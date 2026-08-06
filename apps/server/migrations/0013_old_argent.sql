ALTER TABLE `layout_widgets` ADD `screen_id` text;--> statement-breakpoint
ALTER TABLE `screens` ADD `display_today_events` integer;--> statement-breakpoint
ALTER TABLE `screens` ADD `display_next_days` integer;--> statement-breakpoint
ALTER TABLE `screens` ADD `display_horizon_weeks` integer;--> statement-breakpoint
ALTER TABLE `screens` ADD `display_blocks` text;--> statement-breakpoint
ALTER TABLE `screens` ADD `layout_mode` text;--> statement-breakpoint
ALTER TABLE `screens` ADD `layout_aspect` real;