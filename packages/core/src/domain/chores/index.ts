/**
 * Chores.
 *
 * Self-contained by design, the way `domain/shift/` is. Nothing else in core
 * imports from this directory, and this directory imports nothing from core
 * beyond civil date arithmetic — so it can be extracted later without a
 * refactor, and a household with no chores can have the whole feature switched
 * off and lose nothing.
 *
 * What lives here is only the *model*: when a chore falls due, and how to say
 * that in a sentence. Who it belongs to, whether it has been done, and what
 * draws it are all one layer out, in the server — pure functions here have no
 * database and no clock, and take the day they are asked about.
 */
export * from './schedule.js';
