-- Custom SQL migration file, put your code below! --

-- RFC 015 phase 2: the household default theme is retired, and every browser
-- wall names its own. Before `0045` drops the four household columns and adds
-- the CHECK that refuses a wall with no theme, copy what each wall was already
-- drawing onto it — resolved exactly as `buildManifest` resolved it until now:
-- the wall's own value, else the household's, else Panels.
--
-- Hand-written (drizzle-kit generate --custom), not an edited generated file.
-- `NULLIF` folds a stored empty string with a null, because the settings form
-- read '' as "follow the household" too and a wall left holding '' would pass
-- the CHECK while naming a theme nothing draws. The value is copied *raw* — a
-- household still carrying `board` hands `board` to its walls, and resolving a
-- retired key is the reader's job, as it always was.
UPDATE screens
   SET theme = COALESCE(
         NULLIF(theme, ''),
         (SELECT NULLIF(theme, '') FROM household_settings WHERE id = 'singleton'),
         'panels'
       )
 WHERE kind = 'browser';
--> statement-breakpoint
-- The daylight schedule fell back field by field: a wall with no daytime
-- theme took the household's, and a wall with a daytime theme but no hours
-- took the household's hours. Two statements, so both readings survive.
UPDATE screens
   SET daytime_theme = (SELECT daytime_theme FROM household_settings WHERE id = 'singleton')
 WHERE kind = 'browser'
   AND (daytime_theme IS NULL OR daytime_theme = '')
   AND (SELECT NULLIF(daytime_theme, '') FROM household_settings WHERE id = 'singleton') IS NOT NULL;
--> statement-breakpoint
UPDATE screens
   SET daytime_starts_at = COALESCE(
         NULLIF(daytime_starts_at, ''),
         (SELECT daytime_starts_at FROM household_settings WHERE id = 'singleton')
       ),
       daytime_ends_at = COALESCE(
         NULLIF(daytime_ends_at, ''),
         (SELECT daytime_ends_at FROM household_settings WHERE id = 'singleton')
       )
 WHERE kind = 'browser'
   AND daytime_theme IS NOT NULL AND daytime_theme != '';
