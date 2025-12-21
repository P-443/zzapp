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
const { exec } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec);

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

// إعداد multer للرفع
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
    const allowedTypes = ['image/*', 'video/*', 'audio/*', 'application/octet-stream'];
    if (allowedTypes.some(type => file.mimetype.startsWith(type.split('/')[0]))) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم'));
    }
  }
});

/* ================= DATABASE ================= */
const getDatabaseConfig = () => {
  const connectionString = process.env.DATABASE_URL || "postgres://postgres:6DQNh71sjOwHWwi5VYvGGZDtx5GpsdXRz6DWQKb7mBy9fwHNTn9X21yAJy05A14v@31.97.47.20:5433/postgres";
  
  return {
    connectionString: connectionString,
    ssl: {
      rejectUnauthorized: false,
      require: true
    }
  };
};

const pool = new Pool(getDatabaseConfig());

// ================= FFMPEG FUNCTIONS =================

// دالة لتحويل أي صوت إلى Voice Note (Opus/OGG) حقيقي
async function convertToVoiceNote(inputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const outputPath = inputPath.replace(/\.[^/.]+$/, "") + "_voice.ogg";
      
      // أولاً: التحقق مما إذا كان الملف موجوداً
      if (!fs.existsSync(inputPath)) {
        reject(new Error(`الملف غير موجود: ${inputPath}`));
        return;
      }
      
      console.log(`🎤 جاري تحويل الصوت إلى Voice Note: ${path.basename(inputPath)}`);
      
      // استخدام ffmpeg لتحويل إلى OGG/Opus (تنسيق WhatsApp الصوتي)
      const command = `ffmpeg -y -i "${inputPath}" -map_metadata -1 -vn -c:a libopus -b:a 32k -ac 1 -ar 48000 -vbr on -compression_level 10 -application voip "${outputPath}"`;
      
      const { stdout, stderr } = await execPromise(command);
      
      console.log(`✅ تم تحويل الصوت بنجاح: ${path.basename(outputPath)}`);
      resolve(outputPath);
      
    } catch (error) {
      console.error(`❌ فشل تحويل الصوت:`, error.message);
      
      // في حالة فشل التحويل، استخدم الملف الأصلي
      if (fs.existsSync(inputPath)) {
        console.log(`⚠️ استخدام الملف الأصلي: ${path.basename(inputPath)}`);
        resolve(inputPath);
      } else {
        reject(error);
      }
    }
  });
}

// دالة لتحويل الصور إلى JPEG مضغوط
async function compressImage(imageBuffer, quality = 50) {
  try {
    const compressedBuffer = await sharp(imageBuffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ 
        quality: quality,
        progressive: true,
        optimizeScans: true
      })
      .toBuffer();
    
    return compressedBuffer;
  } catch (error) {
    console.log("⚠️ خطأ في ضغط الصورة، استخدام النسخة الأصلية:", error.message);
    return imageBuffer;
  }
}

// ================= WHATSAPP FUNCTIONS =================

let qrCode = null;
let isReady = false;
let client = null;
let userInfo = null;
let currentSessionId = null;
let sessionRestoreAttempted = false;
let whatsappInitializing = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// دالة للحصول على معلومات جهة الاتصال
async function getContactInfo(contactId, sessionId) {
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
        
        if (chat.isGroup && chat.description) {
          about = chat.description;
        }
      }
    } catch (e) {
      console.log("⚠️ لا يمكن الحصول على معلومات المحادثة:", e.message);
    }
    
    // محاولة الحصول على صورة الملف الشخصي
    try {
      const profilePicUrl = await client.getProfilePicUrl(contactId);
      if (profilePicUrl) {
        const cacheFileName = `profile_${contactId.replace(/[@\.]/g, '_')}.jpg`;
        const cachePath = path.join(cacheDir, cacheFileName);
        const avatarPath = path.join(avatarsDir, cacheFileName);
        
        if (fs.existsSync(cachePath)) {
          pic = `/cache/${cacheFileName}`;
        } else if (fs.existsSync(avatarPath)) {
          pic = `/avatars/${cacheFileName}`;
        } else {
          const response = await fetch(profilePicUrl);
          if (response.ok) {
            const buffer = await response.buffer();
            const compressedBuffer = await compressImage(buffer, 50);
            fs.writeFileSync(cachePath, compressedBuffer);
            pic = `/cache/${cacheFileName}`;
          }
        }
      }
    } catch (e) {
      // تجاهل الخطأ
    }
    
    return {
      id: contactId,
      name: name,
      display_name: displayName,
      number: extractNumberFromId(contactId),
      about: about,
      pic: pic,
      is_group: isGroup,
      pic_cached: !!pic,
      session_id: sessionId
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
      pic_cached: false,
      session_id: sessionId
    };
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
    
    let pic = null;
    try {
      const profilePicUrl = await client.getProfilePicUrl(info.wid._serialized);
      if (profilePicUrl) {
        const cacheFileName = `user_${info.wid.user}.jpg`;
        const cachePath = path.join(cacheDir, cacheFileName);
        
        if (fs.existsSync(cachePath)) {
          pic = `/cache/${cacheFileName}`;
        } else {
          const response = await fetch(profilePicUrl);
          if (response.ok) {
            const buffer = await response.buffer();
            const compressedBuffer = await compressImage(buffer, 50);
            fs.writeFileSync(cachePath, compressedBuffer);
            pic = `/cache/${cacheFileName}`;
          }
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
      about: info.about || "",
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
  
  const cleanName = name.replace(/^\d+@/, '');
  
  return cleanName || extractNumberFromId(contactId);
}

// دالة لتحميل جميع المحادثات
async function loadAllChats(sessionId) {
  try {
    const chatsRes = await pool.query(
      "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST",
      [sessionId]
    );
    return chatsRes.rows;
  } catch (e) {
    console.log("⚠️ خطأ في تحميل المحادثات:", e.message);
    return [];
  }
}

// دالة لتحميل الرسائل
async function loadMessages(chatId, sessionId) {
  try {
    const messagesRes = await pool.query(
      `SELECT * FROM zzapp_messages 
       WHERE chat_id = $1 AND session_id = $2
       ORDER BY timestamp ASC
       LIMIT 500`,
      [chatId, sessionId]
    );
    return messagesRes.rows;
  } catch (e) {
    console.log("⚠️ خطأ في تحميل الرسائل:", e.message);
    return [];
  }
}

// دالة لتهيئة واتساب مع إعادة المحاولة
async function initWhatsApp(sessionId = null) {
  if (whatsappInitializing) {
    console.log("⏳ واتساب بالفعل قيد التشغيل...");
    return;
  }
  
  return new Promise(async (resolve, reject) => {
    console.log("🔧 جاري تشغيل واتساب...");
    whatsappInitializing = true;
    reconnectAttempts = 0;

    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        console.log("⚠️ خطأ في تدمير العميل السابق:", e.message);
      }
    }

    currentSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`🆔 معرف الجلسة: ${currentSessionId}`);

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: currentSessionId,
        dataPath: sessionsDir
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ],
        ignoreHTTPSErrors: true
      }
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
      reconnectAttempts = 0;
      
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
      whatsappInitializing = false;
      reconnectAttempts = 0;
      
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
      
      try {
        const chats = await loadAllChats(currentSessionId);
        io.emit("chats", chats);
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
        let contactInfo = await getContactInfo(chatId, currentSessionId);
        
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
              
              if (mediaType === 'image') {
                const compressedBuffer = await compressImage(buffer, 60);
                fs.writeFileSync(filePath, compressedBuffer);
              } else {
                fs.writeFileSync(filePath, buffer);
              }
              
              mediaUrl = `/downloads/${fileName}`;
              mediaName = msg.mediaFilename || fileName;
            }
          } catch (e) {
            console.log("⚠️ خطأ في حفظ الوسائط:", e.message);
          }
        }

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

        try {
          await pool.query(
            `INSERT INTO zzapp_chats (id, name, display_name, number, about, pic, pic_cached, last_message, last_time, 
              updated_at, is_group, session_id, message_count, unread_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10, 1, 
                    CASE WHEN $11 = true THEN 0 ELSE 1 END)
             ON CONFLICT (id, session_id) 
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
      whatsappInitializing = false;
      reconnectAttempts++;
      
      try {
        await pool.query(
          `UPDATE zzapp_sessions SET last_active = NOW() WHERE session_id = $1`,
          [currentSessionId]
        );
      } catch (e) {
        console.log("⚠️ خطأ في تحديث الجلسة:", e.message);
      }
      
      setTimeout(() => {
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          console.log(`🔄 إعادة تشغيل واتساب بعد انقطاع (المحاولة ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          initWhatsAppWithRetry(currentSessionId);
        } else {
          console.log("❌ تجاوزت الحد الأقصى لمحاولات إعادة الاتصال");
        }
      }, 5000);
    });

    client.on("auth_failure", (message) => {
      console.log("❌ فشل المصادقة:", message);
      isReady = false;
      whatsappInitializing = false;
      reject(new Error("فشل المصادقة: " + message));
    });

    try {
      await client.initialize();
      console.log("✅ تم تشغيل واتساب بنجاح");
    } catch (error) {
      console.error("❌ فشل تشغيل واتساب:", error.message);
      whatsappInitializing = false;
      reject(error);
    }
  });
}

// دالة لإعادة المحاولة مع زيادة التباعد
async function initWhatsAppWithRetry(sessionId = null, retries = 5, delay = 10000) {
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
          const chats = await loadAllChats(sessionId);
          socket.emit("chats", chats);
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
      const messages = await loadMessages(chatId, sessionId || currentSessionId);
      socket.emit("load_messages", messages);
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
      
      const contactInfo = await getContactInfo(chatId, currentSessionId);
      
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
           ON CONFLICT (id, session_id) 
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

  // إرسال وسائط - الحل النهائي للرسائل الصوتية
  socket.on("send_media", async (data) => {
    if (!isReady) {
      socket.emit("error", "واتساب غير متصل");
      return;
    }

    try {
      const chatId = data.to.includes('@') ? data.to : `${data.to}@c.us`;
      let mediaPath = path.join(__dirname, 'public', data.filePath.replace(/^\//, ''));
      
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

      let finalMediaPath = mediaPath;
      let finalMediaType = data.mediaType;
      let finalFileName = path.basename(mediaPath);
      
      // ====== الحل النهائي: تحويل الصوت إلى Voice Note ======
      if (data.mediaType === 'audio' && data.isVoiceMessage) {
        try {
          // تحويل الصوت إلى Voice Note حقيقي (Opus/OGG)
          const convertedPath = await convertToVoiceNote(mediaPath);
          finalMediaPath = convertedPath;
          finalFileName = path.basename(convertedPath);
          console.log("✅ تم تحويل الصوت إلى Voice Note");
        } catch (convertError) {
          console.log("⚠️ فشل تحويل الصوت، استخدام الملف الأصلي:", convertError.message);
        }
      }

      // قراءة الملف النهائي
      const fileBuffer = fs.readFileSync(finalMediaPath);
      
      // تحديد MIME type الصحيح
      let mimeType;
      if (finalMediaType === 'image') {
        mimeType = 'image/jpeg';
      } else if (finalMediaType === 'audio') {
        // صوتيات بعد التحويل ستكون audio/ogg; codecs=opus
        mimeType = 'audio/ogg; codecs=opus';
      } else if (finalMediaType === 'video') {
        mimeType = 'video/mp4';
      } else {
        mimeType = 'application/octet-stream';
      }
      
      // إنشاء كائن Media
      const media = new MessageMedia(mimeType, fileBuffer.toString('base64'), finalFileName);
      
      // إرسال الوسائط - بدون sendAudioAsVoice
      const message = await client.sendMessage(chatId, media, { 
        caption: data.caption || ''
      });

      const contactInfo = await getContactInfo(chatId, currentSessionId);

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
           finalMediaType,
           stats.size,
           finalFileName,
           true]
        );
      } catch (dbError) {
        console.log("⚠️ خطأ في حفظ الوسائط:", dbError.message);
      }

      try {
        await pool.query(
          `INSERT INTO zzapp_chats (id, name, display_name, number, about, pic, pic_cached, last_message, last_time, updated_at, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9)
           ON CONFLICT (id, session_id) 
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
        media_type: finalMediaType,
        media_name: finalFileName,
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

  // بقية السوكيت...
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
      base64Data = audioData.split(',')[1];
    }
    
    const buffer = Buffer.from(base64Data, 'base64');
    
    // حفظ الملف
    const finalFileName = fileName || `voice_${Date.now()}.ogg`;
    const filePath = path.join(uploadsDir, finalFileName);
    
    fs.writeFileSync(filePath, buffer);
    
    res.json({ 
      success: true, 
      filePath: `/uploads/${finalFileName}`
    });
  } catch (error) {
    console.error("❌ خطأ في حفظ الصوت:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// بقية الروتات...

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 التطبيق يعمل على المنفذ " + PORT);
  console.log("📱 واجهة متوافقة مع الهواتف القديمة والزرارية");
  console.log("🌐 افتح المتصفح على: http://localhost:" + PORT);
  console.log("📱 التطبيق متاح للتثبيت كمتصفح PWA");
  console.log("🟢 جاهز للعمل مع WhatsApp");
  
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
