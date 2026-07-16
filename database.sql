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
-- جدول الماكينات (ثابت: ماكينتان فقط - كبيرة وصغيرة)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `machines`;
CREATE TABLE `machines` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` ENUM('big','small') NOT NULL COMMENT 'معرف ثابت للماكينة',
  `label` VARCHAR(100) NOT NULL,
  `status` ENUM('RUNNING','STOPPED') NOT NULL DEFAULT 'STOPPED',
  `current_file` VARCHAR(255) DEFAULT NULL,
  `machine_time` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'بالثواني',
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
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_machine` (`machine_id`),
  CONSTRAINT `fk_file_machine` FOREIGN KEY (`machine_id`) REFERENCES `machines` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
-- جدول الإشعارات
-- ------------------------------------------------------------
DROP TABLE IF EXISTS `notifications`;
CREATE TABLE `notifications` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message` VARCHAR(255) NOT NULL,
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- بيانات أولية (Seed Data)
-- ============================================================

-- المستخدم الرئيسي (admin / lol / 214205)
-- كلمة المرور مشفرة بـ bcrypt — سيتم توليدها تلقائياً عند أول تشغيل من ملف seed.js
-- هذا السطر فقط احتياطي في حال التشغيل اليدوي للـ SQL (كلمة المرور هنا = 214205 مشفرة):
INSERT INTO `users` (`id`,`name`,`username`,`password`,`role`,`is_root`) VALUES
(1,'المشرف الرئيسي','lol','$2b$10$rDxJZxQqQxJQqQxJQqQxJOzGZ5KZ5KZ5KZ5KZ5KZ5KZ5KZ5KZ5KZu','admin',1);
-- ملاحظة: شغّل "node src/utils/seed.js" بعد رفع المشروع لتوليد الهاش الصحيح فعلياً وإدراج البيانات بأمان.

INSERT INTO `machines` (`id`,`code`,`label`,`status`,`current_file`,`machine_time`) VALUES
(1,'big','ماكينة كبيرة - CNC CO2','STOPPED','sign.svg',0),
(2,'small','ماكينة صغيرة - CNC CO2','RUNNING','keychain.dxf',0);

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

INSERT INTO `notifications` (`message`,`is_read`) VALUES
('النظام جاهز للعمل',0);
