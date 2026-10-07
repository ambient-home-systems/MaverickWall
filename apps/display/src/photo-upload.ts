/**
 * Photos made the right size before they are sent (plan item M3.1, MQ2).
 *
 * There is no image library in the image, by decision, so the browser that
 * already holds the photo shrinks it: each one is drawn onto a canvas no
 * longer than `LONG_SIDE` on its long side and sent as a JPEG. A phone's
 * twelve-megapixel photo arrives as about half a megabyte, and re-encoding
 * leaves behind what a phone writes into every photo it takes — the place it
 * was taken, among the rest — which a wall has no use for.
 *
 * The form works without this. The server renders it complete, and this only
 * swaps the chosen files for smaller ones and then lets the form submit as it
 * would have, so the page the household lands on is the server's own answer
 * either way. A file the browser cannot draw — a HEIC photo in a browser that
 * does not read HEIC — is sent as it is, and the server names it and says
 * what to do. Safari reads HEIC, so on an iPhone this is also the conversion.
 *
 * GIFs are sent as they are, because drawing one keeps its first frame only.
 */

/** Wide enough for a 4K television's long side, which is the biggest wall there is. */
export const LONG_SIDE = 2560;
/** Below this, and already small enough, a JPEG/PNG/WebP is sent untouched. */
export const SMALL_BYTES = 1_500_000;
const QUALITY = 0.86;

/** The size a photo is drawn at: its own, or scaled so its long side is `LONG_SIDE`. */
export function fitSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= LONG_SIDE) return { width, height };
  const scale = LONG_SIDE / long;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function shrink(file: File): Promise<File> {
  if (file.type === 'image/gif') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Not something this browser can draw: the server says what it is.
    return file;
  }
  const size = fitSize(bitmap.width, bitmap.height);
  const plain = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (plain && size.width === bitmap.width && file.size <= SMALL_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    bitmap.close();
    return file;
  }
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (blob === null) return file;
  const stem = file.name.replace(/\.[^.]*$/, '') || 'photo';
  return new File([blob], `${stem}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
}

function wire(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>('input[type="file"][name="photos"]');
  const status = form.querySelector<HTMLElement>('[data-photo-status]');
  const note = form.querySelector<HTMLElement>('[data-photo-resize]');
  // Replacing an input's files needs DataTransfer; without it the files go as
  // they are, so the sentence that promises otherwise stays hidden.
  if (input === null || typeof DataTransfer === 'undefined') return;
  if (note !== null) note.hidden = false;
  let ready = false;

  form.addEventListener('submit', (event) => {
    if (ready) return;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button !== null) button.disabled = true;
    if (status !== null) {
      status.textContent = `Making ${files.length === 1 ? 'the photo' : `${files.length} photos`} the right size…`;
    }
    void (async (): Promise<void> => {
      const out = new DataTransfer();
      for (const file of files) out.items.add(await shrink(file));
      input.files = out.files;
      if (status !== null) status.textContent = 'Sending…';
      ready = true;
      // A disabled submit sends nothing; `requestSubmit` would re-enter this
      // handler, which `ready` lets through.
      if (button !== null) button.disabled = false;
      if (typeof form.requestSubmit === 'function') form.requestSubmit(button ?? undefined);
      else form.submit();
    })();
  });
}

// Guarded so the arithmetic above can be tested where there is no document.
if (typeof document !== 'undefined') document.querySelectorAll<HTMLFormElement>('form[data-photo-upload]').forEach(wire);
