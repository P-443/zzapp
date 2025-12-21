const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json({ limit: '10mb' }));

// إنشاء مجلدات
const downloadsDir = path.join(__dirname, 'downloads');
const uploadsDir = path.join(__dirname, 'uploads');
const sessionsDir = path.join(__dirname, '.wwebjs_auth');

[downloadsDir, uploadsDir, sessionsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use('/downloads', express.static(downloadsDir));
app.use('/uploads', express.static(uploadsDir));

// إعداد multer للرفع
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
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
    await pool.query('DROP TABLE IF EXISTS zzapp_messages CASCADE');
    await pool.query('DROP TABLE IF EXISTS zzapp_chats CASCADE');
    
    // جدول المحادثات
    await pool.query(`
      CREATE TABLE zzapp_chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        number TEXT,
        pic TEXT,
        last_message TEXT,
        message_count INTEGER DEFAULT 0,
        unread_count INTEGER DEFAULT 0,
        last_time TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_group BOOLEAN DEFAULT false
      )
    `);

    // جدول الرسائل
    await pool.query(`
      CREATE TABLE zzapp_messages (
        id SERIAL PRIMARY KEY,
        chat_id TEXT,
        message_id TEXT,
        sender_id TEXT,
        sender_name TEXT,
        sender_number TEXT,
        content TEXT,
        media_url TEXT,
        media_type TEXT,
        is_from_me BOOLEAN DEFAULT false,
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);

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

// دالة لاستخراج الرقم من ID
function extractNumberFromId(contactId) {
  if (!contactId) return "غير معروف";
  
  // إزالة البادئات والنهايات
  let number = contactId
    .replace('@c.us', '')
    .replace('@lid', '')
    .replace('@g.us', '')
    .replace('@s.whatsapp.net', '');
  
  return number || "غير معروف";
}

// دالة لتحميل صورة جهة الاتصال
async function loadContactPic(contact) {
  try {
    if (!contact) return null;
    const pic = await contact.getProfilePicUrl();
    return pic;
  } catch (e) {
    return null;
  }
}

// دالة للحصول على اسم جهة الاتصال
function getContactName(contact, contactId) {
  if (!contact) {
    return extractNumberFromId(contactId);
  }
  
  try {
    // أولوية الأسماء
    if (contact.name && contact.name.trim() !== "") {
      return contact.name;
    }
    
    if (contact.pushname && contact.pushname.trim() !== "") {
      return contact.pushname;
    }
    
    if (contact.verifiedName && contact.verifiedName.trim() !== "") {
      return contact.verifiedName;
    }
    
    return extractNumberFromId(contactId);
  } catch (e) {
    return extractNumberFromId(contactId);
  }
}

// دالة لتهيئة واتساب
async function initWhatsApp() {
  console.log("🔧 جاري تشغيل واتساب...");

  if (client) {
    try {
      await client.destroy();
    } catch (e) {}
  }

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
    io.emit("qr", qrCode);
  });

  client.on("authenticated", () => {
    console.log("✅ تم تسجيل الدخول");
    qrCode = null;
  });

  client.on("ready", async () => {
    console.log("🚀 واتساب جاهز للاستخدام");
    isReady = true;
    qrCode = null;
    
    // الحصول على معلومات المستخدم
    try {
      // طريقة أبسط للحصول على معلومات المستخدم
      const me = await client.getMe();
      userInfo = {
        id: me.id._serialized,
        name: me.name || me.pushname || "المستخدم",
        number: me.id.user,
        pic: null
      };
      
      // محاولة الحصول على صورة الملف الشخصي
      try {
        const pic = await loadContactPic(me);
        if (pic) userInfo.pic = pic;
      } catch (e) {
        console.log("⚠️ لا توجد صورة للمستخدم");
      }
      
      console.log("👤 معلومات المستخدم:", userInfo.name);
      io.emit("user_info", userInfo);
    } catch (e) {
      console.log("⚠️ خطأ في الحصول على معلومات المستخدم:", e.message);
      userInfo = {
        id: "unknown",
        name: "المستخدم",
        number: "unknown",
        pic: null
      };
      io.emit("user_info", userInfo);
    }
    
    io.emit("ready");
  });

  client.on("message", async (msg) => {
    try {
      console.log("📩 رسالة جديدة من:", msg.from);
      
      let chatId = msg.id.remote || msg.from;
      let isGroup = chatId.includes('@g.us');
      let chat = null;
      let contact = null;
      let chatName = "مستخدم";
      let number = extractNumberFromId(chatId);
      let senderName = number;
      let senderNumber = number;
      let contactPic = null;
      let senderId = msg.from;
      
      try {
        if (isGroup) {
          // للمجموعات
          try {
            chat = await msg.getChat();
            chatName = chat.name || "مجموعة";
            
            // الحصول على معلومات المرسل في المجموعة
            if (msg.author) {
              senderId = msg.author;
              senderNumber = extractNumberFromId(msg.author);
              
              try {
                // محاولة الحصول على جهة الاتصال
                contact = await client.getContactById(msg.author);
                if (contact) {
                  senderName = getContactName(contact, msg.author);
                  // الحصول على صورة المرسل
                  try {
                    contactPic = await loadContactPic(contact);
                  } catch (e) {
                    // إذا فشل، نستخدم صورة المجموعة
                    try {
                      contactPic = await loadContactPic(chat);
                    } catch (e2) {}
                  }
                } else {
                  senderName = senderNumber;
                }
              } catch (e) {
                console.log("⚠️ لا يمكن الحصول على معلومات المرسل في المجموعة");
                senderName = senderNumber;
              }
            }
          } catch (e) {
            console.log("⚠️ خطأ في الحصول على معلومات المجموعة");
            chatName = "مجموعة";
          }
        } else {
          // للمحادثات الفردية
          try {
            contact = await client.getContactById(chatId);
            if (contact) {
              chatName = getContactName(contact, chatId);
              senderName = chatName;
              // الحصول على صورة جهة الاتصال
              try {
                contactPic = await loadContactPic(contact);
              } catch (e) {}
            }
          } catch (e) {
            console.log("⚠️ لا يمكن الحصول على معلومات جهة الاتصال");
          }
        }
      } catch (e) {
        console.log("⚠️ خطأ في الحصول على معلومات المحادثة:", e.message);
      }

      // حفظ أو تحديث المحادثة
      await pool.query(
        `INSERT INTO zzapp_chats (id, name, number, pic, last_message, last_time, updated_at, is_group)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6)
         ON CONFLICT (id) 
         DO UPDATE SET 
           name = COALESCE($2, zzapp_chats.name),
           pic = COALESCE($4, zzapp_chats.pic),
           last_message = $5,
           last_time = NOW(),
           updated_at = NOW(),
           message_count = zzapp_chats.message_count + 1,
           unread_count = zzapp_chats.unread_count + 1`,
        [chatId, chatName, number, contactPic, msg.body || "[وسائط]", isGroup]
      );

      // معالجة الوسائط
      let mediaUrl = null;
      let mediaType = null;

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            const timestamp = Date.now();
            let fileName = '';
            
            if (msg.type === 'image') {
              mediaType = 'image';
              fileName = `img_${timestamp}.jpg`;
              
              // استخدم sharp إذا كان متاحًا، وإلا احفظ الملف مباشرة
              try {
                const sharp = require('sharp');
                const buffer = Buffer.from(media.data, 'base64');
                await sharp(buffer)
                  .jpeg({ quality: 70 })
                  .toFile(path.join(downloadsDir, fileName));
              } catch (e) {
                fs.writeFileSync(
                  path.join(downloadsDir, fileName),
                  Buffer.from(media.data, 'base64')
                );
              }
                
            } else if (msg.type === 'audio' || msg.type === 'ptt') {
              mediaType = 'audio';
              fileName = `audio_${timestamp}.ogg`;
              
              fs.writeFileSync(
                path.join(downloadsDir, fileName),
                Buffer.from(media.data, 'base64')
              );
            } else if (msg.type === 'video') {
              mediaType = 'video';
              fileName = `video_${timestamp}.mp4`;
              
              fs.writeFileSync(
                path.join(downloadsDir, fileName),
                Buffer.from(media.data, 'base64')
              );
            } else if (msg.type === 'document') {
              mediaType = 'document';
              fileName = `doc_${timestamp}_${msg.mediaFilename || 'file'}`;
              
              fs.writeFileSync(
                path.join(downloadsDir, fileName),
                Buffer.from(media.data, 'base64')
              );
            }
            
            if (fileName) {
              mediaUrl = `/downloads/${fileName}`;
            }
          }
        } catch (e) {
          console.log("⚠️ خطأ في حفظ الوسائط:", e.message);
        }
      }

      // حفظ الرسالة
      await pool.query(
        `INSERT INTO zzapp_messages 
         (chat_id, message_id, sender_id, sender_name, sender_number, content, media_url, media_type, is_from_me)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [chatId, 
         msg.id._serialized || 'msg_' + Date.now(), 
         senderId, 
         senderName,
         senderNumber,
         msg.body || "[وسائط]", 
         mediaUrl, 
         mediaType, 
         false]
      );

      // إرسال تحديث للعملاء
      io.emit("chat_update", { 
        id: chatId, 
        name: chatName, 
        number: number, 
        pic: contactPic,
        last_message: msg.body || "[وسائط]",
        updated_at: new Date().toISOString(),
        is_group: isGroup
      });

      io.emit("message", { 
        from: chatId, 
        text: msg.body || "[وسائط]", 
        media: mediaUrl,
        media_type: mediaType,
        timestamp: new Date().toISOString(),
        self: false,
        sender_name: senderName,
        sender_number: senderNumber,
        sender_id: senderId
      });

    } catch (e) {
      console.log("❌ خطأ في معالجة الرسالة:", e.message);
    }
  });

  client.on("disconnected", (reason) => {
    console.log("❌ انقطع الاتصال:", reason);
    isReady = false;
    setTimeout(() => {
      initWhatsApp();
    }, 5000);
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
      initWhatsApp();
    }, 10000);
  }
}

// بدء واتساب
initWhatsApp();

/* ================= SOCKET.IO ================= */
io.on("connection", async (socket) => {
  console.log("👤 مستخدم جديد");

  // إرسال معلومات المستخدم إذا كانت متوفرة
  if (userInfo) {
    socket.emit("user_info", userInfo);
  }

  // التحقق من حالة الاتصال
  if (isReady) {
    socket.emit("ready");
    
    // إرسال المحادثات
    try {
      const chatsRes = await pool.query(
        "SELECT * FROM zzapp_chats ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 50"
      );
      socket.emit("chats", chatsRes.rows);
    } catch (e) {
      console.log("خطأ في تحميل المحادثات:", e.message);
    }
  } else if (qrCode) {
    socket.emit("qr", qrCode);
  } else {
    socket.emit("waiting");
  }

  // طلب الرسائل
  socket.on("get_messages", async (chatId) => {
    try {
      const messagesRes = await pool.query(
        `SELECT * FROM zzapp_messages 
         WHERE chat_id = $1 
         ORDER BY timestamp ASC`,
        [chatId]
      );
      socket.emit("load_messages", messagesRes.rows);
    } catch (e) {
      console.log("خطأ في تحميل الرسائل:", e.message);
    }
  });

  // إرسال رسالة
  socket.on("send_message", async (data) => {
    if (!isReady) {
      socket.emit("error", "واتساب غير متصل");
      return;
    }
    
    try {
      const chatId = data.to.includes('@') ? data.to : `${data.to}@c.us`;
      await client.sendMessage(chatId, data.text);
      
      // الحصول على معلومات المحادثة
      let chatName = extractNumberFromId(chatId);
      let chatPic = null;
      try {
        const contact = await client.getContactById(chatId);
        if (contact) {
          chatName = getContactName(contact, chatId);
          try {
            chatPic = await loadContactPic(contact);
          } catch (e) {}
        }
      } catch (e) {}
      
      // حفظ الرسالة
      await pool.query(
        `INSERT INTO zzapp_messages 
         (chat_id, sender_id, sender_name, sender_number, content, is_from_me)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [chatId, "me", "أنا", "me", data.text, true]
      );

      // تحديث المحادثة
      await pool.query(
        `INSERT INTO zzapp_chats (id, name, number, pic, last_message, last_time, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (id) 
         DO UPDATE SET 
           name = COALESCE($2, zzapp_chats.name),
           pic = COALESCE($4, zzapp_chats.pic),
           last_message = $5,
           last_time = NOW(),
           updated_at = NOW(),
           message_count = COALESCE(zzapp_chats.message_count, 0) + 1`,
        [chatId, chatName, data.to, chatPic, data.text]
      );

      socket.emit("message", { 
        from: data.to, 
        text: data.text, 
        timestamp: new Date().toISOString(),
        self: true,
        sender_name: "أنا",
        sender_number: "me"
      });
      
      // إرسال تحديث للمحادثة
      io.emit("chat_update", {
        id: chatId,
        name: chatName,
        number: data.to,
        pic: chatPic,
        last_message: data.text,
        last_time: new Date().toISOString()
      });

    } catch (error) {
      console.log("❌ فشل إرسال الرسالة:", error.message);
      socket.emit("error", "فشل إرسال الرسالة: " + error.message);
    }
  });

  // إرسال وسائط - معالجة مشكلة Evaluation failed
  socket.on("send_media", async (data) => {
    if (!isReady) {
      socket.emit("error", "واتساب غير متصل");
      return;
    }

    try {
      const chatId = data.to.includes('@') ? data.to : `${data.to}@c.us`;
      const mediaPath = path.join(__dirname, data.filePath.replace(/^\//, ''));
      
      if (!fs.existsSync(mediaPath)) {
        socket.emit("error", "الملف غير موجود");
        return;
      }

      // التحقق من حجم الملف
      const stats = fs.statSync(mediaPath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      
      if (fileSizeInMB > 10) {
        socket.emit("error", "حجم الملف كبير جداً (10MB كحد أقصى)");
        return;
      }

      // إرسال الوسائط بطريقة آمنة
      try {
        const media = MessageMedia.fromFilePath(mediaPath);
        
        // إرسال بدون caption أولاً لتجنب المشاكل
        await client.sendMessage(chatId, media);
        
        // إذا كان هناك caption، نرسله كرسالة منفصلة
        if (data.caption && data.caption.trim() !== "") {
          setTimeout(async () => {
            try {
              await client.sendMessage(chatId, data.caption);
            } catch (e) {}
          }, 500);
        }
      } catch (error) {
        console.log("❌ فشل إرسال الوسائط:", error.message);
        
        // محاولة بديلة: إرسال كملف وثيقة
        try {
          const media = MessageMedia.fromFilePath(mediaPath);
          await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
        } catch (error2) {
          console.log("❌ فشل إرسال الوسائط (المحاولة الثانية):", error2.message);
          socket.emit("error", "فشل إرسال الوسائط");
          return;
        }
      }

      // الحصول على معلومات المحادثة
      let chatName = extractNumberFromId(chatId);
      let chatPic = null;
      try {
        const contact = await client.getContactById(chatId);
        if (contact) {
          chatName = getContactName(contact, chatId);
          try {
            chatPic = await loadContactPic(contact);
          } catch (e) {}
        }
      } catch (e) {}

      await pool.query(
        `INSERT INTO zzapp_messages 
         (chat_id, sender_id, sender_name, sender_number, content, media_url, media_type, is_from_me)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [chatId, "me", "أنا", "me", data.caption || "[وسائط]", data.filePath, data.mediaType, true]
      );

      await pool.query(
        `INSERT INTO zzapp_chats (id, name, number, pic, last_message, last_time, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (id) 
         DO UPDATE SET 
           name = COALESCE($2, zzapp_chats.name),
           pic = COALESCE($4, zzapp_chats.pic),
           last_message = $5,
           last_time = NOW(),
           updated_at = NOW(),
           message_count = COALESCE(zzapp_chats.message_count, 0) + 1`,
        [chatId, chatName, data.to, chatPic, data.caption || "[وسائط]"]
      );

      socket.emit("message", {
        from: data.to,
        text: data.caption || "[وسائط]",
        media: data.filePath,
        media_type: data.mediaType,
        timestamp: new Date().toISOString(),
        self: true,
        sender_name: "أنا",
        sender_number: "me"
      });
      
      io.emit("chat_update", {
        id: chatId,
        name: chatName,
        number: data.to,
        pic: chatPic,
        last_message: data.caption || "[وسائط]",
        last_time: new Date().toISOString()
      });

      // حذف الملف بعد 5 دقائق
      setTimeout(() => {
        if (fs.existsSync(mediaPath)) {
          try {
            fs.unlinkSync(mediaPath);
          } catch (e) {}
        }
      }, 300000);

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
      // تنظيف الرقم
      let cleanNumber = phoneNumber.trim().replace(/\D/g, '');
      
      if (!cleanNumber || cleanNumber.length < 10) {
        socket.emit("error", "رقم الهاتف غير صالح");
        return;
      }
      
      if (cleanNumber.length === 10 && !cleanNumber.startsWith('2')) {
        cleanNumber = '2' + cleanNumber;
      }
      
      const chatId = `${cleanNumber}@c.us`;
      
      // الحصول على معلومات جهة الاتصال
      let contactName = cleanNumber;
      let contactPic = null;
      try {
        const contact = await client.getContactById(chatId);
        if (contact) {
          contactName = getContactName(contact, chatId);
          try {
            contactPic = await loadContactPic(contact);
          } catch (e) {}
        }
      } catch (e) {}
      
      const existing = await pool.query(
        "SELECT * FROM zzapp_chats WHERE id = $1 OR number = $2",
        [chatId, cleanNumber]
      );
      
      let chatData;
      
      if (existing.rows.length > 0) {
        chatData = existing.rows[0];
      } else {
        await pool.query(
          `INSERT INTO zzapp_chats (id, name, number, pic, updated_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [chatId, contactName, cleanNumber, contactPic]
        );
        
        const result = await pool.query(
          "SELECT * FROM zzapp_chats WHERE id = $1",
          [chatId]
        );
        chatData = result.rows[0];
      }

      socket.emit("new_chat_started", {
        id: chatData.id,
        name: chatData.name || contactName,
        number: chatData.number || cleanNumber,
        pic: chatData.pic || contactPic,
        last_message: "ابدأ المحادثة",
        last_time: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      io.emit("chat_update", {
        id: chatData.id,
        name: chatData.name || contactName,
        number: chatData.number || cleanNumber,
        pic: chatData.pic || contactPic,
        updated_at: new Date().toISOString()
      });

    } catch (error) {
      console.log("❌ خطأ في بدء محادثة جديدة:", error.message);
      socket.emit("error", "فشل بدء المحادثة");
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
      
      // تحويل base64 إلى ملف
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
        socket.emit("logged_out");
        console.log("👋 تم تسجيل الخروج");
        
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
  res.json({ 
    success: true, 
    filePath: `/uploads/${req.file.filename}` 
  });
});

// رفع صوت مباشر
app.post("/upload_voice", upload.single('voice'), (req, res) => {
  res.json({ 
    success: true, 
    filePath: `/uploads/${req.file.filename}` 
  });
});

// حفظ صوت من base64
app.post("/save_voice", express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { audioData, fileName } = req.body;
    
    if (!audioData) {
      return res.status(400).json({ success: false, error: "لا توجد بيانات صوتية" });
    }
    
    // تحويل base64 إلى ملف
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

app.get("/messages/:chatId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM zzapp_messages 
       WHERE chat_id = $1 
       ORDER BY timestamp ASC`,
      [req.params.chatId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/chats", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM zzapp_chats ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST LIMIT 50"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
});

app.get("/status", (req, res) => {
  res.json({
    isReady: isReady,
    hasQr: !!qrCode
  });
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
});
