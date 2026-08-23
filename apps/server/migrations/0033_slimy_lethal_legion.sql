CREATE TABLE `chore_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`chore_id` text NOT NULL,
	`date` text NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chore_completions_chore_date_idx` ON `chore_completions` (`chore_id`,`date`);--> statement-breakpoint
CREATE INDEX `chore_completions_date_idx` ON `chore_completions` (`date`);--> statement-breakpoint
CREATE TABLE `chores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`person_id` text,
	`schedule` text NOT NULL,
	`due_time` text,
	`paused` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chores_person_idx` ON `chores` (`person_id`);--> statement-breakpoint
ALTER TABLE `screens` ADD `allow_chores` integer DEFAULT false NOT NULL;