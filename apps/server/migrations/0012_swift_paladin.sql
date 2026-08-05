CREATE TABLE `layout_widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`w` real NOT NULL,
	`h` real NOT NULL,
	`z` integer DEFAULT 0 NOT NULL,
	`config` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `household_settings` ADD `layout_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `household_settings` ADD `layout_aspect` real DEFAULT 0.5625 NOT NULL;