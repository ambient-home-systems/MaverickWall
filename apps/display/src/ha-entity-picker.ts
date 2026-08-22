/**
 * The Home Assistant entity picker.
 *
 * A first-party enhancement of the admin's Home Assistant screen: the server
 * renders the entity list as JSON on a mount, and this turns it into a
 * searchable, domain-filtered, multi-select picker that shows each entity's
 * live state. Nothing is fetched — the data ships with the page and the module
 * ships in the image (rule three) — and the whole thing degrades to a plain
 * `<datalist>` in `<noscript>` when a browser runs no script.
 *
 * It sees a resolved value and a friendly name, and posts back entity ids to
 * watch. It never touches the token or the connection; the server is the only
 * thing that talks to Home Assistant.
 */

interface Entity {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly state: string;
  readonly unit: string | null;
}
interface Mode {
  readonly key: string;
  readonly label: string;
}

/** Domains as a household would name a room of them, for the filter chips. */
const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  sensor: 'Sensors',
  binary_sensor: 'Binary sensors',
  weather: 'Weather',
  person: 'People',
  device_tracker: 'Presence',
  lock: 'Locks',
  cover: 'Covers',
  climate: 'Climate',
  light: 'Lights',
  switch: 'Switches',
};
function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function boot(): void {
  const mount = document.getElementById('ha-entity-picker');
  if (mount === null) return;

  let entities: Entity[];
  let modes: Mode[];
  try {
    entities = JSON.parse(mount.dataset['entities'] ?? '[]') as Entity[];
    modes = JSON.parse(mount.dataset['modes'] ?? '[]') as Mode[];
  } catch {
    return; // The <noscript> datalist stays as the fallback.
  }
  if (!Array.isArray(entities)) return;

  if (entities.length === 0) {
    mount.appendChild(
      el('p', 'hint', 'Connect Home Assistant above to choose readings for the wall.'),
    );
    return;
  }

  const selected = new Set<string>();
  let query = '';
  let domain = ''; // '' is every domain.

  // ---- structure --------------------------------------------------------

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'hep-search';
  search.placeholder = 'Search by name or entity id…';
  search.autocomplete = 'off';

  const chips = el('div', 'hep-chips');
  const selBar = el('div', 'hep-selected');
  const list = el('div', 'hep-list');

  const modeSelect = document.createElement('select');
  for (const mode of modes) {
    const opt = document.createElement('option');
    opt.value = mode.key;
    opt.textContent = mode.label;
    modeSelect.appendChild(opt);
  }
  const modeField = el('label', 'hep-field');
  modeField.appendChild(el('span', undefined, 'Show them as'));
  modeField.appendChild(modeSelect);

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Leave empty to use its own name';
  const labelField = el('label', 'hep-field');
  labelField.appendChild(el('span', undefined, 'Call it'));
  labelField.appendChild(labelInput);
  labelField.style.display = 'none'; // only when exactly one is selected

  const addButton = el('button', 'btn btn-primary') as HTMLButtonElement;
  addButton.type = 'button';
  const status = el('span', 'hep-status');

  const footer = el('div', 'hep-footer');
  footer.append(labelField, modeField, addButton, status);

  mount.append(search, chips, selBar, list, footer);

  // ---- domain chips -----------------------------------------------------

  const counts = new Map<string, number>();
  for (const entity of entities) counts.set(entity.domain, (counts.get(entity.domain) ?? 0) + 1);
  const domains = [...counts.keys()].sort((a, b) => domainLabel(a).localeCompare(domainLabel(b)));

  function renderChips(): void {
    chips.textContent = '';
    const chip = (value: string, text: string): void => {
      const button = el('button', 'hep-chip' + (domain === value ? ' active' : ''), text);
      (button as HTMLButtonElement).type = 'button';
      button.addEventListener('click', () => {
        domain = value;
        renderChips();
        renderList();
      });
      chips.appendChild(button);
    };
    chip('', `All (${entities.length})`);
    for (const d of domains) chip(d, `${domainLabel(d)} (${counts.get(d) ?? 0})`);
  }

  // ---- the list ---------------------------------------------------------

  function matches(entity: Entity): boolean {
    if (domain !== '' && entity.domain !== domain) return false;
    if (query === '') return true;
    return entity.name.toLowerCase().includes(query) || entity.id.toLowerCase().includes(query);
  }

  function renderList(): void {
    list.textContent = '';
    const shown = entities.filter(matches);
    if (shown.length === 0) {
      list.appendChild(el('p', 'hint', 'No entities match that.'));
      return;
    }
    // A cap so a household with a thousand entities does not build a thousand
    // rows on every keystroke; the search narrows it long before this bites.
    for (const entity of shown.slice(0, 300)) {
      const row = el('label', 'hep-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(entity.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(entity.id);
        else selected.delete(entity.id);
        renderSelected();
      });
      const main = el('div', 'hep-main');
      main.appendChild(el('div', 'hep-name', entity.name));
      main.appendChild(el('div', 'hep-id', entity.id));
      const value = entity.unit === null ? entity.state : `${entity.state} ${entity.unit}`;
      row.append(box, main, el('div', 'hep-state', value));
      list.appendChild(row);
    }
    if (shown.length > 300) {
      list.appendChild(el('p', 'hint', `Showing 300 of ${shown.length}. Narrow it with search.`));
    }
  }

  // ---- selection --------------------------------------------------------

  function renderSelected(): void {
    selBar.textContent = '';
    if (selected.size === 0) {
      selBar.appendChild(el('span', 'hint', 'Nothing selected yet — tick some above.'));
    } else {
      for (const id of selected) {
        const entity = entities.find((e) => e.id === id);
        const chip = el('span', 'hep-pill', entity?.name ?? id);
        const x = el('button', 'hep-pill-x', '×');
        (x as HTMLButtonElement).type = 'button';
        x.setAttribute('aria-label', `Remove ${entity?.name ?? id}`);
        x.addEventListener('click', () => {
          selected.delete(id);
          // Untick it in the list if it is on screen.
          renderList();
          renderSelected();
        });
        chip.appendChild(x);
        selBar.appendChild(chip);
      }
    }
    // A custom name only makes sense for a single reading; a batch takes each
    // entity's own name.
    labelField.style.display = selected.size === 1 ? '' : 'none';
    addButton.disabled = selected.size === 0;
    addButton.textContent =
      selected.size === 0 ? 'Add to the wall' : `Add ${selected.size} to the wall`;
  }

  // ---- add --------------------------------------------------------------

  addButton.addEventListener('click', () => {
    if (selected.size === 0) return;
    addButton.disabled = true;
    status.textContent = 'Adding…';
    status.className = 'hep-status';
    const single = selected.size === 1;
    const label = single ? labelInput.value.trim() : '';
    const payload = {
      entities: [...selected].map((id) => ({
        entity_id: id,
        ...(single && label !== '' ? { label } : {}),
      })),
      display_mode: modeSelect.value,
    };
    void fetch('admin/home-assistant/entities/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (response) => {
        if (response.ok) {
          // The server re-renders with the new readings; a reload is the whole
          // "show what happened" without duplicating the card markup here.
          window.location.reload();
          return;
        }
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        status.textContent = body.message ?? 'That did not save.';
        status.className = 'hep-status is-error';
        addButton.disabled = false;
      })
      .catch(() => {
        status.textContent = 'Could not reach the server.';
        status.className = 'hep-status is-error';
        addButton.disabled = false;
      });
  });

  search.addEventListener('input', () => {
    query = search.value.toLowerCase().trim();
    renderList();
  });

  renderChips();
  renderSelected();
  renderList();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
