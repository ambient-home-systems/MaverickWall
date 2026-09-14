PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_screens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text DEFAULT 'browser' NOT NULL,
	`panel_width` integer,
	`panel_height` integer,
	`panel_colour` text,
	`theme` text,
	`layout` text,
	`timezone` text,
	`daytime_theme` text,
	`daytime_starts_at` text,
	`daytime_ends_at` text,
	`display_today_events` integer,
	`display_next_days` integer,
	`display_horizon_weeks` integer,
	`display_blocks` text,
	`clock_24` integer,
	`layout_mode` text,
	`layout_follows` text,
	`layout_aspect` real,
	`layout_landscape_aspect` real,
	`layout_background` text,
	`layout_landscape_background` text,
	`report_w` integer,
	`report_h` integer,
	`orientation` text DEFAULT 'auto' NOT NULL,
	`rotation` integer DEFAULT 0 NOT NULL,
	`panel_width_mm` integer,
	`panel_height_mm` integer,
	`read_distance_mm` integer,
	`allow_dismiss` integer DEFAULT false NOT NULL,
	`allow_chores` integer DEFAULT false NOT NULL,
	`allow_todo` integer DEFAULT false NOT NULL,
	`lan_only` integer DEFAULT false NOT NULL,
	`token_issued_at` integer NOT NULL,
	`revoked_at` integer,
	`pairing_code_hash` text,
	`pairing_code_expires_at` integer,
	`last_seen_at` integer,
	`last_seen_ip` text,
	`last_seen_user_agent` text,
	`app_version` text,
	`last_seen_forwarding` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "screens_wall_names_theme" CHECK("kind" = 'epaper' OR "theme" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_screens`("id", "name", "token_hash", "kind", "panel_width", "panel_height", "panel_colour", "theme", "layout", "timezone", "daytime_theme", "daytime_starts_at", "daytime_ends_at", "display_today_events", "display_next_days", "display_horizon_weeks", "display_blocks", "clock_24", "layout_mode", "layout_follows", "layout_aspect", "layout_landscape_aspect", "layout_background", "layout_landscape_background", "report_w", "report_h", "orientation", "rotation", "panel_width_mm", "panel_height_mm", "read_distance_mm", "allow_dismiss", "allow_chores", "allow_todo", "lan_only", "token_issued_at", "revoked_at", "pairing_code_hash", "pairing_code_expires_at", "last_seen_at", "last_seen_ip", "last_seen_user_agent", "app_version", "last_seen_forwarding", "created_at", "updated_at") SELECT "id", "name", "token_hash", "kind", "panel_width", "panel_height", "panel_colour", "theme", "layout", "timezone", "daytime_theme", "daytime_starts_at", "daytime_ends_at", "display_today_events", "display_next_days", "display_horizon_weeks", "display_blocks", "clock_24", "layout_mode", "layout_follows", "layout_aspect", "layout_landscape_aspect", "layout_background", "layout_landscape_background", "report_w", "report_h", "orientation", "rotation", "panel_width_mm", "panel_height_mm", "read_distance_mm", "allow_dismiss", "allow_chores", "allow_todo", "lan_only", "token_issued_at", "revoked_at", "pairing_code_hash", "pairing_code_expires_at", "last_seen_at", "last_seen_ip", "last_seen_user_agent", "app_version", "last_seen_forwarding", "created_at", "updated_at" FROM `screens`;--> statement-breakpoint
DROP TABLE `screens`;--> statement-breakpoint
ALTER TABLE `__new_screens` RENAME TO `screens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `screens_token_hash_idx` ON `screens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `household_settings` DROP COLUMN `theme`;--> statement-breakpoint
ALTER TABLE `household_settings` DROP COLUMN `daytime_theme`;--> statement-breakpoint
ALTER TABLE `household_settings` DROP COLUMN `daytime_starts_at`;--> statement-breakpoint
ALTER TABLE `household_settings` DROP COLUMN `daytime_ends_at`;