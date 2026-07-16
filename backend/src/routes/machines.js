const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { upload, uploadThumbnail, UPLOAD_DIR, R2_ENABLED } = require('../middleware/upload');
const { uploadToR2, getFromR2, deleteFromR2 } = require('../config/r2');
const { addLog, addNotification } = require('../utils/events');
const { timeToSeconds, secondsToTime } = require('../utils/time');

module.exports = (io) => {
  const router = express.Router();

  router.use(authenticate); // كل المسارات تتطلب تسجيل دخول (مشرف أو مشغل)

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
        thumbnailUrl: f.thumbnail_filename ? `/api/machines/files/${f.id}/thumbnail` : null
      }))
    };
  }

  // جلب كل الماكينات (الكبيرة والصغيرة) مع ملفاتها
  router.get('/', async (req, res) => {
    try {
      const big = await getMachineFull('big');
      const small = await getMachineFull('small');
      res.json({ big, small });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // تشغيل/إيقاف ماكينة (مشرف فقط)
  router.patch('/:code/toggle', requireAdmin, async (req, res) => {
    try {
      const { code } = req.params;
      const [rows] = await pool.query('SELECT * FROM machines WHERE code = ?', [code]);
      const machine = rows[0];
      if (!machine) return res.status(404).json({ error: 'الماكينة غير موجودة' });

      const newStatus = machine.status === 'RUNNING' ? 'STOPPED' : 'RUNNING';
      await pool.query('UPDATE machines SET status = ? WHERE id = ?', [newStatus, machine.id]);

      const title = machine.label;
      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — ${title}: ${newStatus === 'RUNNING' ? 'بدء التشغيل' : 'إيقاف التشغيل'}`,
        type: newStatus === 'RUNNING' ? 'success' : 'warning'
      });
      await addNotification(io, title + (newStatus === 'RUNNING' ? ' - بدأ التشغيل' : ' - توقف'));

      const updated = await getMachineFull(code);
      io.emit('machine:update', updated);
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

      const seconds = timeToSeconds(time || '00:08:00');
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
      await addNotification(io, 'ملف جديد: ' + name);

      const updated = await getMachineFull(code);
      io.emit('machine:update', updated);
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

      const seconds = timeToSeconds(time || '00:08:00');
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
      await addNotification(io, 'ملف جديد: ' + req.file.originalname);

      const updated = await getMachineFull(code);
      io.emit('machine:update', updated);
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
      io.emit('machine:update', updated);
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
      io.emit('machine:update', updated);
      res.json(updated);
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
      io.emit('machine:update', updated);
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
      io.emit('machine:update', updated);
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
      io.emit('machine:update', updated);
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
      io.emit('machine:update', updated);
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
      io.emit('machine:update', updated);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
