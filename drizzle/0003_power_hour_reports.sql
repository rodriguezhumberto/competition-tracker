CREATE TABLE `power_hour_report_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` integer NOT NULL,
	`operator_number` text NOT NULL,
	`value` integer NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `power_hour_reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `power_hour_operator_per_report` ON `power_hour_report_values` (`report_id`,`operator_number`);--> statement-breakpoint
CREATE TABLE `power_hour_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`timestamp` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`item_code` text DEFAULT '' NOT NULL,
	`proof_image_path` text,
	FOREIGN KEY (`session_id`) REFERENCES `power_hour_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `power_hour_report_timestamp` ON `power_hour_reports` (`session_id`,`timestamp`);--> statement-breakpoint
ALTER TABLE `power_hour_sessions` ADD `report_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `power_hour_sessions` ADD `report_metric_id` integer REFERENCES competition_metrics(id);--> statement-breakpoint
ALTER TABLE `power_hour_sessions` ADD `report_metric_precision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `power_hour_sessions` ADD `report_schema_version` integer;--> statement-breakpoint
ALTER TABLE `power_hour_sessions` ADD `report_profile_version` integer;