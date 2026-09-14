-- ============================================================
-- ترقية قاعدة بيانات موجودة مسبقاً (لا تحذف أي بيانات)
-- 🆕 نسخة آمنة ومتكررة التنفيذ (Idempotent) — نفس محتوى
-- migration_file_time_statistics.sql بالظبط، لكن بعد ما تبيّن إن
-- محاولة سابقة (غير موثّقة) كانت خلصت خطوة إضافة عمود time_recorded_at
-- بنجاح ووقفت قبل باقي الملف (ERROR 1060: Duplicate column name
-- 'time_recorded_at' عند إعادة تشغيل الملف الأصلي).
-- باقي الملف (CREATE TABLE IF NOT EXISTS + UPDATE بشرط IS NULL) كان
-- أصلاً آمنًا للتكرار، فمكانش محتاج تعديل.
-- ============================================================

-- 1) عمود time_recorded_at: يُضاف فقط لو مش موجود بالفعل
SET @col_exists := (
  SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'machine_files' AND COLUMN_NAME = 'time_recorded_at'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `machine_files` ADD COLUMN `time_recorded_at` DATETIME NULL COMMENT ''يُحدَّث تلقائيًا كلما أُدخل/عُدِّل وقت الملف (time_seconds) — لتجميع Statistics فقط، لا علاقة له بطريقة الإدخال اليدوي'' AFTER `time_seconds`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) جدول الأرشيف: كان أصلاً IF NOT EXISTS، بلا تغيير
CREATE TABLE IF NOT EXISTS `file_time_archive` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `machine_id` INT UNSIGNED NOT NULL,
  `seconds` INT UNSIGNED NOT NULL COMMENT 'قيمة time_seconds وقت حذف الملف',
  `recorded_at` DATETIME NOT NULL COMMENT 'time_recorded_at الأصلي للملف (أو created_at لو لم يُدخَل وقت صراحةً قبل الحذف)',
  `archived_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'وقت الحذف الفعلي (للتوثيق فقط، غير مستخدم في التجميع)',
  PRIMARY KEY (`id`),
  KEY `idx_machine` (`machine_id`),
  KEY `idx_recorded_at` (`recorded_at`),
  CONSTRAINT `fk_archive_machine` FOREIGN KEY (`machine_id`) REFERENCES `machines` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Backfill: كان أصلاً بشرط IS NULL، بلا تغيير (آمن للتكرار)
UPDATE `machine_files`
SET `time_recorded_at` = `created_at`
WHERE `time_seconds` > 0 AND `time_recorded_at` IS NULL;

-- ملاحظة: machine_runtime_logs وoperator_sessions لم يُمَسّا إطلاقًا.
