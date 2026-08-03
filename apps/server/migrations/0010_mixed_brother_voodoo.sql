CREATE TABLE `interrupt_dismissals` (
	`key` text PRIMARY KEY NOT NULL,
	`dismissed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `active_alerts` ADD `sent` text;--> statement-breakpoint
ALTER TABLE `active_alerts` ADD `message_type` text DEFAULT 'Alert' NOT NULL;--> statement-breakpoint
ALTER TABLE `active_alerts` ADD `description` text;--> statement-breakpoint
ALTER TABLE `active_alerts` ADD `instruction` text;--> statement-breakpoint
ALTER TABLE `active_alerts` ADD `area_desc` text;--> statement-breakpoint
ALTER TABLE `active_alerts` ADD `sender_name` text;--> statement-breakpoint
ALTER TABLE `alert_zones` ADD `kind` text DEFAULT 'forecast' NOT NULL;--> statement-breakpoint
ALTER TABLE `alert_zones` ADD `etag` text;--> statement-breakpoint
ALTER TABLE `alert_zones` ADD `last_polled_at` integer;--> statement-breakpoint
ALTER TABLE `alert_zones` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `pierces_night_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `min_dwell_sec` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `dismissible` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `reassert_after_sec` integer;