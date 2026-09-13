const { pool } = require('../config/db');

// إضافة سجل عملية جديد + بثه لحظياً لكل المتصلين عبر Socket.io
async function addLog(io, { userId = null, event, type = 'info' }) {
  const [result] = await pool.query(
    'INSERT INTO logs (user_id, event, type) VALUES (?,?,?)',
    [userId, event, type]
  );

  const [rows] = await pool.query('SELECT * FROM logs WHERE id = ?', [result.insertId]);
  const log = rows[0];

  if (io) io.emit('log:new', log);
  return log;
}

// إضافة إشعار جديد + بثه لحظياً
// type: تصنيف حسب مصدر الحدث — 'machine' | 'file' | 'workday' (يطابق ENUM notifications.type)
async function addNotification(io, message, type = 'file') {
  const [result] = await pool.query(
    'INSERT INTO notifications (message, type) VALUES (?, ?)',
    [message, type]
  );
  const [rows] = await pool.query('SELECT * FROM notifications WHERE id = ?', [result.insertId]);
  const notif = rows[0];

  if (io) io.emit('notif:new', notif);
  return notif;
}

module.exports = { addLog, addNotification };
