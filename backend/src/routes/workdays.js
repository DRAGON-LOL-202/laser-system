const express = require('express');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');

// ترتيب الأيام الثابت: الجمعة → الخميس (يطابق ENUM day_name في قاعدة البيانات)
const DAY_ORDER = ['fri', 'sat', 'sun', 'mon', 'tue', 'wed', 'thu'];

module.exports = (io) => {
  const router = express.Router();
  router.use(authenticate); // القراءة متاحة لأي مستخدم مسجّل دخول (لا كتابة هنا؛ الخانات ثابتة ومزروعة مسبقًا)

  // -------- الشبكة الثابتة: 4 أسابيع × 7 أيام (28 خانة مستقلة) --------
  // كل خانة (week_number, day_name) لها id ثابت دائم؛ machine_files.work_day_id يشاور عليه.
  // لا إنشاء ولا حذف لخانات هنا — الشبكة مزروعة مسبقًا عبر migration_day_week_independence.sql.
  router.get('/grid', async (req, res) => {
    try {
      const [weeks] = await pool.query('SELECT id, week_number FROM work_weeks ORDER BY week_number ASC');
      const [days] = await pool.query('SELECT id, week_id, day_name FROM work_days ORDER BY week_id ASC');

      const daysByWeek = {};
      for (const d of days) {
        (daysByWeek[d.week_id] ||= []).push({ id: d.id, dayName: d.day_name });
      }

      const grid = weeks.map(w => ({
        weekId: w.id,
        weekNumber: w.week_number,
        days: DAY_ORDER
          .map(name => (daysByWeek[w.id] || []).find(d => d.dayName === name))
          .filter(Boolean)
      }));

      res.json(grid);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // -------- الأسابيع (قراءة فقط — الأربعة أسابيع ثابتة ومزروعة مسبقًا) --------
  router.get('/weeks', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM work_weeks ORDER BY week_number ASC');
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
