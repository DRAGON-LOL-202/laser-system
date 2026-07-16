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
async function addNotification(io, message) {
  const [result] = await pool.query(
    'INSERT INTO notifications (message) VALUES (?)',
    [message]
  );
  const [rows] = await pool.query('SELECT * FROM notifications WHERE id = ?', [result.insertId]);
  const notif = rows[0];

  if (io) io.emit('notif:new', notif);
  return notif;
}

module.exports = { addLog, addNotification };
