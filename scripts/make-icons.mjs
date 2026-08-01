/*
 * make-icons.mjs — generate the PWA icon set, with no image dependency.
 *
 * A PWA install prompt needs 192px and 512px icons, and iOS wants its own
 * apple-touch-icon. Rather than commit opaque binaries nobody can regenerate,
 * this draws them: Node ships zlib, and a PNG is just zlib-compressed scanlines
 * plus three chunks. Re-run it and the bytes are identical — the icons are
 * reproducible from the palette rather than from a design file that isn't here.
 *
 * The mark is the app's own motif: burnt-orange slash noteheads on ink, the same
 * two colours index.html uses for --accent and --ink.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const INK = [0x20, 0x20, 0x1c]; // --ink
const ACCENT = [0xb8, 0x35, 0x0f]; // --accent (burnt orange)

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB pixel buffer → PNG bytes (8-bit truecolour, filter 0 per scanline). */
function encodePng(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    rgb.copy(raw, o, y * size * 3, (y + 1) * size * 3);
    o += size * 3;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Three slash noteheads on an ink field.
 *
 * `inset` is the fraction of the canvas kept clear around the mark. Maskable
 * icons get a bigger inset because Android crops them to a circle: the art has
 * to survive inside the ~80% safe zone.
 */
function drawIcon(size, inset) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    px[i * 3] = INK[0];
    px[i * 3 + 1] = INK[1];
    px[i * 3 + 2] = INK[2];
  }

  const art = size * (1 - inset * 2);
  const left = size * inset;
  const slashes = 3;
  const gap = art / slashes;
  const w = gap * 0.46; // notehead width
  const h = art * 0.30; // notehead height
  const lean = w * 0.85; // horizontal rise over the height — the slash angle
  const midY = size / 2;

  for (let s = 0; s < slashes; s++) {
    const cx = left + gap * (s + 0.5);
    const x0 = cx - (w + lean) / 2;
    const y0 = midY - h / 2;
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
      if (y < 0 || y >= size) continue;
      // A parallelogram: each scanline's span shifts right as y decreases.
      const t = (y0 + h - y) / h; // 1 at the top, 0 at the bottom
      const xs = x0 + lean * t;
      for (let x = Math.floor(xs); x < Math.ceil(xs + w); x++) {
        if (x < 0 || x >= size) continue;
        const i = (y * size + x) * 3;
        px[i] = ACCENT[0];
        px[i + 1] = ACCENT[1];
        px[i + 2] = ACCENT[2];
      }
    }
  }
  return px;
}

const OUT = [
  ['icon-192.png', 192, 0.16],
  ['icon-512.png', 512, 0.16],
  // Maskable: Android crops to a circle, so the mark sits inside the safe zone.
  ['icon-maskable-512.png', 512, 0.26],
  // iOS composites onto its own rounded rect and does not respect transparency.
  ['apple-touch-icon.png', 180, 0.16],
];

for (const [name, size, inset] of OUT) {
  writeFileSync(join(root, name), encodePng(size, drawIcon(size, inset)));
  console.log(`wrote ${name} (${size}x${size})`);
}
