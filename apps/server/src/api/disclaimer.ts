/**
 * The life-safety disclaimer.
 *
 * One constant, shown in three places — the alerts settings screen, the
 * first-run wizard, and the README. A copy per screen is how three of them end
 * up saying slightly different things, and this is the one piece of text in the
 * product where that matters.
 *
 * It is not legal boilerplate to be tucked under a fold. Somebody could
 * reasonably look at a wall that shows tornado warnings and conclude it will
 * wake them for one, and every part of that chain — a household internet
 * connection, a tablet that may have crashed, mains power, a public API that
 * degrades under load during exactly the events that matter — is something
 * this project does not control and a weather radio does not depend on.
 */
export const LIFE_SAFETY_DISCLAIMER =
  'Maverick Wall is not a life-safety system. Do not rely on it for emergency ' +
  'warnings. It is not a substitute for a NOAA Weather Radio, Wireless Emergency ' +
  'Alerts, or local warning sirens. Delivery depends on your internet connection, ' +
  'device, and power.';
