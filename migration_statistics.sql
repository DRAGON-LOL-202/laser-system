-- ============================================================
-- ترقية قاعدة بيانات موجودة مسبقاً (لا تحذف أي بيانات)
-- شغّل هذا الملف فقط إذا كانت قاعدة بياناتك منشأة قبل إضافة ميزة
-- "Statistics" (إحصائيات وقت تشغيل الماكينات + جلسات المشغّلين)
-- مثال للتشغيل: mysql -u root -p اسم_قاعدة_البيانات < migration_statistics.sql
-- ============================================================

ALTER TABLE `machines`
  ADD COLUMN `running_started_at` DATETIME DEFAULT NULL
  COMMENT 'وقت بدء التشغيل الفعلي الحالي؛ NULL يعني الماكينة متوقفة الآن'
  AFTER `machine_time`;

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

CREATE TABLE `operator_sessions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `login_at` DATETIME NOT NULL,
  `logout_at` DATETIME DEFAULT NULL COMMENT 'NULL = لم تُغلَق صراحةً عبر /logout',
  `duration_seconds` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_login_at` (`login_at`),
  CONSTRAINT `fk_session_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ملاحظة: كل التشغيلات والجلسات السابقة لهذه الترقية لن تظهر في الإحصائيات
-- الجديدة (لا توجد بيانات تاريخية عنها) — الإحصائيات ستبدأ بالتراكم من لحظة
-- تشغيل هذه الترقية فصاعدًا فقط. هذا متوقَّع وليس خطأ.
