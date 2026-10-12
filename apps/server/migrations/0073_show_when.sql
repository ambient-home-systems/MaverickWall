CREATE TABLE `ha_condition_states` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`changed_at` integer NOT NULL,
	`read_at` integer NOT NULL
);
