CREATE TABLE `ha_todo_items` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`uid` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`due` text,
	`position` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ha_todo_items_entity_uid_idx` ON `ha_todo_items` (`entity_id`,`uid`);--> statement-breakpoint
CREATE TABLE `ha_todo_lists` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text,
	`supports_update` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`last_fetched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `screens` ADD `allow_todo` integer DEFAULT false NOT NULL;