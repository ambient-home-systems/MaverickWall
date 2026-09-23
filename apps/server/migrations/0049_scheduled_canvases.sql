CREATE TABLE `layout_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`screen_id` text NOT NULL,
	`position` integer NOT NULL,
	`slot` text NOT NULL,
	`from_hhmm` text NOT NULL,
	`to_hhmm` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `layout_schedule_screen_position_idx` ON `layout_schedule` (`screen_id`,`position`);--> statement-breakpoint
ALTER TABLE `layout_widgets` ADD `slot` text;