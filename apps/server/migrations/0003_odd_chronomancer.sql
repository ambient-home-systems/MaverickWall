ALTER TABLE `household_settings` ADD `display_today_events` integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `display_next_days` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `display_horizon_weeks` integer DEFAULT 5 NOT NULL;