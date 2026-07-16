const jwt = require('jsonwebtoken');

// التحقق من وجود توكن صالح
// يقبل التوكن من Authorization header (الحالة العادية لطلبات fetch/axios)
// أو من query parameter ?token=... (ضروري لوسوم <img src> التي لا ترسل headers مخصصة، مثل صور المعاينة)
function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  const headerToken = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  const token = headerToken || req.query.token || null;

  if (!token) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول إلى هذا المورد' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'الجلسة غير صالحة أو منتهية، يرجى تسجيل الدخول مجدداً' });
    }
    req.user = decoded; // { id, username, name, role, isRoot }
    next();
  });
}

// السماح فقط للمشرفين (admin)
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'هذا الإجراء يتطلب صلاحية مشرف' });
  }
  next();
}

// السماح فقط للمشرف الرئيسي (Root)
function requireRoot(req, res, next) {
  if (!req.user?.isRoot) {
    return res.status(403).json({ error: 'هذا الإجراء يتطلب صلاحية المشرف الرئيسي' });
  }
  next();
}

module.exports = { authenticate, requireAdmin, requireRoot };
