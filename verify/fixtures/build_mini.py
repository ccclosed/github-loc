#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка ДЕТЕРМИНИРОВАННОГО мини-tar.gz для самопроверки оракула.

Фикстура собирается «руками» (никакого кода движка), состав и содержимое
подобраны так, чтобы ожидаемые числа можно было посчитать в уме/на бумаге.
Все ожидания — в expected.json, они вписаны ЛИТЕРАЛАМИ (не вычисляются скриптом),
иначе проверка была бы тавтологией.

Состав (23 записи) и ручной расчёт — в METHOD.md, таблица «Фикстура mini.tar.gz».

  python3 fixtures/build_mini.py            # → fixtures/mini.tar.gz + манифест
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = "mini-repo-abc123/"          # первый компонент = корень архива (отбрасывается)
OUT = os.path.join(HERE, "mini.tar.gz")
MANIFEST = os.path.join(HERE, "mini.manifest.json")

# ---------------------------------------------------------------------------------
# Содержимое файлов. Всё задано литералами: байты → строки считаются вручную.
# ---------------------------------------------------------------------------------
FILES = {
    # --- Python: 5 строк (1 пустая, 1 комментарий, 3 кода), 36 байт ---
    "src/main.py": b"import os\n# comment\nx = 1\n\nprint(x)\n",
    # пустой файл → 0 строк, но файл считается
    "src/empty.py": b"",
    # CRLF + одиночный CR → 3 строки кода, 15 байт
    "src/crlf.py": b"a = 1\r\nb = 2\rc = 3",
    # только переводы строк → 2 пустые строки
    "src/blanks.py": b"\n\n",
    # --- Rust: 4 строки (1 пустая, 2 комментария, 1 код), 48 байт ---
    "src/lib.rs": b"// crate docs\npub fn main() {}\n\n// trailing comment\n",
    # --- JavaScript: 4 строки (1 комментарий, 3 кода), 44 байта ---
    "lib/helper.js": b"// header\nfunction f() {\n  return 42;\n}\n",
    # --- TypeScript через .d.ts (SPEC 2.1 шаг 2) ---
    "types/index.d.ts": b"export const x: number;\n",
    # --- файл сверх лимита maxFileBytes=2048: 400 строк × 13 Б = 5200 Б ---
    "big/generated.js": b"const x = 1;\n" * 400,
    # --- «язык известен, но бинарь»: NUL в первых 8192 Б ---
    "data/blob.js": b"\x00\x01\x02binary\x00",
    # --- игнор: каталог vendor в середине пути ---
    "src/vendor/lib.py": b"x = 1\ny = 2\n",
    # --- игнор: IGNORE_FILES ---
    "package-lock.json": b'{"lockfileVersion": 3}\n',
    # --- игнор: IGNORE_SUFFIXES ---
    "web/app.min.js": b"!function(){var a=1}();\n",
    "maps/app.js.map": b'{"version":3}\n',
    # --- игнор: IGNORE_DIRS (node_modules) ---
    "node_modules/left-pad/index.js": b"module.exports = 1;\n",
    "node_modules/left-pad/package.json": b'{"name":"left-pad"}\n',
    # --- unknown: нет расширения ---
    "LICENSE": b"MIT\n",
    # --- unknown: неизвестное расширение ---
    "data/notes.xyz": b"hello\nworld\n",
    # --- unknown: известное БИНАРНОЕ расширение (SPEC 2.1 шаг 4) ---
    "assets/logo.png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 8,
}

# Записи-каталоги: проверяют skippedReasons.nonFile.
DIRS = ["", "src", "assets"]

# Симлинк и hardlink: SPEC 2.3 type='symlink'/'other' → nonFile.
SYMLINK = ("link.py", "src/main.py")
HARDLINK = ("src/copy.py", ROOT + "src/main.py")


def build() -> tuple[bytes, list[dict]]:
    raw = io.BytesIO()
    manifest: list[dict] = []
    with tarfile.open(fileobj=raw, mode="w") as tf:
        for d in DIRS:
            ti = tarfile.TarInfo(ROOT + d)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.mtime = 0
            tf.addfile(ti)
            manifest.append({"path": ROOT + d, "type": "dir", "size": 0})
        for rel in sorted(FILES):
            data = FILES[rel]
            ti = tarfile.TarInfo(ROOT + rel)
            ti.size = len(data)
            ti.mode = 0o644
            ti.mtime = 0
            tf.addfile(ti, io.BytesIO(data))
            manifest.append({"path": ROOT + rel, "type": "file", "size": len(data),
                             "sha256": hashlib.sha256(data).hexdigest()})
        ti = tarfile.TarInfo(ROOT + SYMLINK[0])
        ti.type = tarfile.SYMTYPE
        ti.linkname = SYMLINK[1]
        ti.mtime = 0
        tf.addfile(ti)
        manifest.append({"path": ROOT + SYMLINK[0], "type": "symlink",
                         "linkname": SYMLINK[1], "size": 0})
        ti = tarfile.TarInfo(ROOT + HARDLINK[0])
        ti.type = tarfile.LNKTYPE
        ti.linkname = HARDLINK[1]
        ti.mtime = 0
        tf.addfile(ti)
        manifest.append({"path": ROOT + HARDLINK[0], "type": "hardlink",
                         "linkname": HARDLINK[1], "size": 0})
    # Детерминированный gzip: mtime=0, без имени файла.
    gzbuf = io.BytesIO()
    gz = gzip.GzipFile(filename="", mode="wb", fileobj=gzbuf, mtime=0)
    gz.write(raw.getvalue())
    gz.close()
    return gzbuf.getvalue(), manifest


def main() -> int:
    data, manifest = build()
    with open(OUT, "wb") as f:
        f.write(data)
    meta = {
        "root": ROOT,
        "entries": len(manifest),
        "tarBytes": len(gzip.decompress(data)),
        "gzBytes": len(data),
        "gzSha256": hashlib.sha256(data).hexdigest(),
        "members": manifest,
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("собрано: %s (%d записей, tar=%d Б, gz=%d Б, sha256=%s)"
          % (OUT, len(manifest), meta["tarBytes"], meta["gzBytes"], meta["gzSha256"][:16]))
    return 0


if __name__ == "__main__":
    sys.exit(main())