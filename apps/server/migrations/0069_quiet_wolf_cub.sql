CREATE TABLE `photo_folder_assets` (
	`handle` text NOT NULL,
	`folder_id` text NOT NULL,
	`path` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_folder_assets_once` ON `photo_folder_assets` (`folder_id`,`handle`);--> statement-breakpoint
CREATE INDEX `photo_folder_assets_handle` ON `photo_folder_assets` (`handle`);--> statement-breakpoint
CREATE INDEX `photo_folder_assets_folder` ON `photo_folder_assets` (`folder_id`,`position`);--> statement-breakpoint
CREATE TABLE `photo_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url_encrypted` text NOT NULL,
	`host` text NOT NULL,
	`username` text,
	`password_encrypted` text,
	`allow_lan` integer DEFAULT 0 NOT NULL,
	`allow_http` integer DEFAULT 0 NOT NULL,
	`subfolders` integer DEFAULT 0 NOT NULL,
	`skipped_heic` integer DEFAULT 0 NOT NULL,
	`skipped_raw` integer DEFAULT 0 NOT NULL,
	`skipped_large` integer DEFAULT 0 NOT NULL,
	`last_fetched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
