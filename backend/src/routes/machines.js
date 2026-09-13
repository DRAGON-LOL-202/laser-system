const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { upload, uploadThumbnail, uploadVoice, UPLOAD_DIR, R2_ENABLED } = require('../middleware/upload');
const { uploadToR2, getFromR2, deleteFromR2 } = require('../config/r2');
const { addLog, addNotification } = require('../utils/events');
const { timeToSeconds, secondsToTime } = require('../utils/time');

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
  async function getMachineFull(code) {
    const [mRows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
    const machine = mRows[0];
    if (!machine) return null;

    const [files] = await pool.query(
      'SELECT * FROM machine_files WHERE machine_id = ? ORDER BY sort_order ASC, id ASC',
      [machine.id]
    );

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
  router.get('/', async (req, res) => {
    try {
      const big = await getMachineFull('big');
      const small = await getMachineFull('small');
      // قائمة الانتظار: تُرجَع فقط للمشرف (لا يراها المشغّل إطلاقاً، حتى لا تصل بياناتها للمتصفح أصلاً)
      const queue = req.user.role === 'admin' ? await getMachineFull('queue') : null;
      res.json({ big, small, queue });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تشغيل/إيقاف ماكينة (مشرف فقط)
  router.patch('/:code/toggle', requireAdmin, async (req, res) => {
    try {
      const { code } = req.params;
      if (code === 'queue') return res.status(400).json({ error: 'قائمة الانتظار ليست ماكينة، لا يمكن تشغيلها أو إيقافها' });

      const [rows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = rows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      const newStatus = machine.status === 'RUNNING' ? 'STOPPED' : 'RUNNING';

      if (newStatus === 'RUNNING') {
        // بدء تشغيل جديد: نسجّل لحظة البدء فقط الآن؛ يُحسب Runtime الفعلي عند التوقف
        await pool.query('UPDATE machines SET status = ?, running_started_at = NOW() WHERE id = ?', [newStatus, machine.id]);
      } else {
        // توقف: نغلق دورة التشغيل الحالية ونحسب مدتها الفعلية (Runtime حقيقي، منفصل عن machine_time المقدَّر)
        await pool.query('UPDATE machines SET status = ?, running_started_at = NULL WHERE id = ?', [newStatus, machine.id]);
        if (machine.running_started_at) {
          await pool.query(
            `INSERT INTO machine_runtime_logs (machine_id, started_by, started_at, stopped_at, duration_seconds)
             VALUES (?, ?, ?, NOW(), TIMESTAMPDIFF(SECOND, ?, NOW()))`,
            [machine.id, req.user.id, machine.running_started_at, machine.running_started_at]
          );
        }
        // ملاحظة: إن كانت running_started_at فارغة رغم أن الحالة كانت RUNNING (بيانات قديمة قبل
        // ترقية Statistics)، لا يمكن حساب مدة حقيقية لها — يُتجاهَل تسجيل Runtime لهذه الحالة فقط
        // دون التأثير على تبديل الحالة نفسه.
      }

      const title = machine.label;
      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — ${title}: ${newStatus === 'RUNNING' ? 'بدء التشغيل' : 'إيقاف التشغيل'}`,
        type: newStatus === 'RUNNING' ? 'success' : 'warning'
      });
      await addNotification(io, title + (newStatus === 'RUNNING' ? ' - بدأ التشغيل' : ' - توقف'), 'machine');

      const updated = await getMachineFull(code);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // إضافة ملف جديد (بالاسم فقط، بدون رفع فعلي) — مشرف فقط
  router.post('/:code/files', requireAdmin, async (req, res) => {
    try {
      const { code } = req.params;
      const { name, time } = req.body;
      if (!name) return res.status(400).json({ error: 'اسم الملف مطلوب' });

      const [rows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = rows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      const seconds = timeToSeconds(time || '00:00:00');
      const [maxOrder] = await pool.query(
        'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ?', [machine.id]
      );

      await pool.query(
        'INSERT INTO machine_files (machine_id, name, status, time_seconds, sort_order) VALUES (?,?,?,?,?)',
        [machine.id, name, 'WAITING', seconds, maxOrder[0].m + 1]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — أضاف ملف: ${name} إلى ${machine.label}`,
        type: 'success'
      });
      await addNotification(io, 'ملف جديد: ' + name, 'file');

      const updated = await getMachineFull(code);
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
      const { time } = req.body;
      if (!req.file) return res.status(400).json({ error: 'لم يتم استلام أي ملف' });

      const [rows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = rows[0];
      if (!machine) {
        if (!R2_ENABLED && req.file.path) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'الماكينة غير موجودة' });
      }

      const seconds = timeToSeconds(time || '00:00:00');
      const [maxOrder] = await pool.query(
        'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ?', [machine.id]
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
         (machine_id, name, status, time_seconds, stored_filename, original_filename, file_size, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [machine.id, req.file.originalname, 'WAITING', seconds, storedName, req.file.originalname, req.file.size, maxOrder[0].m + 1]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — رفع ملف: ${req.file.originalname} إلى ${machine.label}`,
        type: 'success'
      });
      await addNotification(io, 'ملف جديد: ' + req.file.originalname, 'file');

      const updated = await getMachineFull(code);
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

      const updated = await getMachineFull(machineCode);
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

      const updated = await getMachineFull(machineCode);
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

      const updated = await getMachineFull(machineCode);
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

      const updated = await getMachineFull(machineCode);
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

      const updated = await getMachineFull(machineCode);
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

      const updated = await getMachineFull(machineCode);
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

      const [maxOrder] = await pool.query(
        'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ?', [targetMachine.id]
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

      // نبثّ تحديث الماكينتين معاً (المصدر والهدف) لأن الحالة تغيّرت في الاثنتين
      const updatedSource = sourceMachine ? await getMachineFull(sourceMachine.code) : null;
      const updatedTarget = await getMachineFull(targetMachine.code);
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

      const { targetMachineCode } = req.body;
      if (!['big', 'small', 'queue'].includes(targetMachineCode)) {
        return res.status(400).json({ error: 'كود الماكينة الهدف غير صحيح' });
      }

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

        affectedSourceMachineIds.add(file.machine_id);

        const [maxOrder] = await pool.query(
          'SELECT COALESCE(MAX(sort_order),0) AS m FROM machine_files WHERE machine_id = ?', [targetMachine.id]
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
        if (mRows[0]) broadcastMachineUpdate(await getMachineFull(mRows[0].code));
      }
      broadcastMachineUpdate(await getMachineFull(targetMachine.code));

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

      for (const fileId of ids) {
        const [rows] = await pool.query('SELECT * FROM machine_files WHERE id = ?', [fileId]);
        const file = rows[0];
        if (!file) { skipped.push(fileId); continue; }

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
        if (mRows[0]) broadcastMachineUpdate(await getMachineFull(mRows[0].code));
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

      const updated = await getMachineFull(machineCode);
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
      await pool.query('UPDATE machine_files SET time_seconds = ? WHERE id = ?', [seconds, fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — غيّر وقت "${file.name}" إلى "${time}" في ${machineLabel || ''}`,
        type: 'info'
      });

      const updated = await getMachineFull(machineCode);
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

      const updated = await getMachineFull(machineCode);
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
      await pool.query('DELETE FROM machine_files WHERE id = ?', [fileId]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف ملف: ${file.name} من ${machineLabel || ''} (أُضيف وقته ${secondsToTime(file.time_seconds)} لوقت الماكينة)`,
        type: 'warning'
      });

      const updated = await getMachineFull(machineCode);
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
      const { orderedIds } = req.body; // مصفوفة معرفات الملفات بالترتيب الجديد
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'orderedIds يجب أن تكون مصفوفة' });
      }

      const [mRows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = mRows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      // تحديث ترتيب كل ملف
      await Promise.all(orderedIds.map((id, idx) =>
        pool.query('UPDATE machine_files SET sort_order = ? WHERE id = ? AND machine_id = ?', [idx + 1, id, machine.id])
      ));

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — رتّب قائمة التشغيل في ${machine.label}`,
        type: 'info'
      });

      const updated = await getMachineFull(code);
      broadcastMachineUpdate(updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
