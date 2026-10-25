// Подсчёт строк: инкрементальный счётчик по чанкам + обход tar-архива.
import { scanTar } from './tar.js';
import { detectLanguage, LINE_COMMENTS } from './lang.js';
import { isIgnoredPath, looksBinary } from './ignore.js';

export const DEFAULT_COUNT_OPTIONS = {
  countBlankLines: true,
  countCommentLines: true,
  maxFileBytes: 5 * 1024 * 1024,
  ignoreDirs: true,
  extraIgnoreDirs: [],
};

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw fail('aborted', 'подсчёт отменён');
}

/**
 * Разбор текста на строки. Переводы строк: \n, \r\n и одиночный \r.
 * Неполная последняя строка без перевода строки тоже считается строкой;
 * пустой файл — 0 строк.
 */
class LineScanner {
  constructor(languageName, options = {}) {
    this.countBlankLines = options.countBlankLines !== false;
    this.countCommentLines = options.countCommentLines !== false;
    this.tokens = LINE_COMMENTS.get(languageName) || [];
    this.carry = '';
    this.lines = 0;
    this.blank = 0;
    this.comment = 0;
    this.code = 0;
  }

  addLine(text) {
    const trimmed = text.trim();
    const isBlank = trimmed.length === 0;
    const isComment =
      !isBlank && this.tokens.length > 0 && this.tokens.some((t) => trimmed.startsWith(t));
    if (isBlank) this.blank += 1;
    else if (isComment) this.comment += 1;
    else this.code += 1;
    const counted = !(isBlank && !this.countBlankLines) && !(isComment && !this.countCommentLines);
    if (counted) this.lines += 1;
  }

  push(text) {
    if (!text) return;
    const s = this.carry + text;
    // замыкающий \r может оказаться началом \r\n — отложим его до следующего чанка
    const limit = s.endsWith('\r') ? s.length - 1 : s.length;
    let i = 0;
    let start = 0;
    while (i < limit) {
      const ch = s.charCodeAt(i);
      if (ch === 10) {
        this.addLine(s.slice(start, i));
        i += 1;
        start = i;
      } else if (ch === 13) {
        this.addLine(s.slice(start, i));
        i += 1;
        if (i < limit && s.charCodeAt(i) === 10) i += 1;
        start = i;
      } else {
        i += 1;
      }
    }
    this.carry = s.slice(start);
  }

  end() {
    if (this.carry.length > 0) {
      this.addLine(this.carry);
      this.carry = '';
    }
    return { lines: this.lines, blank: this.blank, comment: this.comment, code: this.code };
  }
}

/** Инкрементальный счётчик строк для одного файла. */
export class LineCounter {
  constructor(languageName, options = {}) {
    this.languageName = languageName;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.scanner = new LineScanner(languageName, options);
    this.bytes = 0;
  }

  push(uint8) {
    if (!uint8 || !uint8.length) return;
    this.bytes += uint8.length;
    this.scanner.push(this.decoder.decode(uint8, { stream: true }));
  }

  end() {
    const tail = this.decoder.decode();
    if (tail) this.scanner.push(tail);
    const stats = this.scanner.end();
    return { ...stats, bytes: this.bytes };
  }
}

/** Подсчёт строк в готовой строке (для тестов и мелких нужд). */
export function countText(text, languageName, options = {}) {
  const counter = new LineCounter(languageName, options);
  counter.push(new TextEncoder().encode(String(text ?? '')));
  return counter.end();
}

function stripRoot(path) {
  const i = path.indexOf('/');
  return i < 0 ? '' : path.slice(i + 1);
}

/**
 * Считает строки по распакованному tar-потоку.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{options?:object, signal?:AbortSignal, onProgress?:Function}} [opts]
 */
export async function countTarball(stream, { options = {}, signal, onProgress } = {}) {
  const opts = { ...DEFAULT_COUNT_OPTIONS, ...options };
  const started = Date.now();

  let consumed = 0;
  const counting = stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        consumed += chunk.length;
        controller.enqueue(chunk);
      },
    }),
  );

  const perLanguage = Object.create(null);
  const skippedReasons = { ignored: 0, binary: 0, tooLarge: 0, nonFile: 0, unknown: 0 };
  let total = 0;
  let files = 0;
  let bytes = 0;
  let entries = 0;
  let skipped = 0;
  let truncated = false;
  let lastProgress = 0;

  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgress < 100) return;
    lastProgress = now;
    try {
      onProgress({ phase: 'parse', bytes: consumed, files, entries, total });
    } catch {
      /* прогресс не должен ломать подсчёт */
    }
  };

  try {
    await scanTar(
      counting,
      async (entry) => {
        entries += 1;
        throwIfAborted(signal);

        if (entry.type !== 'file') {
          skipped += 1;
          skippedReasons.nonFile += 1;
          report();
          return;
        }
        const rel = stripRoot(entry.path);
        if (!rel) {
          skipped += 1;
          skippedReasons.nonFile += 1;
          report();
          return;
        }
        if (opts.ignoreDirs !== false && isIgnoredPath(rel, { extraDirs: opts.extraIgnoreDirs })) {
          skipped += 1;
          skippedReasons.ignored += 1;
          report();
          return;
        }
        if (entry.size > opts.maxFileBytes) {
          skipped += 1;
          skippedReasons.tooLarge += 1;
          report();
          return;
        }

        const language = detectLanguage(rel);
        const head = new Uint8Array(Math.min(8192, entry.size));
        let headLen = 0;
        let fileBytes = 0;
        let decided = false;
        let counter = null;
        const buffered = [];

        const decide = () => {
          decided = true;
          if (looksBinary(head.subarray(0, headLen))) return;
          if (!language) return;
          counter = new LineCounter(language.name, opts);
          for (const chunk of buffered) counter.push(chunk);
          buffered.length = 0;
        };

        for await (const chunk of entry.body) {
          throwIfAborted(signal);
          fileBytes += chunk.length;
          if (headLen < head.length) {
            const take = Math.min(head.length - headLen, chunk.length);
            head.set(chunk.subarray(0, take), headLen);
            headLen += take;
          }
          if (!decided) {
            buffered.push(chunk);
            if (head.length > 0 && headLen >= head.length) decide();
            continue;
          }
          if (counter) counter.push(chunk);
          report();
        }
        if (!decided) decide();

        if (counter) {
          const stats = counter.end();
          const name = language.name;
          const bucket = (perLanguage[name] ??= {
            lines: 0, code: 0, blank: 0, comment: 0, files: 0, bytes: 0,
          });
          bucket.lines += stats.lines;
          bucket.code += stats.code;
          bucket.blank += stats.blank;
          bucket.comment += stats.comment;
          bucket.files += 1;
          bucket.bytes += fileBytes;
          total += stats.lines;
          files += 1;
          bytes += fileBytes;
        } else {
          skipped += 1;
          if (looksBinary(head.subarray(0, headLen))) skippedReasons.binary += 1;
          else skippedReasons.unknown += 1;
        }
        report();
      },
      { signal },
    );
  } catch (e) {
    if (e && e.code === 'truncated') truncated = true;
    else throw e;
  }

  report(true);
  return {
    total,
    files,
    bytes,
    perLanguage: { ...perLanguage },
    skipped,
    skippedReasons,
    entries,
    archiveBytes: consumed,
    truncated,
    ms: Date.now() - started,
  };
}