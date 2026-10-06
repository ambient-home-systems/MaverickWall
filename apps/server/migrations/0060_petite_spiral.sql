CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`posted_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `timers` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text,
	`started_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `screens` ADD `allow_clear` integer DEFAULT false NOT NULL;