// cron/translation-processor.js
const { connectToDatabase } = require('../utils/db');
const TranslationJob = require('../models/translationJob.model');
const Novel = require('../models/novel.model');
const Glossary = require('../models/glossary.model');
const Settings = require('../models/settings.model');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Firestore Setup ---
let firestore;
try {
  const firebaseAdmin = require('../config/firebaseAdmin');
  firestore = firebaseAdmin.db;
} catch (e) {
  console.error("❌ CRITICAL: Firestore not loaded. Translator cannot work without it.");
}

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Helper to push logs ---
async function pushLog(jobId, message, type) {
  await TranslationJob.findByIdAndUpdate(jobId, {
    $push: { logs: { message, type, timestamp: new Date() } }
  });
}

// --- The DEFAULT_EXTRACT_PROMPT from original translatorRoutes.js ---
const DEFAULT_EXTRACT_PROMPT = `ROLE: Expert Web Novel Terminology Extractor.
TASK: Analyze the "English Text" and "Arabic Translation" below. Extract key proper nouns, unique concepts, and specific terminology for a comprehensive Glossary (Codex).

STRICT RULES:
1.  Categories: Classify each extracted term into one of: 'character', 'location', 'item', 'rank', 'concept', 'other'.
    *   character: Names of individuals, specific titles referring to a person.
    *   location: Cities, villages, geographical regions, buildings, headquarters.
    *   item: Tools, weapons, materials, unique objects, or specific creatures.
    *   rank: General military, social, or cultivation ranks (not specific character names).
    *   concept: Spiritual, philosophical, agricultural terms, general techniques, or abstract ideas.
    *   other: Any other important term that doesn't fit the above categories.
2.  Format: Return a clean JSON array of objects.
3.  Content:
    *   "name": The exact English name (Capitalized where appropriate).
    *   "translation": The exact Arabic translation used in the text.
    *   "description": وصف قصير جداً باللغة العربية (2-4 كلمات)، مثل: "البطل الرئيسي", "مهارة سيف", "طريقة زراعة", "طاقة روحية".
4.  Filtering & Exclusion (قواعد التصفية والاستبعاد):
    *   Ignore common words. Only specific names, places, unique cultivation terms, and key concepts should be extracted.
    *   Blacklist (تجاهل تام - لا تستخرج هذه أبداً):
        *   الأرقام المنفردة أو أرقام الفصول (مثال: 1, 500, Chapter 10).
        *   عبارات النظام أو الإشعارات (مثال: Ding, System alert, Level Up).
        *   جمل التفاعل والإعلانات (مثال: Subscribe, Read at..., Translator notes, ...).
        *   الأفعال والصفات العادية (مثال: run, fast, big, eat, go).
        *   الكلمات الشائعة جداً التي لا تعتبر مصطلحات خاصة.
5.  Accuracy (الدقة):
    *   Each extracted English term must be unique.
    *   The Arabic translation must exactly match the word or phrase used in the provided Arabic text.
    *   Extracted terms must be meaningful within their context.

Focus Areas (مجالات التركيز - لتوجيه الاستخراج):
*   مصطلحات الزراعة والتقنيات: مثل أنواع النباتات، أساليب الزراعة، أدوات وتقنيات زراعية، أمراض النباتات، حلول هندسية زراعية.
*   أسماء المواقع والمقرات: أسماء المدن، القرى، المناطق الجغرافية، المباني، المقرات الحكومية أو الخاصة، أي موقع ذي أهمية.
*   الشخصيات والرتب الخالدة: أسماء الأشخاص، الألقاب، الرتب العسكرية أو الاجتماعية، الشخصيات التاريخية أو الخيالية.
*   المفاهيم الروحية والزراعية: المصطلحات الدينية، الفلسفية، الروحية، أو المفاهيم المتعلقة بالزراعة العضوية، الاستدامة، التنوع البيولوجي.

OUTPUT JSON STRUCTURE:
[
  { "category": "character", "name": "Fang Yuan", "translation": "فانغ يوان", "description": "البطل الرئيسي" },
  { "category": "concept", "name": "Immortal Gu", "translation": "غو الخالد", "description": "عنصر زراعة" },
  { "category": "location", "name": "Green Mountain Sect", "translation": "طائفة الجبل الأخضر", "description": "مقر الطائفة" }
]

RETURN ONLY JSON:`;

// --- The batch processor ---
module.exports = async (req, res) => {
  // 🔐 Verify cron secret
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await connectToDatabase();

  // Find an active translation job
  const job = await TranslationJob.findOne({ status: 'active' }).sort({ lastUpdate: 1 });
  if (!job) {
    return res.json({ message: 'No active translation jobs' });
  }

  const novel = await Novel.findById(job.novelId);
  if (!novel) {
    job.status = 'failed';
    await job.save();
    await pushLog(job._id, '❌ الرواية غير موجودة', 'error');
    return res.json({ error: 'Novel not found' });
  }

  const settings = await Settings.findOne();
  let keys = (job.apiKeys && job.apiKeys.length) ? job.apiKeys : (settings?.translatorApiKeys || []);
  if (!keys.length) {
    job.status = 'failed';
    await job.save();
    await pushLog(job._id, '❌ لا توجد مفاتيح API محفوظة.', 'error');
    return res.json({ error: 'No API keys' });
  }

  // Batch size: process at most 2 chapters per cron invocation
  const BATCH_SIZE = 2;
  const chaptersToProcess = job.targetChapters.slice(0, BATCH_SIZE);
  if (chaptersToProcess.length === 0) {
    // All done
    job.status = 'completed';
    await job.save();
    await pushLog(job._id, '🏁 اكتملت جميع الفصول!', 'success');
    return res.json({ message: 'Job completed' });
  }

  const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the novel chapter from English to Arabic. Output ONLY the Arabic translation. Use the glossary provided.";
  const extractPrompt = settings?.translatorExtractPrompt || DEFAULT_EXTRACT_PROMPT;
  const selectedModel = settings?.translatorModel || 'gemini-1.5-flash';

  let keyIndex = 0; // will be incremented on quota errors
  let processedCount = 0;

  for (const chapterNum of chaptersToProcess) {
    // Check if job still active (might have been paused)
    const freshJob = await TranslationJob.findById(job._id);
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

    if (!sourceContent || sourceContent.trim().length === 0) {
      await pushLog(job._id, `⚠️ تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر (Firestore)`, 'warning');
      continue;
    }

    const glossaryItems = await Glossary.find({ novelId: freshNovel._id });
    const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');

    const getModel = () => {
      const currentKey = keys[keyIndex % keys.length];
      const genAI = new GoogleGenerativeAI(currentKey);
      return genAI.getGenerativeModel({ model: selectedModel });
    };

    let translatedText = "";
    try {
      await pushLog(job._id, `1️⃣ جاري ترجمة الفصل ${chapterNum}...`, 'info');

      const model = getModel();
      const translationInput = `
${transPrompt}

--- GLOSSARY (Use these strictly) ---
${glossaryText}
-------------------------------------

--- ENGLISH Text TO TRANSLATE ---
${sourceContent}
---------------------------------
`;
      const result = await model.generateContent(translationInput);
      const response = await result.response;
      translatedText = response.text();
    } catch (err) {
      console.error(err);
      if (err.message.includes('429') || err.message.includes('quota')) {
        keyIndex++;
        await pushLog(job._id, `⚠️ ضغط على المفتاح، تبديل وإعادة المحاولة...`, 'warning');
        await delay(5000);
        // we will retry this chapter later; since we didn't remove it from targetChapters yet,
        // we just skip it for now and it will be picked up next cron.
        continue;
      }
      await pushLog(job._id, `❌ فشل الترجمة للفصل ${chapterNum}: ${err.message}`, 'error');
      continue;
    }

    // Extract title from translated content (same logic as original)
    let extractedTitle = `الفصل ${chapterNum}`;
    try {
      const lines = translatedText.split('\n');
      let firstParagraph = "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          firstParagraph = line.trim();
          break;
        }
      }
      if (firstParagraph && (firstParagraph.includes('الفصل') || firstParagraph.includes('Chapter')) && firstParagraph.includes(':')) {
        const parts = firstParagraph.split(':');
        if (parts.length > 1) {
          const potentialTitle = parts.slice(1).join(':').trim();
          if (potentialTitle.length > 0) {
            extractedTitle = potentialTitle;
          }
        }
      }
    } catch (titleErr) {
      console.log("Title extraction error:", titleErr);
    }

    // --- Extraction of glossary terms ---
    try {
      await pushLog(job._id, `2️⃣ جاري استخراج المصطلحات...`, 'info');

      keyIndex++; // rotate key for extraction call
      const modelJSON = getModel();
      modelJSON.generationConfig = { responseMimeType: "application/json" };

      const extractionInput = `
${extractPrompt}

English Text (Excerpt):
"""${sourceContent.substring(0, 8000)}"""

Arabic Text (Excerpt):
"""${translatedText.substring(0, 8000)}"""
`;
      const resultExt = await modelJSON.generateContent(extractionInput);
      const responseExt = await resultExt.response;
      let jsonText = responseExt.text().trim();

      if (jsonText.startsWith("```json")) {
        jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }

      let parsedTerms = [];
      try {
        const parsed = JSON.parse(jsonText);
        if (Array.isArray(parsed)) {
          parsedTerms = parsed;
        } else if (parsed.newTerms && Array.isArray(parsed.newTerms)) {
          parsedTerms = parsed.newTerms;
        } else if (parsed.terms && Array.isArray(parsed.terms)) {
          parsedTerms = parsed.terms;
        }
      } catch (e) {
        console.log("JSON Parse Error", e);
      }

      if (parsedTerms.length > 0) {
        let newTermsCount = 0;
        for (const termObj of parsedTerms) {
          const rawTerm = termObj.name || termObj.term;
          const translation = termObj.translation;
          if (rawTerm && translation) {
            let category = termObj.category ? termObj.category.toLowerCase() : 'other';
            if (category === 'character') category = 'characters';
            else if (category === 'location') category = 'locations';
            else if (category === 'item') category = 'items';
            else if (category === 'rank') category = 'ranks';
            else if (category === 'concept') category = 'other';
            if (!['characters', 'locations', 'items', 'ranks'].includes(category)) {
              category = 'other';
            }
            await Glossary.updateOne(
              { novelId: freshNovel._id, term: rawTerm },
              {
                $set: {
                  translation: translation,
                  category: category,
                  description: termObj.description || ''
                },
                $setOnInsert: { autoGenerated: true }
              },
              { upsert: true }
            );
            newTermsCount++;
          }
        }
        if (newTermsCount > 0) await pushLog(job._id, `✅ تم إضافة/تحديث ${newTermsCount} مصطلح للمسرد`, 'success');
      } else {
        await pushLog(job._id, `ℹ️ لم يتم استخراج مصطلحات جديدة`, 'info');
      }
    } catch (err) {
      console.error("Extraction/Save Error:", err);
      // Continue even if extraction fails; we still want to save translation.
    }

    // Save translation to Firestore and update novel
    try {
      if (firestore) {
        await firestore.collection('novels').doc(freshNovel._id.toString())
          .collection('chapters').doc(chapterNum.toString())
          .set({
            title: extractedTitle,
            content: translatedText,
            lastUpdated: new Date()
          }, { merge: true });
      }

      const updates = {
        $set: {
          "chapters.$.title": extractedTitle,
          "chapters.$.createdAt": new Date(),
          "lastChapterUpdate": new Date()
        }
      };
      if (freshNovel.status === 'خاصة') {
        updates.$set.status = 'مستمرة';
        await pushLog(job._id, `🔓 تم تغيير حالة الرواية إلى 'عامه' لأن فصل تم ترجمته`, 'success');
      }
      await Novel.findOneAndUpdate(
        { _id: freshNovel._id, "chapters.number": chapterNum },
        updates
      );

      // Remove chapter from targetChapters and increment counter
      await TranslationJob.findByIdAndUpdate(job._id, {
        $inc: { translatedCount: 1 },
        $pull: { targetChapters: chapterNum },
        $set: { currentChapter: chapterNum, lastUpdate: new Date() }
      });

      await pushLog(job._id, `🎉 تم إنجاز الفصل ${chapterNum} بعنوان "${extractedTitle}" وحفظه في السيرفر`, 'success');
      processedCount++;
    } catch (saveErr) {
      await pushLog(job._id, `❌ فشل الحفظ النهائي للفصل ${chapterNum}: ${saveErr.message}`, 'error');
    }

    await delay(2000); // small delay between chapters
  }

  // After batch, update lastUpdate to reflect the cron run
  await TranslationJob.findByIdAndUpdate(job._id, { lastUpdate: new Date() });

  res.json({
    message: `Processed ${processedCount} chapters`,
    remaining: job.targetChapters.length - processedCount
  });
};