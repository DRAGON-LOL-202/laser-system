-- ============================================================
-- ترقية قاعدة بيانات موجودة مسبقاً (لا تحذف أي بيانات)
-- شغّل هذا فقط إذا كانت قاعدة بياناتك تحتوي بالفعل على الجداول الأساسية
-- (يُضاف إلى نفس آلية GitHub Actions المستخدمة سابقاً — انظر ملف
--  .github/workflows/migrate-database.yml وأضف خطوة تشغيل لهذا الملف،
--  أو شغّله يدوياً بنفس طريقة migration_thumbnail.sql)
-- ============================================================

ALTER TABLE `machine_files`
  ADD COLUMN `text_comment` TEXT DEFAULT NULL COMMENT 'تعليق كتابي يضيفه المشرف'
  AFTER `thumbnail_filename`,
  ADD COLUMN `voice_comment_filename` VARCHAR(255) DEFAULT NULL COMMENT 'اسم ملف التسجيل الصوتي المخزن (يضيفه المشرف)'
  AFTER `text_comment`;
