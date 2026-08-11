ALTER TABLE `external_modules` ADD `kind` text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_modules` ADD `recipe` text;--> statement-breakpoint
ALTER TABLE `external_modules` ADD `config` text;