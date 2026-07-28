CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `active_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`zone_code` text,
	`event` text NOT NULL,
	`headline` text,
	`severity` text,
	`urgency` text,
	`certainty` text,
	`onset_at` integer,
	`expires_at` integer,
	`fetched_at` integer NOT NULL,
	`dismissed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `active_alerts_external_idx` ON `active_alerts` (`external_id`);--> statement-breakpoint
CREATE INDEX `active_alerts_expires_idx` ON `active_alerts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `alert_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`provider` text DEFAULT 'nws' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_zones_code_unique` ON `alert_zones` (`code`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `calendar_events_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`uid` text NOT NULL,
	`recurrence_id` text,
	`title` text NOT NULL,
	`location` text,
	`description` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`start_local_date` text NOT NULL,
	`end_local_date` text NOT NULL,
	`source_tzid` text NOT NULL,
	`status` text DEFAULT 'CONFIRMED' NOT NULL,
	`is_recurring_instance` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `calendar_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_starts_at_idx` ON `calendar_events_cache` (`starts_at`);--> statement-breakpoint
CREATE INDEX `events_local_date_idx` ON `calendar_events_cache` (`start_local_date`);--> statement-breakpoint
CREATE INDEX `events_source_idx` ON `calendar_events_cache` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_identity_idx` ON `calendar_events_cache` (`source_id`,`uid`,`recurrence_id`);--> statement-breakpoint
CREATE TABLE `calendar_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url_encrypted` text NOT NULL,
	`url_host` text,
	`color` text DEFAULT '#4C7FD1' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`allow_private_network` integer DEFAULT false NOT NULL,
	`allow_http` integer DEFAULT false NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_sync_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `calendar_sources_enabled_idx` ON `calendar_sources` (`enabled`);--> statement-breakpoint
CREATE TABLE `ha_entity_cache` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`state` text,
	`attributes` text,
	`friendly_name` text,
	`unit_of_measurement` text,
	`last_changed_at` integer,
	`fetched_at` integer NOT NULL,
	`watched` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ha_entity_watched_idx` ON `ha_entity_cache` (`watched`);--> statement-breakpoint
CREATE TABLE `ha_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`base_url` text,
	`token_encrypted` text,
	`enabled` integer DEFAULT false NOT NULL,
	`allow_private_network` integer DEFAULT true NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `household_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`theme` text DEFAULT 'board' NOT NULL,
	`daytime_theme` text,
	`daytime_starts_at` text DEFAULT '07:00',
	`daytime_ends_at` text DEFAULT '21:00',
	`latitude` integer,
	`longitude` integer,
	`shift_enabled` integer DEFAULT false NOT NULL,
	`weather_enabled` integer DEFAULT true NOT NULL,
	`alerts_enabled` integer DEFAULT true NOT NULL,
	`setup_completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `interrupt_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger` text NOT NULL,
	`conditions` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`wake_screen` integer DEFAULT false NOT NULL,
	`dismiss_after_seconds` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interrupt_rules_enabled_idx` ON `interrupt_rules` (`enabled`,`trigger`);--> statement-breakpoint
CREATE TABLE `job_state` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_duration_ms` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`running_since` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_state_next_run_idx` ON `job_state` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`original_name` text,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`usage` text DEFAULT 'other' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_path_unique` ON `media_assets` (`path`);--> statement-breakpoint
CREATE INDEX `media_sha_idx` ON `media_assets` (`sha256`);--> statement-breakpoint
CREATE INDEX `media_usage_idx` ON `media_assets` (`usage`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#E8A33D' NOT NULL,
	`avatar_path` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`has_shift_rotation` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `screens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`theme` text,
	`layout` text,
	`timezone` text,
	`token_issued_at` integer NOT NULL,
	`revoked_at` integer,
	`last_seen_at` integer,
	`last_seen_ip` text,
	`last_seen_user_agent` text,
	`app_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `screens_token_hash_idx` ON `screens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_expires_idx` ON `session` (`expires_at`);--> statement-breakpoint
CREATE TABLE `shift_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`date` text NOT NULL,
	`shift_type_key` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shift_overrides_person_date_idx` ON `shift_overrides` (`person_id`,`date`);--> statement-breakpoint
CREATE INDEX `shift_overrides_date_idx` ON `shift_overrides` (`date`);--> statement-breakpoint
CREATE TABLE `shift_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`anchor_date` text,
	`cycle` text,
	`calendar_source_id` text,
	`matchers` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`calendar_source_id`) REFERENCES `calendar_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shift_plans_range_idx` ON `shift_plans` (`effective_from`,`effective_to`);--> statement-breakpoint
CREATE TABLE `shift_types` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`short_code` text NOT NULL,
	`color_token` text NOT NULL,
	`is_working` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shift_types_key_unique` ON `shift_types` (`key`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `weather_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'nws' NOT NULL,
	`cache_key` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weather_cache_cache_key_unique` ON `weather_cache` (`cache_key`);