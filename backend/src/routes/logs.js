const express = require('express');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');

module.exports = () => {
  const router = express.Router();
  router.use(authenticate);

  // جلب السجل: المشرف الرئيسي يرى الكل، غيره يرى سجلاته فقط
  router.get('/', async (req, res) => {
    try {
      let rows;
      if (req.user.isRoot) {
        [rows] = await pool.query(
          `SELECT l.*, u.name AS user_name FROM logs l
           LEFT JOIN users u ON u.id = l.user_id
           ORDER BY l.id DESC LIMIT 200`
        );
      } else {
        [rows] = await pool.query(
          `SELECT l.*, u.name AS user_name FROM logs l
           LEFT JOIN users u ON u.id = l.user_id
           WHERE l.user_id = ?
           ORDER BY l.id DESC LIMIT 200`,
          [req.user.id]
        );
      }
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
