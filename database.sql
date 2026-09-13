-- ============================================================
-- نظام إدارة ماكينات الليزر/CNC — قاعدة البيانات
-- متوافق مع MySQL 5.7+ / MariaDB 10+ (مناسب للاستضافات المجانية)
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------
-- جدول المستخدمين
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `username` VARCHAR(50) NOT NULL,
  `password` VARCHAR(255) NOT NULL COMMENT 'مشفّرة بـ bcrypt',
  `role` ENUM('admin','operator') NOT NULL DEFAULT 'operator',
  `is_root` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول الماكينات (ماكينتان فعليتان + قائمة انتظار مؤقتة)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `machines`;
CREATE TABLE `machines` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` ENUM('big','small','queue') NOT NULL COMMENT 'معرف ثابت؛ queue = قائمة انتظار مؤقتة لا تظهر للمشغل',
  `label` VARCHAR(100) NOT NULL,
  `status` ENUM('RUNNING','STOPPED') NOT NULL DEFAULT 'STOPPED',
  `current_file` VARCHAR(255) DEFAULT NULL,
  `machine_time` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'بالثواني — مجموع الوقت المقدَّر (time_seconds) للملفات المحذوفة/المنجزة، ليس Runtime فعلي (انظر machine_runtime_logs للـRuntime الحقيقي)',
  `running_started_at` DATETIME DEFAULT NULL COMMENT 'وقت بدء التشغيل الفعلي الحالي؛ NULL يعني الماكينة متوقفة الآن',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول ملفات التشغيل (قائمة الانتظار لكل ماكينة)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `machine_files`;
CREATE TABLE `machine_files` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `machine_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `status` ENUM('WAITING','WORKING','CUTTING','DELIVERED') NOT NULL DEFAULT 'WAITING',
  `time_seconds` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'الوقت المقدر للملف بالثواني',
  `stored_filename` VARCHAR(255) DEFAULT NULL COMMENT 'اسم الملف الفعلي المخزن على السيرفر',
  `original_filename` VARCHAR(255) DEFAULT NULL,
  `file_size` INT UNSIGNED DEFAULT NULL COMMENT 'بالبايت',
  `thumbnail_filename` VARCHAR(255) DEFAULT NULL COMMENT 'اسم صورة المعاينة المخزنة (يرفعها المشرف فقط)',
  `text_comment` TEXT DEFAULT NULL COMMENT 'تعليق كتابي يضيفه المشرف',
  `voice_comment_filename` VARCHAR(255) DEFAULT NULL COMMENT 'اسم ملف التسجيل الصوتي المخزن (يضيفه المشرف)',
  `sort_order` INT NOT NULL DEFAULT 0,
  `work_day_id` INT UNSIGNED DEFAULT NULL COMMENT 'وسم تاريخي ليوم العمل - Tag فقط، لا Snapshot ولا نسخ للصف',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_machine` (`machine_id`),
  KEY `idx_work_day` (`work_day_id`),
  CONSTRAINT `fk_file_machine` FOREIGN KEY (`machine_id`) REFERENCES `machines` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول الأسابيع — بتواريخ بداية/نهاية فعلية (وليس رقم أسبوع مجرد)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `work_weeks`;
CREATE TABLE `work_weeks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `week_number` TINYINT UNSIGNED NOT NULL COMMENT 'رقم الأسبوع للعرض فقط (1..5) - التمييز الفعلي بين الأسابيع عبر start_date',
  `start_date` DATE NOT NULL,
  `end_date` DATE NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_week_start` (`start_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول أيام العمل — سجل تاريخي لكل يوم عمل فعلي (Tag على machine_files، ليس Snapshot)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `work_days`;
CREATE TABLE `work_days` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `work_date` DATE NOT NULL,
  `day_name` ENUM('sat','sun','mon','tue','wed','thu') NOT NULL,
  `week_id` INT UNSIGNED DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'اليوم المفتوح حاليًا للعمل - صف واحد فقط يجب أن يكون 1 (يُطبَّق في الـBackend)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_work_date` (`work_date`),
  KEY `idx_week` (`week_id`),
  CONSTRAINT `fk_workday_week` FOREIGN KEY (`week_id`) REFERENCES `work_weeks` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `machine_files`
  ADD CONSTRAINT `fk_file_workday` FOREIGN KEY (`work_day_id`) REFERENCES `work_days` (`id`) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- جدول السجل (Logs)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `logs`;
CREATE TABLE `logs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `event` TEXT NOT NULL,
  `type` ENUM('info','success','warning') NOT NULL DEFAULT 'info',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  CONSTRAINT `fk_log_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول سجلات التشغيل الفعلي للماكينات (Runtime حقيقي — لإحصائيات Statistics)
-- صف واحد لكل دورة RUNNING→STOPPED مكتملة (لا يُقسَّم الصف نفسه أبداً). قاعدة
-- منتصف الليل الفعلية تُطبَّق عند القراءة فقط (backend/src/routes/statistics.js
-- + utils/time.js -> splitIntervalByDay): كل دورة تُقسَّم على مستوى الثانية بين
-- كل الأيام التقويمية التي تمر بها started_at→stopped_at فعلياً، بدل نسب المدة
-- كاملة ليوم البداية فقط.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `machine_runtime_logs`;
CREATE TABLE `machine_runtime_logs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `machine_id` INT UNSIGNED NOT NULL,
  `started_by` INT UNSIGNED DEFAULT NULL COMMENT 'المستخدم (مشرف) الذي ضغط زر التشغيل',
  `started_at` DATETIME NOT NULL,
  `stopped_at` DATETIME NOT NULL,
  `duration_seconds` INT UNSIGNED NOT NULL COMMENT 'محسوبة ومخزَّنة وقت التوقف (stopped_at - started_at)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_machine` (`machine_id`),
  KEY `idx_started_at` (`started_at`),
  CONSTRAINT `fk_runtime_machine` FOREIGN KEY (`machine_id`) REFERENCES `machines` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_runtime_user` FOREIGN KEY (`started_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول جلسات المشغّلين (حضور/انصراف — Login → Logout) — لإحصائيات Operator Sessions
-- logout_at = NULL يعني أن الجلسة لم تُغلَق صراحةً عبر /api/auth/logout (مثال: إغلاق
-- التبويب مباشرة دون تسجيل خروج) — تُستبعد هذه الجلسات من إجمالي المدة في التقارير
-- حتى تُغلَق، ولا تُغلَق تلقائيًا أبدًا عند تسجيل دخول جديد (تفادي اختلاق وقت غير حقيقي).
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `operator_sessions`;
CREATE TABLE `operator_sessions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `login_at` DATETIME NOT NULL,
  `logout_at` DATETIME DEFAULT NULL,
  `duration_seconds` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_login_at` (`login_at`),
  CONSTRAINT `fk_session_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- جدول الإشعارات
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `notifications`;
CREATE TABLE `notifications` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message` VARCHAR(255) NOT NULL,
  `type` ENUM('machine','file','workday') NOT NULL DEFAULT 'file' COMMENT 'تصنيف حسب مصدر الحدث',
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- بيانات أولية (Seed Data)
-- ============================================================

-- المستخدم الرئيسي (admin / lol / 214205)
-- كلمة المرور مشفرة بـ bcrypt — سيتم توليدها تلقائياً عند أول تشغيل من ملف seed.js
-- هذا السطر فقط احتياطي في حال التشغيل اليدوي للـ SQL (كلمة المرور هنا = 214205 مشفرة):
INSERT INTO `users` (`id`,`name`,`username`,`password`,`role`,`is_root`) VALUES
(1,'المشرف الرئيسي','lol','$2a$10$eLlK55xPopuwP9OD0meLUegSlhhYctwU4I3xtt.sOn3nwZiAEMUx6','admin',1);
-- ملاحظة: شغّل "node src/utils/seed.js" بعد رفع المشروع لتوليد الهاش الصحيح فعلياً وإدراج البيانات بأمان.

INSERT INTO `machines` (`id`,`code`,`label`,`status`,`current_file`,`machine_time`) VALUES
(1,'big','ماكينة كبيرة - CNC CO2','STOPPED','sign.svg',0),
(2,'small','ماكينة صغيرة - CNC CO2','RUNNING','keychain.dxf',0),
(3,'queue','قائمة الانتظار','STOPPED',NULL,0);

INSERT INTO `machine_files` (`machine_id`,`name`,`status`,`time_seconds`,`sort_order`) VALUES
(1,'wooden_sign.svg','DELIVERED',5100,1),
(1,'metal_bracket.ai','WAITING',5100,2),
(1,'metal_bracket_v2.ai','DELIVERED',5100,3),
(1,'cabinet_part_V3.ai','WORKING',5100,4),
(1,'logo_prototype.dwg','WAITING',5100,5),
(2,'acrylic_keychain_V2.dxf','CUTTING',495,1),
(2,'acrylic_brackt.dxf','WORKING',480,2),
(2,'wooden_sign.ar','WORKING',480,3),
(2,'acrylic_sign.dxf','WAITING',510,4),
(2,'keychain_V2.dxf','CUTTING',495,5);

INSERT INTO `logs` (`user_id`,`event`,`type`) VALUES
(NULL,'بدء تشغيل النظام','info');

INSERT INTO `notifications` (`message`,`type`,`is_read`) VALUES
('النظام جاهز للعمل','file',0);
