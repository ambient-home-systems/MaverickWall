CREATE TABLE `ha_cameras` (
	`handle` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`name` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ha_cameras_entity_id_unique` ON `ha_cameras` (`entity_id`);