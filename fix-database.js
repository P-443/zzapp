const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:6DQNh71sjOwHWwi5VYvGGZDtx5GpsdXRz6DWQKb7mBy9fwHNTn9X21yAJy05A14v@31.97.47.20:5433/postgres',
  ssl: {
    rejectUnauthorized: false,
    require: true
  }
});

async function fixDatabase() {
  try {
    console.log('🔧 جاري إصلاح قاعدة البيانات...');
    
    // 1. حذف السجلات المكررة
    console.log('🗑️  حذف السجلات المكررة...');
    await pool.query(`
      DELETE FROM zzapp_chats 
      WHERE ctid IN (
        SELECT ctid FROM (
          SELECT ctid, 
            ROW_NUMBER() OVER (PARTITION BY id, COALESCE(session_id, 'default') ORDER BY updated_at DESC) as rn
          FROM zzapp_chats
        ) t 
        WHERE t.rn > 1
      )
    `);
    
    // 2. ضمان أن جميع السجلات لها session_id
    console.log('🆔 إضافة session_id للمحادثات المفقودة...');
    await pool.query(`
      UPDATE zzapp_chats 
      SET session_id = COALESCE(session_id, 'default_session_' || id)
      WHERE session_id IS NULL
    `);
    
    // 3. إصلاح المفتاح الأساسي
    console.log('🔑 إصلاح المفتاح الأساسي...');
    
    // إسقاط المفتاح الأساسي القديم
    try {
      await pool.query(`ALTER TABLE zzapp_chats DROP CONSTRAINT IF EXISTS zzapp_chats_pkey CASCADE`);
    } catch (e) {
      console.log('⚠️ لا يمكن إسقاط المفتاح الأساسي القديم:', e.message);
    }
    
    // إنشاء مفتاح أساسي جديد
    await pool.query(`
      ALTER TABLE zzapp_chats 
      ADD PRIMARY KEY (id, session_id)
    `);
    
    // 4. إضافة الفهارس
    console.log('📊 إضافة الفهارس...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chats_session ON zzapp_chats(session_id);
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON zzapp_chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_session ON zzapp_messages(chat_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON zzapp_messages(timestamp DESC);
    `);
    
    console.log('✅ تم إصلاح قاعدة البيانات بنجاح!');
    
  } catch (error) {
    console.error('❌ خطأ في إصلاح قاعدة البيانات:', error.message);
  } finally {
    await pool.end();
  }
}

fixDatabase();
