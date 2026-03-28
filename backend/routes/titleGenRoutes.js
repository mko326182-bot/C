
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Novel = require('../models/novel.model.js');
const TitleGenJob = require('../models/titleGenJob.model.js');
const Settings = require('../models/settings.model.js');

// --- Firestore Setup ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Title Generator cannot work without it.");
}

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 🔥 Helper to get GLOBAL Settings (Singleton)
async function getGlobalSettings() {
    let settings = await Settings.findOne();
    if (!settings) {
        settings = new Settings({});
        await settings.save();
    }
    return settings;
}

// --- THE TITLE GENERATOR WORKER ---
async function processTitleGenJob(jobId) {
    try {
        const job = await TitleGenJob.findById(jobId);
        if (!job || job.status !== 'active') return;

        if (!firestore) {
            job.status = 'failed';
            job.logs.push({ message: 'خطأ خادم: قاعدة بيانات النصوص (Firestore) غير متصلة', type: 'error' });
            await job.save();
            return;
        }

        const novel = await Novel.findById(job.novelId);
        if (!novel) {
            job.status = 'failed';
            job.logs.push({ message: 'الرواية لم تعد موجودة', type: 'error' });
            await job.save();
            return;
        }

        const settings = await getGlobalSettings(); 
        
        // 🔥 Use specific Title Gen keys OR fallback to translator keys if empty
        let keys = settings?.titleGenApiKeys || [];
        if (!keys || keys.length === 0) {
            keys = settings?.translatorApiKeys || [];
        }
        
        if (!keys || keys.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مفاتيح API محفوظة لمولد العناوين أو المترجم.', type: 'error' });
            await job.save();
            return;
        }

        let keyIndex = 0;
        // Use Specific Model for Title Gen (defaulting to flash)
        let selectedModel = settings?.titleGenModel || 'gemini-2.5-flash'; 
        
        // Use Specific Prompt for Title Gen
        const systemPrompt = settings?.titleGenPrompt || 'Read the following chapter content and suggest a short, engaging, and professional Arabic title for it (Maximum 6 words). Output ONLY the Arabic title string without any quotes, prefixes, or chapter numbers.';

        const chaptersToProcess = job.targetChapters.sort((a, b) => a - b);

        for (const chapterNum of chaptersToProcess) {
            const freshJob = await TitleGenJob.findById(jobId);
            if (!freshJob || freshJob.status !== 'active') {
                if (freshJob && freshJob.status === 'paused') {
                    await pushLog(jobId, `⏸️ تم إيقاف المهمة مؤقتاً عند الفصل ${chapterNum}`, 'warning');
                }
                break;
            }

            const freshNovel = await Novel.findById(job.novelId);
            const chapterIndex = freshNovel.chapters.findIndex(c => c.number === chapterNum);
            
            // Need content to generate title
            let sourceContent = ""; 
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

            if (!sourceContent || sourceContent.trim().length < 50) {
                 await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى قصير جداً أو غير موجود`, 'warning');
                 continue;
            }

            const getModel = () => {
                const currentKey = keys[keyIndex % keys.length];
                const genAI = new GoogleGenerativeAI(currentKey);
                return genAI.getGenerativeModel({ model: selectedModel });
            };

            let generatedTitle = "";

            try {
                await pushLog(jobId, `1️⃣ جاري توليد عنوان للفصل ${chapterNum}...`, 'info');
                
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
                
                // Cleanup Title
                generatedTitle = generatedTitle.replace(/["'«»]/g, '').replace(/الفصل\s*\d+[:\-]?\s*/, '').trim();

            } catch (err) {
                console.error(err);
                if (err.message.includes('429') || err.message.includes('quota')) {
                    keyIndex++;
                    await pushLog(jobId, `⚠️ ضغط على المفتاح، تبديل وإعادة المحاولة...`, 'warning');
                    await delay(3000);
                    chaptersToProcess.unshift(chapterNum); // Retry
                    continue;
                }
                await pushLog(jobId, `❌ فشل توليد العنوان للفصل ${chapterNum}: ${err.message}`, 'error');
                continue; 
            }

            if (generatedTitle) {
                try {
                    // 1. Update Firestore
                    await firestore.collection('novels').doc(freshNovel._id.toString())
                        .collection('chapters').doc(chapterNum.toString())
                        .set({
                            title: generatedTitle,
                            lastUpdated: new Date()
                        }, { merge: true });
                    
                    // 2. Update MongoDB
                    await Novel.findOneAndUpdate(
                        { _id: freshNovel._id, "chapters.number": chapterNum },
                        { 
                            $set: { 
                                "chapters.$.title": generatedTitle,
                                "lastChapterUpdate": new Date() 
                            } 
                        }
                    );

                    await TitleGenJob.findByIdAndUpdate(jobId, {
                        $inc: { processedCount: 1 },
                        $set: { currentChapter: chapterNum, lastUpdate: new Date() },
                        $pull: { targetChapters: chapterNum }
                    });

                    await pushLog(jobId, `✅ تم تعيين العنوان: "${generatedTitle}" للفصل ${chapterNum}`, 'success');

                } catch (saveErr) {
                    await pushLog(jobId, `❌ فشل الحفظ: ${saveErr.message}`, 'error');
                }
            }

            await delay(1500); 
        }

        // Final check
        const finalJob = await TitleGenJob.findById(jobId);
        if (finalJob.status === 'active' && finalJob.targetChapters.length === 0) {
            await TitleGenJob.findByIdAndUpdate(jobId, { status: 'completed' });
            await pushLog(jobId, `🏁 اكتملت معالجة العناوين!`, 'success');
        }

    } catch (e) {
        console.error("TitleGen Worker Critical Error:", e);
        await TitleGenJob.findByIdAndUpdate(jobId, { status: 'failed' });
    }
}

async function pushLog(jobId, message, type) {
    await TitleGenJob.findByIdAndUpdate(jobId, {
        $push: { logs: { message, type, timestamp: new Date() } }
    });
}

module.exports = function(app, verifyToken, verifyAdmin) {

    // 1. Get Jobs List
    app.get('/api/title-gen/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const jobs = await TitleGenJob.find()
                .select('novelTitle cover status processedCount totalToProcess startTime') 
                .sort({ updatedAt: -1 })
                .limit(20);
            
            const uiJobs = jobs.map(j => ({
                id: j._id,
                novelTitle: j.novelTitle,
                cover: j.cover,
                status: j.status,
                processed: j.processedCount,
                total: j.totalToProcess,
                startTime: j.startTime
            }));
            res.json(uiJobs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Start Job
    app.post('/api/title-gen/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, jobId } = req.body; 
            
            // Resume
            if (jobId) {
    const existingJob = await TitleGenJob.findById(jobId);
    if (!existingJob) return res.status(404).json({ message: "Job not found" });
    
    existingJob.status = 'active';
    existingJob.logs.push({ message: '▶️ تم استئناف المهمة', type: 'info' });
    await existingJob.save();
    
    // 🔥 تم إزالة الاستدعاء المباشر للمعالج. ستتم المعالجة بواسطة Cron Job.
    // processTitleGenJob(existingJob._id);
    return res.json({ message: "Job resumed", jobId: existingJob._id });
}

            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            let targetChapters = [];
            if (chapters === 'all') {
                targetChapters = novel.chapters.map(c => c.number);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters;
            }

            const job = new TitleGenJob({
    novelId,
    novelTitle: novel.title,
    cover: novel.cover,
    targetChapters,
    totalToProcess: targetChapters.length,
    logs: [{ message: `تم بدء مهمة توليد العناوين لـ ${targetChapters.length} فصل`, type: 'info' }]
});

await job.save();

// 🔥 تم إزالة الاستدعاء المباشر للمعالج. ستتم المعالجة بواسطة Cron Job.
// processTitleGenJob(job._id);

res.json({ message: "Job started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Pause Job
    app.post('/api/title-gen/jobs/:id/pause', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TitleGenJob.findById(req.params.id);
            if (!job) return res.status(404).json({ message: "Job not found" });
            
            job.status = 'paused';
            job.logs.push({ message: '⏸️ طلب إيقاف مؤقت...', type: 'warning' });
            await job.save();
            
            res.json({ message: "Job paused" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4. Delete Job
    app.delete('/api/title-gen/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await TitleGenJob.findByIdAndDelete(req.params.id);
            res.json({ message: "Job deleted" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5. Get Job Details
    app.get('/api/title-gen/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TitleGenJob.findById(req.params.id);
            if (!job) return res.status(404).json({message: "Job not found"});
            res.json(job);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6. Settings (Global)
    app.get('/api/title-gen/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            let settings = await getGlobalSettings();
            res.json({
                prompt: settings?.titleGenPrompt || '',
                apiKeys: settings?.titleGenApiKeys || []
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/title-gen/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { prompt, apiKeys } = req.body;
            let settings = await getGlobalSettings();
            
            if (prompt !== undefined) settings.titleGenPrompt = prompt;
            if (apiKeys !== undefined) settings.titleGenApiKeys = apiKeys;
            
            await settings.save();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
