// Generates icons/icon{16,32,48,128}.png: two overlapping circles (Generator blue, Reviewer orange).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function icon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const circles = [
    { cx: size * 0.38, cy: size * 0.5, r: size * 0.32, c: [37, 99, 235] },
    { cx: size * 0.62, cy: size * 0.5, r: size * 0.32, c: [234, 88, 12] },
  ];
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let px = [0, 0, 0, 0];
      for (const ci of circles) {
        const d = Math.hypot(x + 0.5 - ci.cx, y + 0.5 - ci.cy);
        const a = Math.max(0, Math.min(1, ci.r - d + 0.5));
        if (a > 0) {
          const alpha = a * 0.9;
          px = [0, 1, 2].map((i) => px[i] * (1 - alpha) + ci.c[i] * alpha).concat([Math.min(255, px[3] + alpha * 255 * (1 - px[3] / 255))]);
        }
      }
      raw.set(px.map((v) => Math.round(v)), y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`../icons/icon${s}.png`, import.meta.url), icon(s));
