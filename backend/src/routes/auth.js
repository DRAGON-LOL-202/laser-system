const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { addLog } = require('../utils/events');

module.exports = (io) => {
  const router = express.Router();

  // تسجيل الدخول
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'الرجاء إدخال البيانات' });
      }

      const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
      const user = rows[0];

      if (!user) {
        return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
      }

      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
      }

      const payload = {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        isRoot: !!user.is_root
      };

      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d'
      });

      await addLog(io, { userId: user.id, event: `تسجيل دخول: ${user.name}`, type: 'info' });

      // فتح جلسة حضور جديدة (لإحصائيات Operator Sessions) — لا تُغلَق أي جلسة سابقة مفتوحة
      // تلقائيًا هنا تجنّبًا لاختلاق وقت خروج غير حقيقي (انظر ملاحظة في database.sql)
      await pool.query('INSERT INTO operator_sessions (user_id, login_at) VALUES (?, NOW())', [user.id]);

      res.json({ token, user: payload });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // الحصول على بيانات المستخدم الحالي (لتحقق الجلسة عند تحميل الصفحة)
  router.get('/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  // تسجيل الخروج (تسجيل في اللوج + إغلاق جلسة الحضور المفتوحة لهذا المستخدم)
  router.post('/logout', authenticate, async (req, res) => {
    await addLog(io, { userId: req.user.id, event: `تسجيل خروج: ${req.user.name}`, type: 'info' });

    // إغلاق آخر جلسة مفتوحة (logout_at IS NULL) لهذا المستخدم فقط، إن وُجدت
    const [openSessions] = await pool.query(
      'SELECT id FROM operator_sessions WHERE user_id = ? AND logout_at IS NULL ORDER BY id DESC LIMIT 1',
      [req.user.id]
    );
    if (openSessions[0]) {
      await pool.query(
        'UPDATE operator_sessions SET logout_at = NOW(), duration_seconds = TIMESTAMPDIFF(SECOND, login_at, NOW()) WHERE id = ?',
        [openSessions[0].id]
      );
    }

    res.json({ ok: true });
  });

  return router;
};
