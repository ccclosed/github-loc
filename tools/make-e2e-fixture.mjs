#!/usr/bin/env node
// Готовит фикстуру для e2e: tar.gz + эталонные числа, посчитанные вручную.
// Файлы кладутся в docs/, чтобы сервис-воркер мог забрать их через chrome.runtime.getURL.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarGz } from '../tests/tar-writer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOCS = resolve(ROOT, 'docs');

// Эталон: считаем строки прямо здесь, вручную, и фиксируем в JSON.
// lib.rs  : "pub fn a() {}\n\n// комментарий\npub fn b() {}\n" → 4 строки (пустая 1, комментарий 1, код 2)
// main.py : "import os\n\n\ndef main():\n    return 1\n"      → 5 строк (пустых 2, код 3)
// index.js: "console.log(1);\n"                               → 1 строка
// README  : "# Demo\n\nТекст\n"                                → 3 строки (пустая 1, код 2)
// node_modules → ignored, logo.png → binary, каталог → nonFile
const ENTRIES = [
  { path: 'demo-main/', type: '5' },
  { path: 'demo-main/src/lib.rs', data: 'pub fn a() {}\n\n// комментарий\npub fn b() {}\n' },
  { path: 'demo-main/app/main.py', data: 'import os\n\n\ndef main():\n    return 1\n' },
  { path: 'demo-main/web/index.js', data: 'console.log(1);\n' },
  { path: 'demo-main/README.md', data: '# Demo\n\nТекст\n' },
  { path: 'demo-main/node_modules/pkg/index.js', data: 'module.exports = 42;\n' },
  { path: 'demo-main/assets/logo.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]) },
];

export const EXPECTED = {
  total: 13,
  files: 4,
  skipped: 3,
  perLanguage: {
    Rust: { lines: 4, files: 1 },
    Python: { lines: 5, files: 1 },
    JavaScript: { lines: 1, files: 1 },
    Markdown: { lines: 3, files: 1 },
  },
};

export function writeFixture() {
  mkdirSync(DOCS, { recursive: true });
  const tarball = resolve(DOCS, 'e2e-fixture.tar.gz');
  const expectedFile = resolve(DOCS, 'e2e-expected.json');
  const bytes = buildTarGz(ENTRIES);
  writeFileSync(tarball, bytes);
  writeFileSync(expectedFile, `${JSON.stringify(EXPECTED, null, 2)}\n`);
  return { tarball, expectedFile, bytes: bytes.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = writeFixture();
  console.log(`[ghloc] фикстура: ${out.tarball} (${out.bytes} байт)`);
  console.log(`[ghloc] эталон:   ${out.expectedFile}`);
}