CREATE TABLE `ha_wall_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`screen_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`ok` integer NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `ha_wall_actions_at_idx` ON `ha_wall_actions` (`at`);