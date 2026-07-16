const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

// تفعيل R2 فقط إن وُجدت بياناته في .env — وإلا يعمل النظام بالتخزين المحلي (للتطوير فقط)
const R2_ENABLED = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

let s3 = null;
if (R2_ENABLED) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('✓ تخزين الملفات: Cloudflare R2 (دائم)');
} else {
  console.log('⚠ تخزين الملفات: القرص المحلي (مؤقت — يُفقد عند إعادة تشغيل الاستضافات المجانية). أضف بيانات R2 في .env للتخزين الدائم.');
}

const BUCKET = process.env.R2_BUCKET_NAME || 'laser-cnc-files';

// رفع ملف (buffer) إلى R2 وإرجاع المفتاح المُخزَّن
async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

// جلب ملف من R2 كـ stream (للتحميل)
async function getFromR2(key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return result.Body; // stream قابل للتمرير مباشرة في res
}

// حذف ملف من R2
async function deleteFromR2(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { R2_ENABLED, uploadToR2, getFromR2, deleteFromR2 };
