require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { testConnection } = require('./config/db');
const { markOnline, markOffline, getOnlineUserIds } = require('./utils/presence');

const app = express();
const server = http.createServer(app);

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

// -------- Middleware --------
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// تقديم الملفات المرفوعة (للمعاينة المباشرة عند الحاجة)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// -------- Socket.io: مصادقة الاتصال + تتبع الحضور (Online/Offline) --------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(); // نسمح بالاتصال دون توكن (للتوافق)، لكن لن يُحسب "متصل"
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (!err && decoded) socket.user = decoded;
    next();
  });
});

io.on('connection', (socket) => {
  if (socket.user) {
    markOnline(socket.user.id, socket.id);
    io.emit('presence:update', { userId: socket.user.id, online: true });
    // المشرفون فقط ينضمون لغرفة خاصة تستقبل تحديثات قائمة الانتظار (لا يجب أن يصل بثّها لغير المشرفين إطلاقاً)
    if (socket.user.role === 'admin') {
      socket.join('admins');
    }
  }

  socket.on('disconnect', () => {
    if (socket.user) {
      markOffline(socket.user.id, socket.id);
      // بعد قطع الاتصال، نتحقق هل ما زال للمستخدم اتصال آخر مفتوح قبل بثّ "غير متصل"
      const stillOnline = getOnlineUserIds().includes(socket.user.id);
      if (!stillOnline) io.emit('presence:update', { userId: socket.user.id, online: false });
    }
  });
});

// -------- المسارات (Routes) --------
app.use('/api/auth', require('./routes/auth')(io));
app.use('/api/users', require('./routes/users')(io));
app.use('/api/machines', require('./routes/machines')(io));
app.use('/api/logs', require('./routes/logs')());
app.use('/api/notifications', require('./routes/notifications')());

// قائمة المستخدمين المتصلين الآن (يُستخدم عند تحميل الصفحة لأول مرة)
app.get('/api/presence', (req, res) => {
  res.json({ onlineUserIds: getOnlineUserIds() });
});

// فحص صحة السيرفر
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// التعامل مع أخطاء Multer وغيرها بشكل موحّد
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && err.message.includes('غير مدعوم')) {
    return res.status(400).json({ error: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'حجم الملف أكبر من المسموح' });
  }
  res.status(500).json({ error: 'خطأ غير متوقع في الخادم' });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  await testConnection();
});
