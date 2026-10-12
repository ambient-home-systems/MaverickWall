CREATE TABLE `layout_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`screen_id` text NOT NULL,
	`reason` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `layout_snapshots_screen_idx` ON `layout_snapshots` (`screen_id`,`created_at`);