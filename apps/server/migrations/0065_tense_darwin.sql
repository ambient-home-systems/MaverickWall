CREATE TABLE `weather_keys` (
	`provider` text PRIMARY KEY NOT NULL,
	`key_encrypted` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `household_settings` ADD `weather_entity` text;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `weather_station` text;