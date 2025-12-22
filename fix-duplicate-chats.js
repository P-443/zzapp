const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:6DQNh71sjOwHWwi5VYvGGZDtx5GpsdXRz6DWQKb7mBy9fwHNTn9X21yAJy05A14v@31.97.47.20:5433/postgres',
  ssl: {
    rejectUnauthorized: false,
    require: true
  }
});

async function fixDuplicateChats() {
  try {
    console.log('🔧 جاري إصلاح المحادثات المكررة...');
    
    // 1. العثور على جميع المحادثات المكررة
    console.log('🔍 البحث عن المحادثات المكررة...');
    
    const duplicates = await pool.query(`
      WITH ranked_chats AS (
        SELECT 
          id,
          number,
          session_id,
          name,
          display_name,
          last_message,
          last_time,
          updated_at,
          ROW_NUMBER() OVER (PARTITION BY number, session_id ORDER BY updated_at DESC) as rn
        FROM zzapp_chats
        WHERE number IS NOT NULL AND number != 'جهة اتصال' AND number != 'مجموعة'
      )
      SELECT * FROM ranked_chats WHERE rn > 1
    `);
    
    console.log(`📱 تم العثور على ${duplicates.rows.length} محادثة مكررة`);
    
    // 2. تحديث المحادثات المكررة
    for (const duplicate of duplicates.rows) {
      try {
        // تحديث المحادثة الأقدم لتكون duplicate = true
        await pool.query(`
          UPDATE zzapp_chats 
          SET is_duplicate = true 
          WHERE number = $1 
            AND session_id = $2 
            AND updated_at < $3
            AND is_duplicate = false
        `, [duplicate.number, duplicate.session_id, duplicate.updated_at]);
        
        console.log(`✅ تم إصلاح المحادثة المكررة للرقم: ${duplicate.number}`);
      } catch (error) {
        console.log(`⚠️ خطأ في إصلاح المحادثة ${duplicate.number}:`, error.message);
      }
    }
    
    // 3. حذف المحادثات المكررة تماماً إذا كانت فارغة
    console.log('🗑️ جاري حذف المحادثات المكررة الفارغة...');
    
    await pool.query(`
      DELETE FROM zzapp_chats 
      WHERE is_duplicate = true 
        AND (last_message IS NULL OR last_message = 'لا توجد رسائل' OR last_message = 'ابدأ المحادثة')
        AND message_count = 0
    `);
    
    console.log('✅ تم إصلاح المحادثات المكررة بنجاح!');
    
  } catch (error) {
    console.error('❌ خطأ في إصلاح المحادثات المكررة:', error.message);
  } finally {
    await pool.end();
  }
}

fixDuplicateChats();
