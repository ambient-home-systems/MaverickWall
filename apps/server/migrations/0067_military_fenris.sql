CREATE TABLE `photo_album_items` (
	`album_id` text NOT NULL,
	`media_name` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_album_items_once` ON `photo_album_items` (`album_id`,`media_name`);--> statement-breakpoint
CREATE INDEX `photo_album_items_album` ON `photo_album_items` (`album_id`,`position`);--> statement-breakpoint
CREATE TABLE `photo_albums` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
