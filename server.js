const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const multer = require("multer");
const fetch = require("node-fetch");
const sharp = require("sharp");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// إنشاء مجلدات
const downloadsDir = path.join(__dirname, 'public', 'downloads');
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const sessionsDir = path.join(__dirname, '.wwebjs_auth');
const cacheDir = path.join(__dirname, 'public', 'cache');
const avatarsDir = path.join(__dirname, 'public', 'avatars');

[downloadsDir, uploadsDir, sessionsDir, cacheDir, avatarsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// إعداد multer للرفع - قبول جميع أنواع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uniqueName + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // قبول جميع أنواع الملفات
    cb(null, true);
  }
});

/* ================= DATABASE ================= */
const getDatabaseConfig = () => {
  const connectionString = process.env.DATABASE_URL || "postgres://postgres:6DQNh71sjOwHWwi5VYvGGZDtx5GpsdXRz6DWQKb7mBy9fwHNTn9X21yAJy05A14v@31.97.47.20:5433/postgres";
  
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: url.pathname.replace('/', ''),
    user: url.username,
    password: url.password,
    ssl: {
      rejectUnauthorized: false,
      require: true
    }
  };
};

const pool = new Pool(getDatabaseConfig());

// دالة لتحديث هيكل قاعدة البيانات
async function updateDatabaseSchema() {
  try {
    console.log("🔄 جاري تحديث هيكل قاعدة البيانات...");
    
    // التحقق من وجود عمود display_name في جدول zzapp_chats وإضافته إذا لم يكن موجوداً
    const checkColumnQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'zzapp_chats' AND column_name = 'display_name'
    `;
    
    const result = await pool.query(checkColumnQuery);
    
    if (result.rows.length === 0) {
      console.log("➕ إضافة عمود display_name إلى جدول zzapp_chats...");
      await pool.query(`
        ALTER TABLE zzapp_chats 
        ADD COLUMN display_name TEXT
      `);
      console.log("✅ تم إضافة عمود display_name");
    }
    
    // التحقق من وجود عمود pic_cached وإضافته إذا لم يكن موجوداً
    const checkPicCachedQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'zzapp_chats' AND column_name = 'pic_cached'
    `;
    
    const picCachedResult = await pool.query(checkPicCachedQuery);
    
    if (picCachedResult.rows.length === 0) {
      console.log("➕ إضافة عمود pic_cached إلى جدول zzapp_chats...");
      await pool.query(`
        ALTER TABLE zzapp_chats 
        ADD COLUMN pic_cached BOOLEAN DEFAULT false
      `);
      console.log("✅ تم إضافة عمود pic_cached");
    }
    
    console.log("✅ تم تحديث هيكل قاعدة البيانات بنجاح");
  } catch (error) {
    console.error("❌ خطأ في تحديث هيكل قاعدة البيانات:", error.message);
  }
}

// إعداد قاعدة البيانات
async function setupDatabase() {
  try {
    console.log("🔧 جاري إعداد قاعدة البيانات...");
    
    const client = await pool.connect();
    console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');
    
    // إنشاء الجداول
    await pool.query(`
      CREATE TABLE IF NOT EXISTS zzapp_sessions (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        user_data JSONB,
        last_active TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS zzapp_chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        display_name TEXT,
        number TEXT,
        about TEXT,
        pic TEXT,
        pic_cached BOOLEAN DEFAULT false,
        last_message TEXT,
        message_count INTEGER DEFAULT 0,
        unread_count INTEGER DEFAULT 0,
        last_time TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_group BOOLEAN DEFAULT false,
        is_pinned BOOLEAN DEFAULT false,
        session_id TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS zzapp_messages (
        id SERIAL PRIMARY KEY,
        chat_id TEXT,
        message_id TEXT UNIQUE,
        session_id TEXT,
        sender_id TEXT,
        sender_name TEXT,
        sender_number TEXT,
        content TEXT,
        media_url TEXT,
        media_type TEXT,
        media_size INTEGER,
        media_name TEXT,
        is_from_me BOOLEAN DEFAULT false,
        timestamp TIMESTAMP DEFAULT NOW(),
        delivered BOOLEAN DEFAULT false,
        read_receipt BOOLEAN DEFAULT false
      )
    `);

    // تحديث هيكل قاعدة البيانات
    await updateDatabaseSchema();

    // إنشاء الفهارس
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_chats_session ON zzapp_chats(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON zzapp_messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON zzapp_messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON zzapp_messages(timestamp);
      `);
    } catch (indexError) {
      console.log("⚠️ خطأ في إنشاء الفهارس:", indexError.message);
    }

    client.release();
    console.log("✅ تم إعداد قاعدة البيانات بنجاح");
  } catch (error) {
    console.error("❌ خطأ في إعداد قاعدة البيانات:", error.message);
  }
}

// إعداد قاعدة البيانات مع إعادة المحاولة
async function setupDatabaseWithRetry(retries = 3, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      await setupDatabase();
      return;
    } catch (error) {
      console.log(`⚠️ محاولة ${i + 1}/${retries} فشلت، إعادة المحاولة بعد ${delay/1000} ثواني...`);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.log("⚠️ استمرار التطبيق بدون اتصال بقاعدة البيانات");
}

setupDatabaseWithRetry();

/* ================= WHATSAPP ================= */
let qrCode = null;
let isReady = false;
let client = null;
let userInfo = null;
let currentSessionId = null;
let sessionRestoreAttempted = false;

// دالة لاستخراج الرقم من ID
function extractNumberFromId(contactId) {
  if (!contactId) return "جهة اتصال";
  
  if (contactId.includes('@g.us')) {
    return "مجموعة";
  }
  
  if (contactId.includes('@lid')) {
    return "جهة اتصال";
  }
  
  let number = contactId
    .replace('@c.us', '')
    .replace('@lid', '')
    .replace('@g.us', '')
    .replace('@s.whatsapp.net', '')
    .replace('+', '');
  
  return number || "جهة اتصال";
}

// دالة لتنظيف الاسم
function cleanDisplayName(name, contactId) {
  if (!name) return extractNumberFromId(contactId);
  
  // إذا كان الاسم هو نفس الرقم الطويل، نعود الرقم المختصر
  if (name.replace(/[@\.]/g, '') === contactId.replace(/[@\.]/g, '')) {
    return extractNumberFromId(contactId);
  }
  
  // إزالة البادئة إذا كانت موجودة
  const cleanName = name.replace(/^\d+@/, '');
  
  return cleanName || extractNumberFromId(contactId);
}

// دالة لتحويل الصور إلى صيغة 3gp مخففة الجودة
async function convertTo3GP(imageBuffer) {
  try {
    // تحويل الصورة إلى JPEG بجودة 30% ثم إعادة تسميتها كـ 3gp
    const convertedBuffer = await sharp(imageBuffer)
      .jpeg({ quality: 30 })
      .toBuffer();
    
    return convertedBuffer;
  } catch (error) {
    console.log("⚠️ خطأ في تحويل الصورة، استخدام النسخة الأصلية:", error.message);
    return imageBuffer;
  }
}

// دالة للحصول على معلومات جهة الاتصال
async function getContactInfo(contactId) {
  try {
    if (!client) return null;
    
    let name = extractNumberFromId(contactId);
    let about = "";
    let pic = null;
    let displayName = name;
    let isGroup = contactId.includes('@g.us');
    
    try {
      const chat = await client.getChatById(contactId);
      if (chat) {
        name = chat.name || chat.pushname || name;
        displayName = cleanDisplayName(name, contactId);
        
        if (chat.isGroup) {
          isGroup = true;
          displayName = name;
        }
      }
    } catch (e) {
      console.log("⚠️ لا يمكن الحصول على معلومات المحادثة:", e.message);
    }
    
    // محاولة الحصول على صورة الملف الشخصي
    try {
      const profilePicUrl = await client.getProfilePicUrl(contactId);
      if (profilePicUrl) {
        const cacheFileName = `profile_${contactId.replace(/[@\.]/g, '_')}.3gp`;
        const cachePath = path.join(cacheDir, cacheFileName);
        const avatarPath = path.join(avatarsDir, cacheFileName);
        
        // التحقق من وجود صورة مخبأة
        if (fs.existsSync(cachePath)) {
          const stats = fs.statSync(cachePath);
          const now = new Date();
          const cacheAge = now - stats.mtime;
          
          // تحديث الصورة إذا كانت عمرها أكثر من 24 ساعة
          if (cacheAge > 86400000) {
            await downloadAndCacheImage(profilePicUrl, cachePath, avatarPath);
          }
          pic = `/cache/${cacheFileName}`;
        } else if (fs.existsSync(avatarPath)) {
          pic = `/avatars/${cacheFileName}`;
        } else {
          await downloadAndCacheImage(profilePicUrl, cachePath, avatarPath);
          pic = `/cache/${cacheFileName}`;
        }
      }
    } catch (e) {
      // تجاهل الخطأ إذا لم توجد صورة
    }
    
    return {
      id: contactId,
      name: name,
      display_name: displayName,
      number: extractNumberFromId(contactId),
      about: about,
      pic: pic,
      is_group: isGroup,
      pic_cached: !!pic
    };
  } catch (e) {
    console.log("⚠️ خطأ في الحصول على معلومات جهة الاتصال:", e.message);
    return {
      id: contactId,
      name: extractNumberFromId(contactId),
      display_name: extractNumberFromId(contactId),
      number: extractNumberFromId(contactId),
      about: "",
      pic: null,
      is_group: contactId.includes('@g.us'),
      pic_cached: false
    };
  }
}

// دالة لتنزيل وتخزين الصور
async function downloadAndCacheImage(url, cachePath, avatarPath = null) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('فشل تحميل الصورة');
    
    const buffer = await response.buffer();
    
    // تحويل الصورة إلى 3gp مخففة الجودة
    const convertedBuffer = await convertTo3GP(buffer);
    
    // حفظ في مجلد الكاش
    fs.writeFileSync(cachePath, convertedBuffer);
    
    // حفظ نسخة في مجلد الأفاتار
    if (avatarPath) {
      fs.writeFileSync(avatarPath, convertedBuffer);
    }
    
    return true;
  } catch (error) {
    console.log("⚠️ خطأ في تخزين الصورة:", error.message);
    return false;
  }
}

// دالة للحصول على معلومات المستخدم
async function getUserInfo() {
  try {
    if (!client) return null;
    
    const info = client.info;
    if (!info) {
      return {
        id: 'unknown',
        name: "المستخدم",
        display_name: "المستخدم",
        number: 'unknown',
        about: "",
        pic: null,
        pic_cached: false
      };
    }
    
    // محاولة الحصول على صورة المستخدم
    let pic = null;
    try {
      const profilePicUrl = await client.getProfilePicUrl(info.wid._serialized);
      if (profilePicUrl) {
        const cacheFileName = `user_${info.wid.user}.3gp`;
        const cachePath = path.join(cacheDir, cacheFileName);
        const avatarPath = path.join(avatarsDir, cacheFileName);
        
        if (fs.existsSync(cachePath)) {
          pic = `/cache/${cacheFileName}`;
        } else if (fs.existsSync(avatarPath)) {
          pic = `/avatars/${cacheFileName}`;
        } else {
          await downloadAndCacheImage(profilePicUrl, cachePath, avatarPath);
          pic = `/cache/${cacheFileName}`;
        }
      }
    } catch (e) {
      // تجاهل الخطأ
    }
    
    return {
      id: info.wid._serialized,
      name: info.pushname || info.me?.name || "المستخدم",
      display_name: info.pushname || info.me?.name || "المستخدم",
      number: info.wid.user || 'unknown',
      about: "",
      pic: pic,
      pic_cached: !!pic
    };
  } catch (e) {
    console.log("⚠️ خطأ في الحصول على معلومات المستخدم:", e.message);
    return {
      id: "unknown",
      name: "المستخدم",
      display_name: "المستخدم",
      number: "unknown",
      about: "",
      pic: null,
      pic_cached: false
    };
  }
}

// دالة لاستعادة الجلسة من قاعدة البيانات
async function restoreSession() {
  try {
    console.log("🔍 جاري البحث عن جلسة نشطة...");
    
    // البحث عن أحدث جلسة
    const result = await pool.query(
      "SELECT * FROM zzapp_sessions ORDER BY last_active DESC LIMIT 1"
    );
    
    if (result.rows.length > 0) {
      const session = result.rows[0];
      console.log(`🔄 وجدت جلسة سابقة: ${session.session_id}`);
      
      // التحقق من أن الجلسة حديثة (أقل من 24 ساعة)
      const lastActive = new Date(session.last_active);
      const now = new Date();
      const hoursDiff = (now - lastActive) / (1000 * 60 * 60);
      
      if (hoursDiff < 24) {
        currentSessionId = session.session_id;
        console.log("✅ جلسة حديثة، سيتم استعادتها");
        
        // تحديث وقت الجلسة
        await pool.query(
          `UPDATE zzapp_sessions SET last_active = NOW() WHERE session_id = $1`,
          [currentSessionId]
        );
        
        return session.session_id;
      } else {
        console.log("⚠️ الجلسة قديمة (أكثر من 24 ساعة)، سيتم إنشاء جلسة جديدة");
      }
    }
    
    console.log("❌ لا توجد جلسة حديثة للاستعادة");
    return null;
  } catch (error) {
    console.error("❌ خطأ في استعادة الجلسة:", error.message);
    return null;
  }
}

// دالة لتهيئة واتساب مع إعادة المحاولة
async function initWhatsApp(sessionId = null) {
  return new Promise(async (resolve, reject) => {
    console.log("🔧 جاري تشغيل واتساب...");

    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        console.log("⚠️ خطأ في تدمير العميل السابق:", e.message);
      }
    }

    // استعادة الجلسة إذا لم يتم توفير واحدة
    if (!sessionId && !sessionRestoreAttempted) {
      sessionId = await restoreSession();
      sessionRestoreAttempted = true;
    }
    
    currentSessionId = sessionId || `session_${Date.now()}`;
    console.log(`🆔 معرف الجلسة: ${currentSessionId}`);

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "zzapp-client",
        dataPath: sessionsDir
      }),
      puppeteer: {
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--disable-features=site-per-process',
          '--window-size=1920,1080',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--disable-blink-features=AutomationControlled'
        ],
        ignoreHTTPSErrors: true,
        timeout: 60000
      },
      takeoverOnConflict: false,
      takeoverTimeoutMs: 0
    });

    client.on("qr", async (qr) => {
      console.log("📱 يوجد كود QR");
      try {
        qrCode = await QRCode.toDataURL(qr);
        
        try {
          await pool.query(
            `INSERT INTO zzapp_sessions (session_id, last_active, created_at)
             VALUES ($1, NOW(), NOW())
             ON CONFLICT (session_id) 
             DO UPDATE SET last_active = NOW()`,
            [currentSessionId]
          );
        } catch (dbError) {
          console.log("⚠️ خطأ في حفظ الجلسة:", dbError.message);
        }
        
        io.emit("qr", { qr: qrCode, sessionId: currentSessionId });
      } catch (e) {
        console.log("❌ خطأ في إنشاء QR:", e.message);
      }
    });

    client.on("authenticated", async () => {
      console.log("✅ تم تسجيل الدخول");
      qrCode = null;
      
      try {
        await pool.query(
          `UPDATE zzapp_sessions SET last_active = NOW() WHERE session_id = $1`,
          [currentSessionId]
        );
      } catch (e) {
        console.log("⚠️ خطأ في تحديث الجلسة:", e.message);
      }
    });

    client.on("ready", async () => {
      console.log("🚀 واتساب جاهز للاستخدام");
      isReady = true;
      qrCode = null;
      
      try {
        userInfo = await getUserInfo();
        console.log("👤 معلومات المستخدم:", userInfo.name);
        
        try {
          await pool.query(
            `UPDATE zzapp_sessions SET user_data = $1 WHERE session_id = $2`,
            [JSON.stringify(userInfo), currentSessionId]
          );
        } catch (e) {
          console.log("⚠️ خطأ في حفظ معلومات المستخدم:", e.message);
        }
        
        io.emit("user_info", userInfo);
      } catch (e) {
        console.log("⚠️ خطأ في الحصول على معلومات المستخدم:", e.message);
        userInfo = {
          id: "unknown",
          name: "المستخدم",
          display_name: "المستخدم",
          number: "unknown",
          about: "",
          pic: null,
          pic_cached: false
        };
        io.emit("user_info", userInfo);
      }
      
      io.emit("ready", { sessionId: currentSessionId });
      
      // تحميل المحادثات
      try {
        const chatsRes = await pool.query(
          "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 200",
          [currentSessionId]
        );
        io.emit("chats", chatsRes.rows);
      } catch (e) {
        console.log("⚠️ خطأ في تحميل المحادثات:", e.message);
        io.emit("chats", []);
      }
      
      resolve();
    });

    client.on("message", async (msg) => {
      try {
        let chatId = msg.id.remote || msg.from;
        let isGroup = chatId.includes('@g.us');
        let contactInfo = await getContactInfo(chatId);
        
        // معالجة الوسائط
        let mediaUrl = null;
        let mediaType = null;
        let mediaSize = 0;
        let mediaName = null;

        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              const timestamp = Date.now();
              let fileName = '';
              let ext = '';
              
              if (msg.type === 'image') {
                mediaType = 'image';
                ext = '.jpg';
                fileName = `img_${timestamp}${ext}`;
              } else if (msg.type === 'audio' || msg.type === 'ptt') {
                mediaType = 'audio';
                ext = '.ogg';
                fileName = `audio_${timestamp}${ext}`;
              } else if (msg.type === 'video') {
                mediaType = 'video';
                ext = '.mp4';
                fileName = `video_${timestamp}${ext}`;
              } else if (msg.type === 'document') {
                mediaType = 'document';
                ext = path.extname(msg.mediaFilename || 'file.bin');
                fileName = `doc_${timestamp}${ext}`;
              } else {
                mediaType = msg.type;
                fileName = `file_${timestamp}.bin`;
              }
              
              const filePath = path.join(downloadsDir, fileName);
              const buffer = Buffer.from(media.data, 'base64');
              mediaSize = buffer.length;
              
              fs.writeFileSync(filePath, buffer);
              mediaUrl = `/downloads/${fileName}`;
              mediaName = msg.mediaFilename || fileName;
            }
          } catch (e) {
            console.log("⚠️ خطأ في حفظ الوسائط:", e.message);
          }
        }

        // حفظ الرسالة
        try {
          await pool.query(
            `INSERT INTO zzapp_messages 
             (chat_id, message_id, session_id, sender_id, sender_name, sender_number, 
              content, media_url, media_type, media_size, media_name, is_from_me, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
             ON CONFLICT (message_id) DO NOTHING`,
            [chatId, 
             msg.id._serialized, 
             currentSessionId,
             msg.from,
             contactInfo.display_name,
             contactInfo.number,
             msg.body || "[وسائط]", 
             mediaUrl, 
             mediaType,
             mediaSize,
             mediaName,
             msg.fromMe]
          );
        } catch (dbError) {
          console.log("⚠️ خطأ في حفظ الرسالة:", dbError.message);
        }

        // تحديث المحادثة
        try {
          await pool.query(
            `INSERT INTO zzapp_chats (id, name, display_name, number, about, pic, pic_cached, last_message, last_time, 
              updated_at, is_group, session_id, message_count, unread_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10, 1, 
                    CASE WHEN $11 = true THEN 0 ELSE 1 END)
             ON CONFLICT (id) 
             DO UPDATE SET 
               name = COALESCE($2, zzapp_chats.name),
               display_name = COALESCE($3, zzapp_chats.display_name),
               about = COALESCE($5, zzapp_chats.about),
               pic = COALESCE($6, zzapp_chats.pic),
               pic_cached = COALESCE($7, zzapp_chats.pic_cached),
               last_message = $8,
               last_time = NOW(),
               updated_at = NOW(),
               message_count = zzapp_chats.message_count + 1,
               unread_count = CASE WHEN $11 = true THEN zzapp_chats.unread_count 
                                 ELSE zzapp_chats.unread_count + 1 END`,
            [chatId, 
             contactInfo.name,
             contactInfo.display_name,
             contactInfo.number,
             contactInfo.about,
             contactInfo.pic,
             contactInfo.pic_cached,
             msg.body || "[وسائط]",
             isGroup,
             currentSessionId,
             msg.fromMe]
          );
        } catch (dbError) {
          console.log("⚠️ خطأ في تحديث المحادثة:", dbError.message);
        }

        // إرسال تحديث للعملاء
        const chatData = { 
          id: chatId, 
          name: contactInfo.name,
          display_name: contactInfo.display_name,
          number: contactInfo.number,
          about: contactInfo.about,
          pic: contactInfo.pic,
          pic_cached: contactInfo.pic_cached,
          last_message: msg.body || "[وسائط]",
          last_time: new Date().toISOString(),
          is_group: isGroup,
          session_id: currentSessionId
        };
        
        io.emit("chat_update", chatData);

        const messageData = { 
          chat_id: chatId,
          message_id: msg.id._serialized,
          text: msg.body || "[وسائط]", 
          media: mediaUrl,
          media_type: mediaType,
          media_name: mediaName,
          timestamp: new Date().toISOString(),
          is_from_me: msg.fromMe,
          sender_name: contactInfo.display_name,
          sender_number: contactInfo.number,
          session_id: currentSessionId
        };
        
        io.emit("message", messageData);

      } catch (e) {
        console.log("❌ خطأ في معالجة الرسالة:", e.message);
      }
    });

    client.on("message_ack", async (msg, ack) => {
      try {
        await pool.query(
          `UPDATE zzapp_messages 
           SET delivered = $1, read_receipt = $2
           WHERE message_id = $3`,
          [ack >= 2, ack >= 3, msg.id._serialized]
        );
        
        io.emit("message_status", {
          message_id: msg.id._serialized,
          delivered: ack >= 2,
          read: ack >= 3
        });
      } catch (e) {
        console.log("❌ خطأ في تحديث حالة الرسالة:", e.message);
      }
    });

    client.on("disconnected", async (reason) => {
      console.log("❌ انقطع الاتصال:", reason);
      isReady = false;
      
      try {
        await pool.query(
          `UPDATE zzapp_sessions SET last_active = NOW() WHERE session_id = $1`,
          [currentSessionId]
        );
      } catch (e) {
        console.log("⚠️ خطأ في تحديث الجلسة:", e.message);
      }
      
      // إعادة التشغيل بعد 10 ثواني
      setTimeout(() => {
        console.log("🔄 إعادة تشغيل واتساب بعد انقطاع...");
        initWhatsAppWithRetry(currentSessionId);
      }, 10000);
    });

    client.on("auth_failure", (message) => {
      console.log("❌ فشل المصادقة:", message);
      isReady = false;
      reject(new Error("فشل المصادقة: " + message));
    });

    try {
      await client.initialize();
      console.log("✅ تم تشغيل واتساب بنجاح");
    } catch (error) {
      console.error("❌ فشل تشغيل واتساب:", error.message);
      reject(error);
    }
  });
}

// دالة لإعادة المحاولة مع زيادة التباعد
async function initWhatsAppWithRetry(sessionId = null, retries = 10, delay = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🔄 محاولة تشغيل واتساب (${i + 1}/${retries})...`);
      await initWhatsApp(sessionId);
      console.log("✅ نجحت محاولة تشغيل واتساب");
      return;
    } catch (error) {
      console.error(`❌ فشلت المحاولة ${i + 1}/${retries}:`, error.message);
      
      if (i < retries - 1) {
        const nextDelay = delay * (i + 1);
        console.log(`⏳ الانتظار ${nextDelay/1000} ثانية قبل المحاولة التالية...`);
        await new Promise(resolve => setTimeout(resolve, nextDelay));
      } else {
        console.error("❌ استنفذت جميع محاولات التشغيل. إعادة المحاولة بعد دقيقة...");
        setTimeout(() => {
          initWhatsAppWithRetry(sessionId, retries, delay);
        }, 60000);
        break;
      }
    }
  }
}

/* ================= SOCKET.IO ================= */
io.on("connection", async (socket) => {
  console.log("👤 مستخدم جديد متصل");

  socket.on("restore_session", async (sessionId) => {
    try {
      const sessionRes = await pool.query(
        "SELECT * FROM zzapp_sessions WHERE session_id = $1",
        [sessionId]
      );
      
      if (sessionRes.rows.length > 0) {
        const session = sessionRes.rows[0];
        
        if (session.user_data) {
          socket.emit("user_info", session.user_data);
        }
        
        try {
          const chatsRes = await pool.query(
            "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 200",
            [sessionId]
          );
          socket.emit("chats", chatsRes.rows);
        } catch (e) {
          console.log("⚠️ خطأ في تحميل المحادثات:", e.message);
          socket.emit("chats", []);
        }
        
        socket.emit("session_restored", { sessionId: sessionId });
      }
    } catch (e) {
      console.log("❌ خطأ في استعادة الجلسة:", e.message);
      socket.emit("chats", []);
    }
  });

  if (userInfo) {
    socket.emit("user_info", userInfo);
  }

  if (isReady) {
    socket.emit("ready", { sessionId: currentSessionId });
  } else if (qrCode) {
    socket.emit("qr", { qr: qrCode, sessionId: currentSessionId });
  } else {
    socket.emit("waiting");
  }

  // طلب الرسائل
  socket.on("get_messages", async (data) => {
    try {
      const { chatId, sessionId } = data;
      const messagesRes = await pool.query(
        `SELECT * FROM zzapp_messages 
         WHERE chat_id = $1 AND session_id = $2
         ORDER BY timestamp ASC
         LIMIT 100`,
        [chatId, sessionId || currentSessionId]
      );
      socket.emit("load_messages", messagesRes.rows);
    } catch (e) {
      console.log("⚠️ خطأ في تحميل الرسائل:", e.message);
      socket.emit("load_messages", []);
    }
  });

  // إرسال رسالة نصية
  socket.on("send_message", async (data) => {
    if (!isReady) {
      socket.emit("error", "واتساب غير متصل");
      return;
    }
    
    try {
      const chatId = data.to.includes('@') ? data.to : `${data.to}@c.us`;
      const message = await client.sendMessage(chatId, data.text);
      
      const contactInfo = await getContactInfo(chatId);
      
      // حفظ الرسالة
      try {
        await pool.query(
          `INSERT INTO zzapp_messages 
           (chat_id, message_id, session_id, sender_id, sender_name, sender_number, content, is_from_me, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [chatId, 
           message.id._serialized,
           currentSessionId,
           'me',
           'أنا',
           'me',
           data.text, 
           true]
        );
      } catch (dbError) {
        console.log("⚠️ خطأ في حفظ الرسالة:", dbError.message);
      }

      // تحديث المحادثة
      try {
        await pool.query(
          `INSERT INTO zzapp_chats (id, name, display_name, number, about, pic, pic_cached, last_message, last_time, updated_at, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9)
           ON CONFLICT (id) 
           DO UPDATE SET 
             name = COALESCE($2, zzapp_chats.name),
             display_name = COALESCE($3, zzapp_chats.display_name),
             about = COALESCE($5, zzapp_chats.about),
             pic = COALESCE($6, zzapp_chats.pic),
             pic_cached = COALESCE($7, zzapp_chats.pic_cached),
             last_message = $8,
             last_time = NOW(),
             updated_at = NOW(),
             message_count = COALESCE(zzapp_chats.message_count, 0) + 1`,
          [chatId, 
           contactInfo.name,
           contactInfo.display_name,
           contactInfo.number,
           contactInfo.about,
           contactInfo.pic,
           contactInfo.pic_cached,
           data.text,
           currentSessionId]
        );
      } catch (dbError) {
        console.log("⚠️ خطأ في تحديث المحادثة:", dbError.message);
      }

      const messageData = { 
        chat_id: chatId,
        message_id: message.id._serialized,
        text: data.text, 
        timestamp: new Date().toISOString(),
        is_from_me: true,
        sender_name: "أنا",
        sender_number: "me",
        session_id: currentSessionId
      };
      
      socket.emit("message", messageData);
      
      const chatData = {
        id: chatId,
        name: contactInfo.name,
        display_name: contactInfo.display_name,
        number: contactInfo.number,
        about: contactInfo.about,
        pic: contactInfo.pic,
        pic_cached: contactInfo.pic_cached,
        last_message: data.text,
        last_time: new Date().toISOString(),
        session_id: currentSessionId
      };
      
      io.emit("chat_update", chatData);

    } catch (error) {
      console.log("❌ فشل إرسال الرسالة:", error.message);
      socket.emit("error", "فشل إرسال الرسالة: " + error.message);
    }
  });

  // إرسال وسائط
  socket.on("send_media", async (data) => {
    if (!isReady) {
      socket.emit("error", "واتساب غير متصل");
      return;
    }

    try {
      const chatId = data.to.includes('@') ? data.to : `${data.to}@c.us`;
      const mediaPath = path.join(__dirname, 'public', data.filePath.replace(/^\//, ''));
      
      if (!fs.existsSync(mediaPath)) {
        socket.emit("error", "الملف غير موجود");
        return;
      }

      const stats = fs.statSync(mediaPath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      
      if (fileSizeInMB > 100) {
        socket.emit("error", "حجم الملف كبير جداً (100MB كحد أقصى)");
        return;
      }

      const media = MessageMedia.fromFilePath(mediaPath);
      
      // إرسال كرسالة صوتية إذا كان تسجيلاً صوتياً
      if (data.mediaType === 'audio' && data.isVoiceMessage) {
        media.mimetype = 'audio/ogg; codecs=opus';
        media.filename = 'voice.ogg';
      }

      const message = await client.sendMessage(chatId, media, { 
        caption: data.caption || '',
        sendAudioAsVoice: data.mediaType === 'audio' && data.isVoiceMessage
      });

      const contactInfo = await getContactInfo(chatId);

      // حفظ في قاعدة البيانات
      try {
        await pool.query(
          `INSERT INTO zzapp_messages 
           (chat_id, message_id, session_id, sender_id, sender_name, sender_number, 
            content, media_url, media_type, media_size, media_name, is_from_me, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [chatId, 
           message.id._serialized,
           currentSessionId,
           'me',
           'أنا',
           'me',
           data.caption || "[وسائط]", 
           data.filePath, 
           data.mediaType,
           stats.size,
           path.basename(mediaPath),
           true]
        );
      } catch (dbError) {
        console.log("⚠️ خطأ في حفظ الوسائط:", dbError.message);
      }

      try {
        await pool.query(
          `INSERT INTO zzapp_chats (id, name, display_name, number, about, pic, pic_cached, last_message, last_time, updated_at, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9)
           ON CONFLICT (id) 
           DO UPDATE SET 
             name = COALESCE($2, zzapp_chats.name),
             display_name = COALESCE($3, zzapp_chats.display_name),
             about = COALESCE($5, zzapp_chats.about),
             pic = COALESCE($6, zzapp_chats.pic),
             pic_cached = COALESCE($7, zzapp_chats.pic_cached),
             last_message = $8,
             last_time = NOW(),
             updated_at = NOW(),
             message_count = COALESCE(zzapp_chats.message_count, 0) + 1`,
          [chatId, 
           contactInfo.name,
           contactInfo.display_name,
           contactInfo.number,
           contactInfo.about,
           contactInfo.pic,
           contactInfo.pic_cached,
           data.caption || "[وسائط]",
           currentSessionId]
        );
      } catch (dbError) {
        console.log("⚠️ خطأ في تحديث المحادثة:", dbError.message);
      }

      const messageData = {
        chat_id: chatId,
        message_id: message.id._serialized,
        text: data.caption || "[وسائط]",
        media: data.filePath,
        media_type: data.mediaType,
        media_name: path.basename(mediaPath),
        timestamp: new Date().toISOString(),
        is_from_me: true,
        sender_name: "أنا",
        sender_number: "me",
        session_id: currentSessionId
      };
      
      socket.emit("message", messageData);
      
      const chatData = {
        id: chatId,
        name: contactInfo.name,
        display_name: contactInfo.display_name,
        number: contactInfo.number,
        about: contactInfo.about,
        pic: contactInfo.pic,
        pic_cached: contactInfo.pic_cached,
        last_message: data.caption || "[وسائط]",
        last_time: new Date().toISOString(),
        session_id: currentSessionId
      };
      
      io.emit("chat_update", chatData);

    } catch (error) {
      console.log("❌ فشل إرسال الوسائط:", error.message);
      socket.emit("error", "فشل إرسال الوسائط: " + error.message);
    }
  });

  // بدء محادثة جديدة
  socket.on("start_new_chat", async (phoneNumber) => {
    if (!isReady) {
      socket.emit("error", "واتساب غير متصل");
      return;
    }

    try {
      let cleanNumber = phoneNumber.trim().replace(/\D/g, '');
      
      if (!cleanNumber || cleanNumber.length < 10) {
        socket.emit("error", "رقم الهاتف غير صالح");
        return;
      }
      
      if (cleanNumber.length === 10 && !cleanNumber.startsWith('2')) {
        cleanNumber = '2' + cleanNumber;
      }
      
      const chatId = `${cleanNumber}@c.us`;
      
      // إرسال رسالة تجريبية
      try {
        await client.sendMessage(chatId, "مرحباً 👋");
      } catch (e) {
        console.log("⚠️ لا يمكن إرسال رسالة إلى هذا الرقم:", e.message);
      }
      
      const contactInfo = await getContactInfo(chatId);
      
      let chatData;
      
      try {
        const existing = await pool.query(
          "SELECT * FROM zzapp_chats WHERE id = $1 AND session_id = $2",
          [chatId, currentSessionId]
        );
        
        if (existing.rows.length > 0) {
          chatData = existing.rows[0];
        } else {
          await pool.query(
            `INSERT INTO zzapp_chats (id, name, display_name, number, about, pic, pic_cached, updated_at, session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
            [chatId, 
             contactInfo.name,
             contactInfo.display_name,
             cleanNumber, 
             contactInfo.about, 
             contactInfo.pic,
             contactInfo.pic_cached,
             currentSessionId]
          );
          
          const result = await pool.query(
            "SELECT * FROM zzapp_chats WHERE id = $1 AND session_id = $2",
            [chatId, currentSessionId]
          );
          chatData = result.rows[0];
        }
      } catch (dbError) {
        console.log("⚠️ خطأ في قاعدة البيانات:", dbError.message);
        chatData = {
          id: chatId,
          name: contactInfo.name,
          display_name: contactInfo.display_name,
          number: cleanNumber,
          about: contactInfo.about,
          pic: contactInfo.pic,
          pic_cached: contactInfo.pic_cached,
          last_message: "ابدأ المحادثة",
          last_time: new Date().toISOString(),
          session_id: currentSessionId
        };
      }

      socket.emit("new_chat_started", chatData);
      io.emit("chat_update", chatData);

    } catch (error) {
      console.log("❌ خطأ في بدء محادثة جديدة:", error.message);
      socket.emit("error", "فشل بدء المحادثة: " + error.message);
    }
  });

  // تسجيل الخروج
  socket.on("logout", async () => {
    try {
      if (client) {
        await client.logout();
        await client.destroy();
        isReady = false;
        userInfo = null;
        sessionRestoreAttempted = false;
        
        try {
          await pool.query("DELETE FROM zzapp_sessions WHERE session_id = $1", [currentSessionId]);
          await pool.query("DELETE FROM zzapp_chats WHERE session_id = $1", [currentSessionId]);
          await pool.query("DELETE FROM zzapp_messages WHERE session_id = $1", [currentSessionId]);
        } catch (dbError) {
          console.log("⚠️ خطأ في حذف البيانات:", dbError.message);
        }
        
        socket.emit("logged_out");
        console.log("👋 تم تسجيل الخروج وحذف الجلسة");
        
        setTimeout(() => {
          initWhatsAppWithRetry();
        }, 3000);
      }
    } catch (error) {
      console.log("❌ خطأ في تسجيل الخروج:", error.message);
      socket.emit("error", "فشل تسجيل الخروج");
    }
  });
});

/* ================= ROUTES ================= */
app.post("/upload", upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "لم يتم رفع أي ملف" });
    }
    
    res.json({ 
      success: true, 
      filePath: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      fileSize: req.file.size
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/save_voice", express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { audioData, fileName } = req.body;
    
    if (!audioData) {
      return res.status(400).json({ success: false, error: "لا توجد بيانات صوتية" });
    }
    
    let base64Data = audioData;
    if (audioData.includes(',')) {
      base64Data = audioData.replace(/^data:audio\/\w+;base64,/, "");
    }
    
    const buffer = Buffer.from(base64Data, 'base64');
    
    // حفظ الرسالة الصوتية كملف ogg
    const filePath = path.join(uploadsDir, fileName || `voice_${Date.now()}.ogg`);
    
    fs.writeFileSync(filePath, buffer);
    
    res.json({ 
      success: true, 
      filePath: `/uploads/${path.basename(filePath)}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/messages/:chatId/:sessionId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM zzapp_messages 
       WHERE chat_id = $1 AND session_id = $2
       ORDER BY timestamp ASC
       LIMIT 100`,
      [req.params.chatId, req.params.sessionId]
    );
    res.json(result.rows);
  } catch (error) {
    console.log("❌ خطأ في جلب الرسائل:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/chats/:sessionId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 200",
      [req.params.sessionId]
    );
    res.json(result.rows);
  } catch (error) {
    console.log("❌ خطأ في جلب المحادثات:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/sessions", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM zzapp_sessions ORDER BY last_active DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.log("❌ خطأ في جلب الجلسات:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/status", (req, res) => {
  res.json({
    isReady: isReady,
    hasQr: !!qrCode,
    sessionId: currentSessionId,
    status: isReady ? "ready" : qrCode ? "qr" : "waiting",
    sessionRestored: sessionRestoreAttempted
  });
});

// ملف manifest للتطبيق
app.get("/manifest.json", (req, res) => {
  res.json({
    "name": "ZZApp واتساب",
    "short_name": "ZZApp",
    "description": "تطبيق واتساب ويب للهواتف القديمة والزرارية",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#075e54",
    "theme_color": "#075e54",
    "orientation": "portrait",
    "icons": [
      {
        "src": "/icon-192x192.png",
        "sizes": "192x192",
        "type": "image/png",
        "purpose": "any maskable"
      },
      {
        "src": "/icon-512x512.png",
        "sizes": "512x512",
        "type": "image/png",
        "purpose": "any maskable"
      }
    ],
    "categories": ["social", "communication"],
    "shortcuts": [
      {
        "name": "محادثة جديدة",
        "short_name": "جديد",
        "description": "بدء محادثة جديدة",
        "url": "/?newchat=true",
        "icons": [{ "src": "/icon-96x96.png", "sizes": "96x96" }]
      }
    ]
  });
});

app.get("/service-worker.js", (req, res) => {
  const sw = `
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open('zzapp-cache-v6').then(cache => {
      return cache.addAll([
        '/',
        '/index.html',
        '/style.css',
        '/app.js',
        '/icon-192x192.png',
        '/icon-512x512.png',
        'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
        'https://web.whatsapp.com/favicon.ico'
      ]);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== 'zzapp-cache-v6') {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('/downloads/') || 
      event.request.url.includes('/uploads/') ||
      event.request.url.includes('/cache/') ||
      event.request.url.includes('/avatars/')) {
    event.respondWith(
      caches.match(event.request).then(response => {
        return response || fetch(event.request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) {
        return response;
      }
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open('zzapp-cache-v6').then(cache => {
          cache.put(event.request, responseToCache);
        });
        return response;
      });
    }).catch(() => {
      if (event.request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});
  `;
  
  res.set('Content-Type', 'application/javascript');
  res.send(sw);
});

// روت لمسح الصور المخبأة
app.post("/clear-cache", (req, res) => {
  try {
    const files = fs.readdirSync(cacheDir);
    files.forEach(file => {
      fs.unlinkSync(path.join(cacheDir, file));
    });
    
    const avatarFiles = fs.readdirSync(avatarsDir);
    avatarFiles.forEach(file => {
      fs.unlinkSync(path.join(avatarsDir, file));
    });
    
    res.json({ success: true, message: "تم مسح الكاش" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// روت لفحص صحة التطبيق
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    whatsapp: isReady ? "ready" : qrCode ? "qr" : "waiting",
    database: "connected",
    uptime: process.uptime(),
    sessionId: currentSessionId
  });
});

// روت لإعادة تشغيل واتساب
app.post("/restart-whatsapp", (req, res) => {
  try {
    console.log("🔄 إعادة تشغيل واتساب بطلب من المستخدم...");
    initWhatsAppWithRetry(currentSessionId);
    res.json({ success: true, message: "جاري إعادة تشغيل واتساب..." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get("*", (req, res) => {
  res.redirect("/");
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 التطبيق يعمل على المنفذ " + PORT);
  console.log("📱 واجهة متوافقة مع الهواتف القديمة والزرارية");
  console.log("🌐 افتح المتصفح على: http://localhost:" + PORT);
  console.log("📱 التطبيق متاح للتثبيت كمتصفح PWA");
  console.log("🟢 جاهز للعمل مع WhatsApp");
  
  // بدء واتساب بعد تأخير قصير
  setTimeout(() => {
    initWhatsAppWithRetry();
  }, 2000);
});

// معالجة الأخطاء
process.on('uncaughtException', (err) => {
  console.error('❌ خطأ غير متوقع:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ وعد مرفوض:', reason);
});

process.on('SIGINT', async () => {
  console.log('🛑 إغلاق التطبيق...');
  if (client) {
    try {
      await client.destroy();
    } catch (e) {}
  }
  await pool.end();
  process.exit(0);
});
