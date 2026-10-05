/**
 * "Copy" beside a read-only field — the companion token (plan item M2.1).
 *
 * The server renders the button `hidden`, and this is what reveals it, the
 * rule `geolocate-button.ts` states: a control that is shown and then silently
 * does nothing is worse than one never offered. Without script the field is
 * still there, read-only, to select and copy by hand.
 *
 * `navigator.clipboard` needs a secure context, which a box reached by its LAN
 * address over plain http is not — the commonest install there is. So where it
 * is missing this selects the field and asks the older `execCommand('copy')`,
 * which still works there; and the button says what happened either way, since
 * a copy has nothing else to show for itself.
 */

function wire(button: HTMLButtonElement): void {
  const target = document.getElementById(button.dataset['copy'] ?? '');
  if (!(target instanceof HTMLInputElement)) return;
  const label = button.textContent ?? 'Copy';

  const said = (words: string): void => {
    button.textContent = words;
    window.setTimeout(() => {
      button.textContent = label;
    }, 2000);
  };

  button.hidden = false;
  button.addEventListener('click', () => {
    const fallback = (): void => {
      target.focus();
      target.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      said(copied ? 'Copied' : 'Selected — copy it now');
    };
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      navigator.clipboard.writeText(target.value).then(() => said('Copied'), fallback);
    } else {
      fallback();
    }
  });
}

document.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach(wire);
