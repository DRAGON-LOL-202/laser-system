const express = require('express');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { addLog } = require('../utils/events');
const { secondsToTime, addDaysToDateStr, splitIntervalByDay } = require('../utils/time');

// صفحة Statistics مخصَّصة للمشرف فقط حاليًا (نفس نمط users/logs/workdays في هذا المشروع)
//
// 🆕 مصدر إحصائيات "وقت تشغيل الماكينات" (GET /machines) هو الآن File Time
// (machine_files.time_seconds + file_time_archive)، وليس machine_runtime_logs —
// انظر التوثيق أعلى مسار /machines أدناه وHANDOFF.md لتفاصيل القرار والسبب.
//
// قاعدة منتصف الليل (Midnight Rule) — ما زالت مطبَّقة فقط على جلسات المشغّلين
// (operator_sessions في مسار /operators أدناه، عبر فترة login_at→logout_at):
// أي جلسة تُقسَّم على مستوى الثانية بين كل الأيام التقويمية التي تمر بها فعليًا،
// بدل نسب المدة كاملة ليوم البداية فقط. نفس المنطق يُطبَّق أيضًا على حدود المدى
// نفسه (بداية/نهاية الأسبوع أو الشهر): أي فترة تبدأ قبل المدى أو تنتهي بعده تُقصّ
// على حدود المدى بدل استبعادها بالكامل أو احتساب جزء خارج المدى بالخطأ. التقسيم
// يتم في الكود (utils/time.js -> splitIntervalByDay) على نصوص DATETIME خام
// (dateStrings: true) بدون أي تحويل Date عبر الـdriver، تفاديًا لأي انزياح منطقة زمنية.
// إحصائيات الماكينات (/machines) لا تحتاج هذا التقسيم لأن كل وقت ملف نقطة زمنية
// واحدة (time_recorded_at)، لا فترة بداية/نهاية.
module.exports = (io) => {
  const router = express.Router();
  router.use(authenticate, requireAdmin);

  // 🆕 (إصلاح القيد الموثّق في HANDOFF §21 "Bugs"): بعد تحويل work_weeks إلى
  // 4 خانات ثابتة (Week 1-4) بدون start_date/end_date حقيقيين، لم يعد ممكنًا
  // ربط الإحصائيات الأسبوعية بـweekId. الحل المطبَّق هنا (مطابق للتصميم
  // المرجعي المرسل الذي يعرض مدى تاريخ حقيقي "17-09-2026 → 13-09-2026" وليس
  // "الأسبوع 1/2/3/4"): الإحصائيات الأسبوعية تعتمد الآن على أسبوع تقويمي حقيقي
  // (الجمعة → الخميس) محسوب من `weekStart` (تاريخ الجمعة، YYYY-MM-DD) القادم
  // من الواجهة، بدل الاعتماد على الشبكة الوهمية. هذا مستقل تمامًا عن نموذج
  // Week1-4/WAITING transfer في machine_files (ذاك لا علاقة له بالإحصائيات).
  function resolveWeekStart(dateStr) {
    // يرجع تاريخ أقرب جمعة <= dateStr (أو اليوم الحالي لو لم يُمرَّر تاريخ)
    const base = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
    const day = base.getUTCDay(); // 0=Sun..6=Sat, الجمعة=5
    const diff = (day - 5 + 7) % 7; // كم يومًا رجّع لآخر جمعة
    const y = base.getUTCFullYear(), mo = base.getUTCMonth(), d = base.getUTCDate();
    return msToDateStrUTC(Date.UTC(y, mo, d - diff));
  }
  function msToDateStrUTC(ms) {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }

  // يحسب مدى half-open [start, end) فعلي (DATETIME كنص) بحسب scope=week|month.
  // end دائمًا "اليوم التالي لآخر يوم في المدى الساعة 00:00:00" (وليس 23:59:59
  // لآخر يوم) حتى تصير مقارنات التداخل (start < end) بسيطة وصحيحة عند القصّ.
  async function resolveRange(query) {
    const { scope, weekStart, year, month } = query;
    if (scope === 'week') {
      const start = resolveWeekStart(weekStart);
      const end = addDaysToDateStr(start, 7);
      const endLabel = addDaysToDateStr(start, 6);
      return {
        start: `${start} 00:00:00`,
        end: `${end} 00:00:00`,
        weekStart: start,
        label: `الأسبوع (${endLabel} — ${start})`
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

  // إحصائيات وقت تشغيل الماكينات
  // 🆕 (قرار مستخدم صريح — انظر HANDOFF.md "تصحيح مصدر الإحصائيات"): المصدر الآن
  // هو "وقت الملف" (machine_files.time_seconds) — أي نفس الرقم الظاهر في بطاقة
  // الماكينة تحت "مجموع وقت الملفات" — وليس machine_runtime_logs ولا زر
  // تسجيل بدء/توقف التشغيل. machine_runtime_logs يبقى موجودًا في قاعدة البيانات
  // بلا حذف، لكنه لم يعد مصدر بيانات لهذا المسار إطلاقًا.
  // كل ملف وقتُه نقطة زمنية واحدة (time_recorded_at) لا فترة بداية/نهاية، لذلك
  // لا حاجة لـsplitIntervalByDay هنا (تلك تبقى مستخدمة فقط في /operators أدناه).
  // نجمع من مصدرين معًا: machine_files الحيّة (ملفات لم تُحذف بعد) + file_time_archive
  // (ملفات حُذفت سابقًا عبر حذف فردي/جماعي/Cleanup لكن أُرشِف وقتها قبل الحذف)،
  // حتى لا تفقد الإحصائيات بياناتها التاريخية بعد أي حذف/Cleanup.
  // 🆕 فلتر اختياري machineCode (HANDOFF §11) — لو غاب، تُحسَب كل الماكينات (big/small).
  router.get('/machines', async (req, res) => {
    try {
      const range = await resolveRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const { machineCode } = req.query;
      const codeFilter = (machineCode === 'big' || machineCode === 'small') ? machineCode : null;

      // dateStrings صراحةً لتفادي أي تحويل Date عبر الـdriver (نفس نمط بقية الملف).
      const [liveRows] = await pool.query(
        {
          sql: `SELECT m.code, mf.time_seconds AS seconds,
                       COALESCE(mf.time_recorded_at, mf.created_at) AS recorded_at
                FROM machine_files mf
                JOIN machines m ON m.id = mf.machine_id
                WHERE m.code IN ('big','small') ${codeFilter ? 'AND m.code = ?' : ''}
                  AND mf.time_seconds > 0
                  AND COALESCE(mf.time_recorded_at, mf.created_at) >= ?
                  AND COALESCE(mf.time_recorded_at, mf.created_at) < ?`,
          dateStrings: true
        },
        codeFilter ? [codeFilter, range.start, range.end] : [range.start, range.end]
      );

      const [archivedRows] = await pool.query(
        {
          sql: `SELECT m.code, fta.seconds AS seconds, fta.recorded_at AS recorded_at
                FROM file_time_archive fta
                JOIN machines m ON m.id = fta.machine_id
                WHERE m.code IN ('big','small') ${codeFilter ? 'AND m.code = ?' : ''}
                  AND fta.recorded_at >= ? AND fta.recorded_at < ?`,
          dateStrings: true
        },
        codeFilter ? [codeFilter, range.start, range.end] : [range.start, range.end]
      );

      const totalsByCode = { big: { totalSeconds: 0, runs: 0 }, small: { totalSeconds: 0, runs: 0 } };
      const dayMap = {};

      for (const row of [...liveRows, ...archivedRows]) {
        const date = String(row.recorded_at).slice(0, 10); // "YYYY-MM-DD"
        totalsByCode[row.code].runs += 1;
        totalsByCode[row.code].totalSeconds += row.seconds;
        if (!dayMap[date]) dayMap[date] = { date, big: 0, small: 0 };
        dayMap[date][row.code] += row.seconds;
      }

      const [labelRows] = await pool.query(
        `SELECT code, label FROM machines WHERE code IN ('big','small')`
      );
      const labelByCode = Object.fromEntries(labelRows.map(r => [r.code, r.label]));

      res.json({
        label: range.label,
        weekStart: range.weekStart,
        machines: (codeFilter ? [codeFilter] : ['big', 'small']).map(code => ({
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
  // 🆕 فلتر اختياري userId (HANDOFF §11 "اختيار مشغل يجب أن يفلتر الإحصائيات
  // الخاصة به") — من Users الحقيقيين، وليس أسماء ثابتة.
  router.get('/operators', async (req, res) => {
    try {
      const range = await resolveRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const userIdFilter = parseInt(req.query.userId, 10) || null;

      // كل المشغّلين أولًا (حتى من لا جلسات له = صفوف صفرية)، أو مشغّل واحد فقط لو تم الفلتر
      const [users] = await pool.query(
        userIdFilter
          ? `SELECT id, name FROM users WHERE role = 'operator' AND id = ?`
          : `SELECT id, name FROM users WHERE role = 'operator'`,
        userIdFilter ? [userIdFilter] : []
      );
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

      res.json({ label: range.label, weekStart: range.weekStart, operators });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // 🆕 جدول جلسات المشغّلين التفصيلي (صف لكل جلسة حضور/انصراف — لمطابقة التصميم
  // المرجعي §12 بدقة أكبر). مختلف عن /operators أعلاه (اللي بيرجّع إجمالي واحد
  // لكل مشغّل): هنا كل صف هو جلسة واحدة فعلية بوقت دخول/خروج حقيقيَين، بدون أي
  // تقسيم/قصّ على منتصف الليل (القصّ مفيد فقط للمجاميع، مش لعرض جلسة كما هي).
  // يعرض أي جلسة تتقاطع مع المدى المطلوب (تبدأ قبل النهاية وتنتهي بعد البداية،
  // أو لسه مفتوحة وبدأت داخل المدى). لا يوجد ربط بماكينة معيّنة في `operator_sessions`
  // حاليًا، فحقل "الماكينة المستخدمة" يُرجَع دائمًا null (تعرضه الواجهة كـ"-").
  router.get('/operators/sessions', async (req, res) => {
    try {
      const range = await resolveRange(req.query);
      if (range.error) return res.status(400).json({ error: range.error });
      const userIdFilter = parseInt(req.query.userId, 10) || null;

      const [rows] = await pool.query(
        {
          sql: `SELECT s.id, s.user_id, u.name, s.login_at, s.logout_at
                FROM operator_sessions s
                JOIN users u ON u.id = s.user_id
                WHERE u.role = 'operator' ${userIdFilter ? 'AND s.user_id = ?' : ''}
                  AND s.login_at < ?
                  AND (s.logout_at IS NULL OR s.logout_at > ?)
                ORDER BY s.login_at ASC`,
          dateStrings: true
        },
        userIdFilter ? [userIdFilter, range.end, range.start] : [range.end, range.start]
      );

      const DAY_NAME_AR_BY_JS_DAY = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      const sessions = rows.map(r => {
        const loginDateStr = String(r.login_at).slice(0, 10);
        const loginTime = String(r.login_at).slice(11, 16);
        const logoutTime = r.logout_at ? String(r.logout_at).slice(11, 16) : null;
        let durationSeconds = null;
        if (r.logout_at) {
          durationSeconds = Math.max(0, Math.round(
            (new Date(String(r.logout_at).replace(' ', 'T') + 'Z') - new Date(String(r.login_at).replace(' ', 'T') + 'Z')) / 1000
          ));
        }
        return {
          sessionId: r.id,
          userId: r.user_id,
          name: r.name,
          date: loginDateStr,
          dayName: DAY_NAME_AR_BY_JS_DAY[new Date(loginDateStr + 'T00:00:00Z').getUTCDay()],
          loginTime,
          logoutTime,
          durationSeconds,
          duration: durationSeconds !== null ? secondsToTime(durationSeconds) : null,
          machineUsed: null
        };
      });

      res.json({ label: range.label, sessions });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // 🆕 حذف/تصحيح إحصائيات ماكينة معيّنة في يوم معيّن (طلب مستخدم صريح: بيانات
  // دخلت غلط أو محتاجة تعديل). يُصفِّر مساهمة اليوم/الماكينة دي من مصدرَي
  // الإحصائيات معًا حتى يختفي الرقم فعليًا:
  //  1) machine_files الحيّة المسجَّلة في هذا اليوم لنفس الماكينة: time_seconds
  //     وtime_recorded_at يُصفَّران (الملف نفسه لا يُحذف، فقط وقته المُدخَل خطأ) —
  //     هذا متسق مع القرار الثابت أن الإحصائيات = وقت الملف بالضبط (لا رقم منفصل).
  //  2) file_time_archive: أي سجل مؤرشَف (من ملف اتحذف قبل كده) لنفس اليوم/الماكينة
  //     يُحذف نهائيًا.
  // Destructive و لا يمكن التراجع عنه — مشرف فقط (requireAdmin مطبَّق على الراوتر كله أعلاه).
  router.delete('/machines/day', async (req, res) => {
    try {
      const { machineCode, date } = req.body || {};
      if (machineCode !== 'big' && machineCode !== 'small') {
        return res.status(400).json({ error: 'machineCode يجب أن يكون big أو small' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
        return res.status(400).json({ error: 'date غير صالح (يجب أن يكون بصيغة YYYY-MM-DD)' });
      }

      const [mRows] = await pool.query('SELECT id, label FROM machines WHERE code = ?', [machineCode]);
      const machine = mRows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      const dayStart = `${date} 00:00:00`;
      const dayEnd = `${addDaysToDateStr(date, 1)} 00:00:00`;

      const [liveResult] = await pool.query(
        {
          sql: `UPDATE machine_files SET time_seconds = 0, time_recorded_at = NULL
                WHERE machine_id = ? AND time_seconds > 0
                  AND COALESCE(time_recorded_at, created_at) >= ?
                  AND COALESCE(time_recorded_at, created_at) < ?`,
          dateStrings: true
        },
        [machine.id, dayStart, dayEnd]
      );

      const [archiveResult] = await pool.query(
        {
          sql: `DELETE FROM file_time_archive WHERE machine_id = ? AND recorded_at >= ? AND recorded_at < ?`,
          dateStrings: true
        },
        [machine.id, dayStart, dayEnd]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف إحصائيات ${machine.label} ليوم ${date} (${liveResult.affectedRows} ملف حي مُصفَّر، ${archiveResult.affectedRows} سجل أرشيف مُحذوف)`,
        type: 'warning'
      });

      res.json({ ok: true, clearedLiveFiles: liveResult.affectedRows, clearedArchiveRows: archiveResult.affectedRows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
