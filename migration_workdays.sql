-- ============================================================
-- ترقية قاعدة بيانات موجودة مسبقاً (لا تحذف أي بيانات)
-- المرحلة 3: نظام "أيام العمل الستة" + جدول الأسابيع بتواريخ فعلية
--
-- القرار المعماري (محسوم بالرجوع للقرار المحفوظ مسبقًا عن هذا المشروع):
-- "يوم العمل" هو Tag تاريخي يُلصَق على صف machine_files الحالي فقط
-- (عمود work_day_id)، وليس Snapshot (لا يُنسَخ أي صف) وليس قفل حالة حية.
-- إن انتقل ملف لاحقًا بين الماكينات أو تغيّرت حالته، يبقى نفس الصف
-- ونفس work_day_id إلا إذا غيّره المستخدم صراحة (مثلاً عبر Bulk Move
-- ليوم آخر لاحقًا في مرحلة قادمة).
--
-- لا يوجد أي حذف أو نسخ لبيانات machine_files في هذا الملف.
-- مثال للتشغيل: mysql -u root -p اسم_قاعدة_البيانات < migration_workdays.sql
-- ============================================================

-- جدول الأسابيع — بتواريخ بداية/نهاية فعلية (وليس رقم أسبوع مجرد)
CREATE TABLE IF NOT EXISTS `work_weeks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `week_number` TINYINT UNSIGNED NOT NULL COMMENT 'رقم الأسبوع للعرض فقط (1..5) - التمييز الفعلي بين الأسابيع عبر start_date',
  `start_date` DATE NOT NULL,
  `end_date` DATE NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_week_start` (`start_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- جدول أيام العمل — سجل تاريخي لكل يوم عمل فعلي (تاريخ حقيقي، ليس تكرار أسبوعي)
CREATE TABLE IF NOT EXISTS `work_days` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `work_date` DATE NOT NULL,
  `day_name` ENUM('sat','sun','mon','tue','wed','thu') NOT NULL,
  `week_id` INT UNSIGNED DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'اليوم المفتوح حاليًا للعمل. صف واحد فقط يجب أن يكون 1 - يُطبَّق ذلك في الـBackend عند "بدء يوم جديد"، وليس بقيد DB',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_work_date` (`work_date`),
  KEY `idx_week` (`week_id`),
  CONSTRAINT `fk_workday_week` FOREIGN KEY (`week_id`) REFERENCES `work_weeks` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- وسم (Tag) يوم العمل على صف الملف الحالي في machine_files
-- ON DELETE SET NULL: حذف يوم عمل (نادرًا، احتياطيًا) لا يحذف ولا يمس ملفات machine_files إطلاقًا،
-- فقط يفرّغ الوسم - تماشيًا مع بند "لا تحذف بيانات الأيام/الأسابيع السابقة عند بدء يوم جديد"
-- والأهم: لا يحذف الملفات الفعلية بأي حال.
ALTER TABLE `machine_files`
  ADD COLUMN `work_day_id` INT UNSIGNED DEFAULT NULL COMMENT 'وسم تاريخي ليوم العمل - Tag فقط، لا Snapshot ولا نسخ للصف'
    AFTER `sort_order`,
  ADD CONSTRAINT `fk_file_workday` FOREIGN KEY (`work_day_id`) REFERENCES `work_days` (`id`) ON DELETE SET NULL;

ALTER TABLE `machine_files`
  ADD KEY `idx_work_day` (`work_day_id`);
