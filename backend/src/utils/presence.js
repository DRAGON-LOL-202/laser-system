// تتبّع المستخدمين المتصلين حالياً عبر Socket.io
// الخريطة: userId -> Set من socket.id (نفس المستخدم قد يكون متصلاً من أكثر من جهاز/تبويب)
const onlineUsers = new Map();

function markOnline(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}

// إزالة هذا الـ socket فقط؛ يبقى المستخدم "متصل" إن كان لديه اتصال آخر مفتوح (تبويب ثانٍ مثلاً)
function markOffline(userId, socketId) {
  if (!onlineUsers.has(userId)) return;
  const set = onlineUsers.get(userId);
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}

function isOnline(userId) {
  return onlineUsers.has(userId);
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

module.exports = { markOnline, markOffline, isOnline, getOnlineUserIds };
