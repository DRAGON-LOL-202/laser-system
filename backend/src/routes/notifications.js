const express = require('express');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const VALID_TYPES = ['machine', 'file', 'workday'];
const MAX_PAGE_LIMIT = 100;

module.exports = () => {
  const router = express.Router();
  router.use(authenticate);

  // جلب آخر الإشعارات (بدون تصنيف/صفحات) — تُستخدَم فقط من جرس الإشعارات
  // (القائمة المنسدلة) في أعلى الواجهة. لم يتغيّر شكل الاستجابة (مصفوفة مباشرة)
  // حتى لا يُكسَر أي كود Frontend قديم يعتمد عليه.
  router.get('/', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 30');
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // صفحة كاملة لكل الإشعارات — تدعم الفلترة حسب النوع (machine/file/workday) والصفحات.
  // ملاحظة ترتيب: يجب أن يبقى هذا المسار مُعرَّفاً كـ'/all' (نص ثابت)، لا يوجد أي
  // مسار عام بصيغة '/:id' في هذا الملف، فلا تعارض في الترتيب مثل bulk-move/bulk-delete
  // في machines.js — لكن أي مسار عام يُضاف مستقبلاً يجب أن يأتي بعد '/all'.
  router.get('/all', async (req, res) => {
    try {
      const { type, page, limit } = req.query;

      const conditions = [];
      const params = [];
      if (type && VALID_TYPES.includes(type)) {
        conditions.push('type = ?');
        params.push(type);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const [rows] = await pool.query(
        `SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
      );
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM notifications ${where}`,
        params
      );

      res.json({
        items: rows,
        total: countRows[0].total,
        page: pageNum,
        limit: limitNum
      });
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
