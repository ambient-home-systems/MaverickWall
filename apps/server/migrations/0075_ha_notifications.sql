CREATE TABLE `ha_notifications` (
	`notification_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`message` text NOT NULL,
	`created_at` integer,
	`read_at` integer NOT NULL
);
