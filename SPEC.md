# SPEC (frozen interfaces) — расширение «GitHub LOC»

Цель: MV3-расширение для Chromium-браузеров (Chrome/Helium/Brave/Edge) + сборка для Firefox.
На странице репозитория GitHub под списком языков показывает **сколько всего строк кода** в репозитории.
Два режима: мгновенная **оценка** по байтам из GitHub API и **точный подсчёт** потоковым разбором
tarball из codeload (gzip → tar → построчный подсчёт), с прогрессом и кэшем.

**Этот файл — контракт. Менять его может только Lead.** Если нужен новый API — пиши Lead'у.

---

## 1. Файлы и владельцы (write scopes)

| Путь | Владелец |
|---|---|
| `SPEC.md`, `manifest.json`, `package.json`, `README.md`, `tools/**`, `src/icons/**` | Lead |
| `src/loc/**`, `tests/**` | engine |
| `src/background.js`, `src/content.js`, `src/content.css`, `src/popup.html`, `src/popup.js`, `src/popup.css` | ui |
| `verify/**` | verifier |

Правила кода: ESM (`import`/`export`), без внешних зависимостей, без сборки, без `eval`,
без `innerHTML` с внешними данными, только `textContent`/`createElement`. Node 24 может
импортировать файлы из `src/loc/**` напрямую (никаких chrome API в этой папке!).
Строки UI — по-русски. Логи с префиксом `[ghloc]`.
Исключение: `src/content.js` — классический content script, ES-импорты в нём недоступны,
поэтому локальные мини-копии `formatInt`/`formatCompact`/`plural` в нём разрешены и обязаны
совпадать по поведению с `src/loc/format.js`. Остальные файлы UI используют `src/loc/format.js`.

## 2. Движок `src/loc/**` (чистый ESM, работает в Node и в браузере)

### 2.1 `src/loc/lang.js`
```js
export const LANGUAGE_TABLE;      // Map<string ext без точки, {name, bpl}> ; ключи в нижнем регистре
export const SPECIAL_FILENAMES;   // Map<string basename в нижнем регистре, string name>
export const TEXT_EXTENSIONS;     // Set<string> — расширения, которые считаем текстовыми
export const BINARY_EXTENSIONS;   // Set<string> — картинки/шрифты/архивы/бинарники
export const LINE_COMMENTS;       // Map<string langName, string[]> — токены строчных комментариев
export function bytesPerLine(languageName);      // число (байт/строка), fallback 30
export function detectLanguage(relPath);         // -> {name, key, bpl} | null
```
`detectLanguage`:
1. basename в нижнем регистре есть в `SPECIAL_FILENAMES` → этот язык;
2. иначе расширение после последней `.` в нижнем регистре: `.d.ts` → `TypeScript`,
   `.min.js`/`.min.css` сюда не доходят (их режет ignore);
3. расширение в `LANGUAGE_TABLE` → соответствующий язык;
4. расширение в `BINARY_EXTENSIONS` → `null` (не считаем);
5. иначе, если расширение в `TEXT_EXTENSIONS` → `{name:'Other', ...}`; если расширения нет
   вообще → `null` (файлы без расширения, кроме `SPECIAL_FILENAMES`, не считаем);
6. иначе → `null`.

### 2.2 `src/loc/ignore.js`
```js
export const IGNORE_DIRS;        // string[] — сегменты пути в нижнем регистре
export const IGNORE_FILES;       // string[] — basename'ы в нижнем регистре
export const IGNORE_SUFFIXES;    // string[] — суффиксы файлов (.min.js, .map, .lock, ...)
export function isIgnoredPath(relPath);   // -> boolean (учитывает все три списка + пути с '/' в начале)
export function looksBinary(uint8);       // -> boolean: NUL-байт в первых 8192 байтах
export const DEFAULT_IGNORE_DIRS_EXTRA;   // string[] — пользовательские доп. сегменты (пусто)
```
`IGNORE_DIRS` минимум: `.git`, `.hg`, `.svn`, `node_modules`, `bower_components`, `vendor`,
`dist`, `build`, `out`, `target`, `venv`, `.venv`, `env`, `__pycache__`, `.mypy_cache`,
`.pytest_cache`, `.tox`, `.next`, `.nuxt`, `.svelte-kit`, `.cache`, `coverage`, `.gradle`,
`Pods`, `Carthage`, `DerivedData`, `third_party`, `thirdparty`, `external`, `deps`,
`.idea`, `.vscode`, `__snapshots__`, `site-packages`, `packages.lock`? (нет — это файл).
`IGNORE_FILES` минимум: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`,
`cargo.lock`, `composer.lock`, `gemfile.lock`, `poetry.lock`, `pipfile.lock`, `go.sum`,
`bun.lockb`, `uv.lock`, `flake.lock`, `packages.lock.json`, `.ds_store`, `thumbs.db`.
`IGNORE_SUFFIXES` минимум: `.min.js`, `.min.css`, `.map`, `.snap`, `.d.ts.map`, `.pyc`, `.pyo`.

### 2.3 `src/loc/tar.js`
```js
export async function scanTar(stream, onEntry, { signal } = {});
// stream: ReadableStream<Uint8Array> (уже распакованный gzip)
// onEntry({ path, size, type, body }) -> Promise<void>|void
//   path: string (без ведущего "/" , без "./")
//   size: number (байт полезной нагрузки)
//   type: 'file' | 'dir' | 'symlink' | 'other'
//   body: AsyncIterable<Uint8Array> — читать ТОЛЬКО внутри onEntry, ровно size байт
// Не вызвал body() — запись пропускается автоматически (обязательно дочитать до конца).
// Поддержать: заголовки ustar (prefix-поле 345..500), pax 'x'/'g' (запись `path=`),
// GNU LongLink 'L', base-256 (старший бит) в размере, padding до 512, два нулевых блока = конец.
// Бросает Error с .code='truncated' при обрыве потока посреди записи.
export class ByteReader;   // внутренний, экспортировать не обязательно
```
Требование: **не буферизовать файл целиком** — обёртка отдаёт чанки по мере чтения.

### 2.4 `src/loc/count.js`
```js
export function countText(text, languageName, options);   // -> {lines, blank, comment, code}
export class LineCounter {   // инкрементальный
  constructor(languageName, options);
  push(uint8);               // Uint8Array (декодирование внутри, TextDecoder streaming)
  end();                     // -> {lines, blank, comment, code, bytes}
}
export async function countTarball(stream, { options, signal, onProgress } = {});
// -> {
//   total, files, bytes,                    // total = сумма строк по языкам (после применения опций)
//   perLanguage: { [name]: {lines, code, blank, comment, files, bytes} },
//   skipped: number, skippedReasons: {ignored, binary, tooLarge, nonFile, unknown},
//   entries: number, archiveBytes: number (распакованные байты), truncated: boolean, ms: number
// Обрыв архива посреди записи: не бросать, вернуть частичный результат с truncated:true.
// Отмена через signal — бросать Error.code='aborted'.
// }
export const DEFAULT_COUNT_OPTIONS = { countBlankLines:true, countCommentLines:true,
  maxFileBytes: 5*1024*1024 };
```
Семантика строк (заморожено):
* переводы строк: `\n`, `\r\n`, одиночный `\r`;
* `lines` = число переводов строки + 1, если файл непустой и не заканчивается переводом строки;
  пустой файл → 0;
* `blank` — строки, у которых `trim()` пуст; `comment` — строки, у которых `trim()` начинается
  с одного из `LINE_COMMENTS[lang]` (только целые строчные комментарии, блочные не детектируем);
* `code` — строки, которые не пустые и не комментарии (считаются всегда, независимо от опций);
  при дефолтных опциях `lines === blank + comment + code`;
* `countBlankLines:false` → пустые строки не попадают в `lines` (в `blank` попадают);
* `countCommentLines:false` → строки-комментарии не попадают в `lines` (в `comment` попадают);
* файл > `maxFileBytes` → `skippedReasons.tooLarge`, не читается;
* `looksBinary` → `skippedReasons.binary`;
* `isIgnoredPath` → `skippedReasons.ignored`;
* symlink/dir → `skippedReasons.nonFile`;
* первый компонент пути (корень архива `repo-ref/`) отбрасывается;
* `perLanguage` создаётся только для встреченных языков; класть туда `Other` при необходимости;
* `onProgress({phase:'parse', bytes, files, entries})` вызывать не чаще 1 раза в 100 мс;
* `signal.aborted` → бросить `Error` с `.code='aborted'`;
* определение языка — по `detectLanguage(relPath)`, но финальное решение «текст/бинарь» — по
  `looksBinary` из первых чанков (до 8192 байт), т.е. файл с языком из таблицы, но с NUL —
  считается бинарём.

### 2.5 `src/loc/estimate.js`
```js
export function estimateLines(languageBytes, { bpl } = {});
// languageBytes: {Rust: 123456, Python: 2345} (байты из GET /repos/{o}/{r}/languages)
// -> { total, method:'estimate', perLanguage: { Rust: {lines, bytes, estimated:true}, ... } }
// lines = round(bytes / bytesPerLine(name)), минимум 1 для bytes>0; unknown язык -> bytesPerLine fallback
```

### 2.6 `src/loc/format.js`
```js
export function formatInt(n);       // 1234567 -> '1 234 567' (разделитель U+00A0)
export function formatCompact(n);   // 1234567 -> '1,2 млн'; 987654 -> '988 тыс.'; 999 -> '999'
export function plural(n, ['строка','строки','строк']);  // русская плюрализация
export function formatBytes(n);     // '1,2 МБ'
export function formatDuration(ms); // '2,3 с' / '1 мин 12 с'
export function repoFromPath(pathname);  // '/o/r/tree/dev/x' -> {owner,repo,ref:'dev'}; '/o/r' -> ref:null
export const RESERVED_OWNERS;       // Set<string> — служебные первые сегменты GitHub
```
`repoFromPath` возвращает `null` для: не-`/o/r` пути, зарезервированных первых сегментов
(`settings`, `orgs`, `marketplace`, `explore`, `topics`, `collections`, `sponsors`, `notifications`,
`new`, `login`, `join`, `features`, `about`, `pricing`, `security`, `enterprise`, `apps`,
`dashboard`, `pulls`, `issues`, `codesearch`, `search`, `users`, `account`, `organizations`,
`projects`, `stars`, `trending`, `events`, `gist`, `site`, `contact`, `git-lfs`, `assets`, `images`,
`static`, `favicon.ico`, `robots.txt`, `sitemap.xml`, `manifest.json`, `opensearch.xml`),
и для сегментов, начинающихся с `.` или `-`.

### 2.7 `src/loc/settings.js`
```js
export const DEFAULT_SETTINGS = {
  countBlankLines: true, countCommentLines: true, showPerLanguage: true, autoEstimate: true,
  maxArchiveMB: 120, maxFileMB: 5, token: '', debugTarballUrl: ''
};
export function normalizeSettings(raw);        // -> полный объект, чистит мусор/типы/границы
export function countOptionsFrom(settings);    // -> DEFAULT_COUNT_OPTIONS-совместимый объект
```

## 3. Протокол сообщений (ui ↔ ui; контракт для обоих концов)

`ext = globalThis.browser ?? globalThis.chrome` (промис-стиль в обоих браузерах).

### 3.1 Порт `'ghloc'` (content script ⇄ background)
Content → BG:
```js
{type:'hello'}                                          -> {type:'hello', settings}
{type:'estimate', owner, repo, ref}                     -> {type:'estimate', ok, method:'exact'|'estimate',
                                                            total, perLanguage, cached, meta:{default_branch,size_kb,private}}
{type:'count', owner, repo, ref, force:false}           -> серия {type:'progress', phase:'meta'|'download'|'parse',
                                                            bytes, total, files, message}
                                                           затем {type:'count', ok:true, result:{...как countTarball},
                                                            elapsedMs, cached:false, ref, commit}
                                                           либо  {type:'count', ok:false, error:{code, message}}
{type:'cancel'}                                         -> {type:'cancelled'}
{type:'settings', settings}                             -> {type:'settings', ok:true, settings}
```
`error.code` ∈ `not_found | private | rate_limit | too_large | network | aborted | unknown`.
Тексты `error.message` — готовые русские фразы для UI.
BG шлёт в порт и `{type:'log', message}` при отладке.

### 3.2 Одноразовые сообщения (popup → BG, `ext.runtime.sendMessage`)
```js
{type:'getSettings'}                    -> {ok:true, settings}
{type:'setSettings', settings}          -> {ok:true, settings}
{type:'clearCache'}                     -> {ok:true, removed}
{type:'cacheStats'}                     -> {ok:true, exact, estimate, meta, bytesApprox}
{type:'countActiveTab'}                 -> {ok:true} | {ok:false, error}
{type:'openUrl', url}                   -> {ok:true}   // только для ссылки на README
```

### 3.3 Ключи хранилища (`ext.storage.local`)
| Ключ | Значение | TTL |
|---|---|---|
| `ghloc.settings.v1` | объект настроек | — |
| `ghloc.meta.v1.<owner>/<repo>` | `{default_branch, size_kb, private, pushed_at, ts}` | 6 ч |
| `ghloc.est.v1.<owner>/<repo>@<ref>` | `{total, perLanguage, method, ts}` | 24 ч |
| `ghloc.loc.v1.<owner>/<repo>@<ref>` | `{result, ref, commit, ts}` | 7 сут |

Источники данных: `GET https://api.github.com/repos/{o}/{r}` (мета: `default_branch`, `size`,
`private`), `GET https://api.github.com/repos/{o}/{r}/languages` (байты по языкам),
tarball: публично `https://codeload.github.com/{o}/{r}/tar.gz/{ref}`,
с токеном — `https://api.github.com/repos/{o}/{r}/tarball/{ref}` + `Authorization: Bearer <token>`.
`ref` по умолчанию — `default_branch` из меты. Кэш-ключ использует `ref || default_branch`.
Rate limit 403/429 → `rate_limit`; 404 → `not_found` (если `private:true` → `private`).
Лимит `maxArchiveMB` считается по **сжатым** байтам на лету: превышение → `too_large`
(оценка остаётся доступной). API-запросы — с `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`, `signal` для отмены.
`debugTarballUrl` (непустой) подменяет URL tarball — только для автотестов.

## 4. Контракт DOM (content script)

* Матч: `https://github.com/*`, `run_at: document_idle`, без `all_frames`.
* Якорь: элемент `h3`/`h2`, чей `textContent.trim() === 'Languages'` (регистронезависимо),
  затем `closest('.BorderGrid-row')` (fallback: `parentElement`, затем `parentElement.parentElement`);
  внутри ищем `ul`. Не нашли — выходим тихо (и пробуем снова при следующей навигации).
* Панель: `<div class="ghloc-panel" data-ghloc="1">` вставляется **после** `ul` (или в конец якоря).
  Классы: `ghloc-panel`, `ghloc-row`, `ghloc-total`, `ghloc-btn`, `ghloc-progress`,
  `ghloc-progress-bar`, `ghloc-note`, `ghloc-error`, `ghloc-details`, `ghloc-lang-lines`, `ghloc-spinner`.
* Строки панели (русский):
  * оценка/кэш: `≈ 1 234 567 строк — оценка по байтам`; если точный кэш: `1 187 402 строки (точно, из кэша)`;
  * кнопки: `Точный подсчёт` / `Обновить` / `Отмена`;
  * прогресс: `Скачано 12,4 МБ · 1 234 файла`;
  * результат: `1 187 402 строки в 3 214 файлах` + `пропущено 210 (бинарные, vendored)` + `за 2,3 с`;
  * `Подробнее` → раскрывает per-language таблицу (язык — строк — файлов), сортировка по строкам.
* В каждый `li` списка языков (если `showPerLanguage`) добавляется
  `<span class="ghloc-lang-lines">` c `· 812 тыс. строк` (только когда есть данные по этому языку;
  сопоставление по имени языка из текста `li`, регистронезависимо, с `Other`).
* SPA: слушать `turbo:load`, `pjax:end`, `popstate` + `MutationObserver` на `body`
  (`subtree:true`, debounce 300 мс, не чаще одной перерисовки на URL, повторный mount только
  если панели нет). Никогда не бросать исключения в страницу: всё в try/catch.
* Стили — на CSS-переменных GitHub (`--fgColor-muted`, `--borderColor-muted`, `--bgColor-muted`,
  `--fgColor-accent`, `--borderColor-default`) с фолбэками, плюс `@media (prefers-color-scheme: dark)`.
  Не использовать `all: unset`, не влиять на чужие селекторы.

## 5. Проверка

* `npm test` → `node --test tests/` (движок, фикстуры генерируются в тесте).
* Lead: `node tools/e2e-browser.mjs` — headless Chromium с `--load-extension`, реальный
  github.com + фикстурный tarball через `debugTarballUrl`, плюс скриншот панели.
* verifier: независимый оракул (`verify/oracle.py` на Python + `tarfile`) и сверка чисел
  на реальном публичном репозитории; отчёт `verify/REPORT.md`.