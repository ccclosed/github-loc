// Генератор tar/tar.gz для тестов: ustar, pax ('x'), GNU LongName ('L'), base-256 размеры,
// а также поток с крошечными чанками — чтобы ловить ошибки на границах буферов.
import { gzipSync } from 'node:zlib';

const BLOCK = 512;
const enc = new TextEncoder();

function octalField(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function base256Field(value, length) {
  const buf = new Uint8Array(length);
  buf[0] = 0x80;
  let v = value;
  for (let i = length - 1; i >= 1; i--) {
    buf[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return buf;
}

function header({ name, size, type = '0', prefix = '', sizeField = null }) {
  const h = new Uint8Array(BLOCK);
  h.set(enc.encode(name).subarray(0, 100), 0);
  h.set(enc.encode(octalField(0o644, 8)), 100);
  h.set(enc.encode(octalField(0, 8)), 108);
  h.set(enc.encode(octalField(0, 8)), 116);
  h.set(sizeField ?? enc.encode(octalField(size, 12)), 124);
  h.set(enc.encode(octalField(1700000000, 12)), 136);
  for (let i = 148; i < 156; i++) h[i] = 32; // chksum — пробелы на время подсчёта
  h[156] = type.charCodeAt(0);
  h.set(enc.encode('ustar\0'), 257);
  h.set(enc.encode('00'), 263);
  h.set(enc.encode('root'), 265);
  h.set(enc.encode('root'), 297);
  if (prefix) h.set(enc.encode(prefix).subarray(0, 155), 345);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return h;
}

export function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let len = body.length;
  for (;;) {
    const candidate = String(len).length + 1 + body.length;
    if (candidate === len) break;
    len = candidate;
  }
  return `${len} ${body}`;
}

function padTo(n) {
  return (BLOCK - (n % BLOCK)) % BLOCK;
}

/**
 * @param {Array<{path:string, data?:string|Uint8Array, type?:string, longName?:'pax'|'gnu', base256?:boolean, prefix?:string}>} entries
 * @returns {Uint8Array}
 */
export function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = typeof entry.data === 'string'
      ? enc.encode(entry.data)
      : entry.data instanceof Uint8Array
        ? entry.data
        : new Uint8Array(0);
    const type = entry.type ?? '0';
    let name = entry.path;

    if (entry.longName === 'pax') {
      const record = paxRecord('path', name);
      const bytes = enc.encode(record);
      parts.push(header({ name: 'PaxHeaders/file', size: bytes.length, type: 'x' }));
      parts.push(bytes, new Uint8Array(padTo(bytes.length)));
      name = name.slice(0, 100);
    } else if (entry.longName === 'gnu') {
      const bytes = enc.encode(`${entry.path}\0`);
      parts.push(header({ name: '././@LongLink', size: bytes.length, type: 'L' }));
      parts.push(bytes, new Uint8Array(padTo(bytes.length)));
      name = name.slice(0, 100);
    }

    parts.push(
      header({
        name,
        size: data.length,
        type,
        prefix: entry.prefix ?? '',
        sizeField: entry.base256 ? base256Field(data.length, 12) : null,
      }),
    );
    if (type !== '5' && data.length > 0) {
      parts.push(data, new Uint8Array(padTo(data.length)));
    }
  }
  parts.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK));

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function buildTarGz(entries) {
  return gzipSync(buildTar(entries));
}

/** ReadableStream с нарезанными чанками (по умолчанию очень мелкими). */
export function chunkedStream(bytes, chunkSize = 7) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
      offset += chunkSize;
    },
  });
}

export function gzipToChunkedStream(gzBytes, chunkSize = 7) {
  return chunkedStream(gzBytes, chunkSize).pipeThrough(new DecompressionStream('gzip'));
}

export async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}