#!/usr/bin/env node
// CLI: считает строки по tar.gz (файл или stdin).
//   node tools/count-repo.mjs repo.tar.gz [--json]
//   curl -sL https://codeload.github.com/owner/repo/tar.gz/HEAD | node tools/count-repo.mjs -
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { countTarball } from '../src/loc/count.js';
import { countOptionsFrom } from '../src/loc/settings.js';
import { formatInt, plural, formatBytes, formatDuration } from '../src/loc/format.js';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--')) ?? '-';
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');

const nodeStream = input === '-' ? process.stdin : createReadStream(input);
const gz = Readable.toWeb(nodeStream).pipeThrough(new DecompressionStream('gzip'));

let lastLine = 0;
const result = await countTarball(gz, {
  options: countOptionsFrom({}),
  onProgress: asJson || quiet
    ? undefined
    : (p) => {
      const now = Date.now();
      if (now - lastLine < 250) return;
      lastLine = now;
      process.stderr.write(`\r  распаковано ${formatBytes(p.bytes)}, файлов ${p.files}   `);
    },
});

if (!asJson && !quiet) process.stderr.write('\r'.padEnd(60) + '\r');

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const rows = Object.entries(result.perLanguage).sort((a, b) => b[1].lines - a[1].lines);
  for (const [name, stats] of rows) {
    console.log(
      `${name.padEnd(24)} ${formatInt(stats.lines).padStart(14)}  ${String(stats.files).padStart(6)} файл(ов)`,
    );
  }
  console.log('─'.repeat(50));
  console.log(
    `ИТОГО: ${formatInt(result.total)} ${plural(result.total, ['строка', 'строки', 'строк'])} `
    + `в ${formatInt(result.files)} файлах, пропущено ${result.skipped} `
    + `(${JSON.stringify(result.skippedReasons)}), архив ${formatBytes(result.archiveBytes)}, `
    + `${formatDuration(result.ms)}${result.truncated ? ' [АРХИВ ОБРЕЗАН]' : ''}`,
  );
}