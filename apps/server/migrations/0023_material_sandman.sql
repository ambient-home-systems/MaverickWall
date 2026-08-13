ALTER TABLE `household_settings` ADD `weather_provider` text DEFAULT 'nws' NOT NULL;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `weather_units` text DEFAULT 'imperial' NOT NULL;