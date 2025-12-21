const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const multer = require("multer");
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

[downloadsDir, uploadsDir, sessionsDir].forEach(dir => {
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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/avi', 'video/mkv', 'video/mov', 'video/wmv',
      'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/aac',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم'), false);
    }
  }
});

/* ================= DATABASE ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/zzapp",
  ssl: false
});

// إعداد قاعدة البيانات
async function setupDatabase() {
  try {
    // حذف الجداول القديمة أولاً
    await pool.query('DROP TABLE IF EXISTS zzapp_sessions CASCADE');
    await pool.query('DROP TABLE IF EXISTS zzapp_messages CASCADE');
    await pool.query('DROP TABLE IF EXISTS zzapp_chats CASCADE');
    
    // جدول الجلسات
    await pool.query(`
      CREATE TABLE zzapp_sessions (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        user_data JSONB,
        last_active TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // جدول المحادثات
    await pool.query(`
      CREATE TABLE zzapp_chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        number TEXT,
        about TEXT,
        pic TEXT,
        last_message TEXT,
        message_count INTEGER DEFAULT 0,
        unread_count INTEGER DEFAULT 0,
        last_time TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_group BOOLEAN DEFAULT false,
        is_pinned BOOLEAN DEFAULT false,
        session_id TEXT REFERENCES zzapp_sessions(session_id) ON DELETE CASCADE
      )
    `);

    // جدول الرسائل
    await pool.query(`
      CREATE TABLE zzapp_messages (
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
        read_receipt BOOLEAN DEFAULT false,
        FOREIGN KEY (session_id) REFERENCES zzapp_sessions(session_id) ON DELETE CASCADE
      )
    `);

    // إنشاء فهارس للأداء
    await pool.query('CREATE INDEX idx_chats_session ON zzapp_chats(session_id)');
    await pool.query('CREATE INDEX idx_messages_chat ON zzapp_messages(chat_id)');
    await pool.query('CREATE INDEX idx_messages_session ON zzapp_messages(session_id)');
    await pool.query('CREATE INDEX idx_messages_timestamp ON zzapp_messages(timestamp)');

    console.log("✅ تم إنشاء قاعدة البيانات");
  } catch (error) {
    console.error("خطأ في إنشاء قاعدة البيانات:", error.message);
  }
}

setupDatabase();

/* ================= WHATSAPP ================= */
let qrCode = null;
let isReady = false;
let client = null;
let userInfo = null;
let currentSessionId = null;

// دالة لاستخراج الرقم من ID
function extractNumberFromId(contactId) {
  if (!contactId) return "غير معروف";
  
  let number = contactId
    .replace('@c.us', '')
    .replace('@lid', '')
    .replace('@g.us', '')
    .replace('@s.whatsapp.net', '')
    .replace('+', '');
  
  return number || "غير معروف";
}

// دالة للحصول على معلومات جهة الاتصال
async function getContactInfo(contactId) {
  try {
    if (!client) return null;
    
    const contact = await client.getContactById(contactId);
    if (!contact) return null;
    
    let name = contact.name || contact.pushname || extractNumberFromId(contactId);
    let about = "";
    let pic = null;
    
    try {
      about = contact.about || "";
    } catch (e) {
      console.log("⚠️ لا يمكن الحصول على البايو:", e.message);
    }
    
    try {
      pic = await contact.getProfilePicUrl();
    } catch (e) {
      console.log("⚠️ لا يمكن الحصول على الصورة:", e.message);
    }
    
    return {
      name: name,
      about: about,
      pic: pic,
      number: extractNumberFromId(contactId),
      id: contactId
    };
  } catch (e) {
    console.log("⚠️ خطأ في الحصول على معلومات جهة الاتصال:", e.message);
    return {
      name: extractNumberFromId(contactId),
      about: "",
      pic: null,
      number: extractNumberFromId(contactId),
      id: contactId
    };
  }
}

// دالة لتهيئة واتساب
async function initWhatsApp(sessionId = null) {
  console.log("🔧 جاري تشغيل واتساب...");

  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.log("⚠️ خطأ في تدمير العميل السابق:", e.message);
    }
  }

  currentSessionId = sessionId || `session_${Date.now()}`;

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "zzapp-client",
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
      ]
    },
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0
  });

  client.on("qr", async (qr) => {
    console.log("📱 يوجد كود QR");
    qrCode = await QRCode.toDataURL(qr);
    
    // حفظ الجلسة في قاعدة البيانات
    await pool.query(
      `INSERT INTO zzapp_sessions (session_id, last_active, created_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (session_id) 
       DO UPDATE SET last_active = NOW()`,
      [currentSessionId]
    );
    
    io.emit("qr", { qr: qrCode, sessionId: currentSessionId });
  });

  client.on("authenticated", async () => {
    console.log("✅ تم تسجيل الدخول");
    qrCode = null;
    
    // تحديث الجلسة
    await pool.query(
      `UPDATE zzapp_sessions SET last_active = NOW() WHERE session_id = $1`,
      [currentSessionId]
    );
  });

  client.on("ready", async () => {
    console.log("🚀 واتساب جاهز للاستخدام");
    isReady = true;
    qrCode = null;
    
    // الحصول على معلومات المستخدم
    try {
      const me = await client.getMe();
      const myContact = await client.getContactById(me._serialized);
      
      userInfo = {
        id: me._serialized,
        name: me.pushname || me.name || "المستخدم",
        number: me.id.user,
        about: "",
        pic: null
      };
      
      // الحصول على البايو
      try {
        userInfo.about = myContact.about || "";
      } catch (e) {
        console.log("⚠️ لا يمكن الحصول على البايو");
      }
      
      // الحصول على صورة الملف الشخصي
      try {
        userInfo.pic = await myContact.getProfilePicUrl();
      } catch (e) {
        console.log("⚠️ لا توجد صورة للمستخدم");
      }
      
      console.log("👤 معلومات المستخدم:", userInfo.name, "- البايو:", userInfo.about);
      
      // حفظ معلومات المستخدم في الجلسة
      await pool.query(
        `UPDATE zzapp_sessions SET user_data = $1 WHERE session_id = $2`,
        [JSON.stringify(userInfo), currentSessionId]
      );
      
      io.emit("user_info", userInfo);
    } catch (e) {
      console.log("⚠️ خطأ في الحصول على معلومات المستخدم:", e.message);
      userInfo = {
        id: "unknown",
        name: "المستخدم",
        number: "unknown",
        about: "",
        pic: null
      };
      io.emit("user_info", userInfo);
    }
    
    io.emit("ready", { sessionId: currentSessionId });
    
    // تحميل المحادثات من قاعدة البيانات لهذه الجلسة
    try {
      const chatsRes = await pool.query(
        "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 100",
        [currentSessionId]
      );
      io.emit("chats", chatsRes.rows);
    } catch (e) {
      console.log("خطأ في تحميل المحادثات:", e.message);
    }
  });

  client.on("message", async (msg) => {
    try {
      console.log("📩 رسالة جديدة من:", msg.from);
      
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
            let filePath = '';
            
            // تحديد نوع الملف وامتداده
            let ext = '.bin';
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
            
            filePath = path.join(downloadsDir, fileName);
            const buffer = Buffer.from(media.data, 'base64');
            mediaSize = buffer.length;
            
            // حفظ الملف
            fs.writeFileSync(filePath, buffer);
            
            // تحسين الصور إذا كانت كبيرة
            if (mediaType === 'image' && mediaSize > 1024 * 1024) {
              try {
                await sharp(filePath)
                  .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 80 })
                  .toFile(filePath + '.optimized.jpg');
                
                // استبدال الملف بالمحسن
                fs.unlinkSync(filePath);
                fs.renameSync(filePath + '.optimized.jpg', filePath);
                mediaSize = fs.statSync(filePath).size;
              } catch (e) {
                console.log("⚠️ لا يمكن تحسين الصورة:", e.message);
              }
            }
            
            mediaUrl = `/downloads/${fileName}`;
            mediaName = msg.mediaFilename || fileName;
          }
        } catch (e) {
          console.log("⚠️ خطأ في حفظ الوسائط:", e.message);
        }
      }

      // حفظ الرسالة في قاعدة البيانات
      await pool.query(
        `INSERT INTO zzapp_messages 
         (chat_id, message_id, session_id, sender_id, sender_name, sender_number, 
          content, media_url, media_type, media_size, media_name, is_from_me)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (message_id) DO NOTHING`,
        [chatId, 
         msg.id._serialized, 
         currentSessionId,
         msg.from,
         contactInfo.name,
         contactInfo.number,
         msg.body || "[وسائط]", 
         mediaUrl, 
         mediaType,
         mediaSize,
         mediaName,
         msg.fromMe]
      );

      // حفظ أو تحديث المحادثة
      await pool.query(
        `INSERT INTO zzapp_chats (id, name, number, about, pic, last_message, last_time, 
          updated_at, is_group, session_id, message_count, unread_count)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7, $8, 1, 1)
         ON CONFLICT (id) 
         DO UPDATE SET 
           name = COALESCE($2, zzapp_chats.name),
           about = COALESCE($4, zzapp_chats.about),
           pic = COALESCE($5, zzapp_chats.pic),
           last_message = $6,
           last_time = NOW(),
           updated_at = NOW(),
           message_count = zzapp_chats.message_count + 1,
           unread_count = CASE WHEN $9 = true THEN zzapp_chats.unread_count ELSE zzapp_chats.unread_count + 1 END`,
        [chatId, 
         contactInfo.name, 
         contactInfo.number,
         contactInfo.about,
         contactInfo.pic,
         msg.body || "[وسائط]",
         isGroup,
         currentSessionId,
         msg.fromMe]
      );

      // إرسال تحديث للعملاء
      io.emit("chat_update", { 
        id: chatId, 
        name: contactInfo.name, 
        number: contactInfo.number,
        about: contactInfo.about,
        pic: contactInfo.pic,
        last_message: msg.body || "[وسائط]",
        last_time: new Date().toISOString(),
        is_group: isGroup,
        session_id: currentSessionId
      });

      io.emit("message", { 
        chat_id: chatId,
        message_id: msg.id._serialized,
        text: msg.body || "[وسائط]", 
        media: mediaUrl,
        media_type: mediaType,
        media_name: mediaName,
        timestamp: new Date().toISOString(),
        is_from_me: msg.fromMe,
        sender_name: contactInfo.name,
        sender_number: contactInfo.number,
        session_id: currentSessionId
      });

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
    
    await pool.query(
      `UPDATE zzapp_sessions SET last_active = NOW() WHERE session_id = $1`,
      [currentSessionId]
    );
    
    setTimeout(() => {
      initWhatsApp(currentSessionId);
    }, 10000);
  });

  client.on("auth_failure", (message) => {
    console.log("❌ فشل المصادقة:", message);
    isReady = false;
  });

  client.on("change_state", (state) => {
    console.log("🔄 تغيير حالة:", state);
  });

  try {
    await client.initialize();
    console.log("✅ تم تشغيل واتساب بنجاح");
  } catch (error) {
    console.error("❌ فشل تشغيل واتساب:", error);
    
    setTimeout(() => {
      console.log("🔄 إعادة المحاولة...");
      initWhatsApp(currentSessionId);
    }, 10000);
  }
}

// بدء واتساب
initWhatsApp();

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
        
        // إرسال معلومات المستخدم إذا كانت محفوظة
        if (session.user_data) {
          socket.emit("user_info", session.user_data);
        }
        
        // إرسال المحادثات لهذه الجلسة
        const chatsRes = await pool.query(
          "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 100",
          [sessionId]
        );
        socket.emit("chats", chatsRes.rows);
        
        socket.emit("session_restored", { sessionId: sessionId });
      }
    } catch (e) {
      console.log("❌ خطأ في استعادة الجلسة:", e.message);
    }
  });

  // إرسال معلومات المستخدم إذا كانت متوفرة
  if (userInfo) {
    socket.emit("user_info", userInfo);
  }

  // التحقق من حالة الاتصال
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
         ORDER BY timestamp ASC`,
        [chatId, sessionId || currentSessionId]
      );
      socket.emit("load_messages", messagesRes.rows);
    } catch (e) {
      console.log("خطأ في تحميل الرسائل:", e.message);
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
      
      // الحصول على معلومات جهة الاتصال
      const contactInfo = await getContactInfo(chatId);
      
      // حفظ الرسالة
      await pool.query(
        `INSERT INTO zzapp_messages 
         (chat_id, message_id, session_id, sender_id, sender_name, sender_number, content, is_from_me)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [chatId, 
         message.id._serialized,
         currentSessionId,
         'me',
         'أنا',
         'me',
         data.text, 
         true]
      );

      // تحديث المحادثة
      await pool.query(
        `INSERT INTO zzapp_chats (id, name, number, about, pic, last_message, last_time, updated_at, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7)
         ON CONFLICT (id) 
         DO UPDATE SET 
           name = COALESCE($2, zzapp_chats.name),
           about = COALESCE($4, zzapp_chats.about),
           pic = COALESCE($5, zzapp_chats.pic),
           last_message = $6,
           last_time = NOW(),
           updated_at = NOW(),
           message_count = COALESCE(zzapp_chats.message_count, 0) + 1`,
        [chatId, 
         contactInfo.name, 
         contactInfo.number,
         contactInfo.about,
         contactInfo.pic,
         data.text,
         currentSessionId]
      );

      socket.emit("message", { 
        chat_id: chatId,
        message_id: message.id._serialized,
        text: data.text, 
        timestamp: new Date().toISOString(),
        is_from_me: true,
        sender_name: "أنا",
        sender_number: "me",
        session_id: currentSessionId
      });
      
      // إرسال تحديث للمحادثة
      io.emit("chat_update", {
        id: chatId,
        name: contactInfo.name,
        number: contactInfo.number,
        about: contactInfo.about,
        pic: contactInfo.pic,
        last_message: data.text,
        last_time: new Date().toISOString(),
        session_id: currentSessionId
      });

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

      // التحقق من حجم الملف
      const stats = fs.statSync(mediaPath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      
      if (fileSizeInMB > 50) {
        socket.emit("error", "حجم الملف كبير جداً (50MB كحد أقصى)");
        return;
      }

      // إرسال الوسائط
      const media = MessageMedia.fromFilePath(mediaPath);
      const message = await client.sendMessage(chatId, media, { caption: data.caption || '' });

      // الحصول على معلومات جهة الاتصال
      const contactInfo = await getContactInfo(chatId);

      // حفظ في قاعدة البيانات
      await pool.query(
        `INSERT INTO zzapp_messages 
         (chat_id, message_id, session_id, sender_id, sender_name, sender_number, 
          content, media_url, media_type, media_size, media_name, is_from_me)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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

      await pool.query(
        `INSERT INTO zzapp_chats (id, name, number, about, pic, last_message, last_time, updated_at, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7)
         ON CONFLICT (id) 
         DO UPDATE SET 
           name = COALESCE($2, zzapp_chats.name),
           about = COALESCE($4, zzapp_chats.about),
           pic = COALESCE($5, zzapp_chats.pic),
           last_message = $6,
           last_time = NOW(),
           updated_at = NOW(),
           message_count = COALESCE(zzapp_chats.message_count, 0) + 1`,
        [chatId, 
         contactInfo.name, 
         contactInfo.number,
         contactInfo.about,
         contactInfo.pic,
         data.caption || "[وسائط]",
         currentSessionId]
      );

      socket.emit("message", {
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
      });
      
      io.emit("chat_update", {
        id: chatId,
        name: contactInfo.name,
        number: contactInfo.number,
        about: contactInfo.about,
        pic: contactInfo.pic,
        last_message: data.caption || "[وسائط]",
        last_time: new Date().toISOString(),
        session_id: currentSessionId
      });

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
      const contactInfo = await getContactInfo(chatId);
      
      // التحقق من وجود المحادثة
      const existing = await pool.query(
        "SELECT * FROM zzapp_chats WHERE id = $1 AND session_id = $2",
        [chatId, currentSessionId]
      );
      
      let chatData;
      
      if (existing.rows.length > 0) {
        chatData = existing.rows[0];
      } else {
        await pool.query(
          `INSERT INTO zzapp_chats (id, name, number, about, pic, updated_at, session_id)
           VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
          [chatId, contactInfo.name, cleanNumber, contactInfo.about, contactInfo.pic, currentSessionId]
        );
        
        const result = await pool.query(
          "SELECT * FROM zzapp_chats WHERE id = $1 AND session_id = $2",
          [chatId, currentSessionId]
        );
        chatData = result.rows[0];
      }

      socket.emit("new_chat_started", chatData);
      io.emit("chat_update", chatData);

    } catch (error) {
      console.log("❌ خطأ في بدء محادثة جديدة:", error.message);
      socket.emit("error", "فشل بدء المحادثة: " + error.message);
    }
  });

  // حفظ رسالة صوتية
  socket.on("save_voice_message", async (data) => {
    try {
      const { chatId, audioData, fileName } = data;
      
      if (!audioData || !chatId) {
        socket.emit("error", "بيانات غير كافية");
        return;
      }
      
      let base64Data = audioData;
      if (audioData.includes(',')) {
        base64Data = audioData.split(',')[1];
      }
      
      const buffer = Buffer.from(base64Data, 'base64');
      const filePath = path.join(uploadsDir, fileName);
      
      fs.writeFileSync(filePath, buffer);
      
      socket.emit("voice_saved", {
        filePath: `/uploads/${fileName}`,
        fileName: fileName
      });
      
    } catch (error) {
      console.log("❌ خطأ في حفظ الرسالة الصوتية:", error.message);
      socket.emit("error", "فشل حفظ الرسالة الصوتية");
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
        
        // حذف الجلسة من قاعدة البيانات
        await pool.query("DELETE FROM zzapp_sessions WHERE session_id = $1", [currentSessionId]);
        
        socket.emit("logged_out");
        console.log("👋 تم تسجيل الخروج وحذف الجلسة");
        
        setTimeout(() => {
          initWhatsApp();
        }, 3000);
      }
    } catch (error) {
      console.log("❌ خطأ في تسجيل الخروج:", error.message);
      socket.emit("error", "فشل تسجيل الخروج");
    }
  });
});

/* ================= ROUTES ================= */
// رفع ملف
app.post("/upload", upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "لم يتم رفع أي ملف" });
    }
    
    res.json({ 
      success: true, 
      filePath: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// حفظ صوت من base64
app.post("/save_voice", express.json({ limit: '50mb' }), (req, res) => {
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
       ORDER BY timestamp ASC`,
      [req.params.chatId, req.params.sessionId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/chats/:sessionId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM zzapp_chats WHERE session_id = $1 ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 100",
      [req.params.sessionId]
    );
    res.json(result.rows);
  } catch (error) {
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
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/status", (req, res) => {
  res.json({
    isReady: isReady,
    hasQr: !!qrCode,
    sessionId: currentSessionId
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
        "src": "/icon-72x72.png",
        "sizes": "72x72",
        "type": "image/png"
      },
      {
        "src": "/icon-96x96.png",
        "sizes": "96x96",
        "type": "image/png"
      },
      {
        "src": "/icon-128x128.png",
        "sizes": "128x128",
        "type": "image/png"
      },
      {
        "src": "/icon-144x144.png",
        "sizes": "144x144",
        "type": "image/png"
      },
      {
        "src": "/icon-152x152.png",
        "sizes": "152x152",
        "type": "image/png"
      },
      {
        "src": "/icon-192x192.png",
        "sizes": "192x192",
        "type": "image/png"
      },
      {
        "src": "/icon-384x384.png",
        "sizes": "384x384",
        "type": "image/png"
      },
      {
        "src": "/icon-512x512.png",
        "sizes": "512x512",
        "type": "image/png"
      }
    ]
  });
});

// خدمة Worker للتطبيق
app.get("/service-worker.js", (req, res) => {
  const sw = `
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open('zzapp-cache').then(cache => {
      return cache.addAll([
        '/',
        '/index.html',
        '/style.css',
        '/app.js',
        '/icon-192x192.png',
        '/icon-512x512.png'
      ]);
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
  `;
  
  res.set('Content-Type', 'application/javascript');
  res.send(sw);
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
});
