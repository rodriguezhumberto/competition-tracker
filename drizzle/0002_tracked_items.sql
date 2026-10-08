DROP INDEX `unique_report_timestamp`;--> statement-breakpoint
ALTER TABLE `entries` ADD `item_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `unique_report_timestamp` ON `entries` (`competition_id`,`operator_number`,`item_code`,`timestamp_on_report`);--> statement-breakpoint
ALTER TABLE `competitions` ADD `multiple_items` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `competitions` ADD `item_label` text DEFAULT 'Item' NOT NULL;--> statement-breakpoint
ALTER TABLE `competitions` ADD `tracked_items` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `item_code` text DEFAULT '' NOT NULL;