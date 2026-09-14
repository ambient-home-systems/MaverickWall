CREATE TABLE `caldav_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`server_url_encrypted` text NOT NULL,
	`server_host` text,
	`username` text NOT NULL,
	`password_encrypted` text NOT NULL,
	`principal_url` text,
	`home_set_url` text,
	`confirmed_host` text,
	`allow_private_network` integer DEFAULT false NOT NULL,
	`allow_loopback` integer DEFAULT false NOT NULL,
	`allow_http` integer DEFAULT false NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `calendar_sources` ADD `caldav_account_id` text REFERENCES caldav_accounts(id);