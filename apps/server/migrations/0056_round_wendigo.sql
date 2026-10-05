ALTER TABLE `ha_entity_cache` ADD `controllable` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `screens` ADD `allow_control` integer DEFAULT false NOT NULL;