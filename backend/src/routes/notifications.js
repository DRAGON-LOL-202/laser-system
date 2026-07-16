const express = require('express');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');

module.exports = () => {
  const router = express.Router();
  router.use(authenticate);

  // جلب آخر الإشعارات
  router.get('/', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 30');
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تحديد الكل كمقروء
  router.patch('/read-all', async (req, res) => {
    try {
      await pool.query('UPDATE notifications SET is_read = 1');
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
