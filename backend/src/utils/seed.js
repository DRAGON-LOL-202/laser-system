// سكريبت تهيئة أولي: يضمن وجود المشرف الرئيسي بكلمة مرور مشفّرة بشكل صحيح
// شغّله مرة واحدة بعد إنشاء قاعدة البيانات: npm run seed
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
require('dotenv').config();

async function seed() {
  try {
    const hash = await bcrypt.hash('214205', 10);

    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', ['lol']);

    if (existing.length > 0) {
      await pool.query('UPDATE users SET password = ?, is_root = 1, role = "admin" WHERE username = ?', [hash, 'lol']);
      console.log('✓ تم تحديث كلمة مرور المشرف الرئيسي بنجاح');
    } else {
      await pool.query(
        'INSERT INTO users (name, username, password, role, is_root) VALUES (?,?,?,?,?)',
        ['المشرف الرئيسي', 'lol', hash, 'admin', 1]
      );
      console.log('✓ تم إنشاء المشرف الرئيسي بنجاح');
    }

    console.log('  اسم المستخدم: lol');
    console.log('  كلمة المرور: 214205');
    console.log('  (يفضّل تغييرها بعد أول تسجيل دخول)');
    process.exit(0);
  } catch (err) {
    console.error('✗ خطأ في التهيئة:', err.message);
    process.exit(1);
  }
}

seed();
