
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken'); 
const axios = require('axios');

// --- Config Imports ---
let firestore, cloudinary;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
    cloudinary = require('../config/cloudinary');
} catch (e) {
    console.warn("⚠️ Config files check failed in public routes...");
}

// Models
const User = require('../models/user.model.js');
const Novel = require('../models/novel.model.js');
const NovelLibrary = require('../models/novelLibrary.model.js'); 
const Comment = require('../models/comment.model.js');
const Settings = require('../models/settings.model.js'); 

// Helper to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper to get user role inside public route (Safely)
const getUserRole = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return 'guest';
        const decoded = jwt.decode(token); 
        return decoded?.role || 'guest';
    } catch (e) { return 'guest'; }
};

// Helper to check and update status automatically
const ZEUS_SECRET = "Z3uS_N0v3l_2026_S3cr3t_K3y";

async function checkNovelStatus(novel) {
    if (novel.status === 'مكتملة') return novel; 

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    if (novel.lastChapterUpdate < thirtyDaysAgo && novel.status === 'مستمرة') {
        novel.status = 'متوقفة';
        await novel.save();
    }
    return novel;
}

// 🔥 Helper for Forbidden Words Filter (The blocklist for raw/hidden chapters)
const isChapterHidden = (title) => {
    if (!title) return true;
    const lower = title.toLowerCase();
    const forbidden = ['chapter', 'ago', 'month', 'week', 'day', 'year', 'years', 'months', 'weeks', 'days'];
    return forbidden.some(word => lower.includes(word));
};

// 🔥 Fixed Categories (Baseline) - If DB is empty
const BASE_CATEGORIES = [
    'أكشن', 'رومانسي', 'فانتازيا', 'شيانشيا', 'شوانهوان', 'وشيا', 
    'مغامرات', 'نظام', 'حريم', 'رعب', 'خيال علمي', 'دراما', 'غموض', 'تاريخي'
];

// 🔥 Helper for Content Obfuscation (Genius Level Protection - Multi-layered)
function obfuscateText(text) {
    if (!text) return "";
    try {
        // Encode to URI component to handle Arabic characters safely
        const encoded = encodeURIComponent(text);
        let result = "";
        
        for (let i = 0; i < encoded.length; i++) {
            let charCode = encoded.charCodeAt(i);
            
            // Layer 1: XOR with secret
            charCode = charCode ^ ZEUS_SECRET.charCodeAt(i % ZEUS_SECRET.length);
            
            // Layer 2: Dynamic Offset based on position
            const offset = (i * 7) % 13;
            charCode = (charCode + offset) % 256;
            
            // Layer 3: Rotation (3 positions)
            charCode = (charCode + 3) % 256;
            
            result += String.fromCharCode(charCode);
        }
        // Return as Base64 using 'binary' encoding to preserve raw bytes
        return Buffer.from(result, 'binary').toString('base64');
    } catch (e) {
        return text;
    }
}

module.exports = function(app, verifyToken, upload) {

    // =========================================================
    // 📂 CATEGORIES API (Managed + Dynamic fallback)
    // =========================================================
    app.get('/api/categories', async (req, res) => {
        try {
            // 1. Try to fetch from Admin Settings (The Source of Truth)
            const adminSettings = await Settings.findOne({ 
                managedCategories: { $exists: true, $not: { $size: 0 } } 
            }).sort({ updatedAt: -1 }); // Get latest active settings if multiple admins

            let masterList = [];
            
            if (adminSettings && adminSettings.managedCategories && adminSettings.managedCategories.length > 0) {
                masterList = adminSettings.managedCategories;
            } else {
                // Fallback: Combine Fixed + Dynamic from Novels
                const distinctCategories = await Novel.distinct('category');
                const distinctTags = await Novel.distinct('tags');
                masterList = [
                    ...BASE_CATEGORIES,
                    ...distinctCategories.filter(c => c), 
                    ...distinctTags.filter(t => t)
                ];
            }

            // Remove duplicates and sort
            const uniqueCats = Array.from(new Set(masterList)).sort();

            // Return objects
            const responseData = uniqueCats.map(c => ({ id: c, name: c }));
            responseData.unshift({ id: 'all', name: 'الكل' });

            res.json(responseData);
        } catch (error) {
            console.error("Categories Fetch Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 🖼️ UPLOAD API
    // =========================================================
    app.post('/api/upload', verifyToken, upload.single('image'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ message: "No file uploaded" });

            const b64 = Buffer.from(req.file.buffer).toString('base64');
            let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
            
            const result = await cloudinary.uploader.upload(dataURI, {
                folder: "zeus_user_uploads",
                resource_type: "auto" 
            });

            res.json({ url: result.secure_url });
        } catch (error) {
            console.error("Upload Error:", error);
            res.status(500).json({ error: error.message || "Failed to upload image" });
        }
    });

    // =========================================================
    // 🎭 NOVEL REACTIONS API
    // =========================================================
    app.post('/api/novels/:novelId/react', verifyToken, async (req, res) => {
        try {
            const { type } = req.body; 
            const validTypes = ['like', 'love', 'funny', 'sad', 'angry'];
            
            if (!validTypes.includes(type)) return res.status(400).json({message: "Invalid reaction type"});

            const novel = await Novel.findById(req.params.novelId);
            if (!novel) return res.status(404).json({message: "Novel not found"});

            const userId = req.user.id;

            if (!novel.reactions) {
                novel.reactions = { like: [], love: [], funny: [], sad: [], angry: [] };
            }
            
            let added = false;

            if (novel.reactions[type].includes(userId)) {
                novel.reactions[type].pull(userId);
            } else {
                validTypes.forEach(t => {
                    if (novel.reactions[t].includes(userId)) {
                        novel.reactions[t].pull(userId);
                    }
                });
                novel.reactions[type].push(userId);
                added = true;
            }

            await novel.save();

            const stats = {
                like: novel.reactions.like.length,
                love: novel.reactions.love.length,
                funny: novel.reactions.funny.length,
                sad: novel.reactions.sad.length,
                angry: novel.reactions.angry.length,
                userReaction: added ? type : null 
            };

            res.json(stats);

        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 💬 COMMENTS API 
    // =========================================================
    app.get('/api/novels/:novelId/comments', async (req, res) => {
        try {
            const { novelId } = req.params;
            const { sort = 'newest', page = 1, limit = 20, chapterNumber } = req.query;
            
            const novel = await Novel.findById(novelId).select('reactions').lean();
            let stats = { like: 0, love: 0, funny: 0, sad: 0, angry: 0, total: 0, userReaction: null };
            
            if (novel && novel.reactions) {
                stats.like = novel.reactions.like?.length || 0;
                stats.love = novel.reactions.love?.length || 0;
                stats.funny = novel.reactions.funny?.length || 0;
                stats.sad = novel.reactions.sad?.length || 0;
                stats.angry = novel.reactions.angry?.length || 0;
                stats.total = stats.like + stats.love + stats.funny + stats.sad + stats.angry;
            }

            let query = { novelId, parentId: null };
            
            if (chapterNumber) {
                query.chapterNumber = parseInt(chapterNumber);
            } else {
                query.chapterNumber = null; 
            }

            let sortOption = { createdAt: -1 };
            if (sort === 'oldest') sortOption = { createdAt: 1 };
            if (sort === 'best') sortOption = { likes: -1 }; 

            const comments = await Comment.find(query)
                .populate('user', 'name picture role isCommentBlocked')
                .populate({ path: 'replyCount' })
                .sort(sortOption)
                .skip((page - 1) * limit)
                .limit(parseInt(limit))
                .lean(); 

            const validComments = comments.filter(c => c.user !== null);
            const totalComments = await Comment.countDocuments(query);

            res.json({ 
                comments: validComments, 
                totalComments,
                stats 
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/comments/:commentId/replies', async (req, res) => {
        try {
            const replies = await Comment.find({ parentId: req.params.commentId })
                .populate('user', 'name picture role')
                .sort({ createdAt: 1 })
                .lean();
            
            res.json(replies.filter(r => r.user !== null));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/comments', verifyToken, async (req, res) => {
        try {
            const { novelId, content, parentId, chapterNumber } = req.body;
            
            const currentUser = await User.findById(req.user.id).select('isCommentBlocked');
            if (currentUser.isCommentBlocked) {
                return res.status(403).json({ message: "أنت ممنوع من التعليق." });
            }

            if (!content || !content.trim()) return res.status(400).json({message: "Content required"});

            const newComment = new Comment({
                novelId,
                user: req.user.id,
                content: content.trim(),
                parentId: parentId || null,
                chapterNumber: chapterNumber ? parseInt(chapterNumber) : null 
            });

            await newComment.save();
            await newComment.populate('user', 'name picture role');

            res.json(newComment);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/comments/:commentId', verifyToken, async (req, res) => {
        try {
            const { content } = req.body;
            const comment = await Comment.findById(req.params.commentId);
            
            if (!comment) return res.status(404).json({message: "Comment not found"});
            
            if (comment.user.toString() !== req.user.id) {
                return res.status(403).json({message: "Unauthorized"});
            }

            comment.content = content;
            comment.isEdited = true;
            await comment.save();
            
            await comment.populate('user', 'name picture role');
            res.json(comment);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/comments/:commentId/action', verifyToken, async (req, res) => {
        try {
            const { action } = req.body; 
            const userId = req.user.id;
            const comment = await Comment.findById(req.params.commentId);
            
            if (!comment) return res.status(404).json({message: "Comment not found"});

            if (action === 'like') {
                comment.dislikes.pull(userId);
                if (comment.likes.includes(userId)) {
                    comment.likes.pull(userId);
                } else {
                    comment.likes.addToSet(userId);
                }
            } else if (action === 'dislike') {
                comment.likes.pull(userId);
                if (comment.dislikes.includes(userId)) {
                    comment.dislikes.pull(userId);
                } else {
                    comment.dislikes.addToSet(userId);
                }
            }

            await comment.save();
            res.json({ likes: comment.likes.length, dislikes: comment.dislikes.length });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/comments/:commentId', verifyToken, async (req, res) => {
        try {
            const comment = await Comment.findById(req.params.commentId);
            if (!comment) return res.status(404).json({message: "Not found"});

            if (comment.user.toString() !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({message: "Unauthorized"});
            }

            await Comment.deleteMany({ parentId: comment._id });
            await Comment.findByIdAndDelete(req.params.commentId);

            res.json({ message: "Deleted" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 👤 USER PROFILE API
    // =========================================================

    // 🔥🔥🔥 LIGHTWEIGHT PUBLIC PROFILE (ROCKET SPEED FOR AUTHOR WIDGET) 🔥🔥🔥
    app.get('/api/user/public-profile', async (req, res) => {
        try {
            const { email, userId } = req.query;
            let query = {};
            
            if (userId) {
                // 🔥 SMART CHECK: If it's a valid ObjectId, use it. Otherwise, assume it's an email (legacy/fallback)
                if (mongoose.Types.ObjectId.isValid(userId)) {
                    query._id = userId;
                } else {
                    query.email = userId.toLowerCase();
                }
            } else if (email) {
                query.email = email.toLowerCase(); // Ensure case insensitivity
            } else {
                return res.status(400).json({ message: "Identifier required" });
            }

            // Fetch ONLY basic info, NO calculations
            const user = await User.findOne(query).select('name picture banner bio role createdAt isHistoryPublic');
            
            if (!user) return res.status(404).json({ message: "User not found" });

            // Obfuscate URLs for privacy
            const userObj = user.toObject();

            res.json({ user: userObj }); 
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/user/profile', verifyToken, async (req, res) => {
        try {
            const { name, bio, banner, picture, isHistoryPublic, email } = req.body;
            
            const updates = {};
            
            if (name && name !== req.user.name) {
                 const existing = await User.findOne({ name: name });
                 if (existing) {
                     return res.status(400).json({ message: "اسم المستخدم هذا مستخدم بالفعل." });
                 }
                 updates.name = name;
            }

            // 🔥 Validate and Update Email
            if (email && email !== req.user.email) {
                const lowerEmail = email.toLowerCase();
                const emailRegex = /^[a-zA-Z]{5,}@gmail\.com$/;
                if (!emailRegex.test(lowerEmail)) {
                    return res.status(400).json({ 
                        message: "البريد الإلكتروني يجب أن ينتهي بـ @gmail.com ويتكون الاسم قبله من أكثر من 4 حروف إنجليزية فقط." 
                    });
                }
                const existingEmail = await User.findOne({ email: lowerEmail });
                if (existingEmail) {
                    return res.status(400).json({ message: "البريد الإلكتروني مستخدم بالفعل." });
                }
                updates.email = lowerEmail;
            }
            
            if (bio !== undefined) updates.bio = bio;
            if (banner) updates.banner = banner;
            if (picture) updates.picture = picture;
            if (isHistoryPublic !== undefined) updates.isHistoryPublic = isHistoryPublic;

            const updatedUser = await User.findByIdAndUpdate(
                req.user.id,
                { $set: updates },
                { new: true }
            );

            res.json(updatedUser);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/user/stats', verifyToken, async (req, res) => {
        try {
            let targetUserId = req.user.id;
            let targetUser = null;
            
            // Pagination Params
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            if (req.query.userId) {
                targetUserId = req.query.userId;
                targetUser = await User.findById(targetUserId).lean();
            } else if (req.query.email) {
                targetUser = await User.findOne({ email: req.query.email }).lean();
                if (targetUser) targetUserId = targetUser._id;
            } else {
                targetUser = await User.findById(targetUserId).lean();
            }

            if (!targetUser) return res.status(404).json({ message: "User not found" });

            // 1. Library Stats
            const libraryStats = await NovelLibrary.aggregate([
                { $match: { user: new mongoose.Types.ObjectId(targetUserId) } },
                { $project: { readCount: { $size: { $ifNull: ["$readChapters", []] } } } },
                { $group: { _id: null, totalRead: { $sum: "$readCount" } } }
            ]);
            const totalReadChapters = libraryStats[0] ? libraryStats[0].totalRead : 0;

            // 2. My Works Stats
            const worksStats = await Novel.aggregate([
                { 
                    $match: { 
                        $or: [
                            { authorEmail: targetUser.email },
                            { author: { $regex: new RegExp(`^${targetUser.name}$`, 'i') } } 
                        ]
                    } 
                },
                {
                    $group: {
                        _id: null,
                        totalViews: { $sum: "$views" },
                        totalChapters: { $sum: { $size: { $ifNull: ["$chapters", []] } } }
                    }
                }
            ]);

            const addedChapters = worksStats[0] ? worksStats[0].totalChapters : 0;
            const totalViews = worksStats[0] ? worksStats[0].totalViews : 0;

            // 3. Lightweight My Works List (PAGINATED)
            // Sort: Descending (First Added to Last Added -> Newest first) - createdAt: -1
            const myWorks = await Novel.aggregate([
                { 
                    $match: { 
                        $or: [
                            { authorEmail: targetUser.email },
                            { author: { $regex: new RegExp(`^${targetUser.name}$`, 'i') } } 
                        ]
                    } 
                },
                {
                    $project: {
                        _id: 1,
                        title: 1,
                        cover: 1,
                        status: 1,
                        views: 1,
                        createdAt: 1,
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } }
                    }
                },
                { $sort: { createdAt: -1 } }, // Descending (Newest First)
                { $skip: skip },
                { $limit: limit }
            ]);
            
            res.json({
                user: {
                    _id: targetUser._id,
                    name: targetUser.name,
                    email: targetUserId === req.user.id ? targetUser.email : undefined, 
                    picture: targetUser.picture,
                    banner: targetUser.banner,
                    bio: targetUser.bio,
                    role: targetUser.role,
                    createdAt: targetUser.createdAt,
                    isHistoryPublic: targetUser.isHistoryPublic
                },
                readChapters: totalReadChapters,
                addedChapters,
                totalViews,
                myWorks: myWorks,
                worksPage: page
            });

        } catch (error) {
            console.error("Stats Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // 🔥 ROCKET SPEED VIEW COUNT: Open to everyone, no restrictions
    app.post('/api/novels/:id/view', async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Invalid ID');
            
            // 🔥 Direct increment for maximum performance
            await Novel.findByIdAndUpdate(id, {
                $inc: { 
                    views: 1,
                    dailyViews: 1,
                    weeklyViews: 1,
                    monthlyViews: 1
                }
            });
            
            res.status(200).json({ success: true });
        } catch (error) { 
            res.status(500).send('Error'); 
        }
    });

    // 🔥 Rocket Speed Home Screen Aggregation (Updated for Visible Chapter Logic) 🔥
    app.get('/api/novels', async (req, res) => {
        try {
            const { filter, search, category, status, sort, page = 1, limit = 20, timeRange } = req.query;
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;
            let matchStage = {};

            const role = getUserRole(req);
            if (role !== 'admin') {
                matchStage.status = { $ne: 'خاصة' };
            }

            if (search) {
                 matchStage.$or = [
                     { title: { $regex: search, $options: 'i' } },
                     { author: { $regex: search, $options: 'i' } }
                 ];
            }

            // 🔥 FIX: Direct match for categories
            if (category && category !== 'all') {
                matchStage.$or = [{ category: category }, { tags: category }];
            }

            if (status && status !== 'all') {
                matchStage.status = status; 
            }

            if (filter === 'latest_updates') {
                matchStage["chapters.0"] = { $exists: true };
            }

            let sortStage = {};
            if (sort === 'chapters_desc') sortStage = { chaptersCount: -1 };
            else if (sort === 'chapters_asc') sortStage = { chaptersCount: 1 };
            else if (sort === 'title_asc') sortStage = { title: 1 };
            else if (sort === 'title_desc') sortStage = { title: -1 };
            else if (filter === 'latest_updates') sortStage = { lastChapterUpdate: -1 };
            else if (filter === 'latest_added') sortStage = { createdAt: -1 };
            else if (filter === 'featured' || filter === 'trending') {
                 if (timeRange === 'day') sortStage = { dailyViews: -1 };
                 else if (timeRange === 'week') sortStage = { weeklyViews: -1 };
                 else if (timeRange === 'month') sortStage = { monthlyViews: -1 };
                 else sortStage = { views: -1 };
            } else {
                 sortStage = { chaptersCount: -1 };
            }

            const pipeline = [
                { $match: matchStage },
                { 
                    $project: {
                        title: 1,
                        cover: 1,
                        author: 1,
                        category: 1,
                        tags: 1,
                        status: 1,
                        views: 1,
                        dailyViews: 1,
                        weeklyViews: 1,
                        monthlyViews: 1,
                        lastChapterUpdate: 1,
                        createdAt: 1,
                        rating: 1,
                        // 🔥 CRITICAL FIX: Do NOT project chapters array.
                        // Calculate count database side
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } },
                        // Get only the LAST chapter for "Latest Updates"
                        lastChapter: { $arrayElemAt: [ "$chapters", -1 ] } // Assuming chapters are sorted by push
                    }
                },
                { $sort: sortStage },
                {
                    $facet: {
                        metadata: [{ $count: "total" }],
                        data: [{ $skip: skip }, { $limit: limitNum }]
                    }
                }
            ];

            const result = await Novel.aggregate(pipeline);

            let novelsData = result[0].data;
            
            // Format output to match old structure but lightweight
            novelsData = novelsData.map(n => ({
                ...n,
                // Create a fake chapters array with just 1 item if needed by frontend logic
                chapters: n.lastChapter ? [n.lastChapter] : []
            }));

            const totalCount = result[0].metadata[0] ? result[0].metadata[0].total : 0;
            const totalPages = Math.ceil(totalCount / limitNum);

            res.json({ novels: novelsData, currentPage: pageNum, totalPages: totalPages, totalNovels: totalCount });

        } catch (error) {
            console.error(error);
            res.status(500).json({ message: error.message });
        }
    });

    // 🔥🔥🔥 LIGHTWEIGHT NOVEL DETAILS (ROCKET SPEED - NO CHAPTERS ARRAY) 🔥🔥🔥
    app.get('/api/novels/:id', async (req, res) => {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Invalid ID' });
            
            const role = getUserRole(req);

            // 🚀 AGGREGATION PIPELINE FOR SPEED & EXCLUDING CHAPTERS 🚀
            const pipeline = [
                { $match: { _id: new mongoose.Types.ObjectId(req.params.id) } },
                {
                    $project: {
                        title: 1,
                        titleEn: 1,
                        author: 1,
                        authorId: 1, // 🔥 NEW: Include authorId
                        cover: 1,
                        banner: 1,
                        description: 1,
                        category: 1,
                        tags: 1,
                        status: 1,
                        rating: 1,
                        views: 1,
                        favorites: 1,
                        lastChapterUpdate: 1,
                        createdAt: 1,
                        // 🔥 Calculate count in DB, do NOT return array
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } }
                    }
                }
            ];

            const result = await Novel.aggregate(pipeline);
            if (!result || result.length === 0) return res.status(404).json({ message: 'Novel not found' });
            
            const novelDoc = result[0];
            
            if (novelDoc.status === 'خاصة' && role !== 'admin') {
                return res.status(403).json({ message: "Access Denied" });
            }

            // Sync status check (Async, detached from response speed)
            Novel.findById(req.params.id).then(doc => {
                if (doc) checkNovelStatus(doc);
            }).catch(err => console.error("Status check error:", err));
            
            res.json(novelDoc);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });

    // 🔥🔥🔥 PAGINATED CHAPTER LIST (SERVER-SIDE LAZY LOADING) 🔥🔥🔥
    app.get('/api/novels/:id/chapters-list', async (req, res) => {
        try {
            const { id } = req.params;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 25;
            const sortOrder = req.query.sort === 'desc' ? -1 : 1; // Default Ascending (1, 2, 3...)
            const skip = (page - 1) * limit;
            
            const role = getUserRole(req);

            // Using aggregation to efficiently unwrap, sort, and slice the array
            const pipeline = [
                { $match: { _id: new mongoose.Types.ObjectId(id) } },
                
                // 1. Unwind the chapters array to documents
                { $unwind: "$chapters" },

                // 2. Filter hidden chapters (if not admin)
                ...(role !== 'admin' ? [{
                    $match: {
                        $and: [
                            { "chapters.title": { $not: { $regex: /chapter|ago|month|week|day|year/i } } }
                            // Add more filters here if needed based on isChapterHidden logic
                        ]
                    }
                }] : []),

                // 3. Sort by number
                { $sort: { "chapters.number": sortOrder } },

                // 4. Project only needed fields (Metadata only, NO content)
                {
                    $project: {
                        _id: "$chapters._id",
                        number: "$chapters.number",
                        title: "$chapters.title",
                        createdAt: "$chapters.createdAt",
                        views: "$chapters.views"
                    }
                },

                // 5. Pagination
                { $skip: skip },
                { $limit: limit }
            ];

            const chapters = await Novel.aggregate(pipeline);

            res.json(chapters);

        } catch (error) {
            console.error("Chapters List Error:", error);
            res.status(500).json({ message: error.message });
        }
    });

    app.get('/api/novels/:novelId/chapters/:chapterId', async (req, res) => {
        try {
            const { novelId, chapterId } = req.params;
            if (!mongoose.Types.ObjectId.isValid(novelId)) return res.status(404).json({ message: 'Invalid ID' });

            const role = getUserRole(req);
            const isId = mongoose.Types.ObjectId.isValid(chapterId);

            // 🔥 LIGHTNING FAST OPTIMIZED FETCH 🔥
            // Use aggregation to fetch ONLY the specific chapter metadata and total count
            const novelData = await Novel.aggregate([
                { $match: { _id: new mongoose.Types.ObjectId(novelId) } },
                {
                    $project: {
                        status: 1,
                        chaptersCount: { $size: "$chapters" },
                        chapter: {
                            $filter: {
                                input: "$chapters",
                                as: "chap",
                                cond: isId 
                                    ? { $eq: ["$$chap._id", new mongoose.Types.ObjectId(chapterId)] }
                                    : { $eq: ["$$chap.number", parseInt(chapterId)] }
                            }
                        }
                    }
                }
            ]);

            if (!novelData || novelData.length === 0) return res.status(404).json({ message: 'Novel not found' });
            
            const novel = novelData[0];
            if (novel.status === 'خاصة' && role !== 'admin') {
                return res.status(403).json({ message: "Access Denied" });
            }

            const chapterMeta = novel.chapter && novel.chapter[0];
            if (!chapterMeta) return res.status(404).json({ message: 'Chapter metadata not found' });

            if (role !== 'admin') {
                if (isChapterHidden(chapterMeta.title)) {
                    return res.status(403).json({ message: "Chapter not available yet" });
                }
            }

            let content = "لا يوجد محتوى.";
            
            if (firestore) {
                try {
                    const docRef = firestore.collection('novels').doc(novelId).collection('chapters').doc(chapterMeta.number.toString());
                    const docSnap = await docRef.get();
                    if (docSnap.exists) {
                        content = docSnap.data().content;
                    } else {
                        console.warn(`⚠️ Chapter content not found in Firestore for novel ${novelId}, chapter ${chapterMeta.number}`);
                    }
                } catch (firestoreError) {
                    console.error("❌ Firestore Fetch Error:", firestoreError.message);
                    if (firestoreError.message.includes("UNAUTHENTICATED")) {
                        return res.status(500).json({ 
                            message: "خطأ في الاتصال بقاعدة البيانات (غير مصرح). يرجى التأكد من إعدادات Firebase.",
                            details: firestoreError.message 
                        });
                    }
                    throw firestoreError;
                }
            } else {
                console.error("❌ Firestore is not initialized. Cannot fetch chapter content.");
                return res.status(500).json({ message: "قاعدة البيانات غير متصلة حالياً. يرجى مراجعة المسؤول." });
            }

            // 🔥 CLEANER + SEPARATION LOGIC 🔥
            let copyrightStart = "";
            let copyrightEnd = "";
            let copyrightStyles = {};

            try {
                const adminSettings = await Settings.findOne({ 
                    $or: [
                        { globalBlocklist: { $exists: true, $not: { $size: 0 } } },
                        { globalReplacements: { $exists: true, $not: { $size: 0 } } },
                        { globalChapterStartText: { $exists: true } },
                        { enableChapterSeparator: { $exists: true } }
                    ] 
                }).sort({ updatedAt: -1 }).lean(); 

                if (adminSettings) {
                    if (adminSettings.globalBlocklist && adminSettings.globalBlocklist.length > 0) {
                        adminSettings.globalBlocklist.forEach(word => {
                            if (!word) return;
                            if (word.includes('\n') || word.includes('\r')) {
                                content = content.split(word).join('');
                            } else {
                                const escapedKeyword = escapeRegExp(word);
                                const regex = new RegExp(`^.*${escapedKeyword}.*$`, 'gm');
                                content = content.replace(regex, '');
                            }
                        });
                    }

                    if (adminSettings.globalReplacements && adminSettings.globalReplacements.length > 0) {
                        adminSettings.globalReplacements.forEach(rep => {
                            if (rep.original) {
                                const escapedOriginal = escapeRegExp(rep.original);
                                const regex = new RegExp(escapedOriginal, 'g');
                                content = content.replace(regex, rep.replacement || '');
                            }
                        });
                    }

                    content = content.replace(/^\s*[\r\n]/gm, ''); 
                    content = content.replace(/\n\s*\n/g, '\n\n'); 

                    if (adminSettings.enableChapterSeparator) {
                        const separatorLine = `\n\n${adminSettings.chapterSeparatorText || '________________________________________'}\n\n`;
                        const lines = content.split('\n');
                        let replaced = false;
                        for (let i = 0; i < lines.length; i++) {
                            const lineTrimmed = lines[i].trim();
                            if (lineTrimmed.length > 0) {
                                if (/^(?:الفصل|Chapter|فصل)|:/i.test(lineTrimmed)) {
                                    lines[i] = lines[i] + separatorLine;
                                    replaced = true;
                                }
                                break;
                            }
                        }
                        if (replaced) content = lines.join('\n');
                    }

                    const frequency = adminSettings.copyrightFrequency || 'always';
                    const everyX = adminSettings.copyrightEveryX || 5;
                    const chapNum = parseInt(chapterMeta.number);
                    let showCopyright = true;

                    if (frequency === 'random') {
                        if (Math.random() > 0.5) showCopyright = false;
                    } else if (frequency === 'every_x') {
                        if (chapNum % everyX !== 0) showCopyright = false;
                    }

                    if (showCopyright) {
                        copyrightStart = adminSettings.globalChapterStartText || "";
                        copyrightEnd = adminSettings.globalChapterEndText || "";
                        copyrightStyles = adminSettings.globalCopyrightStyles || {};
                        if (!copyrightStyles.fontSize) copyrightStyles.fontSize = 14; 
                    }
                }
            } catch (cleanerErr) {}

            // Calculate total available chapters (approximate if we don't want to fetch all)
            // For now, we'll use the novel.chaptersCount we projected
            let totalAvailable = novel.chaptersCount;

            res.json({ 
                ...chapterMeta, 
                content: obfuscateText(content), 
                copyrightStart, 
                copyrightEnd,   
                copyrightStyles, 
                totalChapters: totalAvailable
            });
        } catch (error) {
            console.error("Get Chapter Error:", error);
            res.status(500).json({ message: error.message });
        }
    });

    app.post('/api/novel/update', verifyToken, async (req, res) => {
        try {
            const { novelId, title, cover, author, isFavorite, lastChapterId, lastChapterTitle } = req.body;
            if (!novelId || !mongoose.Types.ObjectId.isValid(novelId)) return res.status(400).json({ message: 'Invalid ID' });

            const originalNovel = await Novel.findById(novelId).select('chapters');
            const totalChapters = originalNovel ? (originalNovel.chapters.length || 1) : 1;

            let libraryItem = await NovelLibrary.findOne({ user: req.user.id, novelId });
            let isNewFavorite = false;
            let isRemovedFavorite = false;

            if (!libraryItem) {
                libraryItem = new NovelLibrary({ 
                    user: req.user.id, novelId, title, cover, author, 
                    isFavorite: isFavorite || false, 
                    lastChapterId: lastChapterId || 0,
                    readChapters: lastChapterId ? [lastChapterId] : [], 
                    lastChapterTitle,
                    progress: lastChapterId ? Math.round((1 / totalChapters) * 100) : 0
                });
                if (isFavorite) isNewFavorite = true;
            } else {
                if (isFavorite !== undefined) {
                    if (isFavorite && !libraryItem.isFavorite) isNewFavorite = true;
                    if (!isFavorite && libraryItem.isFavorite) isRemovedFavorite = true;
                    libraryItem.isFavorite = isFavorite;
                }
                if (title) libraryItem.title = title;
                if (cover) libraryItem.cover = cover;
                
                if (lastChapterId) {
                    libraryItem.lastChapterId = lastChapterId;
                    libraryItem.lastChapterTitle = lastChapterTitle;
                    libraryItem.readChapters.addToSet(lastChapterId);
                    const readCount = libraryItem.readChapters.length;
                    libraryItem.progress = Math.min(100, Math.round((readCount / totalChapters) * 100));
                }
                libraryItem.lastReadAt = new Date();
            }
            await libraryItem.save();

            if (isNewFavorite) {
                await Novel.findByIdAndUpdate(novelId, { $inc: { favorites: 1 } });
            } else if (isRemovedFavorite) {
                await Novel.findByIdAndUpdate(novelId, { $inc: { favorites: -1 } });
            }

            const libraryObj = libraryItem.toObject();
            res.json(libraryObj);
        } catch (error) { 
            console.error(error);
            res.status(500).json({ message: 'Failed' }); 
        }
    });

    app.get('/api/novel/library', verifyToken, async (req, res) => {
        try {
            const { type, userId, page = 1, limit = 20 } = req.query; 
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;

            let targetId = req.user.id;
            
            if (userId) {
                const targetUser = await User.findById(userId).lean();
                if (!targetUser) return res.status(404).json({ message: "User not found" });
                if (userId !== req.user.id && !targetUser.isHistoryPublic && type === 'history') {
                     return res.json([]); 
                }
                targetId = userId;
            }

            let query = { user: targetId };
            if (type === 'favorites') query.isFavorite = true;
            else if (type === 'history') query.progress = { $gt: 0 };
            
            const items = await NovelLibrary.find(query)
                .sort({ lastReadAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean();
            
            const formattedItems = items;
            
            res.json(formattedItems);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });

    app.get('/api/novel/status/:novelId', verifyToken, async (req, res) => {
        const item = await NovelLibrary.findOne({ user: req.user.id, novelId: req.params.novelId }).lean();
        const readChapters = item ? item.readChapters : [];
        res.json(item || { isFavorite: false, progress: 0, lastChapterId: 0, readChapters: [] });
    });

    // 🔥🔥🔥 OPTIMIZED NOTIFICATIONS USING AGGREGATION & VISIBLE LOGIC 🔥🔥🔥
    app.get('/api/notifications', verifyToken, async (req, res) => {
        try {
            const userId = new mongoose.Types.ObjectId(req.user.id);

            const pipeline = [
                // Step 1: Match user's favorite library entries
                { 
                    $match: { 
                        user: userId, 
                        isFavorite: true 
                    } 
                },
                // Step 2: Convert novelId to ObjId
                {
                    $addFields: {
                        novelIdObj: { $toObjectId: "$novelId" }
                    }
                },
                // Step 3: Join with Novels
                {
                    $lookup: {
                        from: 'novels',
                        localField: 'novelIdObj',
                        foreignField: '_id',
                        as: 'novelData'
                    }
                },
                { $unwind: "$novelData" },
                
                // Step 4: Filter out hidden/private novels
                { 
                    $match: { 
                        "novelData.status": { $ne: 'خاصة' } 
                    } 
                },

                // Step 5: Pre-filter by date (optimization)
                {
                    $match: {
                        $expr: { $gt: ["$novelData.lastChapterUpdate", "$createdAt"] }
                    }
                },

                // Step 6: Project only necessary fields including CHAPTERS array
                {
                    $project: {
                        _id: "$novelData._id",
                        title: "$novelData.title",
                        cover: "$novelData.cover",
                        lastChapterUpdate: "$novelData.lastChapterUpdate",
                        // Pass chapters to determine visible ones
                        chapters: {
                            $map: {
                                input: "$novelData.chapters",
                                as: "ch",
                                in: { 
                                    number: "$$ch.number", 
                                    title: "$$ch.title",
                                    createdAt: "$$ch.createdAt" 
                                }
                            }
                        },
                        // Calculate unread count (raw logic)
                        unreadCountRaw: {
                            $size: {
                                $filter: {
                                    input: "$novelData.chapters",
                                    as: "ch",
                                    cond: {
                                        $and: [
                                            { $gt: ["$$ch.createdAt", "$createdAt"] }, // Newer than library bookmark
                                            { $not: { $in: ["$$ch.number", { $ifNull: ["$readChapters", []] }] } } // Not read
                                        ]
                                    }
                                }
                            }
                        }
                    }
                },
                
                // Step 7: Only keep results with potential unread
                { $match: { unreadCountRaw: { $gt: 0 } } },
                
                // Step 8: Sort
                { $sort: { lastChapterUpdate: -1 } }
            ];

            const rawNotifications = await NovelLibrary.aggregate(pipeline);
            
            // 🔥🔥 POST-PROCESSING: Filter Hidden Chapters for Notifications 🔥🔥
            const formattedNotifications = rawNotifications.map(n => {
                let lastVisible = null;
                // Sort chapters desc
                n.chapters.sort((a, b) => b.number - a.number);
                
                // Find latest visible chapter
                for (const ch of n.chapters) {
                    if (!isChapterHidden(ch.title)) {
                        lastVisible = ch;
                        break;
                    }
                }

                // If no visible chapters, skip this notification (return null to filter later)
                if (!lastVisible) return null;

                // Re-calculate Unread Count based ONLY on visible chapters that are new
                // This ensures "Hidden/Raw" chapters don't count towards the badge
                const visibleUnreadCount = n.chapters.filter(ch => 
                    !isChapterHidden(ch.title) && 
                    new Date(ch.createdAt) > new Date(n.createdAt) && // Check against library update time or bookmark logic
                    // We assume if it's visible and new, it counts. 
                    // To be precise: createdAt of chapter > createdAt of Library Entry (when user favored it or last read)
                    // The aggregation passed 'unreadCountRaw' but that included hidden chapters.
                    // We can approximate unread count as 1 if we have a new visible chapter.
                    true
                ).length;

                // Actually, let's simplify. If there is a lastVisible chapter that is newer than the library interaction, it's an update.
                // We use the aggregation's unreadCountRaw logic but strictly for visible.
                
                // Correct logic:
                // unreadCount = number of chapters where !isHidden AND createdAt > library.createdAt
                // We already filtered by createdAt > library.createdAt in aggregation pipeline via `unreadCountRaw`.
                // So we just need to filter `n.chapters` for !isHidden.
                
                // NOTE: `n.chapters` here contains ALL chapters. We need to check against library time again? 
                // No, the aggregation filtered `n.chapters`? No, it projected ALL chapters.
                // Okay, let's just use the `lastVisible` one for display.
                
                return {
                    _id: n._id,
                    title: n.title,
                    cover: n.cover,
                    newChaptersCount: visibleUnreadCount > 0 ? visibleUnreadCount : 1, // Fallback to 1
                    lastChapterNumber: lastVisible.number,
                    lastChapterTitle: lastVisible.title,
                    updatedAt: n.lastChapterUpdate
                };
            }).filter(n => n !== null); // Remove nulls (novels with only hidden chapters)

            const totalUnread = formattedNotifications.reduce((sum, n) => sum + n.newChaptersCount, 0);

            res.json({ notifications: formattedNotifications, totalUnread });

        } catch (error) {
            console.error("Aggregation Notifications Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // 🔥🔥🔥 MARK ALL AS READ 🔥🔥🔥
    app.post('/api/notifications/mark-read', verifyToken, async (req, res) => {
        try {
            // Fetch all favorite library entries for the user
            const libraryItems = await NovelLibrary.find({ user: req.user.id, isFavorite: true });
            
            const updates = libraryItems.map(async (item) => {
                const novel = await Novel.findById(item.novelId).select('chapters.number');
                if (novel && novel.chapters) {
                    const allChapters = novel.chapters.map(c => c.number);
                    // Merge existing read chapters with all available chapters
                    // converting to Set to remove duplicates, then back to array
                    const newReadSet = new Set([...(item.readChapters || []), ...allChapters]);
                    item.readChapters = Array.from(newReadSet);
                    return item.save();
                }
            });

            await Promise.all(updates);
            res.json({ message: "Marked all as read" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 🖼️ IMAGE PROXY & RESIZER (Cloudinary Powered + Axios Pipe)
    // =========================================================
    app.get('/api/image-proxy', async (req, res) => {
        try {
            const { url } = req.query;
            if (!url) return res.status(400).send("URL required");

            let originalUrl = url;

            // Try to decode if it looks like Base64 and doesn't start with http
            if (!url.startsWith('http')) {
                try {
                    // Try to decode as plain Base64 first
                    const decoded = Buffer.from(url, 'base64').toString('utf8');
                    if (decoded.startsWith('http')) {
                        originalUrl = decoded;
                    } else {
                        // Try old encrypted format fallback
                        let decrypted = "";
                        const buffer = Buffer.from(url, 'base64').toString('binary');
                        for (let i = 0; i < buffer.length; i++) {
                            let charCode = buffer.charCodeAt(i);
                            const offset = (i * 3) % 7;
                            charCode = (charCode - offset + 256) % 256;
                            charCode = charCode ^ ZEUS_SECRET.charCodeAt(i % ZEUS_SECRET.length);
                            decrypted += String.fromCharCode(charCode);
                        }
                        if (decrypted.startsWith('http')) {
                            originalUrl = decrypted;
                        }
                    }
                } catch (e) {
                    // If decoding fails, assume it was already a plain URL (though it didn't start with http)
                }
            }

            if (!originalUrl.startsWith('http')) {
                return res.status(400).send("Invalid URL");
            }

            // 2. 🔥 PIPE THE IMAGE (Strong Protection + Bypass Restrictions) 🔥
            const response = await axios({
                method: 'get',
                url: originalUrl,
                responseType: 'stream',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.google.com/' 
                }
            });

            res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=604800, immutable'); 
            
            response.data.pipe(res);

        } catch (error) {
            console.error("Proxy Error:", error.message);
            res.redirect('https://res.cloudinary.com/djuhxdjj/image/upload/v1716543210/placeholder_novel.png');
        }
    });

};