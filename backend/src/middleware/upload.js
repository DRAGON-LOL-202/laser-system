const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { R2_ENABLED } = require('../config/r2');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_EXT = ['.dxf', '.svg', '.ai', '.dwg', '.pdf', '.png', '.jpg', '.jpeg', '.crv3d'];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXT.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('نوع الملف غير مدعوم. الأنواع المسموحة: ' + ALLOWED_EXT.join(', ')));
  }
};

// الحد الأقصى: 100 ميجابايت (أقصى حجم مسموح فعلياً عبر بروكسي Render في الخطة المجانية،
// رفعه أكثر من ذلك في الكود لن يكون له أثر لأن الطلب يُرفض من الاستضافة قبل وصوله للسيرفر)
const maxSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10);

// عند تفعيل R2: نستخدم memoryStorage (الملف يبقى في الذاكرة كـ buffer لنرفعه بعدها يدوياً إلى R2)
// عند عدم تفعيل R2: نستخدم diskStorage كما كان (وضع تطوير محلي فقط، الملفات ستُفقد على الاستضافات المجانية)
const storage = R2_ENABLED
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${unique}${ext}`);
      }
    });

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxSizeMB * 1024 * 1024 }
});

// رافع منفصل خاص بصور المعاينة فقط (jpg/png/webp، حد أقصى 8 ميجابايت)
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const imageFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (IMAGE_EXT.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('صورة المعاينة يجب أن تكون من نوع PNG أو JPG أو WEBP'));
  }
};
const uploadThumbnail = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }
});

// رافع منفصل خاص بالتعليقات الصوتية (webm/mp3/wav/ogg، حد أقصى 15 ميجابايت — يكفي لعدة دقائق تسجيل)
const AUDIO_EXT = ['.webm', '.mp3', '.wav', '.ogg', '.m4a'];
const audioFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (AUDIO_EXT.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('التسجيل الصوتي يجب أن يكون من نوع WEBM أو MP3 أو WAV أو OGG'));
  }
};
const uploadVoice = multer({
  storage,
  fileFilter: audioFileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }
});

module.exports = { upload, uploadThumbnail, uploadVoice, UPLOAD_DIR, R2_ENABLED };
