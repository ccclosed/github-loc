// Потоковый парсер tar (ustar/pax/GNU). Файлы целиком в память не буферизуются:
// запись отдаётся в onEntry как async-итератор по чанкам, ровно size байт.
export const TAR_BLOCK = 512;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw fail('aborted', 'подсчёт отменён');
}

/** Читатель потока с возможностью «заглянуть» ровно n байт и пропустить кусок. */
export class ByteReader {
  constructor(stream) {
    if (!stream || typeof stream.getReader !== 'function') {
      throw fail('invalid', 'нужен ReadableStream<Uint8Array>');
    }
    this.reader = stream.getReader();
    this.buf = null;
    this.off = 0;
    this.ended = false;
    this.consumed = 0;
  }

  async fill() {
    if (this.buf && this.off < this.buf.length) return true;
    if (this.ended) return false;
    for (;;) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.ended = true;
        this.buf = null;
        this.off = 0;
        return false;
      }
      if (value && value.length) {
        this.buf = value;
        this.off = 0;
        this.consumed += value.length;
        return true;
      }
    }
  }

  /** Ровно n байт; при allowEof и пустом потоке — null. */
  async readExact(n, { allowEof = false } = {}) {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      if (!(await this.fill())) {
        if (allowEof && got === 0) return null;
        throw fail('truncated', 'архив обрезан');
      }
      const take = Math.min(n - got, this.buf.length - this.off);
      out.set(this.buf.subarray(this.off, this.off + take), got);
      this.off += take;
      got += take;
    }
    return out;
  }

  /** Следующий доступный кусок, не больше max байт (минимум 1 байт). */
  async nextChunk(max) {
    if (!(await this.fill())) return null;
    const take = Math.min(max, this.buf.length - this.off);
    const chunk = this.buf.subarray(this.off, this.off + take);
    this.off += take;
    return chunk;
  }

  async skip(n) {
    let left = n;
    while (left > 0) {
      if (!(await this.fill())) throw fail('truncated', 'архив обрезан');
      const take = Math.min(left, this.buf.length - this.off);
      this.off += take;
      left -= take;
    }
  }

  close() {
    try {
      this.reader.releaseLock();
    } catch {
      /* поток уже закрыт — не мешает */
    }
  }
}

const decoder = new TextDecoder('utf-8');

function readCString(bytes, from, to) {
  let end = from;
  while (end < to && bytes[end] !== 0) end++;
  if (end === from) return '';
  return decoder.decode(bytes.subarray(from, end));
}

/** Восьмеричное поле заголовка; поддержка base-256 (старший бит первого байта). */
function readNumeric(bytes, from, to) {
  if (bytes[from] & 0x80) {
    let value = 0;
    for (let i = from + 1; i < to; i++) value = value * 256 + bytes[i];
    return value;
  }
  let value = 0;
  let seen = false;
  for (let i = from; i < to; i++) {
    const c = bytes[i];
    if (c === 0 || c === 32) {
      if (seen) break;
      continue;
    }
    if (c < 48 || c > 55) continue;
    value = value * 8 + (c - 48);
    seen = true;
  }
  return value;
}

/** Разбор pax-записей вида "12 path=...\n". */
function parsePax(bytes) {
  const text = decoder.decode(bytes);
  const out = new Map();
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number.parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length + 1) break;
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

function normalizePath(p) {
  let path = String(p || '').replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (path.startsWith('/')) path = path.slice(1);
  return path.replace(/\/{2,}/g, '/');
}

function padding(size) {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}

function emptyBody() {
  return {
    [Symbol.asyncIterator]: () => (async function* nothing() {})(),
  };
}

/**
 * Обходит tar-поток.
 * @param {ReadableStream<Uint8Array>} stream уже распакованный поток
 * @param {(entry:{path:string,size:number,type:'file'|'dir'|'symlink'|'other',body:AsyncIterable<Uint8Array>}) => any} onEntry
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function scanTar(stream, onEntry, { signal } = {}) {
  const br = new ByteReader(stream);
  try {
    await walkTar(br, onEntry, signal);
    await drain(br, signal);
  } finally {
    br.close();
  }
}

/** Дочитывает хвост архива: нужен, чтобы счётчик прочитанных байт не зависел от размера чанков. */
async function drain(br, signal) {
  try {
    for (;;) {
      if (signal && signal.aborted) return;
      const chunk = await br.nextChunk(1 << 16);
      if (!chunk) return;
    }
  } catch {
    /* хвост архива уже не важен: содержимое разобрано */
  }
}

async function walkTar(br, onEntry, signal) {
  let pendingName = null;
  for (;;) {
      throwIfAborted(signal);
      const header = await br.readExact(TAR_BLOCK, { allowEof: true });
      if (!header) return;
      let onlyZeros = true;
      for (let i = 0; i < TAR_BLOCK; i++) {
        if (header[i] !== 0) {
          onlyZeros = false;
          break;
        }
      }
      if (onlyZeros) return;

      const nameField = readCString(header, 0, 100);
      // ustar: prefix занимает байты 345..499 (344 — это devminor из старого формата).
      const prefix = readCString(header, 345, 500);
      const size = Math.max(0, readNumeric(header, 124, 136) || 0);
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const pad = padding(size);
      const whole = size + pad;

      // Расширенные заголовки: pax ('x' — запись, 'g' — глобальная) и GNU LongName 'L'.
      if (typeflag === 'x' || typeflag === 'g') {
        const body = await br.readExact(size);
        await br.skip(pad);
        const records = parsePax(body);
        if (typeflag === 'x' && records.has('path')) pendingName = records.get('path');
        continue;
      }
      if (typeflag === 'L') {
        const body = await br.readExact(size);
        await br.skip(pad);
        pendingName = decoder.decode(body).replace(/\0+$/, '');
        continue;
      }
      if (typeflag === 'K') {
        await br.skip(whole);
        continue;
      }

      const rawName = pendingName || (prefix ? `${prefix}/${nameField}` : nameField);
      pendingName = null;
      const path = normalizePath(rawName);

      const kind =
        typeflag === '5' ? 'dir'
          : typeflag === '1' || typeflag === '2' ? 'symlink'
            : typeflag === '0' || typeflag === '\0' || typeflag === '' ? 'file'
              : 'other';

      if (kind !== 'file') {
        await br.skip(whole);
        await onEntry({ path, size, type: kind, body: emptyBody() });
        continue;
      }

      const state = { remaining: size };
      const body = {
        [Symbol.asyncIterator]: () => (async function* chunks() {
          while (state.remaining > 0) {
            throwIfAborted(signal);
            const chunk = await br.nextChunk(state.remaining);
            if (!chunk) throw fail('truncated', 'архив обрезан');
            state.remaining -= chunk.length;
            yield chunk;
          }
        })(),
      };

      let entryError = null;
      try {
        await onEntry({ path, size, type: 'file', body });
      } catch (e) {
        entryError = e;
      }
      // дочитываем то, что не потребил onEntry, и выравнивание до 512
      if (!entryError) {
        try {
          if (state.remaining > 0) await br.skip(state.remaining);
          await br.skip(pad);
        } catch (e) {
          if (e && e.code === 'aborted') throw e;
          if (e && e.code === 'truncated') throw e;
          entryError = e;
        }
      }
      if (entryError) throw entryError;
  }
}