CREATE TABLE `news_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url_encrypted` text NOT NULL,
	`allow_lan` integer DEFAULT false NOT NULL,
	`allow_http` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`items` text,
	`etag` text,
	`last_modified` text,
	`last_fetched_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
