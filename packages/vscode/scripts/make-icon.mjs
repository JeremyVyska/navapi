/**
 * Generates media/icon.png (128x128) for the Marketplace listing from the
 * same compass geometry as media/navapi.svg — the Marketplace rejects SVG as
 * the extension icon. Pure Node: a 4x-supersampled rasterizer + a minimal
 * PNG encoder, so there are no native/image-tool dependencies. Re-run after
 * changing the mark: `node scripts/make-icon.mjs`.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 4; // supersample factor
const W = SIZE * SS;

// Palette
const BG = [0x26, 0x24, 0x50]; // deep indigo tile
const RING = [0xff, 0xff, 0xff]; // white compass ring
const NEEDLE_N = [0xf5, 0x9e, 0x0b]; // amber north half
const NEEDLE_S = [0xe5, 0xe7, 0xeb]; // light south half

// Brand SVG is a 24x24 viewBox; scale to the supersampled canvas.
const S = W / 24;
const cx = 12 * S;
const cy = 12 * S;
const r = 9.25 * S;
const stroke = 1.5 * S;
const P = (x, y) => [x * S, y * S];
// Needle rhombus (matches navapi.svg), split along the B-D diagonal.
const A = P(15.5, 8.5); // NE tip
const B = P(13.5, 13.5);
const Cc = P(8.5, 15.5); // SW tip
const D = P(10.5, 10.5);

function inTriangle(px, py, [ax, ay], [bx, by], [cx2, cy2]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx2) * (by - cy2) - (bx - cx2) * (py - cy2);
  const d3 = (px - ax) * (cy2 - ay) - (cx2 - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Render supersampled RGB (opaque), then box-downsample to SIZE.
const hi = new Uint8ClampedArray(W * W * 3);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    let color = BG;
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const dist = Math.hypot(dx, dy);
    if (Math.abs(dist - r) <= stroke / 2) color = RING;
    if (inTriangle(x + 0.5, y + 0.5, A, B, D)) color = NEEDLE_N;
    else if (inTriangle(x + 0.5, y + 0.5, Cc, B, D)) color = NEEDLE_S;
    const i = (y * W + x) * 3;
    hi[i] = color[0];
    hi[i + 1] = color[1];
    hi[i + 2] = color[2];
  }
}

// Downsample SSxSS blocks → final RGBA rows with a leading filter byte (0).
const stride = SIZE * 4 + 1;
const raw = Buffer.alloc(stride * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * stride] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 3;
        rSum += hi[i];
        gSum += hi[i + 1];
        bSum += hi[i + 2];
      }
    }
    const n = SS * SS;
    const o = y * stride + 1 + x * 4;
    raw[o] = Math.round(rSum / n);
    raw[o + 1] = Math.round(gSum / n);
    raw[o + 2] = Math.round(bSum / n);
    raw[o + 3] = 255;
  }
}

// --- minimal PNG encoder (8-bit RGBA) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
writeFileSync(out, png);
console.log(`make-icon: wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
