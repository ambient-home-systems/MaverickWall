CREATE TABLE `external_module_variants` (
	`module_id` text NOT NULL,
	`variant_key` text NOT NULL,
	`panel` text,
	`last_polled_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	PRIMARY KEY(`module_id`, `variant_key`),
	FOREIGN KEY (`module_id`) REFERENCES `external_modules`(`id`) ON UPDATE no action ON DELETE cascade
);
