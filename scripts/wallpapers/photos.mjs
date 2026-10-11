#!/usr/bin/env node
/**
 * The bundled photographs and paintings (plan item M4.5), fetched, resized and
 * credited.
 *
 * **Every picture comes from a source on the MD5 allowlist, and says so.** The
 * plan names the sources a bundled picture may come from and why each is
 * allowed: a museum's open-access programme or a government agency whose work
 * carries no copyright. Every source on that list says "generally" or "as
 * marked", so the licence is recorded **per file** rather than per source:
 * each entry below names the work, its author and date, the page it was found
 * on, the exact address its bytes were fetched from, the licence, and the date
 * it was retrieved. The script records the sha256 of the bytes it fetched, so
 * anybody can fetch the same address and check the picture is the one that was
 * credited. `wallpaper-photos.test.ts` fails on a shipped file with no entry, on
 * a licence off the allowlist, and on a credit file this script did not write.
 *
 * The set comes from five of them: the National Gallery of Art's open-access
 * images and the Rijksmuseum's (public-domain works, free for any use), NASA's
 * image library (photographs taken by astronauts on the International Space
 * Station), and ESA/Hubble and ESA/Webb, whose images are CC BY 4.0. A CC BY
 * picture names its required credit as \`attribution\`, which the wallpaper
 * picker shows on its tile, because that licence asks for the credit to be
 * shown with the picture and not only written down. The Art Institute of
 * Chicago's image server sits behind a bot check a script cannot pass, so its
 * works are not here.
 *
 * **The pictures are resized, never edited.** Three files per picture, as the
 * drawn set has: about 320px on the long edge for the picker, and long edges
 * of 1600 and 2880 for the wall, which picks by its own pixel size. Unlike the
 * drawn set a photograph is not square, so it names a focal point per
 * orientation: where a landscape wall's crop should sit, and where a portrait
 * wall's narrow slice of the same picture should. Resizing is done in the
 * bundled Chromium, the decoder the wall itself uses, so the image needs no
 * image library and none is added.
 *
 * **What makes a photograph safe to put text near is measured, not assumed.**
 * A painting has both bright skies and dark trees, and the Soft widget ground's
 * fixed 0.86 keeps 4.5:1 over almost none of them. So each picture carries its
 * lightest and darkest block (`soft`), measured off the shipped 1600px file,
 * and the wall solves Soft's opacity from them for the theme it is wearing,
 * never below 0.86 — the way Glass's opacity is solved (M4.2).
 * `browser-wallpaper-contrast.test.ts` holds the promise against the bytes.
 *
 *   MW_BROWSER_EXECUTABLE=/path/to/chrome node scripts/wallpapers/photos.mjs [id …]
 *
 * Fetched originals are kept in `scripts/wallpapers/.cache/` (not committed),
 * so a re-run checks every source's sha256 against the one recorded and
 * refuses to go on when a source has changed under it. With ids, only those
 * are fetched again and the rest of the list is kept. Run `glass.mjs` after.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'apps', 'server', 'package.json'));
const { chromium } = require('playwright-core');

const OUT = join(root, 'apps', 'server', 'assets', 'wallpapers');
const CATALOGUE = join(root, 'apps', 'server', 'src', 'wallpaper-photos.ts');
const LICENSES = join(OUT, 'LICENSES.md');
const NOTICE = join(root, 'NOTICE');
const CACHE = join(dirname(fileURLToPath(import.meta.url)), '.cache');
const SIZES = { thumb: 320, small: 1600, large: 2880 };
/** JPEG quality. A painting's craquelure is detail a JPEG has to keep, so these are a budget rather than a look. */
const QUALITY = { thumb: 0.76, small: 0.78, large: 0.68 };
/** The day these sources were read and fetched. A re-fetch is a new date and a new review. */
const RETRIEVED = '2026-10-10';

/** The NGA's IIIF address for a work's image, at most 3200px a side: plenty for a 2880px file. */
const nga = (uuid) => `https://api.nga.gov/iiif/${uuid}/full/!3200,3200/0/default.jpg`;
const ngaPage = (objectId) => `https://www.nga.gov/collection/art-object-page.${objectId}.html`;
const nasa = (id) => `https://images-assets.nasa.gov/image/${id}/${id}~orig.jpg`;
const nasaPage = (id) => `https://images.nasa.gov/details/${id}`;
/**
 * The Rijksmuseum's IIIF address for a work's image. \`region\` is the IIIF
 * region, kept for a scan whose own frame shows at its edges: the server crops
 * it, so the address recorded is still exactly what was fetched.
 */
const rijks = (iiif, region = 'full') => `https://iiif.micr.io/${iiif}/${region}/!3200,3200/0/default.jpg`;
const rijksPage = (objectNumber) => `https://www.rijksmuseum.nl/en/collection/${objectNumber}`;
/** ESA/Webb's largest JPEG; `large` is only 1200px for some images, `publicationjpg` is the print size. */
const webb = (id, size = 'large') => `https://cdn.esawebb.org/archives/images/${size}/${id}.jpg`;
const webbPage = (id) => `https://esawebb.org/images/${id}/`;
const hubble = (id) => `https://cdn.esahubble.org/archives/images/large/${id}.jpg`;
const hubblePage = (id) => `https://esahubble.org/images/${id}/`;

const DARK = ['panels', 'swiss'];
const LIGHT = ['household', 'almanac', 'blueprint'];

/**
 * The set: twenty-eight, sixteen dark and twelve light. Paintings whose interest is in a sky
 * or a light take a focal point low enough to keep the horizon on a landscape
 * wall, and a portrait wall's slice is centred on what the picture is of.
 */
export const PHOTOS = [
  // --- Paintings, dark ---
  { id: 'moonlit-bridge', name: 'Moonlit landscape', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 52, y: 50 },
    credit: { title: 'Moonlit Landscape with Bridge', author: 'Aert van der Neer', date: 'probably 1648/1650',
      source: ngaPage(71369), image: nga('642620fe-1a26-4ae8-b93a-a84f8c695b60'), licence: 'nga-open-access' } },
  { id: 'sunset-woods', name: 'Sunset in the woods', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 64, y: 50 },
    credit: { title: 'Sunset in the Woods', author: 'George Inness', date: '1891',
      source: ngaPage(166496), image: nga('ec49c7f7-2438-4522-99cd-8569985c909d'), licence: 'nga-open-access' } },
  { id: 'river-of-light', name: 'River of light', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: 'El Rio de Luz (The River of Light)', author: 'Frederic Edwin Church', date: '1877',
      source: ngaPage(50299), image: nga('9d96691b-10b2-44c9-8670-a642e0cd9ce2'), licence: 'nga-open-access' } },
  { id: 'impending-storm', name: 'Impending storm', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 45, y: 50 },
    credit: { title: 'Buffalo Trail: The Impending Storm', author: 'Albert Bierstadt', date: '1869',
      source: ngaPage(166427), image: nga('8681fef5-68c8-4449-9a71-4722f0bc2899'), licence: 'nga-open-access' } },
  { id: 'keelmen', name: 'Keelmen by moonlight', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 42, y: 50 },
    credit: { title: 'Keelmen Heaving in Coals by Moonlight', author: 'Joseph Mallord William Turner', date: '1835',
      source: ngaPage(1225), image: nga('c1e33e8d-ffe4-4d20-a267-87ffcf94f7ce'), licence: 'nga-open-access' } },

  // --- Paintings, light ---
  { id: 'parliament', name: 'Parliament at sunset', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 48, y: 50 },
    credit: { title: 'The Houses of Parliament, Sunset', author: 'Claude Monet', date: '1903',
      source: ngaPage(46523), image: nga('9eae6258-ec1c-442f-b353-a89cff510113'), licence: 'nga-open-access' } },
  { id: 'waterloo-bridge', name: 'Waterloo Bridge', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 40, y: 50 },
    credit: { title: 'Waterloo Bridge, London, at Sunset', author: 'Claude Monet', date: '1904',
      source: ngaPage(61378), image: nga('e5c0853d-e3ac-49c2-884e-c0ac3b0af597'), licence: 'nga-open-access' } },
  { id: 'vetheuil-garden', name: 'Garden at Vétheuil', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: "The Artist's Garden at Vétheuil", author: 'Claude Monet', date: '1881',
      source: ngaPage(52189), image: nga('9fc88734-2f9a-4da8-8d46-2b570b201223'), licence: 'nga-open-access' } },
  { id: 'meadow', name: 'Meadow', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: 'Meadow', author: 'Alfred Sisley', date: '1875',
      source: ngaPage(52227), image: nga('1c2440bb-63a8-434b-8cd9-8307226aa917'), licence: 'nga-open-access' } },
  { id: 'port-en-bessin', name: 'Port-en-Bessin', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 55, y: 50 },
    credit: { title: 'Seascape at Port-en-Bessin, Normandy', author: 'Georges Seurat', date: '1888',
      source: ngaPage(53139), image: nga('f395c5e5-6711-487e-8c1b-747c698d1ef9'), licence: 'nga-open-access' } },
  { id: 'eragny-garden', name: 'Garden at Eragny', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: "The Artist's Garden at Eragny", author: 'Camille Pissarro', date: '1898',
      source: ngaPage(52198), image: nga('e291058c-0769-493c-a5f3-8e0e64e9ea46'), licence: 'nga-open-access' } },
  { id: 'cloud-study', name: 'Cloud study', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 40 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: 'Cloud Study: Stormy Sunset', author: 'John Constable', date: '1821-1822',
      source: ngaPage(104243), image: nga('83544e9a-2499-4d42-aeb1-62dbc2c2392b'), licence: 'nga-open-access' } },
  { id: 'beacon-rock', name: 'Beacon Rock', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 62, y: 50 },
    credit: { title: 'Beacon Rock, Newport Harbor', author: 'John Frederick Kensett', date: '1857',
      source: ngaPage(42389), image: nga('c31769b8-f5f8-41bd-b204-1e838690c219'), licence: 'nga-open-access' } },

  // --- Paintings from the Rijksmuseum ---
  { id: 'wijk-windmill', name: 'Windmill at Wijk', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 70, y: 50 },
    credit: { title: 'The Windmill at Wijk bij Duurstede', author: 'Jacob Isaacksz van Ruisdael', date: 'c. 1668-1670',
      source: rijksPage('SK-C-211'), image: rijks('XWEFp', 'pct:2,3,96,94'), licence: 'rijksmuseum' } },
  { id: 'river-riders', name: 'River with riders', category: 'painting', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 58, y: 50 },
    credit: { title: 'River Landscape with Riders', author: 'Aelbert Cuyp', date: 'c. 1653-1657',
      source: rijksPage('SK-A-4118'), image: rijks('uMHxo'), licence: 'rijksmuseum' } },
  { id: 'winter-skaters', name: 'Winter skaters', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 55 }, portraitFocal: { x: 45, y: 50 },
    credit: { title: 'Winter Landscape with Ice Skaters', author: 'Hendrick Avercamp', date: 'c. 1608',
      source: rijksPage('SK-A-1718'), image: rijks('aXnzA'), licence: 'rijksmuseum' } },
  { id: 'merwede', name: 'The Merwede', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 55, y: 50 },
    credit: { title: 'View of the Merwede off Dordrecht', author: 'attributed to Jeronymus van Diest (II)', date: 'c. 1660',
      source: rijksPage('SK-A-121'), image: rijks('CepGg'), licence: 'rijksmuseum' } },
  { id: 'july-windmill', name: 'In the month of July', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: "A Windmill on a Polder Waterway, Known as 'In the Month of July'", author: 'Paul Joseph Constantin Gabriël', date: 'c. 1889',
      source: rijksPage('SK-A-1505'), image: rijks('HNwWx'), licence: 'rijksmuseum' } },
  { id: 'zwijndrecht-winter', name: 'Zwijndrecht in winter', category: 'painting', tone: 'light', themes: LIGHT,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 55, y: 50 },
    credit: { title: 'Zwijndrecht in the Winter', author: 'Siebe Johannes ten Cate', date: '1892',
      source: rijksPage('SK-A-2299'), image: rijks('cJXML'), licence: 'rijksmuseum' } },

  // --- From space, dark ---
  { id: 'orbital-sunset', name: 'Sunset from orbit', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 60, y: 50 },
    credit: { title: 'The sun peeking over the limb of the Earth (ISS028-E-007274)', author: 'NASA, Expedition 28 crew', date: '11 June 2011',
      source: nasaPage('iss028e007274'), image: nasa('iss028e007274'), licence: 'nasa-media' } },
  { id: 'green-aurora', name: 'Aurora from orbit', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 55 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: "A bright green aurora borealis streams above Earth's surface (iss072e188141)", author: 'NASA astronaut Nick Hague', date: '15 November 2024',
      source: nasaPage('iss072e188141'), image: nasa('iss072e188141'), licence: 'nasa-media' } },
  { id: 'night-lights', name: 'Night lights and aurora', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 85 }, portraitFocal: { x: 55, y: 50 },
    credit: { title: 'Aurora borealis and city lights on the horizon (ISS029-E-012564)', author: 'NASA astronaut Mike Fossum', date: '29 September 2011',
      source: nasaPage('iss029e012564'), image: nasa('iss029e012564'), licence: 'nasa-media' } },

  // --- From space, ESA/Hubble and ESA/Webb (CC BY 4.0: each names its required credit) ---
  { id: 'westerlund', name: 'Westerlund 2', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: "Westerlund 2 — Hubble's 25th anniversary image (heic1509a)", author: 'NASA, ESA, the Hubble Heritage Team (STScI/AURA), A. Nota (ESA/STScI), and the Westerlund 2 Science Team', date: '23 April 2015',
      source: hubblePage('heic1509a'), image: hubble('heic1509a'), licence: 'esa-hubble',
      attribution: 'NASA, ESA, the Hubble Heritage Team (STScI/AURA), A. Nota (ESA/STScI), and the Westerlund 2 Science Team' } },
  { id: 'bubble-nebula', name: 'The Bubble Nebula', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 55, y: 55 }, portraitFocal: { x: 55, y: 50 },
    credit: { title: 'The Bubble Nebula (heic1608a)', author: 'NASA, ESA, Hubble Heritage Team', date: '21 April 2016',
      source: hubblePage('heic1608a'), image: hubble('heic1608a'), licence: 'esa-hubble',
      attribution: 'NASA, ESA, Hubble Heritage Team' } },
  { id: 'butterfly-nebula', name: 'Butterfly Nebula', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 48, y: 50 },
    credit: { title: 'Butterfly emerges from stellar demise in planetary nebula NGC 6302 (heic0910h)', author: 'NASA, ESA and the Hubble SM4 ERO Team', date: '9 September 2009',
      source: hubblePage('heic0910h'), image: hubble('heic0910h'), licence: 'esa-hubble',
      attribution: 'NASA, ESA and the Hubble SM4 ERO Team' } },
  { id: 'cosmic-cliffs', name: 'Cosmic Cliffs', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 55 }, portraitFocal: { x: 45, y: 50 },
    credit: { title: 'NIRCam Image of the "Cosmic Cliffs" in Carina (weic2205a)', author: 'NASA, ESA, CSA, and STScI', date: '12 July 2022',
      source: webbPage('weic2205a'), image: webb('weic2205a'), licence: 'esa-webb',
      attribution: 'NASA, ESA, CSA, and STScI' } },
  { id: 'pillars-webb', name: 'Pillars of Creation', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 50 }, portraitFocal: { x: 50, y: 50 },
    credit: { title: 'Webb Takes a Stunning, Star-Filled Portrait of the Pillars of Creation (weic2216a)', author: 'NASA, ESA, CSA, STScI; J. DePasquale, A. Koekemoer, A. Pagan (STScI)', date: '19 October 2022',
      source: webbPage('weic2216a'), image: webb('weic2216a', 'publicationjpg'), licence: 'esa-webb',
      attribution: 'NASA, ESA, CSA, STScI; J. DePasquale, A. Koekemoer, A. Pagan (STScI)' } },
  { id: 'rho-ophiuchi', name: 'Rho Ophiuchi', category: 'space', tone: 'dark', themes: DARK,
    focal: { x: 50, y: 45 }, portraitFocal: { x: 55, y: 50 },
    credit: { title: 'Rho Ophiuchi cloud complex (weic2316a)', author: 'NASA, ESA, CSA, STScI, K. Pontoppidan (STScI), A. Pagan (STScI)', date: '12 July 2023',
      source: webbPage('weic2316a'), image: webb('weic2316a'), licence: 'esa-webb',
      attribution: 'NASA, ESA, CSA, STScI, K. Pontoppidan (STScI), A. Pagan (STScI)' } },
];

/**
 * The licences a bundled picture may carry: each one's name, where it is
 * stated, and the hosts its pictures may be fetched from. The test holds every
 * entry's licence to this table and both its addresses to the licence's hosts,
 * so a picture cannot be credited to a programme it did not come from.
 */
export const LICENCES = {
  'nga-open-access': {
    name: 'Public domain, National Gallery of Art open access',
    terms: 'https://www.nga.gov/artworks/free-images-and-open-access',
    statement: 'Images of public-domain works, free of charge for any use, whether commercial or non-commercial.',
    hosts: ['api.nga.gov', 'www.nga.gov'],
  },
  'nasa-media': {
    name: 'Public domain, NASA',
    terms: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    statement: 'NASA content is generally not subject to copyright in the United States; credit NASA.',
    hosts: ['images-assets.nasa.gov', 'images.nasa.gov'],
  },
  rijksmuseum: {
    name: 'Public domain, Rijksmuseum',
    terms: 'https://data.rijksmuseum.nl/policy',
    statement: 'Images of works in the public domain, marked with the Public Domain Mark or CC0, free to use for any purpose.',
    hosts: ['data.rijksmuseum.nl', 'www.rijksmuseum.nl', 'iiif.micr.io'],
  },
  'esa-hubble': {
    name: 'CC BY 4.0, ESA/Hubble',
    terms: 'https://esahubble.org/copyright/',
    statement: 'Released under the Creative Commons Attribution 4.0 International licence; the credit listed with each image must be shown with it.',
    attribution: true,
    hosts: ['esahubble.org', 'cdn.esahubble.org'],
  },
  'esa-webb': {
    name: 'CC BY 4.0, ESA/Webb',
    terms: 'https://esawebb.org/copyright/',
    statement: 'Released under the Creative Commons Attribution 4.0 International licence; the credit listed with each image must be shown with it.',
    attribution: true,
    hosts: ['esawebb.org', 'cdn.esawebb.org'],
  },
};

// --- Fetching ---------------------------------------------------------------

const only = new Set(process.argv.slice(2));
mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

/** What the catalogue recorded last time, so a partial run keeps the rest and a re-fetch is checked. */
const previous = new Map();
if (existsSync(CATALOGUE)) {
  const json = /\/\* photos \*\/ (\[[\s\S]*?\]) as const;/.exec(readFileSync(CATALOGUE, 'utf8'))?.[1];
  if (json) for (const entry of JSON.parse(json)) previous.set(entry.id, entry);
}

async function fetchSource(photo) {
  const cached = join(CACHE, `${photo.id}.jpg`);
  if (!existsSync(cached)) {
    const res = await fetch(photo.credit.image);
    if (!res.ok) throw new Error(`${photo.id}: ${photo.credit.image} answered ${res.status}`);
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(cached);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const recorded = previous.get(photo.id)?.credit?.sha256;
  if (recorded !== undefined && recorded !== sha256) {
    throw new Error(`${photo.id}: the source has changed since it was credited (${recorded} → ${sha256}); review it before shipping it`);
  }
  return { bytes, sha256 };
}

// --- Resizing and measuring, in Chromium ------------------------------------

const executablePath = process.env.MW_BROWSER_EXECUTABLE || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();

/** One source drawn at each size and encoded as JPEG, plus what the wall needs to know about it. */
async function render(bytes) {
  return page.evaluate(
    async ({ b64, sizes, quality }) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const source = await createImageBitmap(blob);
      const out = {};
      for (const [size, edge] of Object.entries(sizes)) {
        const scale = Math.min(1, edge / Math.max(source.width, source.height));
        const width = Math.round(source.width * scale);
        const height = Math.round(source.height * scale);
        // A high-quality resample straight from the source, rather than a
        // canvas scale, which drops pixels when the step is large.
        const bitmap = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality[size] });
        const buf = new Uint8Array(await jpeg.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        out[size] = { b64: btoa(bin), width, height };
      }
      return out;
    },
    { b64: bytes.toString('base64'), sizes: SIZES, quality: QUALITY },
  );
}

/**
 * The shipped small file's mean colour and luminance (the picker's tile, and
 * the OLED line), and its lightest and darkest of 40x40 blocks unblurred: what
 * a widget's Soft ground sits over, and so what the wall solves Soft from.
 */
async function measure(jpegB64) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = (c) => 0.2126 * lin(c[0] / 255) + 0.7152 * lin(c[1] / 255) + 0.0722 * lin(c[2] / 255);
    const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const blocks = 40;
    const bw = c.width / blocks;
    const bh = c.height / blocks;
    const sums = new Float64Array(blocks * blocks * 3);
    const counts = new Float64Array(blocks * blocks);
    let total = [0, 0, 0];
    let totalLum = 0;
    for (let y = 0; y < c.height; y++) {
      const by = Math.min(blocks - 1, Math.floor(y / bh));
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const px = [data[i], data[i + 1], data[i + 2]];
        const k = by * blocks + Math.min(blocks - 1, Math.floor(x / bw));
        for (let j = 0; j < 3; j++) sums[k * 3 + j] += px[j];
        counts[k] += 1;
        total = total.map((t, j) => t + px[j]);
        totalLum += lum(px);
      }
    }
    let light;
    let dark;
    for (let k = 0; k < blocks * blocks; k++) {
      const block = [0, 1, 2].map((j) => sums[k * 3 + j] / counts[k]);
      if (light === undefined || lum(block) > lum(light)) light = block;
      if (dark === undefined || lum(block) < lum(dark)) dark = block;
    }
    const n = c.width * c.height;
    return {
      color: hex(total.map((t) => t / n)),
      luminance: Number((totalLum / n).toFixed(3)),
      soft: { light: hex(light), dark: hex(dark) },
    };
  }, jpegB64);
}

const entries = [];
for (const photo of PHOTOS) {
  if (only.size > 0 && !only.has(photo.id)) {
    const kept = previous.get(photo.id);
    if (kept === undefined) throw new Error(`${photo.id} is not in the catalogue yet; run without ids`);
    entries.push(kept);
    continue;
  }
  const { bytes, sha256 } = await fetchSource(photo);
  const files = await render(bytes);
  const names = {};
  for (const [size, file] of Object.entries(files)) {
    const body = Buffer.from(file.b64, 'base64');
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    const name = `${photo.id}-${SIZES[size]}.${hash}.jpg`;
    writeFileSync(join(OUT, name), body);
    names[size] = name;
    process.stderr.write(`${name}  ${file.width}x${file.height}  ${body.length} bytes\n`);
  }
  const stats = await measure(files.small.b64);
  entries.push({
    id: photo.id,
    name: photo.name,
    category: photo.category,
    tone: photo.tone,
    themes: photo.themes,
    focal: photo.focal,
    portraitFocal: photo.portraitFocal,
    color: stats.color,
    luminance: stats.luminance,
    thumb: names.thumb,
    small: names.small,
    large: names.large,
    soft: stats.soft,
    credit: { ...photo.credit, retrieved: previous.get(photo.id)?.credit?.retrieved ?? RETRIEVED, sha256 },
  });
}
await browser.close();

// Every photo file the catalogue no longer names is removed, and only those:
// the drawn set's files are `generate.mjs`'s to keep or remove.
const named = new Set(entries.flatMap((e) => [e.thumb, e.small, e.large]));
const ours = new Set(PHOTOS.map((p) => p.id));
for (const name of readdirSync(OUT)) {
  const id = /^([a-z0-9-]+)-[0-9]{2,4}\.[0-9a-f]+\.jpg$/.exec(name)?.[1];
  if (id !== undefined && ours.has(id) && !named.has(name)) rmSync(join(OUT, name));
}

writeFileSync(
  CATALOGUE,
  `/**
 * The bundled photographs and paintings (plan item M4.5). GENERATED by
 * \`scripts/wallpapers/photos.mjs\` — edit the list there and run it again; do
 * not edit this file.
 *
 * Every entry names where its picture came from, under which licence, when it
 * was retrieved and the sha256 of the bytes that were fetched; its colour,
 * luminance and Soft patches were measured off the shipped 1600px file, and
 * every file name is the sha256 of the bytes it names.
 */
export const PHOTO_LICENCES = ${JSON.stringify(LICENCES, null, 2)} as const;

export const WALLPAPER_PHOTOS = /* photos */ ${JSON.stringify(entries, null, 2)} as const;
`,
);

// The credits, written from the same list so they cannot disagree with it.
const credits = entries
  .map((e) => {
    const licence = LICENCES[e.credit.licence];
    return `- **${e.name}** (\`${e.id}\`): *${e.credit.title}*, ${e.credit.author}, ${e.credit.date}. ` +
      `${licence.name}.${e.credit.attribution ? ` Credit: ${e.credit.attribution}.` : ''} Source: ${e.credit.source}. Fetched ${e.credit.retrieved} from ${e.credit.image} ` +
      `(sha256 \`${e.credit.sha256}\`).`;
  })
  .join('\n');
const licenceList = Object.values(LICENCES).map((l) => `- **${l.name}** — ${l.statement} ${l.terms}`).join('\n');
const START = '<!-- photos:start -->';
const END = '<!-- photos:end -->';
const section = `${START}
## Photographs and paintings

GENERATED by \`scripts/wallpapers/photos.mjs\` from the list in that script; do
not edit between these markers.

These are not this project's work and are not under its licence. Each is a
picture from a source on the plan's allowlist (MD5), public domain or under
Creative Commons Attribution, resized and re-encoded and otherwise unchanged.
A picture under CC BY carries its required credit, which the wallpaper picker
shows beside it. The licences:

${licenceList}

The pictures:

${credits}
${END}`;
const replaceSection = (text) => {
  const at = text.indexOf(START);
  const end = text.indexOf(END);
  return at >= 0 && end > at ? `${text.slice(0, at)}${section}${text.slice(end + END.length)}` : `${text.trimEnd()}\n\n${section}\n`;
};
writeFileSync(LICENSES, replaceSection(readFileSync(LICENSES, 'utf8')));

const noticeStart = '# photos:start';
const noticeEnd = '# photos:end';
const noticeBody = `${noticeStart}
The bundled photographs and paintings under apps/server/assets/wallpapers/ are
not this project's work. They are pictures from the National Gallery of Art's
open-access programme, the Rijksmuseum and NASA (public domain), and from
ESA/Hubble and ESA/Webb (CC BY 4.0, with the credit given), credited one by
one, with where each came from and the sha256 of the bytes fetched, in
apps/server/assets/wallpapers/LICENSES.md:
${entries.map((e) => `  ${e.credit.title}, ${e.credit.author}, ${e.credit.date} (${LICENCES[e.credit.licence].name}${e.credit.attribution ? `; credit: ${e.credit.attribution}` : ''})`).join('\n')}
${noticeEnd}`;
const notice = readFileSync(NOTICE, 'utf8');
const ns = notice.indexOf(noticeStart);
const ne = notice.indexOf(noticeEnd);
writeFileSync(
  NOTICE,
  ns >= 0 && ne > ns ? `${notice.slice(0, ns)}${noticeBody}${notice.slice(ne + noticeEnd.length)}` : `${notice.trimEnd()}\n\n${noticeBody}\n`,
);

const total = entries.reduce((sum, e) => sum + [e.thumb, e.small, e.large].reduce((s, n) => s + readFileSync(join(OUT, n)).length, 0), 0);
process.stderr.write(`${entries.length} photographs and paintings, ${(total / 1024 / 1024).toFixed(2)} MB\n`);
