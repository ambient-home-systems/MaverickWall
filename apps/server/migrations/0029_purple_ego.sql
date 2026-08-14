ALTER TABLE `screens` ADD `kind` text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE `screens` ADD `panel_width` integer;--> statement-breakpoint
ALTER TABLE `screens` ADD `panel_height` integer;--> statement-breakpoint
ALTER TABLE `screens` ADD `panel_colour` text;