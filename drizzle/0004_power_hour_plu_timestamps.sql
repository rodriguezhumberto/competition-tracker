DROP INDEX `power_hour_report_timestamp`;--> statement-breakpoint
CREATE UNIQUE INDEX `power_hour_report_timestamp` ON `power_hour_reports` (`session_id`,`item_code`,`timestamp`);