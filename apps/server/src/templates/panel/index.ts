import type { DisplayTemplate } from '../../api/templates.js';
import { template as blank } from './blank.js';
import { template as builtIn } from './built-in.js';
import { template as month } from './month.js';
import { template as agenda } from './agenda.js';
import { template as week } from './week.js';
import { template as chores } from './chores.js';

/**
 * The starting layouts an **e-paper panel** picks from.
 *
 * A panel used to be offered the wall gallery, and every card in it was wrong
 * about the thing it was previewing: thirteen colour arrangements drawn on a
 * portrait 9:16 canvas for an 800x480 black-and-white device, each captioned
 * "Looks best in Paper Almanac — change it after" on a screen that has no
 * theme, over a "copy another wall's layout" that would put a wall's
 * arrangement on a panel. The panel's own default view — the layout it draws
 * out of the box — was not among them, so the one arrangement a household had
 * actually seen on their panel was the one they could not start from.
 *
 * These are authored for one bit and one panel. Three rules separate them from
 * the wall's, and each is a property a test pins rather than a convention:
 *
 *  - **no theme and no background.** A panel has neither; a card that named one
 *    would be advertising a control that does nothing, which is this project's
 *    oldest recurring fault.
 *  - **the aspect here is nominal.** It is 800x480's, because that is the
 *    commonest panel, and the apply route replaces it with the panel's *own*
 *    geometry — a panel's resolution is a fact about the hardware, and honouring
 *    a stored aspect instead is what once drew boxes on a canvas the device
 *    cannot show.
 *  - **both orientations are authored**, as for every wall template, so a panel
 *    turned a quarter turn after being set up is never in the letterbox case.
 *
 * They are validated by the *same* `templateSchema` a wall template is, so a
 * panel card can place no widget type a household could not place by hand and
 * set no option the editor cannot — the whole safety story is unchanged. The
 * narrowings above are asserted in `test/panel-templates.test.ts`.
 *
 * Order is gallery order. **Blank leads and Built-in follows it**, which is a
 * deliberate change from the release that added this list: Built-in led then,
 * because the gap being closed was that the view a household had actually seen
 * was the one arrangement they could not start from. That is fixed by the card
 * existing rather than by its position, and starting from nothing was the other
 * thing the gallery could not do — every card was somebody else's arrangement,
 * so building your own meant picking the nearest and deleting its boxes.
 *
 * On a panel's *add* page the default is neither of them: it is `builtin`, the
 * real fixed renderer, which is not a template at all. See
 * `EPAPER_LAYOUT_BUILTIN`.
 */
export const PANEL_TEMPLATES: readonly DisplayTemplate[] = [blank, builtIn, month, agenda, week, chores];

/** A panel template by id, or undefined. The apply route validates ids this way. */
export function findPanelTemplate(id: string): DisplayTemplate | undefined {
  return PANEL_TEMPLATES.find((template) => template.id === id);
}
