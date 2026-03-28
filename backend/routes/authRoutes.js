
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/user.model.js');
const Settings = require('../models/settings.model.js');

// 🔥 قائمة الأدمن المسموح بهم حصراً
const ADMIN_EMAILS = ["flaf.aboode@gmail.com", "zeus", "zeus@gmail.com"];

// 🔥 Helper for URL Obfuscation (Genius Level Protection)
const ZEUS_SECRET = "Z3uS_N0v3l_2026_S3cr3t_K3y";
function obfuscateUrl(url) {
    if (!url) return "";
    try {
        let result = "";
        for (let i = 0; i < url.length; i++) {
            result += String.fromCharCode(url.charCodeAt(i) ^ ZEUS_SECRET.charCodeAt(i % ZEUS_SECRET.length));
        }
        return Buffer.from(result).toString('base64');
    } catch (e) {
        return url;
    }
}

// Helper: Hash Password
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

module.exports = function(app, verifyToken) {

    // =========================================================
    // 🟢 تسجيل حساب جديد (STRICT SIGNUP)
    // =========================================================
    app.post('/auth/signup', async (req, res) => {
        try {
            const { name, email, password } = req.body;

            // 1. Validation Rules
            if (!name || !email || !password) {
                return res.status(400).json({ message: "جميع الحقول مطلوبة" });
            }

            const lowerEmail = email.toLowerCase();

            // Email Validation: Ends with @gmail.com, Prefix > 4 English letters
            const emailRegex = /^[a-zA-Z]{5,}@gmail\.com$/;
            if (!emailRegex.test(lowerEmail)) {
                return res.status(400).json({ 
                    message: "البريد الإلكتروني يجب أن ينتهي بـ @gmail.com ويتكون الاسم قبله من أكثر من 4 حروف إنجليزية فقط." 
                });
            }

            // Password Validation: Min 4 chars, English letters, numbers, @ only
            const passwordRegex = /^[a-zA-Z0-9@]{4,}$/;
            if (!passwordRegex.test(password)) {
                return res.status(400).json({ 
                    message: "كلمة المرور يجب أن تكون 4 خانات على الأقل وتحتوي فقط على حروف إنجليزية، أرقام، أو رمز @" 
                });
            }

            // 2. Check Uniqueness
            const existingUser = await User.findOne({ 
                $or: [{ email: lowerEmail }, { name: name }] 
            });
            
            if (existingUser) {
                if (existingUser.email === lowerEmail) {
                    return res.status(400).json({ message: "البريد الإلكتروني مستخدم بالفعل." });
                }
                return res.status(400).json({ message: "اسم المستخدم موجود بالفعل." });
            }

            // 3. Create User
            const localId = `local_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            let role = 'user';
            if (ADMIN_EMAILS.includes(lowerEmail)) role = 'admin';

            const newUser = new User({
                googleId: localId,
                email: lowerEmail,
                name: name,
                password: hashPassword(password), // Storing Hashed Password
                role: role,
                picture: '', 
                createdAt: new Date()
            });

            await newUser.save();
            await new Settings({ user: newUser._id }).save();

            // 4. Generate Token
            const payload = { id: newUser._id, googleId: newUser.googleId, name: newUser.name, email: newUser.email, role: newUser.role };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });

            const userObj = newUser.toObject();
            userObj.picture = obfuscateUrl(userObj.picture);
            userObj.banner = obfuscateUrl(userObj.banner);

            res.json({ token, user: userObj });

        } catch (error) {
            console.error("Signup Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 🔵 تسجيل الدخول (STRICT LOGIN)
    // =========================================================
    app.post('/auth/login', async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ message: "البريد الإلكتروني وكلمة المرور مطلوبان" });

            const lowerEmail = email.toLowerCase();

            // 1. Find User by Email
            const user = await User.findOne({ email: lowerEmail });
            
            if (!user) {
                // IMPORTANT: Return 404 so frontend knows to prompt signup
                return res.status(404).json({ message: "الحساب غير موجود." });
            }

            // 2. Verify Password
            if (!user.password) {
                return res.status(400).json({ message: "هذا الحساب مسجل عبر Google، يرجى الدخول باستخدامه." });
            }

            const hashedInput = hashPassword(password);
            
            // STRICT CHECK: Hashes MUST MATCH EXACTLY
            if (user.password !== hashedInput) {
                return res.status(401).json({ message: "كلمة المرور غير صحيحة." });
            }

            // 3. Generate Token if successful
            const payload = { id: user._id, googleId: user.googleId, name: user.name, email: user.email, role: user.role };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });
            
            const userObj = user.toObject();
            userObj.picture = obfuscateUrl(userObj.picture);
            userObj.banner = obfuscateUrl(userObj.banner);

            res.json({ token, user: userObj });

        } catch (error) {
            console.error("Login Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 🔐 إدارة كلمة المرور (CHANGE/CREATE PASSWORD)
    // =========================================================
    app.put('/auth/password', verifyToken, async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body;
            const user = await User.findById(req.user.id);

            if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

            // 1. إذا كان المستخدم يملك كلمة مرور بالفعل (حساب عادي)، يجب التحقق منها
            if (user.password) {
                if (!currentPassword) {
                    return res.status(400).json({ message: "يرجى إدخال كلمة المرور الحالية" });
                }
                const hashedCurrent = hashPassword(currentPassword);
                if (user.password !== hashedCurrent) {
                    return res.status(401).json({ message: "كلمة المرور الحالية غير صحيحة" });
                }
            }
            // إذا لم يكن لديه كلمة مرور (Google)، لا نطلب كلمة المرور الحالية، نسمح له بالإنشاء مباشرة

            // 2. التحقق من شروط كلمة المرور الجديدة
            const passwordRegex = /^[a-zA-Z0-9@]{4,}$/;
            if (!passwordRegex.test(newPassword)) {
                return res.status(400).json({ 
                    message: "كلمة المرور يجب أن تكون 4 خانات على الأقل وتحتوي فقط على حروف إنجليزية، أرقام، أو رمز @" 
                });
            }

            // 3. تحديث كلمة المرور
            user.password = hashPassword(newPassword);
            await user.save();

            res.json({ message: "تم تحديث كلمة المرور بنجاح", user });

        } catch (error) {
            console.error("Password Update Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 🌐 GOOGLE AUTH ROUTES
    // =========================================================
    const oauth2Client = new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        "https://backend-moon-lilac.vercel.app/auth/google/callback" 
    );

    app.get('/auth/google', (req, res) => {
        const redirectUri = req.query.redirect_uri;
        const platform = req.query.platform;
        let state = redirectUri || (platform === 'mobile' ? 'mobile' : 'web');
        const authorizeUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
            state: state 
        });
        res.redirect(authorizeUrl);
    });

    app.get('/auth/google/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);
            const userInfoResponse = await oauth2Client.request({ url: 'https://www.googleapis.com/oauth2/v3/userinfo' });
            const userInfo = userInfoResponse.data;
            
            let user = await User.findOne({ googleId: userInfo.sub });
            let role = 'user';
            const lowerEmail = userInfo.email.toLowerCase();
            
            if (ADMIN_EMAILS.includes(lowerEmail)) role = 'admin';
            
            if (!user) {
                let proposedName = userInfo.name;
                let counter = 1;
                while(await User.findOne({ name: proposedName })) {
                    proposedName = `${userInfo.name}_${counter}`;
                    counter++;
                }
                user = new User({
                    googleId: userInfo.sub,
                    email: userInfo.email,
                    name: proposedName,
                    picture: userInfo.picture,
                    role: role,
                    createdAt: new Date() 
                });
                await user.save();
                await new Settings({ user: user._id }).save();
            } else {
                 if (role === 'admin' && user.role !== 'admin') {
                    user.role = 'admin';
                    await user.save();
                }
            }
            const payload = { id: user._id, googleId: user.googleId, name: user.name, email: user.email, role: user.role };
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });
            
            if (state && state.startsWith('exp://')) {
                const separator = state.includes('?') ? '&' : '?';
                res.redirect(`${state}${separator}token=${token}`);
            } else if (state === 'mobile' || state.startsWith('aplcionszeus://')) {
                const deepLink = state === 'mobile' ? `aplcionszeus://auth?token=${token}` : `${state}?token=${token}`;
                res.redirect(deepLink);
            } else {
                res.redirect(`https://backend-moon-lilac.vercel.app/?token=${token}`);
            }
        } catch (error) {
            console.error('Auth error:', error);
            res.redirect('https://backend-moon-lilac.vercel.app/?auth_error=true');
        }
    });

    // =========================================================
    // 👤 GET USER API
    // =========================================================
    app.get('/api/user', verifyToken, async (req, res) => {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });
        
        const userObj = user.toObject();
        userObj.picture = obfuscateUrl(userObj.picture);
        userObj.banner = obfuscateUrl(userObj.banner);

        res.json({ loggedIn: true, user: userObj });
    });
};
