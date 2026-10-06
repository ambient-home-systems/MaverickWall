CREATE TABLE `todoist_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`token_encrypted` text NOT NULL,
	`connected_at` integer NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
