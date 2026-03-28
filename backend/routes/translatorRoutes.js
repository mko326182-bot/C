
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const TranslationJob = require('../models/translationJob.model.js');
const Settings = require('../models/settings.model.js');

// --- Firestore Setup (MANDATORY) ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Translator cannot work without it.");
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

// 🔥 New Default Prompt as provided by user
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

// --- THE TRANSLATION WORKER (STRICT FIRESTORE MODE) ---
async function processTranslationJob(jobId) {
    try {
        const job = await TranslationJob.findById(jobId);
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
        let keys = (job.apiKeys && job.apiKeys.length > 0) ? job.apiKeys : (settings?.translatorApiKeys || []);
        
        if (!keys || keys.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مفاتيح API محفوظة.', type: 'error' });
            await job.save();
            return;
        }

        let keyIndex = 0;
        const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the novel chapter from English to Arabic. Output ONLY the Arabic translation. Use the glossary provided.";
        const extractPrompt = settings?.translatorExtractPrompt || DEFAULT_EXTRACT_PROMPT;
        let selectedModel = settings?.translatorModel || 'gemini-1.5-flash'; 

        const chaptersToProcess = job.targetChapters.sort((a, b) => a - b);

        for (const chapterNum of chaptersToProcess) {
            const freshJob = await TranslationJob.findById(jobId);
            // 🔥 Check for pause or stop
            if (!freshJob || freshJob.status !== 'active') {
                if (freshJob && freshJob.status === 'paused') {
                    await pushLog(jobId, `⏸️ تم إيقاف المهمة مؤقتاً عند الفصل ${chapterNum}`, 'warning');
                }
                break;
            }

            const freshNovel = await Novel.findById(job.novelId);
            const chapterIndex = freshNovel.chapters.findIndex(c => c.number === chapterNum);
            
            if (chapterIndex === -1) {
                await pushLog(jobId, `فصل ${chapterNum} غير موجود في الفهرس`, 'warning');
                continue;
            }

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

            if (!sourceContent || sourceContent.trim().length === 0) {
                 await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر (Firestore)`, 'warning');
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
                await pushLog(jobId, `1️⃣ جاري ترجمة الفصل ${chapterNum}...`, 'info');
                
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
                    await pushLog(jobId, `⚠️ ضغط على المفتاح، تبديل وإعادة المحاولة...`, 'warning');
                    await delay(5000);
                    chaptersToProcess.unshift(chapterNum);
                    continue;
                }
                await pushLog(jobId, `❌ فشل الترجمة للفصل ${chapterNum}: ${err.message}`, 'error');
                continue; 
            }

            // 🔥🔥🔥 NEW: EXTRACT TITLE FROM TRANSLATED CONTENT 🔥🔥🔥
            // البحث عن أول فقرة، إذا احتوت على "الفصل" و ":" نأخذ ما بعد النقطتين كعنوان
            let extractedTitle = `الفصل ${chapterNum}`;
            try {
                // تقسيم النص إلى أسطر
                const lines = translatedText.split('\n');
                let firstParagraph = "";
                
                // البحث عن أول سطر غير فارغ
                for (const line of lines) {
                    if (line.trim().length > 0) {
                        firstParagraph = line.trim();
                        break;
                    }
                }

                // التحقق من وجود "الفصل" أو "Chapter" وعلامة النقطتين
                // Regex: يبدأ بكلمة الفصل (اختياري أرقام) ثم نقطتين
                if (firstParagraph && (firstParagraph.includes('الفصل') || firstParagraph.includes('Chapter')) && firstParagraph.includes(':')) {
                    const parts = firstParagraph.split(':');
                    if (parts.length > 1) {
                        // أخذ كل شيء بعد النقطتين الأولى كعنوان
                        const potentialTitle = parts.slice(1).join(':').trim();
                        if (potentialTitle.length > 0) {
                            extractedTitle = potentialTitle;
                        }
                    }
                }
            } catch (titleErr) {
                console.log("Title extraction error:", titleErr);
            }
            // 🔥🔥🔥 END TITLE EXTRACTION 🔥🔥🔥

            try {
                await pushLog(jobId, `2️⃣ جاري استخراج المصطلحات...`, 'info');
                
                keyIndex++; 
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
                
                // 🔥 Cleanup JSON string if it contains markdown code blocks
                if (jsonText.startsWith("```json")) {
                    jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
                } else if (jsonText.startsWith("```")) {
                    jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
                }

                let parsedTerms = [];
                try {
                    const parsed = JSON.parse(jsonText);
                    // Handle if it's an array OR an object with a key like "newTerms"
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
                        // Map prompt keys (name) to DB keys (term)
                        const rawTerm = termObj.name || termObj.term;
                        const translation = termObj.translation;
                        
                        if (rawTerm && translation) {
                            // Map Prompt Categories (singular) to DB Categories (plural)
                            let category = termObj.category ? termObj.category.toLowerCase() : 'other';
                            if (category === 'character') category = 'characters';
                            else if (category === 'location') category = 'locations';
                            else if (category === 'item') category = 'items';
                            else if (category === 'rank') category = 'ranks';
                            else if (category === 'concept') category = 'other'; // Map concept to other as it's not in enum (or add to enum)
                            
                            // Check valid enum, fallback to 'other'
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
                    if (newTermsCount > 0) await pushLog(jobId, `✅ تم إضافة/تحديث ${newTermsCount} مصطلح للمسرد`, 'success');
                } else {
                    await pushLog(jobId, `ℹ️ لم يتم استخراج مصطلحات جديدة`, 'info');
                }

                try {
                    await firestore.collection('novels').doc(freshNovel._id.toString())
                        .collection('chapters').doc(chapterNum.toString())
                        .set({
                            title: extractedTitle, // 🔥 Use the extracted title
                            content: translatedText,
                            lastUpdated: new Date()
                        }, { merge: true });
                    
                } catch (fsSaveErr) {
                    throw new Error(`فشل الحفظ في Firestore: ${fsSaveErr.message}`);
                }

                // 🔥🔥 FIX: Update createdAt to NOW so it triggers "New Chapter" logic
                const updates = { 
                    $set: { 
                        "chapters.$.title": extractedTitle, // 🔥 Use the extracted title
                        "chapters.$.createdAt": new Date(), // Resetting date to make it appear as NEW
                        "lastChapterUpdate": new Date() 
                    } 
                };

                if (freshNovel.status === 'خاصة') {
                    updates.$set.status = 'مستمرة';
                    await pushLog(jobId, `🔓 تم تغيير حالة الرواية إلى 'عامه' لأن فصل تم ترجمته`, 'success');
                }

                await Novel.findOneAndUpdate(
                    { _id: freshNovel._id, "chapters.number": chapterNum },
                    updates
                );

                await TranslationJob.findByIdAndUpdate(jobId, {
                    $inc: { translatedCount: 1 },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() },
                    $pull: { targetChapters: chapterNum } // 🔥 Remove processed chapter from queue
                });

                await pushLog(jobId, `🎉 تم إنجاز الفصل ${chapterNum} بعنوان "${extractedTitle}" وحفظه في السيرفر`, 'success');

            } catch (err) {
                console.error("Extraction/Save Error:", err);
                
                if (translatedText) {
                    try {
                        await firestore.collection('novels').doc(freshNovel._id.toString())
                            .collection('chapters').doc(chapterNum.toString())
                            .set({ content: translatedText }, { merge: true });
                        
                        // 🔥 Also update createdAt on fallback save
                        const updates = { 
                            $set: { 
                                "chapters.$.title": extractedTitle, // 🔥 Use extracted title
                                "chapters.$.createdAt": new Date(),
                                "lastChapterUpdate": new Date()
                            } 
                        };
                        
                        if (freshNovel.status === 'خاصة') updates.$set.status = 'مستمرة';

                        await Novel.findOneAndUpdate(
                            { _id: freshNovel._id, "chapters.number": chapterNum },
                            updates
                        );

                        await TranslationJob.findByIdAndUpdate(jobId, {
                            $pull: { targetChapters: chapterNum } // Remove even if extraction failed
                        });

                        await pushLog(jobId, `⚠️ تم حفظ الترجمة (فشل الاستخراج): ${err.message}`, 'warning');
                    } catch (saveErr) {
                        await pushLog(jobId, `❌ فشل الحفظ النهائي: ${saveErr.message}`, 'error');
                    }
                } else {
                    await pushLog(jobId, `❌ فشل العملية: ${err.message}`, 'error');
                }
            }

            await delay(2000); 
        }

        // Final check
        const finalJob = await TranslationJob.findById(jobId);
        if (finalJob.status === 'active') {
            await TranslationJob.findByIdAndUpdate(jobId, { status: 'completed' });
            await pushLog(jobId, `🏁 اكتملت جميع الفصول!`, 'success');
        }

    } catch (e) {
        console.error("Worker Critical Error:", e);
        await TranslationJob.findByIdAndUpdate(jobId, { status: 'failed' });
    }
}

async function pushLog(jobId, message, type) {
    await TranslationJob.findByIdAndUpdate(jobId, {
        $push: { logs: { message, type, timestamp: new Date() } }
    });
}


module.exports = function(app, verifyToken, verifyAdmin) {

    mongoose.connection.once('open', async () => {
        try {
            const collection = mongoose.connection.db.collection('glossaries');
            const indexes = await collection.indexes();
            if (indexes.some(idx => idx.name === 'user_1_key_1')) {
                await collection.dropIndex('user_1_key_1');
                console.log('✅ Deleted old conflicting index: user_1_key_1');
            }
        } catch (err) {
            console.log('ℹ️ No old indexes to delete or already cleaned.');
        }
    });

    // 1. Get Novels (🔥 OPTIMIZED FOR LAZY LOADING & PERFORMANCE 🔥)
    app.get('/api/translator/novels', verifyToken, async (req, res) => {
        try {
            const { search, page = 1, limit = 20 } = req.query;
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;

            let query = {};
            if (search) {
                query.title = { $regex: search, $options: 'i' };
            }
            
            // 🔥🔥 AGGREGATION PIPELINE: 
            // 1. Filter
            // 2. Count chapters database-side ($size) without loading them
            // 3. Exclude heavy fields like 'chapters', 'description' if not needed
            const novels = await Novel.aggregate([
                { $match: query },
                {
                    $project: {
                        _id: 1,
                        title: 1,
                        cover: 1,
                        author: 1,
                        status: 1,
                        createdAt: 1,
                        // ⚡⚡ ROCKET SPEED: Get array size directly in DB engine
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } } 
                    }
                },
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limitNum }
            ]);
            
            res.json(novels);
        } catch (e) {
            console.error("Translator Novels Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Start Job
    app.post('/api/translator/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, apiKeys, resumeFrom, jobId } = req.body; 
            
            // 🔥 Resume existing job
            if (jobId) {
    const existingJob = await TranslationJob.findById(jobId);
    if (!existingJob) return res.status(404).json({ message: "Job not found" });
    
    existingJob.status = 'active';
    existingJob.logs.push({ message: '▶️ تم استئناف المهمة', type: 'info' });
    await existingJob.save();
    
    // 🔥 تم إزالة الاستدعاء المباشر للمعالج. ستتم المعالجة بواسطة Cron Job.
    // processTranslationJob(existingJob._id);
    return res.json({ message: "Job resumed", jobId: existingJob._id });
}

            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            const userSettings = await getGlobalSettings();
            const savedKeys = userSettings?.translatorApiKeys || [];
            
            const effectiveKeys = (apiKeys && apiKeys.length > 0) ? apiKeys : savedKeys;

            if (effectiveKeys.length === 0) {
                return res.status(400).json({ message: "No API keys found. Please add keys in Settings first." });
            }

            let targetChapters = [];
            
            if (resumeFrom) {
                targetChapters = novel.chapters
                    .filter(c => c.number >= resumeFrom)
                    .map(c => c.number);
            } else if (chapters === 'all') {
                targetChapters = novel.chapters.map(c => c.number);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters;
            }

            const job = new TranslationJob({
    novelId,
    novelTitle: novel.title,
    cover: novel.cover,
    targetChapters,
    totalToTranslate: targetChapters.length,
    apiKeys: effectiveKeys,
    logs: [{ message: `تم بدء المهمة (استهداف ${targetChapters.length} فصل) باستخدام ${effectiveKeys.length} مفتاح`, type: 'info' }]
});

await job.save();

// 🔥 تم إزالة الاستدعاء المباشر للمعالج. ستتم المعالجة بواسطة Cron Job.
// processTranslationJob(job._id);

res.json({ message: "Job started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 🔥 Pause Job
    app.post('/api/translator/jobs/:id/pause', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TranslationJob.findById(req.params.id);
            if (!job) return res.status(404).json({ message: "Job not found" });
            
            job.status = 'paused';
            job.logs.push({ message: '⏸️ طلب إيقاف مؤقت من المستخدم...', type: 'warning' });
            await job.save();
            
            res.json({ message: "Job paused" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 🔥 Delete Job
    app.delete('/api/translator/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await TranslationJob.findByIdAndDelete(req.params.id);
            res.json({ message: "Job deleted" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Get Jobs List (🔥 OPTIMIZED: Exclude logs and apiKeys)
    app.get('/api/translator/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            // 🔥 Use .select() to exclude heavy fields. This is the fix for latency.
            const jobs = await TranslationJob.find()
                .select('novelTitle cover status translatedCount totalToTranslate startTime') 
                .sort({ updatedAt: -1 })
                .limit(20);
            
            // Map to lightweight UI objects
            const uiJobs = jobs.map(j => ({
                id: j._id,
                novelTitle: j.novelTitle,
                cover: j.cover,
                status: j.status,
                translated: j.translatedCount,
                total: j.totalToTranslate,
                startTime: j.startTime
            }));
            res.json(uiJobs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4. Get Job Details
    app.get('/api/translator/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TranslationJob.findById(req.params.id);
            if (!job) return res.status(404).json({message: "Job not found"});

            // Optimize fetching max chapter (don't load whole object if possible, but mongoose is okay here for single item)
            // Use aggregation to just get the max number
            const novelStats = await Novel.aggregate([
                { $match: { _id: job.novelId } },
                { $project: { maxChapter: { $max: "$chapters.number" } } }
            ]);
            
            const maxChapter = (novelStats[0] && novelStats[0].maxChapter) ? novelStats[0].maxChapter : 0;

            const response = job.toObject();
            response.novelMaxChapter = maxChapter;
            
            res.json(response);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5. Manage Glossary
    app.get('/api/translator/glossary/:novelId', verifyToken, async (req, res) => {
        try {
            const terms = await Glossary.find({ novelId: req.params.novelId });
            res.json(terms);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/translator/glossary', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, term, translation, category, description } = req.body; 
            
            // 🔥 Force category check
            const finalCategory = category && ['characters', 'locations', 'items', 'ranks', 'other'].includes(category) 
                                  ? category 
                                  : 'other';

            const newTerm = await Glossary.findOneAndUpdate(
                { novelId, term },
                { 
                    translation, 
                    category: finalCategory,
                    description: description || '',
                    autoGenerated: false 
                },
                { new: true, upsert: true }
            );
            res.json(newTerm);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/translator/glossary/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await Glossary.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    app.post('/api/translator/glossary/bulk-delete', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { ids } = req.body;
            await Glossary.deleteMany({ _id: { $in: ids } });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6. Translator Settings API (GLOBAL)
    app.get('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            let settings = await getGlobalSettings();
            res.json({
                customPrompt: settings.customPrompt || '',
                translatorExtractPrompt: settings.translatorExtractPrompt || DEFAULT_EXTRACT_PROMPT,
                translatorModel: settings.translatorModel || 'gemini-1.5-flash',
                translatorApiKeys: settings.translatorApiKeys || []
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { customPrompt, translatorExtractPrompt, translatorModel, translatorApiKeys } = req.body;
            
            let settings = await getGlobalSettings();

            if (customPrompt !== undefined) settings.customPrompt = customPrompt;
            if (translatorExtractPrompt !== undefined) settings.translatorExtractPrompt = translatorExtractPrompt;
            if (translatorModel !== undefined) settings.translatorModel = translatorModel;
            if (translatorApiKeys !== undefined) settings.translatorApiKeys = translatorApiKeys;

            await settings.save();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
