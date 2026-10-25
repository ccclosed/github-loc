#!/usr/bin/env node
// Классификация каждой записи tar тем же способом, что countTarball (SPEC 2.4),
// но с печатью решения по каждому файлу — для построчного diff с verify/oracle.py --trace.
//
//   node verify/engine-trace.mjs <archive.tar.gz> [--limit N]
//
// TSV: path \t type \t size \t decision \t detail
// decision ∈ ignored|nonFile|tooLarge|binary|unknown|counted
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { scanTar } from '../src/loc/tar.js';
import { detectLanguage } from '../src/loc/lang.js';
import { isIgnoredPath, looksBinary } from '../src/loc/ignore.js';
import { DEFAULT_COUNT_OPTIONS } from '../src/loc/count.js';

const file = process.argv[2];
if (!file) {
  console.error('использование: node verify/engine-trace.mjs <archive.tar.gz>');
  process.exit(64);
}
const opts = { ...DEFAULT_COUNT_OPTIONS };
const limit = Number(process.env.MAX_FILE_BYTES || opts.maxFileBytes);

const stream = Readable.toWeb(createReadStream(file)).pipeThrough(new DecompressionStream('gzip'));

const stripRoot = (p) => {
  const i = p.indexOf('/');
  return i < 0 ? '' : p.slice(i + 1);
};

await scanTar(stream, async (entry) => {
  const rel = stripRoot(entry.path);
  let decision = 'counted';
  let detail = '';
  if (entry.type !== 'file') {
    decision = 'nonFile';
    detail = `type=${entry.type}`;
  } else if (!rel) {
    decision = 'nonFile';
    detail = 'empty-rel';
  } else if (isIgnoredPath(rel)) {
    decision = 'ignored';
  } else if (entry.size > limit) {
    decision = 'tooLarge';
  } else {
    const language = detectLanguage(rel);
    const head = new Uint8Array(Math.min(8192, entry.size));
    let n = 0;
    let totalBytes = 0;
    for await (const chunk of entry.body) {
      totalBytes += chunk.length;
      if (n < head.length) {
        const take = Math.min(head.length - n, chunk.length);
        head.set(chunk.subarray(0, take), n);
        n += take;
      }
    }
    if (looksBinary(head.subarray(0, n))) {
      decision = 'binary';
      detail = `lang=${language ? language.name : 'null'}`;
    } else if (!language) {
      decision = 'unknown';
      detail = `ext=${rel.includes('.') ? '.' + rel.split('.').pop().toLowerCase() : '(none)'}`;
    } else {
      detail = `lang=${language.name} bytes=${totalBytes}`;
    }
  }
  process.stdout.write(`${rel}\t${entry.type}\t${entry.size}\t${decision}\t${detail}\n`);
});