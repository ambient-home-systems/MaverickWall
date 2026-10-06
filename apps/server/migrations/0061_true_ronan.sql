CREATE TABLE `layout_override` (
	`id` text PRIMARY KEY NOT NULL,
	`screen_id` text NOT NULL,
	`until` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`screen_id`) REFERENCES `screens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `screens` ADD `refresh_requested_at` integer;