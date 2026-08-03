PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_calendar_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'ics' NOT NULL,
	`url_encrypted` text,
	`url_host` text,
	`ha_entity_id` text,
	`color` text DEFAULT '#4C7FD1' NOT NULL,
	`person_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`allow_private_network` integer DEFAULT false NOT NULL,
	`allow_loopback` integer DEFAULT false NOT NULL,
	`allow_http` integer DEFAULT false NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_sync_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- `kind` and `ha_entity_id` are deliberately absent from both lists, so every
-- existing row takes the column default: kind 'ics', no entity.
--
-- drizzle-kit generated them in the SELECT, which does not error and does not
-- do what it looks like. SQLite resolves a double-quoted name that matches no
-- column as a *string literal*, so `SELECT "kind" FROM calendar_sources` on a
-- table that has no such column yields the text 'kind' for every row. Applied
-- as generated, every household's calendars would come out with kind='kind',
-- match neither sync path, and never fetch again — a bricked wall from a
-- migration that reports success. Verified on a database at 0008.
INSERT INTO `__new_calendar_sources`("id", "name", "url_encrypted", "url_host", "color", "person_id", "enabled", "visible", "allow_private_network", "allow_loopback", "allow_http", "etag", "last_modified", "last_sync_at", "last_success_at", "last_error", "consecutive_failures", "event_count", "created_at", "updated_at") SELECT "id", "name", "url_encrypted", "url_host", "color", "person_id", "enabled", "visible", "allow_private_network", "allow_loopback", "allow_http", "etag", "last_modified", "last_sync_at", "last_success_at", "last_error", "consecutive_failures", "event_count", "created_at", "updated_at" FROM `calendar_sources`;--> statement-breakpoint
DROP TABLE `calendar_sources`;--> statement-breakpoint
ALTER TABLE `__new_calendar_sources` RENAME TO `calendar_sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `calendar_sources_enabled_idx` ON `calendar_sources` (`enabled`);--> statement-breakpoint
ALTER TABLE `ha_entity_cache` ADD `display_mode` text DEFAULT 'label_value' NOT NULL;--> statement-breakpoint
ALTER TABLE `ha_entity_cache` ADD `label` text;--> statement-breakpoint
ALTER TABLE `ha_entity_cache` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `action` text DEFAULT 'banner' NOT NULL;