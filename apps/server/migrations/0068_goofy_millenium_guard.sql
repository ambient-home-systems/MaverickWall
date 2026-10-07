CREATE TABLE `immich_assets` (
	`handle` text NOT NULL,
	`source_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `immich_assets_once` ON `immich_assets` (`source_id`,`handle`);--> statement-breakpoint
CREATE INDEX `immich_assets_handle` ON `immich_assets` (`handle`);--> statement-breakpoint
CREATE INDEX `immich_assets_source` ON `immich_assets` (`source_id`,`position`);--> statement-breakpoint
CREATE TABLE `immich_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`allow_lan` integer DEFAULT 0 NOT NULL,
	`allow_http` integer DEFAULT 0 NOT NULL,
	`account_label` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `immich_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref` text,
	`name` text NOT NULL,
	`last_fetched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
