#!/usr/bin/env node
// Генератор иконок расширения: тёмный скруглённый квадрат + полоска «языков» (как у GitHub)
// и подчёркивание «итого». Без внешних зависимостей: PNG собирается вручную через zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../src/icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // суперсэмплинг для сглаживания

const COLORS = {
  bg: [31, 35, 40, 255], // #1f2328 — GitHub dark canvas
  peach: [232, 168, 124, 255], // Rust-полоска (как в скриншоте)
  blue: [53, 114, 165, 255], // Python-полоска
  gray: [139, 148, 158, 255], // Other
  line: [208, 215, 222, 255], // подчёркивание «итого»
};

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size) {
  const S = size * SS;
  const px = new Float64Array(S * S * 4);
  const put = (x, y, col) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const a = col[3] / 255;
    for (let k = 0; k < 3; k++) px[i + k] = px[i + k] * (1 - a) + col[k] * a;
    px[i + 3] = Math.max(px[i + 3], col[3]);
  };
  const roundRect = (x0, y0, x1, y1, r, col) => {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
        const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r + 0.25) put(x, y, col);
      }
    }
  };

  // фон
  roundRect(0, 0, S, S, S * 0.22, COLORS.bg);

  // стеклянная полоска языков: peach 62% / blue 28% / gray 10%
  const barH = Math.max(SS * 2, S * 0.15);
  const barY = S * 0.36;
  const barX0 = S * 0.15;
  const barX1 = S * 0.85;
  const barW = barX1 - barX0;
  const r = barH / 2;
  roundRect(barX0, barY, barX0 + barW * 0.62, barY + barH, r, COLORS.peach);
  roundRect(barX0 + barW * 0.62, barY, barX0 + barW * 0.90, barY + barH, r * 0.5, COLORS.blue);
  roundRect(barX0 + barW * 0.90, barY, barX1, barY + barH, r, COLORS.gray);

  // подчёркивание «итого»
  const lineH = Math.max(SS, S * 0.075);
  roundRect(barX0, S * 0.63, barX0 + barW * 0.58, S * 0.63 + lineH, lineH / 2, COLORS.line);

  // суперсэмплинг → итоговый размер
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r0 += px[i];
          g0 += px[i + 1];
          b0 += px[i + 2];
          a0 += px[i + 3];
        }
      }
      const n = SS * SS;
      const j = (y * size + x) * 4;
      out[j] = Math.round(r0 / n);
      out[j + 1] = Math.round(g0 / n);
      out[j + 2] = Math.round(b0 / n);
      out[j + 3] = Math.round(a0 / n);
    }
  }
  return encodePNG(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = render(size);
  const file = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`[ghloc] ${file} — ${png.length} байт`);
}