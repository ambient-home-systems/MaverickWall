ALTER TABLE `household_settings` ADD `layout_landscape_aspect` real DEFAULT 1.7778 NOT NULL;--> statement-breakpoint
ALTER TABLE `layout_widgets` ADD `orientation` text DEFAULT 'portrait' NOT NULL;--> statement-breakpoint
ALTER TABLE `screens` ADD `layout_landscape_aspect` real;