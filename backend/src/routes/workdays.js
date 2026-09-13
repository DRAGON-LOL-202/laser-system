const express = require('express');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { addLog, addNotification } = require('../utils/events');

// أسبوع العمل عندنا 6 أيام (بدون الجمعة) — يطابق ENUM day_name في قاعدة البيانات
const DAY_NAME_BY_JS_DAY = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: null /* الجمعة */, 6: 'sat' };

// يحسب اسم اليوم من تاريخ 'YYYY-MM-DD' بدون أي إزاحة توقيت (نتعامل مع التاريخ كسلسلة/UTC فقط)
function dayNameFromDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  return DAY_NAME_BY_JS_DAY[d.getUTCDay()] ?? null;
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = (io) => {
  const router = express.Router();
  router.use(authenticate); // القراءة متاحة لأي مستخدم مسجّل دخول؛ الكتابة تتطلب requireAdmin أدناه

  // -------- أيام العمل --------

  // جلب كل أيام العمل (الأحدث أولاً)، مع رقم الأسبوع إن وُجد
  router.get('/days', async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT wd.*, ww.week_number, ww.start_date AS week_start, ww.end_date AS week_end
         FROM work_days wd
         LEFT JOIN work_weeks ww ON ww.id = wd.week_id
         ORDER BY wd.work_date DESC
         LIMIT 200`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // جلب يوم العمل النشط حالياً (أو null إن لم يوجد)
  router.get('/days/active', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM work_days WHERE is_active = 1 LIMIT 1');
      res.json(rows[0] || null);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // بدء يوم عمل جديد (مشرف فقط) — يُنشئ الصف إن لم يكن موجوداً، ويجعله النشط الوحيد.
  // ملاحظة معمارية: هذا Tag تاريخي فقط — لا يُنسَخ أي صف من machine_files هنا ولا يُقفَل شيء.
  router.post('/days', requireAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const workDate = (req.body?.date || todayDateStr()).slice(0, 10);
      const dayName = dayNameFromDateStr(workDate);

      if (!dayName) {
        return res.status(400).json({ error: 'تاريخ غير صالح أو يوافق الجمعة (يوم عطلة، ليس ضمن أيام العمل الستة)' });
      }

      await conn.beginTransaction();

      // إيجاد أسبوع يحتوي هذا التاريخ إن وُجد (ربط تلقائي، بدون إلزام بوجوده)
      const [weekRows] = await conn.query(
        'SELECT id FROM work_weeks WHERE start_date <= ? AND end_date >= ? LIMIT 1',
        [workDate, workDate]
      );
      const weekId = weekRows[0]?.id || null;

      // تصفير أي يوم نشط سابق أولاً (ضمان أن صفاً واحداً فقط is_active=1 في كل وقت — منطق تطبيق، لا قيد DB)
      await conn.query('UPDATE work_days SET is_active = 0 WHERE is_active = 1');

      // إن كان اليوم موجوداً بالفعل (تاريخ مُكرَّر)، فعّله بدل إنشاء صف جديد (upsert آمن بدون فقدان أي شيء)
      await conn.query(
        `INSERT INTO work_days (work_date, day_name, week_id, is_active)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE is_active = 1, week_id = VALUES(week_id)`,
        [workDate, dayName, weekId]
      );

      const [rows] = await conn.query('SELECT * FROM work_days WHERE work_date = ?', [workDate]);
      const day = rows[0];

      await conn.commit();

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — بدء يوم عمل جديد: ${workDate}`,
        type: 'success'
      });
      await addNotification(io, `تم بدء يوم عمل جديد: ${workDate}`, 'workday');
      io.emit('workday:update', day);

      res.json(day);
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    } finally {
      conn.release();
    }
  });

  // إغلاق يوم عمل (مشرف فقط) — فقط يفرّغ is_active، لا يحذف الصف ولا يمس أي ملف
  router.patch('/days/:id/close', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await pool.query('UPDATE work_days SET is_active = 0 WHERE id = ? AND is_active = 1', [id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'اليوم غير موجود أو ليس نشطاً بالفعل' });
      }
      const [rows] = await pool.query('SELECT * FROM work_days WHERE id = ?', [id]);
      const day = rows[0];

      await addLog(io, { userId: req.user.id, event: `${req.user.name} — إغلاق يوم العمل: ${day.work_date}`, type: 'info' });
      io.emit('workday:update', day);

      res.json(day);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // -------- الأسابيع --------

  // جلب كل الأسابيع (الأحدث أولاً)
  router.get('/weeks', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM work_weeks ORDER BY start_date DESC LIMIT 100');
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // جلب أسبوع واحد مع أيام العمل المرتبطة به
  router.get('/weeks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const [weekRows] = await pool.query('SELECT * FROM work_weeks WHERE id = ?', [id]);
      const week = weekRows[0];
      if (!week) return res.status(404).json({ error: 'الأسبوع غير موجود' });

      const [days] = await pool.query('SELECT * FROM work_days WHERE week_id = ? ORDER BY work_date ASC', [id]);
      res.json({ ...week, days });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // إنشاء أسبوع جديد بتواريخ بداية/نهاية فعلية (مشرف فقط)
  router.post('/weeks', requireAdmin, async (req, res) => {
    try {
      const { weekNumber, startDate, endDate } = req.body || {};
      if (!weekNumber || !startDate || !endDate) {
        return res.status(400).json({ error: 'weekNumber و startDate و endDate كلها مطلوبة' });
      }
      if (new Date(startDate) > new Date(endDate)) {
        return res.status(400).json({ error: 'تاريخ البداية يجب أن يسبق تاريخ النهاية' });
      }

      const [result] = await pool.query(
        'INSERT INTO work_weeks (week_number, start_date, end_date) VALUES (?,?,?)',
        [weekNumber, startDate, endDate]
      );
      const [rows] = await pool.query('SELECT * FROM work_weeks WHERE id = ?', [result.insertId]);
      const week = rows[0];

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — إنشاء أسبوع جديد: ${startDate} إلى ${endDate}`,
        type: 'success'
      });
      io.emit('workweek:new', week);

      res.status(201).json(week);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'يوجد أسبوع بنفس تاريخ البداية بالفعل' });
      }
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
