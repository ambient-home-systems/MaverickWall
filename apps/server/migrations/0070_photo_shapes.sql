CREATE TABLE `photo_shapes` (
	`handle` text PRIMARY KEY NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`measured` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
