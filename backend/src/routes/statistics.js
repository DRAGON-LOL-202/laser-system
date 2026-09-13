const express = require('express');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { secondsToTime, addDaysToDateStr, splitIntervalByDay } = require('../utils/time');

// صفحة Statistics مخصَّصة للمشرف فقط حاليًا (نفس نمط users/logs/workdays في هذا المشروع)
//
// 🆕 قاعدة منتصف الليل (Midnight Rule) — القرار النهائي المطبَّق فعليًا هنا:
// أي فترة (تشغيل ماكينة من machine_runtime_logs، أو جلسة مشغّل من operator_sessions)
// تُقسَّم على مستوى الثانية بين كل الأيام التقويمية التي تمر بها فعليًا، بدل نسب
// المدة كاملة ليوم البداية فقط. نفس المنطق يُطبَّق أيضًا على حدود المدى نفسه
// (بداية/نهاية الأسبوع أو الشهر): أي فترة تبدأ قبل المدى أو تنتهي بعده تُقصّ على
// حدود المدى بدل استبعادها بالكامل أو احتساب جزء خارج المدى بالخطأ. التقسيم يتم في
// الكود (utils/time.js -> splitIntervalByDay) على نصوص DATETIME خام (dateStrings:
// true) بدون أي تحويل Date عبر الـdriver، تفاديًا لأي انزياح منطقة زمنية.
module.exports = () => {
  const router = express.Router();
  router.use(authenticate, requireAdmin);

  // يحسب مدى half-open [start, end) فعلي (DATETIME كنص) بحسب scope=week|month.
  // end دائمًا "اليوم التالي لآخر يوم في المدى الساعة 00:00:00" (وليس 23:59:59
  // لآخر يوم) حتى تصير مقارنات التداخل (start < end) بسيطة وصحيحة عند القصّ.
  async function resolveRange(query) {
    const { scope, weekId, year, month } = query;
    if (scope === 'week') {
      const id = parseInt(weekId, 10);
      if (!id) return { error: 'weekId مطلوب لنوع week' };
      const [rows] = await pool.query(
        `SELECT week_number, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, DATE_FORMAT(end_date,'%Y-%m-%d') AS end_date
         FROM work_weeks WHERE id = ?`,
        [id]
      );
      const week = rows[0];
      if (!week) return { error: 'الأسبوع غير موجود' };
      return {
        start: `${week.start_date} 00:00:00`,
        end: `${addDaysToDateStr(week.end_date, 1)} 00:00:00`,
        label: `الأسبوع ${week.week_number} (${week.start_date} — ${week.end_date})`
      };
    }
    if (scope === 'month') {
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      if (!y || !m || m < 1 || m > 12) return { error: 'year و month صالحان مطلوبان لنوع month' };
      const mm = String(m).padStart(2, '0');
      const startDate = `${y}-${mm}-01`;
      const nextM = m === 12 ? 1 : m + 1;
      const nextY = m === 12 ? y + 1 : y;
      const endDate = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
      return { start: `${startDate} 00:00:00`, end: `${endDate} 00:00:00`, label: `${y}-${mm}` };
    }
    return { error: "scope يجب أن يكون 'week' أو 'month'" };
  }

  // إحصائيات وقت تشغيل الماكينات الفعلي (Runtime حقيقي من machine_runtime_logs)
  router.get('/machines', async (req, res) => {
    try {
      const range = await resolveRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });

      // نجلب كل الدورات التي تتقاطع زمنيًا مع المدى (حتى لو بدأت قبله أو انتهت
      // بعده) — القصّ الفعلي يحدث لاحقًا في splitIntervalByDay، وليس هنا.
      // dateStrings صراحةً لتفادي أي تحويل Date عبر الـdriver.
      const [rows] = await pool.query(
        {
          sql: `SELECT l.id, m.code,
                       l.started_at AS started_at, l.stopped_at AS stopped_at
                FROM machine_runtime_logs l
                JOIN machines m ON m.id = l.machine_id
                WHERE m.code IN ('big','small') AND l.started_at < ? AND l.stopped_at > ?`,
          dateStrings: true
        },
        [range.end, range.start]
      );

      const totalsByCode = { big: { totalSeconds: 0, runs: 0 }, small: { totalSeconds: 0, runs: 0 } };
      const dayMap = {};

      for (const row of rows) {
        const segments = splitIntervalByDay(row.started_at, row.stopped_at, range.start, range.end);
        if (segments.length === 0) continue;
        totalsByCode[row.code].runs += 1;
        for (const seg of segments) {
          totalsByCode[row.code].totalSeconds += seg.seconds;
          if (!dayMap[seg.date]) dayMap[seg.date] = { date: seg.date, big: 0, small: 0 };
          dayMap[seg.date][row.code] += seg.seconds;
        }
      }

      const [labelRows] = await pool.query(
        `SELECT code, label FROM machines WHERE code IN ('big','small')`
      );
      const labelByCode = Object.fromEntries(labelRows.map(r => [r.code, r.label]));

      res.json({
        label: range.label,
        machines: ['big', 'small'].map(code => ({
          code,
          label: labelByCode[code] || code,
          totalSeconds: totalsByCode[code].totalSeconds,
          total: secondsToTime(totalsByCode[code].totalSeconds),
          runs: totalsByCode[code].runs
        })),
        daily: Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date))
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // إحصائيات جلسات المشغّلين (حضور/انصراف — من operator_sessions، role='operator' فقط)
  router.get('/operators', async (req, res) => {
    try {
      const range = await resolveRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });

      // كل المشغّلين أولًا (حتى من لا جلسات له = صفوف صفرية)
      const [users] = await pool.query(`SELECT id, name FROM users WHERE role = 'operator'`);
      const totalsByUser = {};
      for (const u of users) totalsByUser[u.id] = { userId: u.id, name: u.name, totalSeconds: 0, closedSessions: 0, openSessions: 0 };

      // الجلسات المغلقة فقط (logout_at IS NOT NULL) تتقاطع مع المدى — تُقسَّم/تُقصّ
      // بنفس منطق الماكينات بالضبط.
      const [closedRows] = await pool.query(
        {
          sql: `SELECT s.user_id, s.login_at AS login_at, s.logout_at AS logout_at
                FROM operator_sessions s
                WHERE s.logout_at IS NOT NULL AND s.login_at < ? AND s.logout_at > ?`,
          dateStrings: true
        },
        [range.end, range.start]
      );
      for (const row of closedRows) {
        if (!totalsByUser[row.user_id]) continue; // مستخدم محذوف أو غير operator حاليًا
        const segments = splitIntervalByDay(row.login_at, row.logout_at, range.start, range.end);
        if (segments.length === 0) continue;
        totalsByUser[row.user_id].closedSessions += 1;
        for (const seg of segments) totalsByUser[row.user_id].totalSeconds += seg.seconds;
      }

      // الجلسات المفتوحة (لم تُغلَق بعد) — تُحسَب فقط للعدّ (كما كان)، تُستبعد من
      // الإجمالي لأنه لا نهاية حقيقية معروفة لها بعد. تُحتسَب هنا لو بدأت داخل المدى.
      const [openRows] = await pool.query(
        `SELECT user_id, COUNT(*) AS c FROM operator_sessions
         WHERE logout_at IS NULL AND login_at >= ? AND login_at < ?
         GROUP BY user_id`,
        [range.start, range.end]
      );
      for (const row of openRows) {
        if (!totalsByUser[row.user_id]) continue;
        totalsByUser[row.user_id].openSessions += row.c;
      }

      const operators = Object.values(totalsByUser)
        .map(o => ({ ...o, total: secondsToTime(o.totalSeconds) }))
        .sort((a, b) => b.totalSeconds - a.totalSeconds);

      res.json({ label: range.label, operators });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
