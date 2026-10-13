ALTER TABLE `ha_condition_states` ADD `friendly_name` text;--> statement-breakpoint
ALTER TABLE `ha_condition_states` ADD `noticed_at` integer;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `hold_sec` integer;--> statement-breakpoint
ALTER TABLE `interrupt_rules` ADD `camera` text;