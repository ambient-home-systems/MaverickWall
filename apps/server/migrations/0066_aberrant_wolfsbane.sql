CREATE TABLE `oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text,
	`directory` text,
	`refresh_token_encrypted` text NOT NULL,
	`account_label` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `calendar_sources` ADD `oauth_account_id` text;