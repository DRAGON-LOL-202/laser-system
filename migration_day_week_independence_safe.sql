-- ============================================================
-- Migration: استقلال الأيام السبعة (الجمعة→الخميس) × 4 أسابيع
-- 🆕 نسخة آمنة ومتكررة التنفيذ (Idempotent) — مبنية على فحص فعلي لقاعدة
-- البيانات الحية عبر inspect-day-week-schema.yml (راجع HANDOFF.md §31):
--   - work_weeks: start_date/end_date كانا NULL-able بالفعل، وuq_week_number
--     كان موجودًا بالفعل من قبل (تعديل جزئي/يدوي سابق) — لكن week_number
--     2/3/4 لم تكن مزروعة بعد (صف واحد فقط، week_number=1).
--   - work_days: لسه في الحالة القديمة بالكامل (بدون 'fri'، work_date
--     NOT NULL، بدون uq_week_day)، وفيها صف واحد فقط بـ week_id = NULL
--     (id=1، الأحد، تاريخ 2026-09-13 — واقع فعليًا داخل مدى الأسبوع 1
--     الحالي 2026-09-13→2026-09-17)، وصف آخر سليم (id=3، الاثنين، week_id=1).
--   - machine_files: 0 صفوف تشاور على work_day_id حاليًا — لا خطر فقدان
--     بيانات ملفات من أي تعديل هنا.
-- كل خطوة أدناه تتحقق أولاً (INFORMATION_SCHEMA) قبل التنفيذ، فيمكن إعادة
-- تشغيل هذا الملف بأمان أكثر من مرة دون أي خطأ "already exists" أو
-- "doesn't exist".
-- ============================================================

-- 0) إصلاح الصف الوحيد الناقص week_id قبل أي تعديل بنية (لا حذف لأي بيانات،
--    فقط ربط الصف الموجود فعليًا بالأسبوع 1 الحالي بدل تركه بلا أسبوع)
UPDATE `work_days` SET `week_id` = 1 WHERE `week_id` IS NULL;

-- 1) الأسابيع: حذف uq_week_start فقط لو ما زال موجودًا
SET @idx_exists := (
  SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_weeks' AND INDEX_NAME = 'uq_week_start'
);
SET @sql := IF(@idx_exists > 0, 'ALTER TABLE `work_weeks` DROP INDEX `uq_week_start`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE `work_weeks`
  MODIFY COLUMN `start_date` DATE NULL,
  MODIFY COLUMN `end_date` DATE NULL;

SET @idx_exists := (
  SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_weeks' AND INDEX_NAME = 'uq_week_number'
);
SET @sql := IF(@idx_exists = 0, 'ALTER TABLE `work_weeks` ADD UNIQUE KEY `uq_week_number` (`week_number`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) الأيام: حذف uq_work_date فقط لو ما زال موجودًا
SET @idx_exists := (
  SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_days' AND INDEX_NAME = 'uq_work_date'
);
SET @sql := IF(@idx_exists > 0, 'ALTER TABLE `work_days` DROP INDEX `uq_work_date`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE `work_days`
  MODIFY COLUMN `day_name` ENUM('fri','sat','sun','mon','tue','wed','thu') NOT NULL,
  MODIFY COLUMN `work_date` DATE NULL,
  MODIFY COLUMN `week_id` INT UNSIGNED NOT NULL;

SET @idx_exists := (
  SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_days' AND INDEX_NAME = 'uq_week_day'
);
SET @sql := IF(@idx_exists = 0, 'ALTER TABLE `work_days` ADD UNIQUE KEY `uq_week_day` (`week_id`, `day_name`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) Seed: الأسابيع الأربعة الثابتة (week_number=1 موجود بالفعل فسيُتجاهَل، 2/3/4 ستُضاف)
INSERT IGNORE INTO `work_weeks` (`week_number`, `start_date`, `end_date`) VALUES
  (1, NULL, NULL), (2, NULL, NULL), (3, NULL, NULL), (4, NULL, NULL);

-- 4) Seed: 28 خانة يوم ثابتة (4 أسابيع × 7 أيام) — الخانتان الموجودتان فعلاً
--    (week1/sun و week1/mon) ستُتجاهَلان تلقائيًا بفضل uq_week_day، وتبقيان
--    بنفس id/بيانات القديمة كما هما (لا حذف ولا استبدال).
INSERT IGNORE INTO `work_days` (`work_date`, `day_name`, `week_id`, `is_active`)
SELECT NULL, d.day_name, w.id, 0
FROM `work_weeks` w
CROSS JOIN (
  SELECT 'fri' AS day_name UNION ALL SELECT 'sat' UNION ALL SELECT 'sun' UNION ALL
  SELECT 'mon' UNION ALL SELECT 'tue' UNION ALL SELECT 'wed' UNION ALL SELECT 'thu'
) d;
