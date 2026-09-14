const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { upload, uploadThumbnail, uploadVoice, UPLOAD_DIR, R2_ENABLED } = require('../middleware/upload');
const { uploadToR2, getFromR2, deleteFromR2 } = require('../config/r2');
const { addLog, addNotification } = require('../utils/events');
const { timeToSeconds, secondsToTime } = require('../utils/time');

// ترتيب الأيام الثابت: الجمعة → الخميس (يطابق ENUM day_name وHANDOFF §6 بالضبط)
const DAY_ORDER_BACKEND = ['fri', 'sat', 'sun', 'mon', 'tue', 'wed', 'thu'];
const DAY_NAME_AR_BACKEND = { fri: 'الجمعة', sat: 'السبت', sun: 'الأحد', mon: 'الإثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس' };

module.exports = (io) => {
  const router = express.Router();

  router.use(authenticate); // كل المسارات تتطلب تسجيل دخول (مشرف أو مشغل)

  // بث تحديث ماكينة بأمان: تحديثات queue تذهب فقط لغرفة المشرفين (لا يجب أن يصل بثها لغير المشرفين إطلاقاً)،
  // وتحديثات big/small تذهب للجميع كالمعتاد (بيانات يراها كل المستخدمين أصلاً)
  function broadcastMachineUpdate(updated) {
    if (!updated) return;
    if (updated.code === 'queue') io.to('admins').emit('machine:update', updated);
    else io.emit('machine:update', updated);
  }

  // -------- دالة مساعدة: جلب ماكينة مع ملفاتها كاملة --------
  // workDayId: خانة اليوم/الأسبوع الحالية المختارة في الواجهة (من شبكة 4 أسابيع × 7 أيام).
  // كل خانة مستقلة تمامًا — لا فلترة = لا ملفات (يمنع تسرّب ملفات يوم آخر بالخطأ).
  async function getMachineFull(code, workDayId) {
    const [mRows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
    const machine = mRows[0];
    if (!machine) return null;

    const [files] = workDayId
      ? await pool.query(
          'SELECT * FROM machine_files WHERE machine_id = ? AND work_day_id = ? ORDER BY sort_order ASC, id ASC',
          [machine.id, workDayId]
        )
      : [[]];

    const totalSeconds = files.reduce((acc, f) => acc + f.time_seconds, 0);

    return {
      id: machine.id,
      code: machine.code,
      label: machine.label,
      status: machine.status,
      currentFile: machine.current_file,
      totalTime: secondsToTime(totalSeconds),
      files: files.map(f => ({
        id: f.id,
        name: f.name,
        status: f.status,
        time: secondsToTime(f.time_seconds),
        hasFile: !!f.stored_filename,
        originalFilename: f.original_filename,
        fileSize: f.file_size,
        hasThumbnail: !!f.thumbnail_filename,
        thumbnailUrl: f.thumbnail_filename ? `/api/machines/files/${f.id}/thumbnail` : null,
        hasTextComment: !!f.text_comment,
        textComment: f.text_comment || null,
        hasVoiceComment: !!f.voice_comment_filename,
        voiceCommentUrl: f.voice_comment_filename ? `/api/machines/files/${f.id}/voice` : null
      }))
    };
  }

  // جلب كل الماكينات (الكبيرة والصغيرة) مع ملفاتها
  // ?workDayId=NN مطلوب من الواجهة — يحدد خانة (الأسبوع × اليوم) المعروضة حاليًا؛
  // بدونه تُرجَع الماكينات بحالتها لكن بدون أي ملفات (اليوم/الأسبوع مستقلان تمامًا).
  router.get('/', async (req, res) => {
    try {
      const workDayId = req.query.workDayId ? Number(req.query.workDayId) : null;
      const big = await getMachineFull('big', workDayId);
      const small = await getMachineFull('small', workDayId);
      // قائمة الانتظار: تُرجَع فقط للمشرف (لا يراها المشغّل إطلاقاً، حتى لا تصل بياناتها للمتصفح أصلاً)
      const queue = req.user.role === 'admin' ? await getMachineFull('queue', workDayId) : null;
      res.json({ big, small, queue });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تسجيل بدء/انتهاء فترة تشغيل فعلية للماكينة — كان إعلانًا يدويًا وليس تحكمًا فعليًا في
  // جهاز حقيقي (الموقع لا يتصل بالماكينات إطلاقًا، انظر HANDOFF §5).
  // 🆕 (Change Log §30): هذا الزر **مُعطَّل الآن فعليًا** بقرار المستخدم — أُزيل من الواجهة،
  // والمسار أدناه يرجّع 410 دون تنفيذ أي منطق. السبب: بعد فصل Statistics عن
  // machine_runtime_logs لتعتمد على File Time (§29)، لم يعد هذا الزر مصدر بيانات لأي شيء،
  // فأصبح تنفيذ §5 حرفيًا (إزالة/تعطيل) ممكنًا بأمان. machine_runtime_logs **لم يُحذف**
  // من قاعدة البيانات (بيانات قديمة إن وُجدت تبقى فيه)، فقط لا شيء يكتب إليه بعد الآن.
  router.patch('/:code/toggle', requireAdmin, async (req, res) => {
    try {
      // 🆕 القرار الحالي (HANDOFF §5 + Change Log §30): بعد فصل Statistics عن
      // machine_runtime_logs لتعتمد على File Time (§29)، لم يعد هناك أي تعارض يمنع
      // تعطيل هذا الزر فعليًا كما يطلب §5 أصلاً ("إزالة/تعطيل أزرار تشغيل/إيقاف
      // الماكينة"). الزر أُزيل من الواجهة، والمسار هنا **مُعطَّل** (410) وليس محذوفًا:
      // machine_runtime_logs يبقى كما هو بلا حذف، وهذا الـEndpoint يبقى قابلًا لإعادة
      // التفعيل لاحقًا بسطر واحد لو قرر المستخدم عكس ذلك مستقبلًا.
      return res.status(410).json({ error: 'تعطيل الماكينة يدويًا لم يعد متاحًا — الموقع لا يتحكم فعليًا في أي ماكينة (HANDOFF §5)' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ملاحظة: منطق التشغيل/الإيقاف الفعلي (تحديث machine.status/running_started_at
  // والإدراج في machine_runtime_logs) أُزيل من هنا فعليًا وليس مُعلَّقًا فقط — الجدول
  // machine_runtime_logs نفسه لم يُحذف من قاعدة البيانات (بيانات تاريخية قديمة إن
  // وُجدت تبقى فيه)، لكن لا شيء يكتب إليه بعد الآن لأن هذا المسار أعلاه مُعطَّل (410).

  // إضافة ملف جديد (بالاسم فقط، بدون رفع فعلي) — مشرف فقط
  router.post('/:code/files', requireAdmin, async (req, res) => {
    try {
      const { code } = req.params;
      const { name, time, workDayId } = req.body;
      if (!name) return res.status(400).json({ error: 'اسم الملف مطلوب' });
      if (!workDayId) return res.status(400).json({ error: 'يجب تحديد اليوم/الأسبوع الحالي (workDayId)' });

      const [rows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = rows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      const seconds = timeToSeconds(time || '00:00:00');
      const [maxOrder] = await pool.query(
        'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ? AND work_day_id = ?',
        [machine.id, workDayId]
      );

      await pool.query(
        'INSERT INTO machine_files (machine_id, name, status, time_seconds, sort_order, work_day_id) VALUES (?,?,?,?,?,?)',
        [machine.id, name, 'WAITING', seconds, maxOrder[0].m + 1, workDayId]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — أضاف ملف: ${name} إلى ${machine.label}`,
        type: 'success'
      });
      await addNotification(io, 'ملف جديد: ' + name, 'file');

      const updated = await getMachineFull(code, workDayId);
      broadcastMachineUpdate(updated);
      res.status(201).json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // رفع ملف حقيقي إلى ماكينة (multipart/form-data) — مشرف فقط
  router.post('/:code/files/upload', requireAdmin, upload.single('file'), async (req, res) => {
    try {
      const { code } = req.params;
      const { time, workDayId } = req.body;
      if (!req.file) return res.status(400).json({ error: 'لم يتم استلام أي ملف' });
      if (!workDayId) {
        if (!R2_ENABLED && req.file.path) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'يجب تحديد اليوم/الأسبوع الحالي (workDayId)' });
      }

      const [rows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = rows[0];
      if (!machine) {
        if (!R2_ENABLED && req.file.path) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'الماكينة غير موجودة' });
      }

      const seconds = timeToSeconds(time || '00:00:00');
      const [maxOrder] = await pool.query(
        'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ? AND work_day_id = ?',
        [machine.id, workDayId]
      );

      // اسم التخزين: في وضع R2 نولّد مفتاحاً جديداً ونرفع الـ buffer إليه.
      // في وضع القرص المحلي، multer.diskStorage سبق أن ولّد الاسم فعلياً ووضعه في req.file.filename — نستخدمه كما هو.
      let storedName;
      if (R2_ENABLED) {
        const ext = path.extname(req.file.originalname);
        storedName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        await uploadToR2(storedName, req.file.buffer, req.file.mimetype);
      } else {
        storedName = req.file.filename;
      }

      const [result] = await pool.query(
        `INSERT INTO machine_files
         (machine_id, name, status, time_seconds, stored_filename, original_filename, file_size, sort_order, work_day_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [machine.id, req.file.originalname, 'WAITING', seconds, storedName, req.file.originalname, req.file.size, maxOrder[0].m + 1, workDayId]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — رفع ملف: ${req.file.originalname} إلى ${machine.label}`,
        type: 'success'
      });
      await addNotification(io, 'ملف جديد: ' + req.file.originalname, 'file');

      const updated = await getMachineFull(code, workDayId);
      broadcastMachineUpdate(updated);
      res.status(201).json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // رفع/تغيير صورة المعاينة لملف موجود — مشرف فقط
  router.post('/files/:fileId/thumbnail', requireAdmin, uploadThumbnail.single('thumbnail'), async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { machineCode, machineLabel } = req.body;
      if (!req.file) return res.status(400).json({ error: 'لم يتم استلام أي صورة' });

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file) {
        if (!R2_ENABLED && req.file.path) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'الملف غير موجود' });
      }

      // حذف صورة المعاينة القديمة إن وُجدت (استبدال)
      if (file.thumbnail_filename) {
        if (R2_ENABLED) {
          try { await deleteFromR2(file.thumbnail_filename); } catch (e) { console.error('فشل حذف الصورة القديمة من R2:', e.message); }
        } else {
          const oldPath = path.join(UPLOAD_DIR, file.thumbnail_filename);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
      }

      let storedName;
      if (R2_ENABLED) {
        const ext = path.extname(req.file.originalname);
        storedName = `thumb-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        await uploadToR2(storedName, req.file.buffer, req.file.mimetype);
      } else {
        storedName = req.file.filename;
      }

      await pool.query('UPDATE machine_files SET thumbnail_filename = ? WHERE id = ?', [storedName, fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — أضاف صورة معاينة لملف: ${file.name} في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.status(201).json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // عرض صورة المعاينة (inline، تُفتح مباشرة كصورة لا كتحميل) — متاح لأي مستخدم مسجّل دخول
  router.get('/files/:fileId/thumbnail', async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];

      if (!file || !file.thumbnail_filename) {
        return res.status(404).json({ error: 'لا توجد صورة معاينة لهذا الملف' });
      }

      if (R2_ENABLED) {
        try {
          const stream = await getFromR2(file.thumbnail_filename);
          res.setHeader('Content-Disposition', 'inline');
          stream.pipe(res);
        } catch (e) {
          console.error(e);
          return res.status(404).json({ error: 'الصورة غير موجودة على التخزين' });
        }
      } else {
        const filePath = path.join(UPLOAD_DIR, file.thumbnail_filename);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'الصورة غير موجودة على السيرفر' });
        }
        res.sendFile(filePath);
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // حذف صورة المعاينة فقط (إبقاء الملف نفسه) — مشرف فقط
  router.delete('/files/:fileId/thumbnail', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { machineCode, machineLabel } = req.body;
      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file || !file.thumbnail_filename) {
        return res.status(404).json({ error: 'لا توجد صورة معاينة لحذفها' });
      }

      if (R2_ENABLED) {
        try { await deleteFromR2(file.thumbnail_filename); } catch (e) { console.error(e.message); }
      } else {
        const filePath = path.join(UPLOAD_DIR, file.thumbnail_filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      await pool.query('UPDATE machine_files SET thumbnail_filename = NULL WHERE id = ?', [fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف صورة معاينة ملف: ${file.name} في ${machineLabel || ''}`,
        type: 'warning'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ==================== التعليق الكتابي ====================

  // إضافة/تعديل التعليق الكتابي لملف — مشرف فقط
  router.post('/files/:fileId/comment', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { text, machineCode, machineLabel } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: 'نص التعليق مطلوب' });

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

      await pool.query('UPDATE machine_files SET text_comment = ? WHERE id = ?', [text.trim(), fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — أضاف تعليقاً كتابياً على ملف: ${file.name} في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.status(201).json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // حذف التعليق الكتابي — مشرف فقط
  router.delete('/files/:fileId/comment', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { machineCode, machineLabel } = req.body;
      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file || !file.text_comment) return res.status(404).json({ error: 'لا يوجد تعليق لحذفه' });

      await pool.query('UPDATE machine_files SET text_comment = NULL WHERE id = ?', [fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف تعليقاً كتابياً من ملف: ${file.name} في ${machineLabel || ''}`,
        type: 'warning'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ==================== التعليق الصوتي ====================

  // رفع/استبدال تعليق صوتي لملف — مشرف فقط
  router.post('/files/:fileId/voice', requireAdmin, uploadVoice.single('voice'), async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { machineCode, machineLabel } = req.body;
      if (!req.file) return res.status(400).json({ error: 'لم يتم استلام أي تسجيل صوتي' });

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file) {
        if (!R2_ENABLED && req.file.path) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'الملف غير موجود' });
      }

      // حذف التسجيل القديم إن وُجد (استبدال)
      if (file.voice_comment_filename) {
        if (R2_ENABLED) {
          try { await deleteFromR2(file.voice_comment_filename); } catch (e) { console.error('فشل حذف التسجيل القديم من R2:', e.message); }
        } else {
          const oldPath = path.join(UPLOAD_DIR, file.voice_comment_filename);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
      }

      let storedName;
      if (R2_ENABLED) {
        const ext = path.extname(req.file.originalname) || '.webm';
        storedName = `voice-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        await uploadToR2(storedName, req.file.buffer, req.file.mimetype);
      } else {
        storedName = req.file.filename;
      }

      await pool.query('UPDATE machine_files SET voice_comment_filename = ? WHERE id = ?', [storedName, fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — أضاف تعليقاً صوتياً على ملف: ${file.name} في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.status(201).json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تشغيل/تنزيل التعليق الصوتي — متاح لأي مستخدم مسجّل دخول
  router.get('/files/:fileId/voice', async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];

      if (!file || !file.voice_comment_filename) {
        return res.status(404).json({ error: 'لا يوجد تعليق صوتي لهذا الملف' });
      }

      if (R2_ENABLED) {
        try {
          const stream = await getFromR2(file.voice_comment_filename);
          res.setHeader('Content-Disposition', 'inline');
          stream.pipe(res);
        } catch (e) {
          console.error(e);
          return res.status(404).json({ error: 'التسجيل غير موجود على التخزين' });
        }
      } else {
        const filePath = path.join(UPLOAD_DIR, file.voice_comment_filename);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'التسجيل غير موجود على السيرفر' });
        }
        res.sendFile(filePath);
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // حذف التعليق الصوتي — مشرف فقط
  router.delete('/files/:fileId/voice', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { machineCode, machineLabel } = req.body;
      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file || !file.voice_comment_filename) {
        return res.status(404).json({ error: 'لا يوجد تعليق صوتي لحذفه' });
      }

      if (R2_ENABLED) {
        try { await deleteFromR2(file.voice_comment_filename); } catch (e) { console.error(e.message); }
      } else {
        const filePath = path.join(UPLOAD_DIR, file.voice_comment_filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      await pool.query('UPDATE machine_files SET voice_comment_filename = NULL WHERE id = ?', [fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف تعليقاً صوتياً من ملف: ${file.name} في ${machineLabel || ''}`,
        type: 'warning'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ==================== نقل ملف بين الماكينتين (سحب وإفلات) ====================

  // نقل ملف من ماكينة لأخرى — ينقل كل بياناته (الاسم، الحالة، الوقت، الصورة، التعليقات) — مشرف فقط
  router.patch('/files/:fileId/move', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { targetMachineCode } = req.body;
      if (!['big', 'small', 'queue'].includes(targetMachineCode)) {
        return res.status(400).json({ error: 'كود الماكينة الهدف غير صحيح' });
      }

      const [fileRows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = fileRows[0];
      if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

      const [targetRows] = await pool.query('SELECT * FROM machines WHERE code = ?', [targetMachineCode]);
      const targetMachine = targetRows[0];
      if (!targetMachine) return res.status(404).json({ error: 'الماكينة الهدف غير موجودة' });

      const [sourceRows] = await pool.query('SELECT * FROM machines WHERE id = ?', [file.machine_id]);
      const sourceMachine = sourceRows[0];

      if (sourceMachine && sourceMachine.id === targetMachine.id) {
        return res.status(400).json({ error: 'الملف موجود بالفعل في هذه الماكينة' });
      }

      // الترتيب محصور داخل نفس خانة اليوم/الأسبوع (work_day_id) التي ينتمي إليها الملف أصلاً — النقل بين
      // الماكينات لا يغيّر يوم/أسبوع الملف إطلاقًا (استقلال الأيام محفوظ عبر النقل)
      const [maxOrder] = await pool.query(
        'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ? AND work_day_id <=> ?',
        [targetMachine.id, file.work_day_id]
      );

      await pool.query(
        'UPDATE machine_files SET machine_id = ?, sort_order = ? WHERE id = ?',
        [targetMachine.id, maxOrder[0].m + 1, fileId]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — نقل ملف: ${file.name} من ${sourceMachine ? sourceMachine.label : '—'} إلى ${targetMachine.label}`,
        type: 'info'
      });
      await addNotification(io, `تم نقل ملف: ${file.name} إلى ${targetMachine.label}`, 'file');

      // نبثّ تحديث الماكينتين معاً (المصدر والهدف) لأن الحالة تغيّرت في الاثنتين — بنفس خانة يوم الملف
      const updatedSource = sourceMachine ? await getMachineFull(sourceMachine.code, file.work_day_id) : null;
      const updatedTarget = await getMachineFull(targetMachine.code, file.work_day_id);
      if (updatedSource) broadcastMachineUpdate(updatedSource);
      broadcastMachineUpdate(updatedTarget);

      res.json({ source: updatedSource, target: updatedTarget });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // ==================== Bulk Actions (نقل/حذف جماعي) — مشرف فقط ====================
  // ملاحظة مهمة على الترتيب: هذان المساران (`/files/bulk-move` و`/files/bulk-delete`) يجب أن
  // يبقيا مُعرَّفين قبل أي مسار عام بنمط `/files/:fileId` (مثل حذف/نقل ملف واحد أدناه)، لأن
  // Express يطابق حسب ترتيب التعريف — لو جاء `/files/:fileId` أولاً لكان يلتقط "bulk-move"/
  // "bulk-delete" كأنها قيمة fileId. لا تُعِد ترتيب الملف دون مراعاة هذه النقطة.

  const MAX_BULK_IDS = 200; // حد أقصى معقول لحجم عملية جماعية واحدة

  function parseIdsBody(body) {
    const { fileIds } = body;
    if (!Array.isArray(fileIds) || fileIds.length === 0) return null;
    const ids = [...new Set(fileIds.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id)))];
    if (ids.length === 0 || ids.length > MAX_BULK_IDS) return null;
    return ids;
  }

  function summarizeNames(names) {
    const shown = names.slice(0, 5);
    const rest = names.length - shown.length;
    return shown.join('، ') + (rest > 0 ? ` (و${rest} أخرى)` : '');
  }

  // نقل عدة ملفات دفعة واحدة إلى ماكينة هدف — يعيد استخدام نفس منطق النقل الفردي أعلاه لكل ملف،
  // مع بثّ واحد فقط لكل ماكينة متأثرة (وليس بثّ متكرر لكل ملف) وسجل واحد مُجمَّع
  router.patch('/files/bulk-move', requireAdmin, async (req, res) => {
    try {
      const ids = parseIdsBody(req.body);
      if (!ids) return res.status(400).json({ error: 'fileIds يجب أن تكون مصفوفة غير فارغة (وبحد أقصى ' + MAX_BULK_IDS + ')' });

      const { targetMachineCode, workDayId } = req.body;
      if (!['big', 'small', 'queue'].includes(targetMachineCode)) {
        return res.status(400).json({ error: 'كود الماكينة الهدف غير صحيح' });
      }
      if (!workDayId) return res.status(400).json({ error: 'يجب تحديد اليوم/الأسبوع الحالي (workDayId)' });

      const [targetRows] = await pool.query('SELECT * FROM machines WHERE code = ?', [targetMachineCode]);
      const targetMachine = targetRows[0];
      if (!targetMachine) return res.status(404).json({ error: 'الماكينة الهدف غير موجودة' });

      const movedNames = [];
      const skipped = [];
      const affectedSourceMachineIds = new Set();

      // نُنفَّذ تباعاً (وليس بالتوازي) للحفاظ على sort_order صحيح ومتسلسل عبر maxOrder المتغيّر مع كل إدراج
      for (const fileId of ids) {
        const [fileRows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
        const file = fileRows[0];
        if (!file) { skipped.push(fileId); continue; }
        if (file.machine_id === targetMachine.id) { skipped.push(fileId); continue; }
        // Bulk فقط داخل نفس خانة اليوم/الأسبوع المعروضة — يمنع تسرّب Bulk Selection عبر أيام مختلفة
        if (String(file.work_day_id) !== String(workDayId)) { skipped.push(fileId); continue; }

        affectedSourceMachineIds.add(file.machine_id);

        const [maxOrder] = await pool.query(
          'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ? AND work_day_id = ?',
          [targetMachine.id, workDayId]
        );
        await pool.query(
          'UPDATE machine_files SET machine_id = ?, sort_order = ? WHERE id = ?',
          [targetMachine.id, maxOrder[0].m + 1, fileId]
        );
        movedNames.push(file.name);
      }

      if (movedNames.length > 0) {
        await addLog(io, {
          userId: req.user.id,
          event: `${req.user.name} — نقل ${movedNames.length} ملف جماعيًا إلى ${targetMachine.label}: ${summarizeNames(movedNames)}`,
          type: 'info'
        });
        await addNotification(io, `تم نقل ${movedNames.length} ملف جماعيًا إلى ${targetMachine.label}`, 'file');
      }

      // بث تحديث كل ماكينة مصدر متأثرة + الماكينة الهدف (مرة واحدة لكل ماكينة، بغض النظر عن عدد الملفات)
      for (const machineId of affectedSourceMachineIds) {
        const [mRows] = await pool.query('SELECT code FROM machines WHERE id = ?', [machineId]);
        if (mRows[0]) broadcastMachineUpdate(await getMachineFull(mRows[0].code, workDayId));
      }
      broadcastMachineUpdate(await getMachineFull(targetMachine.code, workDayId));

      res.json({ movedCount: movedNames.length, skippedIds: skipped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // حذف عدة ملفات دفعة واحدة — نفس منطق الحذف الفردي أعلاه (تخزين + صورة معاينة + تعليق صوتي)
  // لكل ملف، مع إعادة وقتها لماكينتها الخاصة (بالمجموع لكل ماكينة)، وبثّ واحد فقط لكل ماكينة متأثرة
  router.delete('/files/bulk-delete', requireAdmin, async (req, res) => {
    try {
      const ids = parseIdsBody(req.body);
      if (!ids) return res.status(400).json({ error: 'fileIds يجب أن تكون مصفوفة غير فارغة (وبحد أقصى ' + MAX_BULK_IDS + ')' });

      const deletedNames = [];
      const skipped = [];
      const affectedMachineIds = new Set();
      let workDayId = null; // Bulk تحدث دائمًا داخل خانة يوم واحدة في الواجهة؛ نأخذها من أول ملف فعليًا محذوف

      for (const fileId of ids) {
        const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
        const file = rows[0];
        if (!file) { skipped.push(fileId); continue; }
        if (workDayId === null) workDayId = file.work_day_id;

        if (file.stored_filename) {
          if (R2_ENABLED) {
            try { await deleteFromR2(file.stored_filename); } catch (e) { console.error('فشل حذف الملف من R2:', e.message); }
          } else {
            const filePath = path.join(UPLOAD_DIR, file.stored_filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        }
        if (file.thumbnail_filename) {
          if (R2_ENABLED) {
            try { await deleteFromR2(file.thumbnail_filename); } catch (e) { console.error('فشل حذف صورة المعاينة من R2:', e.message); }
          } else {
            const thumbPath = path.join(UPLOAD_DIR, file.thumbnail_filename);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
          }
        }
        if (file.voice_comment_filename) {
          if (R2_ENABLED) {
            try { await deleteFromR2(file.voice_comment_filename); } catch (e) { console.error('فشل حذف التسجيل الصوتي من R2:', e.message); }
          } else {
            const voicePath = path.join(UPLOAD_DIR, file.voice_comment_filename);
            if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
          }
        }

        await pool.query(
          'UPDATE machines SET machine_time = machine_time + ? WHERE id = ?',
          [file.time_seconds, file.machine_id]
        );
        // 🆕 أرشفة وقت الملف قبل حذف الصف — نفس منطق الحذف الفردي أعلاه بالضبط
        if (file.time_seconds > 0) {
          await pool.query(
            'INSERT INTO file_time_archive (machine_id, seconds, recorded_at) VALUES (?, ?, ?)',
            [file.machine_id, file.time_seconds, file.time_recorded_at || file.created_at]
          );
        }
        await pool.query('DELETE FROM machine_files WHERE id = ?', [fileId]);

        affectedMachineIds.add(file.machine_id);
        deletedNames.push(file.name);
      }

      if (deletedNames.length > 0) {
        const { machineLabel } = req.body;
        await addLog(io, {
          userId: req.user.id,
          event: `${req.user.name} — حذف ${deletedNames.length} ملف جماعيًا من ${machineLabel || ''}: ${summarizeNames(deletedNames)}`,
          type: 'warning'
        });
        // ملاحظة: أُضيف هذا السطر ضمن جلسة "Notifications" — تصحيح لتناسق ناقص كان موجوداً
        // سابقاً (bulk-move كان يُصدر إشعاراً، بينما bulk-delete لم يكن يُصدر أي إشعار رغم تماثل الأهمية)
        await addNotification(io, `تم حذف ${deletedNames.length} ملف جماعيًا من ${machineLabel || ''}`, 'file');
      }

      for (const machineId of affectedMachineIds) {
        const [mRows] = await pool.query('SELECT code FROM machines WHERE id = ?', [machineId]);
        if (mRows[0]) broadcastMachineUpdate(await getMachineFull(mRows[0].code, workDayId));
      }

      res.json({ deletedCount: deletedNames.length, skippedIds: skipped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تحميل ملف حقيقي من السيرفر
  router.get('/files/:fileId/download', async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];

      if (!file || !file.stored_filename) {
        return res.status(404).json({ error: 'لا يوجد ملف فعلي للتحميل' });
      }

      const downloadName = file.original_filename || file.name;

      if (R2_ENABLED) {
        try {
          const stream = await getFromR2(file.stored_filename);
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
          stream.pipe(res);
        } catch (e) {
          console.error(e);
          return res.status(404).json({ error: 'الملف غير موجود على التخزين' });
        }
      } else {
        const filePath = path.join(UPLOAD_DIR, file.stored_filename);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'الملف غير موجود على السيرفر' });
        }
        res.download(filePath, downloadName);
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تعديل اسم ملف — مشرف فقط
  router.patch('/files/:fileId/name', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { name, machineCode, machineLabel } = req.body;
      if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const old = rows[0];
      if (!old) return res.status(404).json({ error: 'الملف غير موجود' });

      await pool.query('UPDATE machine_files SET name = ? WHERE id = ?', [name, fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — غيّر اسم "${old.name}" إلى "${name}" في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تعديل وقت ملف — متاح لأي مستخدم مسجّل دخول (مشرف أو مشغل)
  router.patch('/files/:fileId/time', async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { time, machineCode, machineLabel } = req.body;
      if (!time) return res.status(400).json({ error: 'الوقت مطلوب' });

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

      const seconds = timeToSeconds(time);
      // 🆕 time_recorded_at يُحدَّث تلقائيًا هنا فقط (Statistics)، بدون أي تغيير على
      // شكل الطلب/الاستجابة أو طريقة إدخال الوقت نفسها في الواجهة (انظر migration_file_time_statistics.sql)
      await pool.query('UPDATE machine_files SET time_seconds = ?, time_recorded_at = NOW() WHERE id = ?', [seconds, fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — غيّر وقت "${file.name}" إلى "${time}" في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تعديل حالة ملف (انتظار/جاري/تم القص/تسليم) — متاح لأي مستخدم مسجّل دخول (مشرف أو مشغل)
  router.patch('/files/:fileId/status', async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { status, machineCode, machineLabel } = req.body;
      const validStatuses = ['WAITING', 'WORKING', 'CUTTING', 'DELIVERED'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'حالة غير صحيحة' });
      }

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

      await pool.query('UPDATE machine_files SET status = ? WHERE id = ?', [status, fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — غيّر حالة "${file.name}" من "${file.status}" إلى "${status}" في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // حذف ملف (يُضاف وقته إلى وقت الماكينة كما في النظام الأصلي) — مشرف فقط
  router.delete('/files/:fileId', requireAdmin, async (req, res) => {
    try {
      const fileId = parseInt(req.params.fileId, 10);
      const { machineCode, machineLabel } = req.body;

      const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
      const file = rows[0];
      if (!file) return res.status(404).json({ error: 'الملف غير موجود' });

      // حذف الملف الفعلي من التخزين (R2 أو القرص المحلي)
      if (file.stored_filename) {
        if (R2_ENABLED) {
          try { await deleteFromR2(file.stored_filename); } catch (e) { console.error('فشل حذف الملف من R2:', e.message); }
        } else {
          const filePath = path.join(UPLOAD_DIR, file.stored_filename);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      }
      // حذف صورة المعاينة المرتبطة بالملف إن وُجدت
      if (file.thumbnail_filename) {
        if (R2_ENABLED) {
          try { await deleteFromR2(file.thumbnail_filename); } catch (e) { console.error('فشل حذف صورة المعاينة من R2:', e.message); }
        } else {
          const thumbPath = path.join(UPLOAD_DIR, file.thumbnail_filename);
          if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }
      }
      // حذف التسجيل الصوتي المرتبط بالملف إن وُجد
      if (file.voice_comment_filename) {
        if (R2_ENABLED) {
          try { await deleteFromR2(file.voice_comment_filename); } catch (e) { console.error('فشل حذف التسجيل الصوتي من R2:', e.message); }
        } else {
          const voicePath = path.join(UPLOAD_DIR, file.voice_comment_filename);
          if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
        }
      }

      await pool.query(
        'UPDATE machines SET machine_time = machine_time + ? WHERE id = ?',
        [file.time_seconds, file.machine_id]
      );
      // 🆕 أرشفة وقت الملف قبل حذف الصف (Statistics تجمع من machine_files الحيّة +
      // file_time_archive معًا — بدون هذا الأرشيف كانت الإحصائيات ستفقد هذا الوقت فورًا)
      if (file.time_seconds > 0) {
        await pool.query(
          'INSERT INTO file_time_archive (machine_id, seconds, recorded_at) VALUES (?, ?, ?)',
          [file.machine_id, file.time_seconds, file.time_recorded_at || file.created_at]
        );
      }
      await pool.query('DELETE FROM machine_files WHERE id = ?', [fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف ملف: ${file.name} من ${machineLabel || ''} (أُضيف وقته ${secondsToTime(file.time_seconds)} لوقت الماكينة)`,
        type: 'warning'
      });

      const updated = await getMachineFull(machineCode, file.work_day_id);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // إعادة ترتيب قائمة الملفات (Drag & Drop) — مشرف فقط
  router.patch('/:code/files/reorder', requireAdmin, async (req, res) => {
    try {
      const { code } = req.params;
      const { orderedIds, workDayId } = req.body; // مصفوفة معرفات الملفات بالترتيب الجديد + خانة اليوم الحالية
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'orderedIds يجب أن تكون مصفوفة' });
      }

      const [mRows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = mRows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      // تحديث ترتيب كل ملف (محصور بنفس الماكينة، ولا يمس work_day_id إطلاقًا)
      await Promise.all(orderedIds.map((id, idx) =>
        pool.query('UPDATE machine_files SET sort_order = ? WHERE id = ? AND machine_id = ?', [idx + 1, id, machine.id])
      ));

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — رتّب قائمة التشغيل في ${machine.label}`,
        type: 'info'
      });

      const updated = await getMachineFull(code, workDayId || null);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // -------- نقل الانتظار لليوم التالي (HANDOFF §8) — مشرف فقط --------
  // ينقل كل الملفات بحالة WAITING (في أي من الماكينتين والانتظار) من خانة اليوم
  // الحالية (workDayId) إلى خانة اليوم التالي، بدون Duplicate: نفس صف machine_files
  // يُحدَّث فيه work_day_id فقط (id ثابت)، فتبقى كل بياناته كما هي (Thumbnail،
  // Comments، Voice، File Time، File Status) تلقائيًا لأننا لا نُنشئ صفًا جديدًا.
  // الخميس -> الجمعة من الأسبوع التالي (مع لفّ الأسبوع 4 -> 1 لأن الشبكة 4 أسابيع ثابتة فقط).
  router.post('/files/transfer-waiting', requireAdmin, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const workDayId = Number(req.body.workDayId);
      if (!workDayId) return res.status(400).json({ error: 'workDayId مطلوب' });

      const [curRows] = await conn.query(
        `SELECT wd.id, wd.day_name, ww.week_number
         FROM work_days wd JOIN work_weeks ww ON ww.id = wd.week_id
         WHERE wd.id = ?`,
        [workDayId]
      );
      const cur = curRows[0];
      if (!cur) return res.status(404).json({ error: 'اليوم غير موجود' });

      const idx = DAY_ORDER_BACKEND.indexOf(cur.day_name);
      const isLastDay = idx === DAY_ORDER_BACKEND.length - 1; // الخميس
      const nextDayName = DAY_ORDER_BACKEND[(idx + 1) % DAY_ORDER_BACKEND.length];
      const nextWeekNumber = isLastDay ? (cur.week_number % 4) + 1 : cur.week_number;

      const [targetRows] = await conn.query(
        `SELECT wd.id FROM work_days wd JOIN work_weeks ww ON ww.id = wd.week_id
         WHERE ww.week_number = ? AND wd.day_name = ?`,
        [nextWeekNumber, nextDayName]
      );
      const target = targetRows[0];
      if (!target) return res.status(500).json({ error: 'خانة اليوم التالي غير موجودة (مشكلة Seed في قاعدة البيانات)' });
      if (target.id === workDayId) return res.status(400).json({ error: 'اليوم التالي هو نفس اليوم الحالي' });

      await conn.beginTransaction();

      let totalMoved = 0;
      const movedByMachine = {};
      for (const code of ['big', 'small', 'queue']) {
        const [mRows] = await conn.query('SELECT id, label FROM machines WHERE code = ?', [code]);
        const machine = mRows[0];
        if (!machine) continue;

        const [waitingFiles] = await conn.query(
          `SELECT id FROM machine_files WHERE machine_id = ? AND work_day_id = ? AND status = 'WAITING' ORDER BY sort_order ASC, id ASC`,
          [machine.id, workDayId]
        );
        if (waitingFiles.length === 0) continue;

        const [[{ maxSort }]] = await conn.query(
          `SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM machine_files WHERE machine_id = ? AND work_day_id = ?`,
          [machine.id, target.id]
        );

        for (let i = 0; i < waitingFiles.length; i++) {
          await conn.query(
            'UPDATE machine_files SET work_day_id = ?, sort_order = ? WHERE id = ?',
            [target.id, maxSort + i + 1, waitingFiles[i].id]
          );
        }
        totalMoved += waitingFiles.length;
        movedByMachine[code] = waitingFiles.length;
      }

      await conn.commit();

      if (totalMoved > 0) {
        await addLog(io, {
          userId: req.user.id,
          event: `${req.user.name} — نقل ${totalMoved} ملف/ملفات من الانتظار (${DAY_NAME_AR_BACKEND[cur.day_name]}) إلى (${DAY_NAME_AR_BACKEND[nextDayName]}${isLastDay ? ' — الأسبوع التالي' : ''})`,
          type: 'info'
        });
        await addNotification(io, `تم نقل ${totalMoved} ملف/ملفات من الانتظار لليوم التالي`, 'file');
      }

      // بث تحديث اليوم الحالي (اليوم الذي فرغ من الملفات المنقولة) لكل من يشاهده الآن
      for (const code of ['big', 'small', 'queue']) {
        const updated = await getMachineFull(code, workDayId);
        broadcastMachineUpdate(updated);
      }

      res.json({ totalMoved, movedByMachine, targetWorkDayId: target.id, targetDayName: nextDayName, targetWeekNumber: nextWeekNumber });
    } catch (err) {
      try { await conn.rollback(); } catch (e2) {}
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    } finally {
      conn.release();
    }
  });

  // -------- Cleanup: مسح كل ملفات أيام محددة (HANDOFF §9) — مشرف فقط --------
  // يحذف كل صفوف machine_files (بكل الحالات بلا استثناء: WAITING/WORKING/CUTTING/DELIVERED)
  // المرتبطة بأي من work_day_id المُرسَلة، عبر الماكينتين وقائمة الانتظار الثلاثة معًا.
  // 🆕 مصدر Statistics أصبح File Time (time_seconds) بدل machine_runtime_logs، لذلك قبل حذف
  // كل صف هنا تُؤرشَف مساهمته في file_time_archive أولًا — فالتاريخ الإحصائي يبقى كما هو
  // تمامًا حتى بعد حذف الملفات نفسها (نفس القرار الموثّق في §9، بمصدر بيانات مختلف الآن).
  // operator_sessions لم يتأثر بهذا التغيير إطلاقًا (إحصائيات المشغّلين مصدرها منفصل تمامًا).
  router.delete('/files/cleanup', requireAdmin, async (req, res) => {
    try {
      const workDayIds = Array.isArray(req.body.workDayIds)
        ? [...new Set(req.body.workDayIds.map(Number).filter(Boolean))]
        : [];
      if (workDayIds.length === 0) return res.status(400).json({ error: 'workDayIds يجب أن تكون مصفوفة غير فارغة' });
      if (workDayIds.length > 28) return res.status(400).json({ error: 'عدد أيام كبير جدًا' }); // أقصى حماية بسيطة (الشبكة كلها 28 خانة)

      const currentWorkDayId = req.body.currentWorkDayId ? Number(req.body.currentWorkDayId) : null;

      const placeholders = workDayIds.map(() => '?').join(',');
      const [files] = await pool.query(
        `SELECT * FROM machine_files WHERE work_day_id IN (${placeholders})`,
        workDayIds
      );

      let deletedCount = 0;
      const affectedMachineIds = new Set();

      for (const file of files) {
        if (file.stored_filename) {
          if (R2_ENABLED) {
            try { await deleteFromR2(file.stored_filename); } catch (e) { console.error('فشل حذف الملف من R2:', e.message); }
          } else {
            const filePath = path.join(UPLOAD_DIR, file.stored_filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        }
        if (file.thumbnail_filename) {
          if (R2_ENABLED) {
            try { await deleteFromR2(file.thumbnail_filename); } catch (e) { console.error('فشل حذف صورة المعاينة من R2:', e.message); }
          } else {
            const thumbPath = path.join(UPLOAD_DIR, file.thumbnail_filename);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
          }
        }
        if (file.voice_comment_filename) {
          if (R2_ENABLED) {
            try { await deleteFromR2(file.voice_comment_filename); } catch (e) { console.error('فشل حذف التسجيل الصوتي من R2:', e.message); }
          } else {
            const voicePath = path.join(UPLOAD_DIR, file.voice_comment_filename);
            if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
          }
        }

        await pool.query('UPDATE machines SET machine_time = machine_time + ? WHERE id = ?', [file.time_seconds, file.machine_id]);
        // 🆕 أرشفة وقت الملف قبل حذفه — بدون هذا كان Cleanup سيحذف مساهمة هذا الملف
        // من Statistics فورًا، وهذا يتعارض مع القرار الثابت "Cleanup لا يحذف التاريخ الإحصائي" (§9)
        if (file.time_seconds > 0) {
          await pool.query(
            'INSERT INTO file_time_archive (machine_id, seconds, recorded_at) VALUES (?, ?, ?)',
            [file.machine_id, file.time_seconds, file.time_recorded_at || file.created_at]
          );
        }
        affectedMachineIds.add(file.machine_id);
        deletedCount++;
      }

      if (deletedCount > 0) {
        await pool.query(`DELETE FROM machine_files WHERE work_day_id IN (${placeholders})`, workDayIds);

        await addLog(io, {
          userId: req.user.id,
          event: `${req.user.name} — Cleanup: حذف ${deletedCount} ملف/ملفات من ${workDayIds.length} يوم/أيام (كل الحالات، لا يشمل التاريخ الإحصائي)`,
          type: 'warning'
        });
        await addNotification(io, `Cleanup: تم حذف ${deletedCount} ملف/ملفات`, 'file');
      }

      // بث تحديث فقط للماكينات المرتبطة باليوم الحالي المعروض عند من طلب العملية (نفس القيد
      // المعروف في بقية الملف: البث الحالي لا يميّز بين الأيام لكل عميل متصل على حدة)
      if (currentWorkDayId && workDayIds.includes(currentWorkDayId)) {
        for (const code of ['big', 'small', 'queue']) {
          broadcastMachineUpdate(await getMachineFull(code, currentWorkDayId));
        }
      }

      res.json({ deletedCount, dayCount: workDayIds.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
