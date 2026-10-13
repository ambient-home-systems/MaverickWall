import { createHash } from 'node:crypto';

/**
 * A module's picture by handle (plan item M7.5).
 *
 * A module panel of `kind: 'image'` names its picture by an address, and that
 * address never reaches a wall: it can carry a token in its query, it names a
 * host on the household's network, and a wall that fetched it itself would be
 * a third-party origin on the glass (rule three). So the manifest carries a
 * handle in its place, shaped like a stored media name, and the wall asks
 * `/d/media/<handle>` for the picture — the route an Immich photo and an
 * album's sleeve already come through.
 *
 * The handle is the hash of the module and the address together, so two
 * modules naming one address are two pictures fetched under their own
 * policies, and a handle says nothing about either. A picture at an address
 * is fetched once and kept: a module whose picture changes gives it a new
 * address, the way a content-hashed file is named.
 */
export function moduleImageHandle(moduleId: string, url: string): string {
  return `${createHash('sha256').update(`${moduleId}\n${url}`).digest('hex')}.jpg`;
}

/**
 * A module's stored panel as the wall is given it: an image panel's address
 * replaced by its handle, and every other panel as it was stored.
 */
export function panelForWall(moduleId: string, panel: unknown): unknown {
  if (panel === null || typeof panel !== 'object') return panel;
  const obj = panel as Record<string, unknown>;
  if (obj['kind'] !== 'image' || typeof obj['url'] !== 'string') return panel;
  const { url, ...rest } = obj;
  return { ...rest, image: moduleImageHandle(moduleId, url) };
}

/** The address an image panel names, or nothing. */
export function panelImageUrl(panel: unknown): string | undefined {
  if (panel === null || typeof panel !== 'object') return undefined;
  const obj = panel as Record<string, unknown>;
  return obj['kind'] === 'image' && typeof obj['url'] === 'string' ? obj['url'] : undefined;
}
