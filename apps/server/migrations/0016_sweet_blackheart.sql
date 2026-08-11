ALTER TABLE `external_modules` ADD `signals` text;--> statement-breakpoint
ALTER TABLE `external_modules` ADD `alerts_action` text DEFAULT 'none' NOT NULL;