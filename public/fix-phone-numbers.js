const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:6DQNh71sjOwHWwi5VYvGGZDtx5GpsdXRz6DWQKb7mBy9fwHNTn9X21yAJy05A14v@31.97.47.20:5433/postgres',
  ssl: {
    rejectUnauthorized: false,
    require: true
  }
});

async function fixPhoneNumbers() {
  try {
    console.log('🔧 جاري إصلاح تنسيق الأرقام...');
    
    // 1. تحويل جميع الأرقام إلى صيغة موحدة
    console.log('📞 جاري تحويل تنسيق الأرقام...');
    
    // تحديث الأرقام في جدول المحادثات
    const chats = await pool.query('SELECT id, number FROM zzapp_chats WHERE number IS NOT NULL');
    
    for (const chat of chats.rows) {
      try {
        let cleanNumber = chat.number.toString().replace(/\D/g, '');
        
        // إضافة رمز الدولة إذا كان الرقم 10 أرقام وليس فيه 2
        if (cleanNumber.length === 10 && !cleanNumber.startsWith('2')) {
          cleanNumber = '2' + cleanNumber;
        }
        
        // تحقق من صحة الرقم
        if (/^2\d{10}$/.test(cleanNumber)) {
          await pool.query(
            'UPDATE zzapp_chats SET number = $1 WHERE id = $2',
            [cleanNumber, chat.id]
          );
          console.log(`✅ تم إصلاح الرقم: ${chat.number} → ${cleanNumber}`);
        }
      } catch (error) {
        console.log(`⚠️ خطأ في إصلاح الرقم ${chat.number}:`, error.message);
      }
    }
    
    // 2. تحديث الأرقام في جدول الرسائل
    const messages = await pool.query('SELECT id, sender_number FROM zzapp_messages WHERE sender_number IS NOT NULL');
    
    for (const msg of messages.rows) {
      try {
        let cleanNumber = msg.sender_number.toString().replace(/\D/g, '');
        
        if (cleanNumber.length === 10 && !cleanNumber.startsWith('2')) {
          cleanNumber = '2' + cleanNumber;
        }
        
        if (/^2\d{10}$/.test(cleanNumber)) {
          await pool.query(
            'UPDATE zzapp_messages SET sender_number = $1 WHERE id = $2',
            [cleanNumber, msg.id]
          );
          console.log(`✅ تم إصلاح رقم المرسل: ${msg.sender_number} → ${cleanNumber}`);
        }
      } catch (error) {
        console.log(`⚠️ خطأ في إصلاح رقم المرسل ${msg.sender_number}:`, error.message);
      }
    }
    
    console.log('✅ تم إصلاح تنسيق الأرقام بنجاح!');
    
  } catch (error) {
    console.error('❌ خطأ في إصلاح الأرقام:', error.message);
  } finally {
    await pool.end();
  }
}

fixPhoneNumbers();
