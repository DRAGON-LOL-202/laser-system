-- ============================================================
-- ترقية قاعدة بيانات موجودة مسبقاً (لا تحذف أي بيانات)
-- الهدف: تصحيح مصدر "وقت تشغيل الماكينات" في صفحة Statistics ليصبح
-- = مجموع "وقت الملف" (time_seconds) الفعلي في machine_files، بدل
-- machine_runtime_logs / زر تسجيل بدء-توقف التشغيل.
-- machine_runtime_logs نفسه لا يُحذف ولا يتوقف عن العمل — يبقى كما هو
-- (القرار الموثّق في HANDOFF.md)، فقط لم يعد Statistics تقرأ منه.
-- مثال للتشغيل: mysql -u root -p اسم_قاعدة_البيانات < migration_file_time_statistics.sql
-- ============================================================

-- 1) عمود جديد: يسجّل تلقائيًا "متى" أُدخل/عُدِّل وقت الملف الحالي (time_seconds).
--    لا يغيّر هذا طريقة إدخال الوقت نفسها (نفس الحقل، نفس الـAPI، نفس الواجهة) —
--    هو فقط طابع زمني داخلي إضافي يُستخدم حصرًا لتجميع الإحصائيات حسب
--    اليوم/الأسبوع/الشهر الحقيقي (machine_files.work_day_id افتراضي/وهمي
--    ولا يحمل تاريخًا حقيقيًا، فلا يصلح للتجميع الزمني الحقيقي).
ALTER TABLE `machine_files`
  ADD COLUMN `time_recorded_at` DATETIME NULL
    COMMENT 'يُحدَّث تلقائيًا كلما أُدخل/عُدِّل وقت الملف (time_seconds) — لتجميع Statistics فقط، لا علاقة له بطريقة الإدخال اليدوي'
  AFTER `time_seconds`;

-- 2) جدول أرشيف صغير (Append-only): يحفظ مساهمة كل ملف في "وقت الملف" وقت
--    حذفه (حذف فردي / حذف جماعي / Cleanup) حتى لا تفقد الإحصائيات بياناتها
--    التاريخية بعد حذف صف machine_files (تمامًا كما كان machine_runtime_logs
--    يحفظ التاريخ سابقًا رغم حذف الملفات، لكن المصدر هنا أصبح File Time).
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

-- 3) Backfill اختياري لصفوف machine_files القديمة (قبل هذه الترقية) التي لها
--    وقت مُدخَل بالفعل (time_seconds > 0) لكن لا time_recorded_at بعد — نأخذ
--    created_at كأفضل تقدير متاح، بدل تركها NULL وضياعها من كل الإحصائيات لحين
--    أول تعديل وقت جديد عليها.
UPDATE `machine_files`
SET `time_recorded_at` = `created_at`
WHERE `time_seconds` > 0 AND `time_recorded_at` IS NULL;

-- ملاحظة: machine_runtime_logs وoperator_sessions لم يُمَسّا إطلاقًا. جدول
-- operator_sessions ما زال يغذّي إحصائيات "جلسات المشغّلين" كما كان تمامًا؛
-- هذه الترقية تخص فقط إحصائيات "وقت تشغيل الماكينات" (GET /api/statistics/machines).
