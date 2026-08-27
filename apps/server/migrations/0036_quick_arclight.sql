PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_household_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`timezone` text DEFAULT 'Etc/UTC' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`theme` text DEFAULT 'board' NOT NULL,
	`daytime_theme` text,
	`daytime_starts_at` text DEFAULT '07:00',
	`daytime_ends_at` text DEFAULT '21:00',
	`latitude` integer,
	`longitude` integer,
	`shift_enabled` integer DEFAULT false NOT NULL,
	`weather_enabled` integer DEFAULT true NOT NULL,
	`weather_provider` text DEFAULT 'nws' NOT NULL,
	`weather_units` text DEFAULT 'imperial' NOT NULL,
	`alerts_enabled` integer DEFAULT true NOT NULL,
	`display_today_events` integer DEFAULT 8 NOT NULL,
	`display_next_days` integer DEFAULT 6 NOT NULL,
	`display_horizon_weeks` integer DEFAULT 5 NOT NULL,
	`display_blocks` text DEFAULT 'now,next,horizon' NOT NULL,
	`clock_24` integer DEFAULT 1 NOT NULL,
	`week_start` text DEFAULT 'sunday' NOT NULL,
	`layout_mode` text DEFAULT 'auto' NOT NULL,
	`layout_backfilled` integer DEFAULT 0 NOT NULL,
	`layout_aspect` real DEFAULT 0.5625 NOT NULL,
	`layout_landscape_aspect` real DEFAULT 1.7778 NOT NULL,
	`layout_background` text,
	`layout_landscape_background` text,
	`update_check_enabled` integer DEFAULT false NOT NULL,
	`update_last_checked_at` integer,
	`update_latest_version` text,
	`update_last_error` text,
	`setup_completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_household_settings`("id", "timezone", "locale", "theme", "daytime_theme", "daytime_starts_at", "daytime_ends_at", "latitude", "longitude", "shift_enabled", "weather_enabled", "weather_provider", "weather_units", "alerts_enabled", "display_today_events", "display_next_days", "display_horizon_weeks", "display_blocks", "clock_24", "week_start", "layout_mode", "layout_backfilled", "layout_aspect", "layout_landscape_aspect", "layout_background", "layout_landscape_background", "update_check_enabled", "update_last_checked_at", "update_latest_version", "update_last_error", "setup_completed_at", "created_at", "updated_at") SELECT "id", "timezone", "locale", "theme", "daytime_theme", "daytime_starts_at", "daytime_ends_at", "latitude", "longitude", "shift_enabled", "weather_enabled", "weather_provider", "weather_units", "alerts_enabled", "display_today_events", "display_next_days", "display_horizon_weeks", "display_blocks", "clock_24", "week_start", "layout_mode", "layout_backfilled", "layout_aspect", "layout_landscape_aspect", "layout_background", "layout_landscape_background", "update_check_enabled", "update_last_checked_at", "update_latest_version", "update_last_error", "setup_completed_at", "created_at", "updated_at" FROM `household_settings`;--> statement-breakpoint
DROP TABLE `household_settings`;--> statement-breakpoint
ALTER TABLE `__new_household_settings` RENAME TO `household_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;