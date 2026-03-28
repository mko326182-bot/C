// cron/title-gen-processor.js
const { connectToDatabase } = require('../utils/db');
const TitleGenJob = require('../models/titleGenJob.model');
const Novel = require('../models/novel.model');
const Settings = require('../models/settings.model');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Firestore Setup ---
let firestore;
try {
  const firebaseAdmin = require('../config/firebaseAdmin');
  firestore = firebaseAdmin.db;
} catch (e) {
  console.error("❌ CRITICAL: Firestore not loaded. Title generator cannot work without it.");
}

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Helper to push logs ---
async function pushLog(jobId, message, type) {
  await TitleGenJob.findByIdAndUpdate(jobId, {
    $push: { logs: { message, type, timestamp: new Date() } }
  });
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await connectToDatabase();

  const job = await TitleGenJob.findOne({ status: 'active' }).sort({ lastUpdate: 1 });
  if (!job) {
    return res.json({ message: 'No active title generation jobs' });
  }

  const novel = await Novel.findById(job.novelId);
  if (!novel) {
    job.status = 'failed';
    await job.save();
    await pushLog(job._id, '❌ الرواية غير موجودة', 'error');
    return res.json({ error: 'Novel not found' });
  }

  const settings = await Settings.findOne();
  let keys = settings?.titleGenApiKeys || [];
  if (!keys || keys.length === 0) {
    keys = settings?.translatorApiKeys || [];
  }
  if (!keys || keys.length === 0) {
    job.status = 'failed';
    await job.save();
    await pushLog(job._id, '❌ لا توجد مفاتيح API محفوظة لمولد العناوين أو المترجم.', 'error');
    return res.json({ error: 'No API keys' });
  }

  const BATCH_SIZE = 2;
  const chaptersToProcess = job.targetChapters.slice(0, BATCH_SIZE);
  if (chaptersToProcess.length === 0) {
    job.status = 'completed';
    await job.save();
    await pushLog(job._id, '🏁 اكتملت معالجة العناوين!', 'success');
    return res.json({ message: 'Job completed' });
  }

  const systemPrompt = settings?.titleGenPrompt || 'Read the following chapter content and suggest a short, engaging, and professional Arabic title for it (Maximum 6 words). Output ONLY the Arabic title string without any quotes, prefixes, or chapter numbers.';
  const selectedModel = settings?.titleGenModel || 'gemini-2.5-flash';

  let keyIndex = 0;
  let processedCount = 0;

  for (const chapterNum of chaptersToProcess) {
    const freshJob = await TitleGenJob.findById(job._id);
    if (!freshJob || freshJob.status !== 'active') {
      if (freshJob && freshJob.status === 'paused') {
        await pushLog(job._id, `⏸️ تم إيقاف المهمة مؤقتاً عند الفصل ${chapterNum}`, 'warning');
      }
      break;
    }

    const freshNovel = await Novel.findById(job.novelId);
    const chapterIndex = freshNovel.chapters.findIndex(c => c.number === chapterNum);
    if (chapterIndex === -1) {
      await pushLog(job._id, `⚠️ فصل ${chapterNum} غير موجود في الفهرس`, 'warning');
      continue;
    }

    let sourceContent = "";
    if (firestore) {
      try {
        const docRef = firestore.collection('novels').doc(freshNovel._id.toString()).collection('chapters').doc(chapterNum.toString());
        const docSnap = await docRef.get();
        if (docSnap.exists) {
          const data = docSnap.data();
          sourceContent = data.content || "";
        }
      } catch (fsErr) {
        console.log(`Firestore fetch error for Ch ${chapterNum}:`, fsErr.message);
      }
    }

    if (!sourceContent || sourceContent.trim().length < 50) {
      await pushLog(job._id, `⚠️ تخطي الفصل ${chapterNum}: المحتوى قصير جداً أو غير موجود`, 'warning');
      continue;
    }

    const getModel = () => {
      const currentKey = keys[keyIndex % keys.length];
      const genAI = new GoogleGenerativeAI(currentKey);
      return genAI.getGenerativeModel({ model: selectedModel });
    };

    let generatedTitle = "";
    try {
      await pushLog(job._id, `1️⃣ جاري توليد عنوان للفصل ${chapterNum}...`, 'info');

      const model = getModel();
      const input = `
${systemPrompt}

--- CHAPTER CONTENT ---
${sourceContent.substring(0, 15000)}
-----------------------
`;
      const result = await model.generateContent(input);
      const response = await result.response;
      generatedTitle = response.text().trim();

      generatedTitle = generatedTitle.replace(/["'«»]/g, '').replace(/الفصل\s*\d+[:\-]?\s*/, '').trim();

    } catch (err) {
      console.error(err);
      if (err.message.includes('429') || err.message.includes('quota')) {
        keyIndex++;
        await pushLog(job._id, `⚠️ ضغط على المفتاح، تبديل وإعادة المحاولة...`, 'warning');
        await delay(3000);
        continue;
      }
      await pushLog(job._id, `❌ فشل توليد العنوان للفصل ${chapterNum}: ${err.message}`, 'error');
      continue;
    }

    if (generatedTitle) {
      try {
        if (firestore) {
          await firestore.collection('novels').doc(freshNovel._id.toString())
            .collection('chapters').doc(chapterNum.toString())
            .set({
              title: generatedTitle,
              lastUpdated: new Date()
            }, { merge: true });
        }

        await Novel.findOneAndUpdate(
          { _id: freshNovel._id, "chapters.number": chapterNum },
          {
            $set: {
              "chapters.$.title": generatedTitle,
              "lastChapterUpdate": new Date()
            }
          }
        );

        await TitleGenJob.findByIdAndUpdate(job._id, {
          $inc: { processedCount: 1 },
          $pull: { targetChapters: chapterNum },
          $set: { currentChapter: chapterNum, lastUpdate: new Date() }
        });

        await pushLog(job._id, `✅ تم تعيين العنوان: "${generatedTitle}" للفصل ${chapterNum}`, 'success');
        processedCount++;
      } catch (saveErr) {
        await pushLog(job._id, `❌ فشل الحفظ: ${saveErr.message}`, 'error');
      }
    }

    await delay(1500);
  }

  await TitleGenJob.findByIdAndUpdate(job._id, { lastUpdate: new Date() });

  res.json({
    message: `Processed ${processedCount} chapters`,
    remaining: job.targetChapters.length - processedCount
  });
};