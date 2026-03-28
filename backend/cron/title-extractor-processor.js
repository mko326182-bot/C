// cron/title-extractor-processor.js
const { connectToDatabase } = require('../utils/db');
const ChapterScraperJob = require('../models/chapterScraperJob.model');
const Novel = require('../models/novel.model');

// --- Firestore Setup ---
let firestore;
try {
  const firebaseAdmin = require('../config/firebaseAdmin');
  firestore = firebaseAdmin.db;
} catch (e) {
  console.error("❌ CRITICAL: Firestore not loaded. Title extractor cannot work without it.");
}

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Helper to push logs ---
async function pushLog(jobId, message, type) {
  await ChapterScraperJob.findByIdAndUpdate(jobId, {
    $push: { logs: { message, type, timestamp: new Date() } }
  });
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await connectToDatabase();

  const job = await ChapterScraperJob.findOne({ status: 'active' }).sort({ lastUpdate: 1 });
  if (!job) {
    return res.json({ message: 'No active title extraction jobs' });
  }

  const novel = await Novel.findById(job.novelId);
  if (!novel) {
    job.status = 'failed';
    await job.save();
    await pushLog(job._id, '❌ الرواية غير موجودة', 'error');
    return res.json({ error: 'Novel not found' });
  }

  if (!firestore) {
    job.status = 'failed';
    await job.save();
    await pushLog(job._id, '❌ Firestore not connected', 'error');
    return res.json({ error: 'Firestore not connected' });
  }

  const chapters = novel.chapters.sort((a, b) => a.number - b.number);
  let updatedCount = 0;
  const BATCH_SIZE = 5; // process 5 chapters per cron invocation
  let processedCount = 0;

  for (let i = job.processedCount; i < chapters.length && processedCount < BATCH_SIZE; i++) {
    const chapter = chapters[i];

    // Check if job still active
    const freshJob = await ChapterScraperJob.findById(job._id);
    if (!freshJob || freshJob.status !== 'active') break;

    try {
      const docRef = firestore.collection('novels').doc(novel._id.toString()).collection('chapters').doc(chapter.number.toString());
      const docSnap = await docRef.get();

      if (docSnap.exists) {
        const content = docSnap.data().content || "";
        const lines = content.split('\n');
        let firstLine = "";
        for (const line of lines) {
          if (line.trim().length > 0) {
            firstLine = line.trim();
            break;
          }
        }

        if (firstLine && (firstLine.includes('الفصل') || firstLine.includes('Chapter')) && firstLine.includes(':')) {
          const parts = firstLine.split(':');
          if (parts.length > 1) {
            const newTitle = parts.slice(1).join(':').trim();

            if (newTitle && newTitle !== chapter.title) {
              await Novel.updateOne(
                { _id: novel._id, "chapters.number": chapter.number },
                { $set: { "chapters.$.title": newTitle } }
              );
              await docRef.update({ title: newTitle });
              updatedCount++;
              await pushLog(job._id, `✅ فصل ${chapter.number}: تم التحديث إلى "${newTitle}"`, 'success');
            }
          }
        }
      }
    } catch (err) {
      await pushLog(job._id, `❌ خطأ في فصل ${chapter.number}: ${err.message}`, 'error');
    }

    processedCount++;
    await ChapterScraperJob.findByIdAndUpdate(job._id, {
      processedCount: i + 1,
      lastUpdate: new Date()
    });
    await delay(100);
  }

  // After batch, check if all chapters processed
  const finalJob = await ChapterScraperJob.findById(job._id);
  if (finalJob && finalJob.processedCount >= chapters.length) {
    await ChapterScraperJob.findByIdAndUpdate(job._id, {
      status: 'completed',
      $push: { logs: { message: `🏁 اكتملت المهمة. تم تحديث ${updatedCount} عنوان.`, type: 'success' } }
    });
  }

  res.json({
    message: `Processed ${processedCount} chapters, updated ${updatedCount} titles`,
    remaining: chapters.length - finalJob.processedCount
  });
};