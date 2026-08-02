ALTER TABLE `household_settings` ADD `update_check_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `update_last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `update_latest_version` text;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `update_last_error` text;