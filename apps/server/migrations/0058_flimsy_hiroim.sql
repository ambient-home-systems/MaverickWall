CREATE TABLE `webhook_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url_encrypted` text NOT NULL,
	`header_name` text,
	`header_value_encrypted` text,
	`allow_lan` integer DEFAULT false NOT NULL,
	`allow_http` integer DEFAULT false NOT NULL,
	`pressable` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
