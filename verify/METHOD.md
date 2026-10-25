# METHOD — как устроен независимый оракул `verify/oracle.py`

Задача: получить **второе, независимое** мнение о числе строк кода в репозитории, чтобы
сравнивать с ним движок расширения (`src/loc/**`). Источник истины — **только текст
`SPEC.md`** (п.2.1 «определение языка», 2.2 «ignore», 2.3 «tar», 2.4 «семантика строк»)
плюс уточнения Lead'а от 25.10 (см. ниже).

> **Заявление о независимости.** Код `src/loc/**` при написании оракула не читался, не
> импортировался и не копировался. Оракул — Python 3 (stdlib: `tarfile`, `gzip`, `json`,
> `urllib`, `codecs`, `argparse`), движок — JS/ESM. Общий у них только текст SPEC.

---

## 1. Реализация правил SPEC

### 1.1 Потоковая распаковка (SPEC 2.3)
`tarfile.open(fileobj=…, mode="r|")` — режим потока без seek и без загрузки архива в
память. Сжатый поток обёрнут в `CountingReader` (считает сжатые байты и следит за
`maxArchiveMB`), распакованный — второй `CountingReader` (его показания и есть
`archiveBytes`). Разбор заголовков ustar/prefix, pax `x`/`g`, GNU LongLink `L`, base-256
размеров, padding до 512 и два нулевых блока выполняет stdlib `tarfile` — то есть
**независимая от движка реализация**; сверка с GNU tar подтвердила совпадение (см. §4.2).
Тело записи читается чанками (`--chunk-size`, по умолчанию 256 КиБ) и никогда не
буферизуется целиком.

### 1.2 `looksBinary` (SPEC 2.2)
`b"\x00" in head[:8192]` — первые 8192 байта записи. Файл, у которого язык определён
(напр. `.js`), но в первых 8192 Б есть NUL, уходит в `skippedReasons.binary` и **не
считается**. NUL после 8192-го байта бинарём не считается (ровно как в SPEC).

### 1.3 Определение языка (SPEC 2.1) — порядок шагов соблюдён буквально
1. basename (lower) ∈ `SPECIAL_FILENAMES` → язык (`makefile`, `dockerfile`, `go.mod`, …);
2. иначе расширение после последней `.` (lower) ∈ `LANGUAGE_TABLE` → язык
   (`index.d.ts` → `ts` → TypeScript);
3. иначе расширение ∈ `BINARY_EXTENSIONS` → `null`;
4. иначе расширение ∈ `TEXT_EXTENSIONS` → `Other`;
5. иначе (в т.ч. расширения нет вообще) → `null` → `skippedReasons.unknown`.

### 1.4 Семантика строк (SPEC 2.4) — построчный автомат
* переводы строк: `\n`, `\r\n`, одиночный `\r` — учитываются как **один** терминатор;
  хвостовой `\r` удерживается в состоянии (`carry_cr`), чтобы `\r` в конце чанка и `\n` в
  начале следующего не превратились в два перевода строки (проверено чтением по 1 байту);
* `lines` (raw) = число терминаторов + 1, если файл не пуст и не заканчивается
  терминатором; пустой файл → 0;
* `blank` — строки, у которых `trim()` пуст; `comment` — строки, у которых `trim()`
  начинается с одного из `LINE_COMMENTS[lang]` (только целые строчные комментарии);
* `code` — всё остальное, считается **всегда**; при дефолтных опциях
  `lines = blank + comment + code`;
* `countBlankLines:false` / `countCommentLines:false` убирают соответствующие строки
  из `lines`, но **не** из `blank`/`comment` и **не** из `code`;
* `trim()` реализован ровно как JS `String.prototype.trim()` (набор WhiteSpace +
  LineTerminator, включая `\u00a0`, `\u2028`, `\ufeff`). Python-овский `str.strip()` по
  умолчанию шире (режет ещё `\x1c`–`\x1f` и `\x85`), поэтому он **не** используется —
  иначе строки с `\x1c` считались бы пустыми вопреки JS-семантике;
* декодирование — потоковый UTF-8 с заменой (`codecs…('replace')`), как `TextDecoder`
  со `stream:true`; неверные байты → U+FFFD, счёт строк от этого не зависит.

### 1.5 Отбрасывание корня архива (SPEC 2.4)
Корень = первый компонент пути первой записи (`repo-ref`). У каждой записи он срезается;
записи вне корня считаются как есть, их число видно в `oracle.entriesOutsideRoot`.

### 1.6 Опции и результат
`--no-blank-lines` / `--no-comment-lines` = `countBlankLines:false` /
`countCommentLines:false`; `--max-file-bytes` = `maxFileBytes` (строго `>`, т.е. ровно
5 МиБ считается); `--max-archive-mb` = лимит по **сжатым** байтам (SPEC 3.3).
Итоговый JSON совпадает по ключам с `countTarball()`:
`total, files, bytes, perLanguage{lines,code,blank,comment,files,bytes}, skipped,
skippedReasons{ignored,binary,tooLarge,nonFile,unknown}, entries, archiveBytes, truncated, ms`.
Всё, что выходит за контракт, лежит в отдельном ключе `oracle` (диагностика: `unknownByExt`,
`compressedBytes`, `tarballRoot`, `ignoreProfile`, `truncError`, мета/commit из API).

**Уточнения Lead'а, уже учтённые (25.10):** `code` считается всегда; бакет
`skippedReasons.unknown` для файлов без определённого языка; `archiveBytes` = распакованные
байты; обрыв архива посреди записи не бросает исключение, а даёт частичный результат с
`truncated:true`.

Порядок классификации, принятый в оракуле (в SPEC не зафиксирован явно):
`ignored > nonFile > tooLarge > unknown > binary`. `skipped` = сумма всех пяти бакетов.

---

## 2. Фикстура `mini.tar.gz` — ручной леджер

Собирается `fixtures/build_mini.py` (детерминированно, `mtime=0`), 23 записи, корень
`mini-repo-abc123/`. Числа ниже посчитаны **вручную** и вписаны литералами в
`fixtures/expected.json`; байты сверены `len()` на литеральных строках.

| файл | язык | строк | пустых | комм. | кода | байт | решение |
|---|---|---|---|---|---|---|---|
| `src/main.py` (`import os`/`# comment`/`x = 1`/пусто/`print(x)`) | Python | 5 | 1 | 1 | 3 | 36 | считается |
| `src/empty.py` (0 Б) | Python | 0 | 0 | 0 | 0 | 0 | считается |
| `src/crlf.py` (`a = 1\r\nb = 2\rc = 3`) | Python | 3 | 0 | 0 | 3 | 18 | считается |
| `src/blanks.py` (`\n\n`) | Python | 2 | 2 | 0 | 0 | 2 | считается |
| `src/lib.rs` | Rust | 4 | 1 | 2 | 1 | 52 | считается |
| `lib/helper.js` | JavaScript | 4 | 0 | 1 | 3 | 40 | считается |
| `types/index.d.ts` | TypeScript | 1 | 0 | 0 | 1 | 24 | считается |
| `big/generated.js` (400×`const x = 1;`) | JavaScript | 400 | 0 | 0 | 400 | 5200 | `tooLarge` при лимите 2048 |
| `data/blob.js` (NUL) | JavaScript | — | — | — | — | 11 | `binary` |
| `src/vendor/lib.py` | — | — | — | — | — | 14 | `ignored` (IGNORE_DIRS `vendor`) |
| `package-lock.json` | — | — | — | — | — | 23 | `ignored` (IGNORE_FILES) |
| `web/app.min.js` | — | — | — | — | — | 22 | `ignored` (IGNORE_SUFFIXES `.min.js`) |
| `maps/app.js.map` | — | — | — | — | — | 14 | `ignored` (`.map`) |
| `node_modules/left-pad/index.js` | — | — | — | — | — | 20 | `ignored` |
| `node_modules/left-pad/package.json` | — | — | — | — | — | 19 | `ignored` |
| `LICENSE` (нет расширения) | — | — | — | — | — | 4 | `unknown` |
| `data/notes.xyz` | — | — | — | — | — | 12 | `unknown` |
| `assets/logo.png` (NUL, бинарное расширение) | — | — | — | — | — | 16 | `unknown` |
| `link.py` (symlink) | — | — | — | — | — | 0 | `nonFile` |
| `src/copy.py` (hardlink) | — | — | — | — | — | 0 | `nonFile` |
| `mini-repo-abc123/`, `src/`, `assets/` (3 каталога) | — | — | — | — | — | 0 | `nonFile` |

Итоги: **7 считанных файлов**, payload 172 Б, 19 строк при лимите `--max-file-bytes 2048`
(Python 10, JavaScript 4, Rust 4, TypeScript 1); `skipped`=16 =
`{ignored:6, binary:1, tooLarge:1, nonFile:5, unknown:3}`; `entries`=23;
`archiveBytes`=30720 (точный размер распакованного tar; `gzip.decompress` даёт то же число).

Контрольные прогоны (`fixtures/check_expected.py`, вывод — `raw/selfcheck-fixture.txt`):

| прогон | что проверяет | результат |
|---|---|---|
| A `--max-file-bytes 2048` | базовый леджер | 10/10 полей совпало |
| B без лимита | граница `tooLarge` (5200 Б считается, `total` 419) | 9/9 |
| C `--no-blank-lines --no-comment-lines` | `lines` падает до 11, `blank`/`comment`/`code` сохраняются | 9/9 |
| D `--chunk-size 1` | перенос `\r`/`\r\n` и UTF-8 через границы чанков | 9/9, числа = прогон A |
| E обрыв архива (3/4 файла) | `truncated:true`, без исключения | OK |
| F не-gzip (мусор) | `{ok:false, error.code:"unknown"}`, без трейсбека | OK |
| G `--max-archive-mb 0.0001` | лимит сжатого архива | `too_large`, rc=3 |
| H `--self-test` | 14 граничных случаев × (целиком + по 1 байту) = 28 проверок | 28/28 |

**Итого 46 проверок, 0 расхождений** (`raw/selfcheck-fixture.txt`).
Прогон G нашёл реальный баг оракула (лимит архива маскировался под «нечитаемый архив») —
исправлен; это иллюстрация того, что самопроверка не декоративная.

---

## 3. Прогоны на реальных публичных репозиториях

Команды (ref и commit зафиксированы, чтобы сверку можно было воспроизвести):

```
./verify/run-oracle.sh octocat/Spoon-Knife        # main @ d0dd1f61b33d
./verify/run-oracle.sh rust-lang/rustlings        # main @ bc8e51115c93
./verify/run-oracle.sh pallets/flask              # main @ d086db856be1
```

| репозиторий | ref@commit | total | files | payload | skipped | entries | сжатый/распакованный |
|---|---|---|---|---|---|---|---|
| octocat/Spoon-Knife | main@d0dd1f61b | 46 | 3 | 1 391 Б | 1 (nonFile) | 4 | 1 075 / 10 240 Б |
| rust-lang/rustlings | main@bc8e51115 | 15 734 | 290 | 515 444 Б | 81 | 371 | 157 323 / 808 960 Б |
| pallets/flask | main@d086db856 | 34 632 | 228 | 1 165 864 Б | 60 | 288 | 739 975 / 2 007 040 Б |

JSON — `out/<owner>__<repo>.json`, логи — `raw/oracle-<owner>__<repo>.log`,
сводка — `raw/real-repos-summary.txt`. Время: 0.2–0.5 с на репозиторий (Python, один поток).

### 3.1 Сверка с GitHub API `/languages` (независимый источник байтов)
Байты оракула по языкам против байтов, которые отдаёт сам GitHub:

* `octocat/Spoon-Knife`: HTML 355 = 355 ✔, CSS 256 = 256 ✔ (Markdown в API не попадает);
* `rust-lang/rustlings`: Rust 341 440 = 341 440 ✔, HTML 6 461 ✔, CSS 1 004 ✔,
  Shell 242 ✔, Just 93 ✔ — **пять из пяти совпали до байта**;
* `pallets/flask`: Python 588 784 против 565 106, HTML 10 474 против 405,
  CSS 1 714 против 18, Shell 165 против 193. Расхождение **объяснено и не является
  ошибкой оракула**: linguist исключает из статистики пути-документацию
  (`examples/`, `docs/`) и файлы, распознанные по shebang:
  `examples/*` HTML = 10 069 Б = разница по HTML; `examples/` + `docs/` Python =
  20 292 + 3 386 = 23 678 Б = разница по Python; `examples/tutorial/flaskr/static/style.css`
  = 1 696 Б = разница по CSS; API Shell 193 = 165 (`on-create-command.sh`) + 28
  (`tests/test_apps/.flaskenv`, файл без «настоящего» расширения, который SPEC 2.1 шаг 5
  велит не считать).

**Вывод для сверки:** числа расширения и виджета Languages в принципе не обязаны совпадать —
`/languages` считает по правилам linguist (без `docs/`, `examples/`, с shebang-детектом),
а SPEC 2.1/2.2 задают другую, более механическую модель. Поэтому в отчёте байты API
используются как **информационная** проверка порядка величин, а не как эталон равенства.

### 3.2 Сверка разбора tar с GNU tar
`rustlings`: оракул 371 запись, `tar tzvf` 371 запись; множества путей совпадают,
сумма payload 537 534 Б = 537 534 Б; считанные (515 444 Б) + пропущенные файлы
(22 090 Б) = весь payload. Протокол — `raw/tar-crosscheck-rustlings.txt`.

---

## 4. Где оракул МОЖЕТ РАСХОДИТЬСЯ с движком (честный список)

Это главный раздел для интерпретации расхождений: **не всякое расхождение = дефект
движка**, и наоборот.

1. **Таблиц в SPEC нет.** `LANGUAGE_TABLE`, `SPECIAL_FILENAMES`, `TEXT_EXTENSIONS`,
   `BINARY_EXTENSIONS`, `LINE_COMMENTS` заданы в SPEC только именами; их содержимое оракул
   написал сам (имена языков — как в GitHub Linguist, потому что UI сопоставляет их с
   текстом виджета Languages). Следствия:
   * разойдётся **разбивка по языкам** и попадание в `Other` (напр. `.md` у оракула
     `Markdown`; движок может отдать `Other` или вообще не считать);
   * разойдётся `comment` там, где наборы токенов не совпали (у оракула, например,
     JavaScript = `//`, CSS = ∅, HTML = `<!--`, Lua/Ada/Haskell = `--`, Clojure = `;`);
   * **`total` от этого почти не зависит** — он зависит от «текст/не текст», а это
     `LANGUAGE_TABLE` ∪ `TEXT_EXTENSIONS` против неизвестного списка движка.
   Обход: `python3 verify/oracle.py --dump-tables` — можно сопоставить таблицы напрямую
   с `src/loc/lang.js` и оценить вклад в расхождение.
2. **Ignore-списки в SPEC помечены как «минимум»** → у движка могут быть лишние записи.
   По умолчанию оракул использует **строго списки из SPEC** (`--ignore-profile spec`);
   профиль `--ignore-profile extended` добавляет очевидные кэш-каталоги
   (`.terraform`, `bazel-*`, …) и дополнительные lock-файлы. Если сверка «spec» даёт
   расхождение, а «extended» — нет, значит движок шире контракта (и это стоит зафиксировать
   в SPEC, а не считать багом).
3. **Порядок причин пропуска не зафиксирован.** Оракул: `ignored → nonFile → tooLarge →
   unknown → binary`. Если движок проверяет, например, `tooLarge` раньше `ignored`,
   разойдутся `skippedReasons` при совпадающем `total`. Для каталогов, попавших внутрь
   `node_modules`, у оракула причина `ignored`, а не `nonFile`.
4. **Бакет `unknown` против `binary`.** Оракул кладёт в `unknown` **все** файлы с
   неопределённым языком, включая `logo.png` (расширение из `BINARY_EXTENSIONS`), потому
   что `detectLanguage()` возвращает `null` и в том и в другом случае. Движок может
   отдельно проверять `BINARY_EXTENSIONS` и отправлять такие файлы в `binary`. Диагностика
   для разбора: `oracle.unknownByExt` и `oracle.unknownBinaryExtFiles`.
5. **`archiveBytes`.** Оракул = точное число байт, отданных распаковщиком (равно размеру
   распакованного tar, сверено с `gzip.decompress`). Движок считает то, что реально
   прочитала его обёртка; при буферизации с опережающим чтением возможна разница в
   пределах внутреннего буфера (единицы-десятки КиБ). Поле `oracle.archiveBytesNoPax`
   (512 + pad(size) на запись + 1024) — нижняя оценка без pax/GNU-заголовков; у codeload
   pax-заголовки есть всегда, поэтому `archiveBytes` ≈ 2×`noPax` для мелких архивов.
6. **`entries`.** Оракул считает каждую запись, включая каталоги (в реальных tar от
   codeload каталогов много: 52–79 на репозиторий). Если движок не считает каталоги или
   считает pax-заголовки отдельными записями, `entries` разойдётся — на `total` не влияет.
7. **`files` и пустые файлы.** Оракул считает пустой файл (0 строк) как считанный файл
   (в фикстуре `src/empty.py`). Если движок пропускает файлы нулевой длины до подсчёта,
   `files` будет меньше на число пустых файлов при том же `total`.
8. **Кодировки.** Оракул декодирует как UTF-8 с заменой (как `TextDecoder`). Для латинницы
   / UTF-16 счёт строк совпадёт (терминаторы ASCII), но `blank`/`comment` могут отличаться
   на экзотике; UTF-16 без BOM-детекта даст «одну строку» в обоих движках одинаково.
9. **`trim()`.** Оракул воспроизводит JS-набор; если движок использует `str.trim()` (в JS
   это и есть JS-набор) — совпадёт. Расхождение возможно только если движок делает
   `.trim()` после декодирования иначе (например, режет `\x0b` вручную).
10. **`truncated`.** Оракул: обрыв посреди записи → частичный результат, `truncated:true`;
    архив, из которого не удалось прочитать ни одной записи (не-gzip), — ошибка
    `{ok:false, code:"unknown"}`. Движок может на не-gzip отдать другой код (`network`/`unknown`).
11. **`ms`** не сравнивается (у оракула Python, у движка JS).
12. **Порядок ключей `perLanguage`** не значим (оракул сортирует по убыванию строк).

---

## 5. Как воспроизвести всё заново

```bash
cd github-loc/verify

python3 oracle.py --self-test                     # граничные случаи счётчика (28)
python3 fixtures/build_mini.py                    # собрать фикстуру (детерминированно)
python3 fixtures/check_expected.py                # 46 проверок против литеральных ожиданий
python3 oracle.py --dump-tables                   # таблицы оракула (для сверки с src/loc/lang.js)
python3 oracle.py --file fixtures/mini.tar.gz --max-file-bytes 2048 --trace /tmp/t.tsv

./run-oracle.sh octocat/Spoon-Knife               # → out/octocat__Spoon-Knife.json
./run-oracle.sh rust-lang/rustlings
./run-oracle.sh pallets/flask
./run-oracle.sh owner/repo main --ignore-profile extended --max-archive-mb 0
```

Сеть нужна только для реальных репозиториев; фикстура и `--self-test` работают офлайн.
Коды возврата: 0 — успех, 2 — сеть/HTTP, 3 — сжатый архив больше лимита, 4 — архив нечитаем.

## 6. Артефакты

| путь | что это |
|---|---|
| `verify/oracle.py` | оракул |
| `verify/run-oracle.sh` | обёртка прогона на репозитории → `verify/out/<owner>__<repo>.json` |
| `verify/fixtures/build_mini.py` | детерминированная сборка мини-архива |
| `verify/fixtures/expected.json` | литеральные ожидания (ручной подсчёт) |
| `verify/fixtures/check_expected.py` | прогон 8 сценариев и сверка с ожиданиями |
| `verify/raw/selfcheck-fixture.txt` | результат самопроверки (46/46) |
| `verify/raw/selfcheck-fixture-raw.json.txt` | сырые JSON всех прогонов самопроверки |
| `verify/raw/tar-crosscheck-rustlings.txt` | сверка с GNU tar |
| `verify/raw/real-repos-summary.txt` | сводка по 3 реальным репозиториям + сверка с API |
| `verify/out/*.json` | результаты оракула на реальных репозиториях |

Оракул намеренно **не** реализует `estimate.js` (оценку по байтам): `bytesPerLine` в SPEC
не задан (известен только fallback 30), поэтому независимая проверка оценки невозможна —
сравнивать оценку можно только с внутренней таблицей движка, а это уже не независимая проверка.