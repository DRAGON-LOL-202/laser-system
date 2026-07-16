const mysql = require('mysql2/promise');
require('dotenv').config();

// حوض اتصالات (Connection Pool) لقاعدة البيانات
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'laser_cnc_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci'
});

// اختبار الاتصال عند بدء التشغيل
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✓ تم الاتصال بقاعدة البيانات بنجاح');
    conn.release();
  } catch (err) {
    console.error('✗ فشل الاتصال بقاعدة البيانات:', err.message);
    console.error('  تأكد من صحة بيانات الاتصال في ملف .env');
  }
}

module.exports = { pool, testConnection };
