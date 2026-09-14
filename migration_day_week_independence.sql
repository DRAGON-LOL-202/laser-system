-- ============================================================
-- Migration: استقلال الأيام السبعة (الجمعة→الخميس) × 4 أسابيع
-- الهدف: تحويل work_weeks/work_days من نموذج "تاريخ حقيقي + يوم نشط واحد"
-- إلى نموذج "28 خانة ثابتة مستقلة" (4 أسابيع × 7 أيام)، كل خانة لها
-- ملفاتها الخاصة دائمًا عبر machine_files.work_day_id (بدون حذف أي بيانات قديمة).
-- ============================================================

-- 1) الأسابيع: التمييز الحقيقي الآن هو week_number (1..4) فقط، التواريخ اختيارية للعرض
ALTER TABLE `work_weeks` DROP INDEX `uq_week_start`;
ALTER TABLE `work_weeks`
  MODIFY COLUMN `start_date` DATE NULL,
  MODIFY COLUMN `end_date` DATE NULL,
  ADD UNIQUE KEY `uq_week_number` (`week_number`);

-- 2) الأيام: إضافة الجمعة، وجعل اليوم مرتبطًا بالأسبوع (وليس بتاريخ حقيقي)
ALTER TABLE `work_days` DROP INDEX `uq_work_date`;
ALTER TABLE `work_days`
  MODIFY COLUMN `day_name` ENUM('fri','sat','sun','mon','tue','wed','thu') NOT NULL,
  MODIFY COLUMN `work_date` DATE NULL,
  MODIFY COLUMN `week_id` INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY `uq_week_day` (`week_id`, `day_name`);

-- 3) Seed: الأسابيع الأربعة الثابتة (لا تُنشأ ديناميكيًا بعد الآن)
INSERT IGNORE INTO `work_weeks` (`week_number`, `start_date`, `end_date`) VALUES
  (1, NULL, NULL), (2, NULL, NULL), (3, NULL, NULL), (4, NULL, NULL);

-- 4) Seed: 28 خانة يوم ثابتة (4 أسابيع × 7 أيام) إن لم تكن موجودة
INSERT IGNORE INTO `work_days` (`work_date`, `day_name`, `week_id`, `is_active`)
SELECT NULL, d.day_name, w.id, 0
FROM `work_weeks` w
CROSS JOIN (
  SELECT 'fri' AS day_name UNION ALL SELECT 'sat' UNION ALL SELECT 'sun' UNION ALL
  SELECT 'mon' UNION ALL SELECT 'tue' UNION ALL SELECT 'wed' UNION ALL SELECT 'thu'
) d;

-- ملاحظة: أي صفوف work_days قديمة كانت مرتبطة بتواريخ حقيقية سابقة تبقى كما هي
-- (لم تُحذف)، وأي machine_files.work_day_id كانت تشاور عليها تبقى صحيحة.
-- الفرق أن التنقل الجديد في الواجهة يعتمد على (week_number, day_name) فقط.
