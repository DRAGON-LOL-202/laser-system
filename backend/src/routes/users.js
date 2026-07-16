const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { addLog } = require('../utils/events');
const { isOnline } = require('../utils/presence');

module.exports = (io) => {
  const router = express.Router();

  // كل مسارات هذا الملف تتطلب تسجيل دخول مشرف
  router.use(authenticate, requireAdmin);

  // جلب كل المستخدمين — مع تصفية هرمية لحالة الاتصال:
  // المشرف الرئيسي (Root) يرى حالة اتصال الجميع.
  // المشرف العادي يرى حالة اتصال (المشرفين العاديين + المشغّلين) فقط، ولا يرى حالة الرئيسي.
  // المشغّل يرى حالة اتصال (المشغّلين الآخرين) فقط، ولا يرى حالة أي مشرف.
  router.get('/', async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT id, name, username, role, is_root AS isRoot, created_at FROM users ORDER BY id ASC'
      );

      const viewer = req.user; // { isRoot, role, id, ... }

      const canSeeStatusOf = (target) => {
        if (viewer.isRoot) return true; // الرئيسي يرى الجميع
        if (target.isRoot) return false; // لا أحد غير الرئيسي يرى حالة الرئيسي
        if (viewer.role === 'admin') return true; // المشرف العادي يرى (مشرفين عاديين + مشغّلين)
        // المشغّل: يرى فقط مشغّلين آخرين
        return target.role === 'operator';
      };

      const result = rows.map(u => {
        const visible = canSeeStatusOf(u);
        return {
          ...u,
          isRoot: !!u.isRoot,
          online: visible ? isOnline(u.id) : null, // null = حالة الاتصال غير مُتاحة لهذا العارض
        };
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // إضافة مستخدم جديد
  router.post('/', async (req, res) => {
    try {
      const { name, username, password, role, adminCode } = req.body;

      if (!name || !username || !password) {
        return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });
      }
      if (adminCode !== process.env.ADMIN_CODE) {
        return res.status(403).json({ error: 'كود الأدمن غير صحيح' });
      }
      // إضافة مشرف جديد تتطلب صلاحية المشرف الرئيسي فقط
      if (role === 'admin' && !req.user.isRoot) {
        return res.status(403).json({ error: 'فقط المشرف الرئيسي يمكنه إضافة مشرفين جدد' });
      }

      const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
      if (existing.length > 0) {
        return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
      }

      const hash = await bcrypt.hash(password, 10);
      const finalRole = role === 'admin' ? 'admin' : 'operator';

      const [result] = await pool.query(
        'INSERT INTO users (name, username, password, role, is_root) VALUES (?,?,?,?,0)',
        [name, username, hash, finalRole]
      );

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — أضاف مستخدماً جديداً: ${name} (${finalRole === 'admin' ? 'مشرف' : 'مشغل'})`,
        type: 'success'
      });

      res.status(201).json({
        id: result.insertId, name, username, role: finalRole, isRoot: false
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  // حذف مستخدم
  router.delete('/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
      const target = rows[0];

      if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
      if (target.is_root) return res.status(403).json({ error: 'لا يمكن حذف المشرف الرئيسي' });
      if (target.role === 'admin' && !req.user.isRoot) {
        return res.status(403).json({ error: 'فقط المشرف الرئيسي يمكنه حذف المشرفين' });
      }

      await pool.query('DELETE FROM users WHERE id = ?', [id]);

      await addLog(io, {
        userId: req.user.id,
        event: `${req.user.name} — حذف المستخدم: ${target.name} (${target.role === 'admin' ? 'مشرف' : 'مشغل'})`,
        type: 'warning'
      });

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  });

  return router;
};
