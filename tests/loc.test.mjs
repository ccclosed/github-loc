import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countText, countTarball } from '../src/loc/count.js';
import { scanTar } from '../src/loc/tar.js';
import { detectLanguage, bytesPerLine } from '../src/loc/lang.js';
import { isIgnoredPath, looksBinary } from '../src/loc/ignore.js';
import { estimateLines } from '../src/loc/estimate.js';
import {
  formatInt, formatCompact, plural, formatBytes, formatDuration, repoFromPath,
} from '../src/loc/format.js';
import { DEFAULT_SETTINGS, normalizeSettings, countOptionsFrom } from '../src/loc/settings.js';
import { buildTar, buildTarGz, chunkedStream, gzipToChunkedStream } from './tar-writer.mjs';

// ---------------------------------------------------------------- семантика строк

test('строки: LF, отсутствие финального перевода, пустой файл', () => {
  assert.deepEqual(pick(countText('a\nb\nc', 'Text')), { lines: 3, blank: 0, comment: 0, code: 3 });
  assert.deepEqual(pick(countText('a\nb\nc\n', 'Text')), { lines: 3, blank: 0, comment: 0, code: 3 });
  assert.deepEqual(pick(countText('', 'Text')), { lines: 0, blank: 0, comment: 0, code: 0 });
  assert.deepEqual(pick(countText('\n', 'Text')), { lines: 1, blank: 1, comment: 0, code: 0 });
  assert.deepEqual(pick(countText('\n\n', 'Text')), { lines: 2, blank: 2, comment: 0, code: 0 });
});

test('строки: CRLF и одиночный CR', () => {
  assert.deepEqual(pick(countText('a\r\nb\r\n', 'Text')), { lines: 2, blank: 0, comment: 0, code: 2 });
  assert.deepEqual(pick(countText('a\rb', 'Text')), { lines: 2, blank: 0, comment: 0, code: 2 });
  assert.deepEqual(pick(countText('a\r', 'Text')), { lines: 1, blank: 0, comment: 0, code: 1 });
  assert.deepEqual(pick(countText('a\r\n\r\nb', 'Text')), { lines: 3, blank: 1, comment: 0, code: 2 });
});

test('строки: пустые и комментарии, опции', () => {
  const text = '# c\ncode\n\nother\n';
  const all = pick(countText(text, 'Python'));
  assert.deepEqual(all, { lines: 4, blank: 1, comment: 1, code: 2 });
  assert.deepEqual(pick(countText(text, 'Python', { countBlankLines: false })), {
    lines: 3, blank: 1, comment: 1, code: 2,
  });
  assert.deepEqual(pick(countText(text, 'Python', { countCommentLines: false })), {
    lines: 3, blank: 1, comment: 1, code: 2,
  });
  assert.deepEqual(
    pick(countText(text, 'Python', { countBlankLines: false, countCommentLines: false })),
    { lines: 2, blank: 1, comment: 1, code: 2 },
  );
});

test('строки: комментарий только если строка начинается с токена', () => {
  assert.deepEqual(pick(countText('x = 1  # не комментарий\n', 'Python')).comment, 0);
  assert.deepEqual(pick(countText('   // отступ и комментарий\n', 'Rust')).comment, 1);
  assert.deepEqual(pick(countText('# комментарий\n', 'Markdown')).comment, 0);
});

test('многобайтовый UTF-8 на границе чанков', () => {
  const bytes = new TextEncoder().encode('привет\nмир\n');
  const { LineCounter } = counterModule;
  const counter = new LineCounter('Text', {});
  counter.push(bytes.subarray(0, 3)); // рвём символ посередине
  counter.push(bytes.subarray(3, 10));
  counter.push(bytes.subarray(10));
  const stats = counter.end();
  assert.equal(stats.lines, 2);
  assert.equal(stats.code, 2);
});

// ---------------------------------------------------------------- языки и ignore

test('detectLanguage: расширения, особые имена, префиксы', () => {
  assert.equal(detectLanguage('src/main.rs').name, 'Rust');
  assert.equal(detectLanguage('a/b/c.PY').name, 'Python');
  assert.equal(detectLanguage('types/index.d.ts').name, 'TypeScript');
  assert.equal(detectLanguage('Dockerfile').name, 'Dockerfile');
  assert.equal(detectLanguage('docker/Dockerfile.dev').name, 'Dockerfile');
  assert.equal(detectLanguage('Makefile').name, 'Makefile');
  assert.equal(detectLanguage('GNUmakefile.in').name, 'Makefile');
  assert.equal(detectLanguage('CMakeLists.txt').name, 'CMake');
  assert.equal(detectLanguage('scripts/release.sh').name, 'Shell');
  assert.equal(detectLanguage('data.log').name, 'Other');
  assert.equal(detectLanguage('assets/logo.png'), null);
  assert.equal(detectLanguage('LICENSE'), null);
  assert.equal(detectLanguage('archive.tar'), null);
  assert.equal(detectLanguage(''), null);
  assert.equal(bytesPerLine('Rust') > 0, true);
  assert.equal(bytesPerLine('НеизвестныйЯзык'), 30);
});

test('isIgnoredPath: vendored, lock-файлы, минифицированное, .github не трогаем', () => {
  assert.equal(isIgnoredPath('node_modules/dep/index.js'), true);
  assert.equal(isIgnoredPath('src/vendor/lib.go'), true);
  assert.equal(isIgnoredPath('target/debug/x.rs'), true);
  assert.equal(isIgnoredPath('src/app.min.js'), true);
  assert.equal(isIgnoredPath('Cargo.lock'), true);
  assert.equal(isIgnoredPath('package-lock.json'), true);
  assert.equal(isIgnoredPath('.git/config'), true);
  assert.equal(isIgnoredPath('.github/workflows/ci.yml'), false);
  assert.equal(isIgnoredPath('src/main.rs'), false);
  assert.equal(isIgnoredPath('core/App.cs'), false);
  assert.equal(isIgnoredPath('', {}), true);
});

test('looksBinary: NUL в первых 8 КБ', () => {
  assert.equal(looksBinary(new Uint8Array([1, 2, 3])), false);
  assert.equal(looksBinary(new Uint8Array([1, 0, 3])), true);
  assert.equal(looksBinary(new Uint8Array(0)), false);
});

// ---------------------------------------------------------------- оценка и формат

test('estimateLines: байты -> строки, мусор игнорируется', () => {
  const est = estimateLines({ Rust: 3300, Python: 0, '': 500, Unknown: 300 });
  assert.equal(est.method, 'estimate');
  assert.equal(est.perLanguage.Rust.lines, 100);
  assert.equal(est.perLanguage.Rust.estimated, true);
  assert.equal(est.perLanguage.Unknown.lines, 10); // fallback 30 байт/строка
  assert.equal(est.perLanguage[''].lines, 17); // пустой ключ не ломает оценку
  assert.equal('Python' in est.perLanguage, false);
  assert.equal(est.total, 127); // 100 + 17 + 10
  assert.equal(estimateLines(null).total, 0);
  assert.equal(estimateLines({ Rust: 1 }).total, 1);
});

test('format: числа, компакт, плюрализация, байты, время', () => {
  assert.equal(formatInt(1234567), '1\u00A0234\u00A0567');
  assert.equal(formatInt(0), '0');
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1234567), '1,2\u00A0млн');
  assert.equal(formatCompact(987654), '988\u00A0тыс.');
  assert.equal(formatCompact(1500), '1,5\u00A0тыс.');
  assert.equal(formatBytes(512), '512\u00A0Б');
  assert.equal(formatBytes(1536), '1,5\u00A0КБ');
  assert.equal(formatBytes(12 * 1024 * 1024), '12\u00A0МБ');
  assert.equal(formatDuration(500), '500\u00A0мс');
  assert.equal(formatDuration(2300), '2,3\u00A0с');
  assert.equal(formatDuration(72000), '1\u00A0мин 12\u00A0с');
  assert.equal(plural(1, ['строка', 'строки', 'строк']), 'строка');
  assert.equal(plural(2, ['строка', 'строки', 'строк']), 'строки');
  assert.equal(plural(5, ['строка', 'строки', 'строк']), 'строк');
  assert.equal(plural(11, ['строка', 'строки', 'строк']), 'строк');
  assert.equal(plural(121, ['строка', 'строки', 'строк']), 'строка');
});

test('repoFromPath: обычные пути, ref, служебные пути', () => {
  assert.deepEqual(repoFromPath('/rust-lang/rust'), { owner: 'rust-lang', repo: 'rust', ref: null });
  assert.deepEqual(repoFromPath('/rust-lang/rust/tree/master/src/lib'), {
    owner: 'rust-lang', repo: 'rust', ref: 'master',
  });
  assert.deepEqual(repoFromPath('/o/r/blob/%D0%B2%D0%B5%D1%82%D0%BA%D0%B0/x.md'), {
    owner: 'o', repo: 'r', ref: 'ветка',
  });
  assert.deepEqual(repoFromPath('/octocat/Hello-World.git'), {
    owner: 'octocat', repo: 'Hello-World', ref: null,
  });
  assert.equal(repoFromPath('/settings/profile'), null);
  assert.equal(repoFromPath('/orgs/foo/repositories'), null);
  assert.equal(repoFromPath('/marketplace'), null);
  assert.equal(repoFromPath('/trending'), null);
  assert.equal(repoFromPath('/'), null);
  assert.equal(repoFromPath('/onlyone'), null);
  assert.equal(repoFromPath('/.github/profile'), null);
});

test('normalizeSettings: мусор на входе, границы значений', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  const dirty = normalizeSettings({
    countBlankLines: 'yes', countCommentLines: false, autoEstimate: 1,
    maxArchiveMB: 1e9, maxFileMB: -5, token: 42, debugTarballUrl: null, showPerLanguage: true,
  });
  assert.equal(dirty.countBlankLines, true); // не boolean -> дефолт
  assert.equal(dirty.countCommentLines, false);
  assert.equal(dirty.autoEstimate, true);
  assert.equal(dirty.maxArchiveMB, 4096); // клампится
  assert.equal(dirty.maxFileMB, 0.1);
  assert.equal(dirty.token, '');
  assert.equal(dirty.debugTarballUrl, '');
  const opts = countOptionsFrom({ maxFileMB: 2, countBlankLines: false });
  assert.equal(opts.maxFileBytes, 2 * 1024 * 1024);
  assert.equal(opts.countBlankLines, false);
  assert.equal(opts.ignoreDirs, true);
});

// ---------------------------------------------------------------- сквозной подсчёт

const RUST_MAIN = 'fn main() {\n    // привет\n\n    println!("x");\n}\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

const LONG_PREFIX = 'repo-main/' + 'd'.repeat(60);
  const PREFIX_ENTRY_PATH = `${LONG_PREFIX}/${'f'.repeat(80)}.rs`; // 149 символов: name+prefix

function fixtureEntries() {
  return [
    { path: 'repo-main/', type: '5' },
    { path: 'repo-main/src/main.rs', data: RUST_MAIN },
    { path: 'repo-main/src/util.py', data: '# comment\nx = 1\n' },
    { path: 'repo-main/README.md', data: '# Заголовок\n\nтекст\n' },
    { path: 'repo-main/.github/workflows/ci.yml', data: 'name: CI\non: push\n' },
    { path: 'repo-main/node_modules/dep/index.js', data: 'module.exports = 1;\n' },
    { path: 'repo-main/assets/logo.png', data: PNG },
    { path: 'repo-main/src/big.txt', data: 'x'.repeat(500) },
    { path: 'repo-main/notes.xyz', data: 'hello\n' },
    { path: 'repo-main/src/' + 'v'.repeat(200) + '.rs', data: '// c\n', longName: 'pax' },
    { path: 'repo-main/gnu/' + 'n'.repeat(150) + '.go', data: 'package main\n', longName: 'gnu' },
    { path: 'repo-main/src/base256.c', data: 'int x;\n', base256: true },
    // ustar-путь через prefix-поле (100..255 символов): name = basename, prefix = остальное
    {
      path: PREFIX_ENTRY_PATH.slice(LONG_PREFIX.length + 1),
      prefix: LONG_PREFIX,
      data: '// prefix test\nfn x() {}\n',
      expectPath: PREFIX_ENTRY_PATH,
    },
  ];
}

// ожидания посчитаны вручную:
//   main.rs  5 строк (blank 1, comment 1, code 3)
//   util.py  2 строки (comment 1, code 1)
//   README   3 строки (blank 1, code 2)
//   ci.yml   2 строки (code 2)
//   pax.rs   1 строка-комментарий (длинный путь через pax)
//   gnu.go   1 строка (GNU LongLink)
//   base256.c 1 строка (размер в base-256)
//   prefix.rs 2 строки (путь собран из ustar prefix-поля, 149 символов)
//   node_modules -> ignored, logo.png -> binary, big.txt -> tooLarge, notes.xyz -> unknown
const EXPECTED = {
  total: 17,
  files: 8,
  skipped: 5,
  skippedReasons: { ignored: 1, binary: 1, tooLarge: 1, nonFile: 1, unknown: 1 },
  perLanguage: {
    Rust: { lines: 8, code: 4, blank: 1, comment: 3, files: 3 },
    Python: { lines: 2, code: 1, comment: 1, files: 1 },
    Markdown: { lines: 3, code: 2, blank: 1, files: 1 },
    YAML: { lines: 2, code: 2, files: 1 },
    Go: { lines: 1, code: 1, files: 1 },
    C: { lines: 1, code: 1, files: 1 },
  },
};

test('countTarball: сквозной подсчёт фикстуры (мелкие чанки)', async () => {
  const gz = buildTarGz(fixtureEntries());
  const result = await countTarball(gzipToChunkedStream(gz, 7), {
    options: { maxFileBytes: 100 },
  });
  assert.equal(result.total, EXPECTED.total);
  assert.equal(result.files, EXPECTED.files);
  assert.equal(result.skipped, EXPECTED.skipped);
  assert.deepEqual(result.skippedReasons, EXPECTED.skippedReasons);
  assert.equal(result.truncated, false);
  assert.ok(result.archiveBytes > 0);
  assert.equal(result.entries, 13); // 13 записей архива, включая каталог

  for (const [name, expected] of Object.entries(EXPECTED.perLanguage)) {
    const bucket = result.perLanguage[name];
    assert.ok(bucket, `нет языка ${name}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(bucket[key], value, `${name}.${key}`);
    }
  }
});

test('countTarball: результат не зависит от размера чанков', async () => {
  const gz = buildTarGz(fixtureEntries());
  const small = await countTarball(gzipToChunkedStream(gz, 1), { options: { maxFileBytes: 100 } });
  const large = await countTarball(gzipToChunkedStream(gz, 65536), { options: { maxFileBytes: 100 } });
  assert.deepEqual(small.perLanguage, large.perLanguage);
  assert.equal(small.total, large.total);
  assert.equal(small.bytes, large.bytes);
  assert.equal(small.archiveBytes, large.archiveBytes);
});

test('countTarball: опции пустых строк и комментариев', async () => {
  const gz = buildTarGz(fixtureEntries());
  const noBlank = await countTarball(gzipToChunkedStream(gz), {
    options: { maxFileBytes: 100, countBlankLines: false },
  });
  assert.equal(noBlank.total, 15); // минус 1 пустая в Rust и 1 в Markdown
  const noComments = await countTarball(gzipToChunkedStream(gz), {
    options: { maxFileBytes: 100, countCommentLines: false },
  });
  assert.equal(noComments.total, 13); // минус 3 комментария в Rust и 1 в Python
});

test('countTarball: прогресс вызывается и не ломает подсчёт', async () => {
  const gz = buildTarGz(fixtureEntries());
  const seen = [];
  const result = await countTarball(gzipToChunkedStream(gz, 7), {
    options: { maxFileBytes: 100 },
    onProgress: (p) => {
      seen.push(p);
      if (seen.length === 1) throw new Error('UI упал — не должно ломать подсчёт');
    },
  });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].phase, 'parse');
  assert.equal(result.total, EXPECTED.total);
});

test('scanTar: pax и GNU longname дают полные пути', async () => {
  const tar = buildTar(fixtureEntries());
  const paths = [];
  await scanTar(chunkedStream(tar, 13), async (entry) => {
    paths.push(entry.path);
  });
  assert.ok(paths.includes(`repo-main/src/${'v'.repeat(200)}.rs`));
  assert.ok(paths.includes(`repo-main/gnu/${'n'.repeat(150)}.go`));
  assert.equal(paths.length, 13);
  assert.ok(paths.includes(PREFIX_ENTRY_PATH), 'путь из ustar prefix-поля потерян');
});

test('обрезанный архив: scanTar бросает truncated, countTarball возвращает частичный результат', async () => {
  const tar = buildTar([{ path: 'repo-main/big.rs', data: 'x'.repeat(1000) }]);
  const cut = tar.subarray(0, 512 + 100); // обрыв посреди данных файла
  await assert.rejects(
    () => scanTar(chunkedStream(cut, 64), async (entry) => {
      // потребим то, что успело прийти
      for await (const _ of entry.body) void _;
    }),
    (e) => e.code === 'truncated',
  );

  const gzCut = buildTarGz([{ path: 'repo-main/big.rs', data: 'x'.repeat(1000) }]);
  const truncatedTar = (await import('node:zlib')).gunzipSync(gzCut).subarray(0, 512 + 100);
  const gz = (await import('node:zlib')).gzipSync(truncatedTar);
  const result = await countTarball(gzipToChunkedStream(gz, 64), {});
  assert.equal(result.truncated, true);
});

test('отмена через AbortSignal', async () => {
  const gz = buildTarGz(fixtureEntries());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => countTarball(gzipToChunkedStream(gz), { signal: controller.signal }),
    (e) => e.code === 'aborted',
  );
});

test('countTarball: пустой архив — нули, без исключений', async () => {
  const gz = buildTarGz([]);
  const result = await countTarball(gzipToChunkedStream(gz), {});
  assert.equal(result.total, 0);
  assert.equal(result.files, 0);
  assert.deepEqual(result.perLanguage, {});
});

function pick(stats) {
  return { lines: stats.lines, blank: stats.blank, comment: stats.comment, code: stats.code };
}

const counterModule = await import('../src/loc/count.js');