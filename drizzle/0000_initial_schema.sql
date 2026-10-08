CREATE TABLE `competition_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`competition_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`precision` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`mode` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`public` integer DEFAULT true NOT NULL,
	`direction` text DEFAULT 'desc' NOT NULL,
	`minimum` text,
	`maximum` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`competition_id`) REFERENCES `competitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_key_per_competition` ON `competition_metrics` (`competition_id`,`key`);--> statement-breakpoint
CREATE TABLE `competitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`metric_label` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`timezone` text DEFAULT 'America/Chicago' NOT NULL,
	`official_metric_key` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`profile_version` integer DEFAULT 1 NOT NULL,
	`report_profile` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_competition` ON `competitions` (`is_active`) WHERE "competitions"."is_active" = 1;--> statement-breakpoint
CREATE TABLE `entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`competition_id` integer NOT NULL,
	`report_id` integer NOT NULL,
	`operator_number` text NOT NULL,
	`timestamp_on_report` text NOT NULL,
	`report_date` text NOT NULL,
	`proof_image_path` text,
	FOREIGN KEY (`competition_id`) REFERENCES `competitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_report_timestamp` ON `entries` (`competition_id`,`operator_number`,`timestamp_on_report`);--> statement-breakpoint
CREATE TABLE `power_hour_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`name_key` text NOT NULL,
	`credential_hash` text,
	FOREIGN KEY (`session_id`) REFERENCES `power_hour_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_name_per_power_hour` ON `power_hour_participants` (`session_id`,`name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_membership_per_power_hour` ON `power_hour_participants` (`session_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_power_hour_credential` ON `power_hour_participants` (`credential_hash`);--> statement-breakpoint
CREATE TABLE `power_hour_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`flagged` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `power_hour_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_score_per_user_session` ON `power_hour_scores` (`session_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `power_hour_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`competition_id` integer,
	`name` text NOT NULL,
	`metric_label` text DEFAULT 'points' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`password_hash` text,
	FOREIGN KEY (`competition_id`) REFERENCES `competitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_power_hour` ON `power_hour_sessions` (`status`) WHERE "power_hour_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX `sessions_by_competition` ON `power_hour_sessions` (`competition_id`);--> statement-breakpoint
CREATE TABLE `report_drafts` (
	`token` text PRIMARY KEY NOT NULL,
	`competition_id` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`profile_version` integer NOT NULL,
	`payload` text NOT NULL,
	`original_payload` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'reviewable' NOT NULL,
	`proof_image_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`cleanup_attempts` integer DEFAULT 0 NOT NULL,
	`cleanup_error` text,
	FOREIGN KEY (`competition_id`) REFERENCES `competitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `drafts_by_status_expiry` ON `report_drafts` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `report_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`metric_id` integer NOT NULL,
	`value` integer NOT NULL,
	`contribution` integer,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`metric_id`) REFERENCES `competition_metrics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `value_per_entry_metric` ON `report_values` (`entry_id`,`metric_id`);--> statement-breakpoint
CREATE INDEX `values_by_metric` ON `report_values` (`metric_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`competition_id` integer NOT NULL,
	`timestamp` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`schema_version` integer NOT NULL,
	`profile_version` integer NOT NULL,
	`proof_image_path` text,
	FOREIGN KEY (`competition_id`) REFERENCES `competitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `site_privacy` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`password_hash` text,
	`session_version` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
-- The site starts public; the admin privacy controls update this singleton.
INSERT INTO `site_privacy` (`id`) VALUES (1);
