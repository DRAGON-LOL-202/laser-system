-- ============================================================
-- ترقية قاعدة بيانات موجودة مسبقاً (لا تحذف أي بيانات)
-- يضيف "queue" (قائمة الانتظار) كقيمة ثالثة مسموحة في عمود machines.code
-- وينشئ صف قائمة الانتظار نفسه إن لم يكن موجوداً
-- ============================================================

ALTER TABLE `machines`
  MODIFY COLUMN `code` ENUM('big','small','queue') NOT NULL COMMENT 'معرف ثابت؛ queue = قائمة انتظار مؤقتة لا تظهر للمشغل';

INSERT INTO `machines` (`code`,`label`,`status`,`current_file`,`machine_time`)
SELECT 'queue','قائمة الانتظار','STOPPED',NULL,0
WHERE NOT EXISTS (SELECT 1 FROM `machines` WHERE `code` = 'queue');
