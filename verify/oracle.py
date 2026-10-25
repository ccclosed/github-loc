#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ghloc verify oracle — НЕЗАВИСИМЫЙ подсчёт строк кода по tarball репозитория.

Источник истины — ТОЛЬКО текст SPEC.md (п.2.1, 2.2, 2.3, 2.4) и ничего больше.
Код движка src/loc/** не читался, не импортируется и не копируется: это принципиально,
иначе проверка «движок против оракула» выродилась бы в сравнение кода с самим собой.

Что делает:
  1. берёт tar.gz (codeload / api tarball / локальный файл / произвольный URL);
  2. потоково распаковывает (tarfile, режим 'r|gz' — без seek, без буферизации архива);
  3. отбрасывает первый компонент пути (корень архива repo-ref/);
  4. применяет ignore-правила (SPEC 2.2), определение языка (SPEC 2.1),
     семантику строк (SPEC 2.4);
  5. печатает JSON, совместимый по ключам с countTarball() из SPEC 2.4,
     плюс блок "oracle" с диагностикой (там же всё, что НЕ входит в контракт).

Запуск:
  python3 oracle.py octocat/Spoon-Knife                 # default_branch, сеть
  python3 oracle.py rust-lang/rustlings master
  python3 oracle.py --file fixtures/mini.tar.gz --max-file-bytes 2048
  python3 oracle.py --tarball-url http://127.0.0.1:8080/x.tar.gz

Только stdlib. Python >= 3.9 (проверено на 3.14.7).
"""

from __future__ import annotations

import argparse
import codecs
import gzip
import json
import os
import re
import sys
import tarfile
import time
import urllib.error
import urllib.request

ORACLE_VERSION = "1.0.0"

# =====================================================================================
# 1. ТАБЛИЦЫ
# -------------------------------------------------------------------------------------
# В SPEC 2.1/2.2 перечислены ИМЕНА констант и МИНИМАЛЬНЫЙ состав списков, но не полный
# состав таблиц движка. Значит таблицы оракула — независимая реализация, и это главный
# источник расхождений per-language (см. METHOD.md, раздел «Где оракул может разойтись»).
# Названия языков взяты как в GitHub Linguist — потому что UI сопоставляет их с текстом
# ссылок из виджета Languages, а тот приходит из linguist.
# =====================================================================================

# ext (без точки, lower) -> имя языка
LANGUAGE_TABLE = {
    # --- популярные ЯП ---
    "js": "JavaScript", "mjs": "JavaScript", "cjs": "JavaScript", "jsx": "JavaScript",
    "ts": "TypeScript", "mts": "TypeScript", "cts": "TypeScript", "tsx": "TypeScript",
    "py": "Python", "pyi": "Python", "pyw": "Python",
    "rs": "Rust",
    "go": "Go",
    "java": "Java",
    "kt": "Kotlin", "kts": "Kotlin",
    "c": "C", "h": "C",
    "cpp": "C++", "cc": "C++", "cxx": "C++", "c++": "C++", "hpp": "C++", "hh": "C++",
    "hxx": "C++", "h++": "C++", "ipp": "C++", "inl": "C++",
    "cs": "C#", "csx": "C#",
    "rb": "Ruby", "rake": "Ruby", "gemspec": "Ruby",
    "php": "PHP", "php3": "PHP", "php4": "PHP", "php5": "PHP", "phtml": "PHP",
    "swift": "Swift",
    "m": "Objective-C", "mm": "Objective-C",
    "scala": "Scala", "sc": "Scala", "sbt": "Scala",
    "sh": "Shell", "bash": "Shell", "zsh": "Shell", "ksh": "Shell", "fish": "Shell",
    "ps1": "PowerShell", "psm1": "PowerShell", "psd1": "PowerShell",
    "lua": "Lua",
    "pl": "Perl", "pm": "Perl", "t": "Perl",
    "r": "R", "rmd": "R",
    "dart": "Dart",
    "ex": "Elixir", "exs": "Elixir",
    "erl": "Erlang", "hrl": "Erlang",
    "hs": "Haskell", "lhs": "Haskell",
    "clj": "Clojure", "cljs": "Clojure", "cljc": "Clojure", "edn": "Clojure",
    "ml": "OCaml", "mli": "OCaml",
    "fs": "F#", "fsi": "F#", "fsx": "F#",
    "elm": "Elm",
    "nim": "Nim", "nims": "Nim",
    "zig": "Zig",
    "v": "V", "vh": "V",
    "jl": "Julia",
    "groovy": "Groovy", "gradle": "Groovy",
    "gd": "GDScript",
    "asm": "Assembly", "s": "Assembly", "nasm": "Assembly",
    "vb": "Visual Basic .NET", "vbs": "VBScript",
    "pas": "Pascal", "pp": "Pascal",
    "cbl": "COBOL", "cob": "COBOL",
    "f": "Fortran", "f77": "Fortran", "f90": "Fortran", "f95": "Fortran", "for": "Fortran",
    "sol": "Solidity",
    "tcl": "Tcl",
    "awk": "Awk",
    "pro": "Prolog",
    "cr": "Crystal",
    "hx": "Haxe",
    "vala": "Vala",
    "d": "D",
    "raku": "Raku", "p6": "Raku",
    "ada": "Ada", "adb": "Ada", "ads": "Ada",
    "matlab": "MATLAB",
    # --- web / разметка / стили ---
    "html": "HTML", "htm": "HTML", "xhtml": "HTML",
    "css": "CSS",
    "scss": "SCSS",
    "sass": "Sass",
    "less": "Less",
    "vue": "Vue",
    "svelte": "Svelte",
    "astro": "Astro",
    "svg": "SVG",
    "xml": "XML", "xsl": "XSLT", "xslt": "XSLT", "xsd": "XML", "wsdl": "XML",
    "plist": "XML", "xaml": "XAML", "resx": "XML", "csproj": "XML", "props": "XML",
    "targets": "XML", "vcxproj": "XML", "storyboard": "XML", "xib": "XML",
    # --- данные / конфиги ---
    "json": "JSON", "jsonc": "JSON", "json5": "JSON", "geojson": "JSON",
    "ipynb": "Jupyter Notebook",
    "yml": "YAML", "yaml": "YAML",
    "toml": "TOML",
    "ini": "INI", "cfg": "INI", "conf": "INI", "properties": "INI",
    "sql": "SQL",
    "graphql": "GraphQL", "gql": "GraphQL",
    "proto": "Protocol Buffer",
    "tf": "HCL", "tfvars": "HCL", "hcl": "HCL",
    "nix": "Nix",
    "cmake": "CMake",
    "bat": "Batchfile", "cmd": "Batchfile",
    "tex": "TeX", "sty": "TeX", "cls": "TeX", "bib": "BibTeX",
    "md": "Markdown", "markdown": "Markdown", "mdown": "Markdown", "mkd": "Markdown",
    "rst": "reStructuredText",
    "adoc": "AsciiDoc", "asciidoc": "AsciiDoc",
    "haml": "Haml", "slim": "Slim", "liquid": "Liquid",
    "erb": "HTML+ERB",
    "cshtml": "HTML+Razor", "razor": "HTML+Razor",
    "prisma": "Prisma",
    "rego": "Open Policy Agent",
    "cue": "CUE",
    "wat": "WebAssembly",
    "ron": "RON",
    "diff": "Diff", "patch": "Diff",
    "po": "Gettext Catalog", "pot": "Gettext Catalog",
    "desktop": "Desktop Entry", "service": "Desktop Entry",
    "gitignore": "Ignore List", "gitattributes": "Git Attributes",
    "gitmodules": "Git Config", "editorconfig": "EditorConfig",
    "npmrc": "INI", "env": "Dotenv",
}

# basename (lower) -> имя языка; проверяется ДО расширения (SPEC 2.1 шаг 1)
SPECIAL_FILENAMES = {
    "makefile": "Makefile", "gnumakefile": "Makefile", "makefile.am": "Makefile",
    "makefile.in": "Makefile", "bsdmakefile": "Makefile",
    "dockerfile": "Dockerfile", "containerfile": "Dockerfile",
    "rakefile": "Ruby", "gemfile": "Ruby", "guardfile": "Ruby", "podfile": "Ruby",
    "brewfile": "Ruby", "vagrantfile": "Ruby", "berksfile": "Ruby",
    "cmakelists.txt": "CMake",
    "jenkinsfile": "Groovy",
    "procfile": "Procfile",
    "justfile": "Just", "justfile.md": "Just",
    "go.mod": "Go", "go.sum": "Go",
    "cargo.lock": "TOML",  # перекрывается ignore-списком, оставлено для полноты
    "pipfile": "TOML",
    "meson.build": "Meson",
    "build.bazel": "Starlark", "workspace.bazel": "Starlark", "build": "Starlark",
    "flake.nix": "Nix",
    "gradlew": "Shell", "mvnw": "Shell",
}

# SPEC 2.2: расширения-бинарники. ВАЖНО: проверяются ПОСЛЕ LANGUAGE_TABLE.
BINARY_EXTENSIONS = {
    # картинки
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "avif", "heic",
    "heif", "psd", "ai", "eps", "indd", "raw", "cr2", "nef", "dng",
    # шрифты
    "woff", "woff2", "ttf", "otf", "eot", "pfb",
    # архивы / упаковка
    "zip", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "lz4", "7z", "rar", "tar",
    "jar", "war", "ear", "aar", "apk", "ipa", "deb", "rpm", "msi", "dmg", "iso", "img",
    "crx", "xpi", "nupkg", "whl", "egg", "gem", "crate",
    # бинарники / объектники
    "exe", "dll", "so", "dylib", "o", "obj", "a", "lib", "bin", "class", "pyc", "pyo",
    "pyd", "wasm", "elf", "out", "ko", "lo", "la", "dSYM", "jnilib", "node",
    # документы
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
    "mobi", "rtf",
    # медиа
    "mp3", "mp4", "m4a", "m4v", "avi", "mov", "mkv", "webm", "ogg", "oga", "ogv",
    "wav", "flac", "aac", "wma", "wmv", "flv", "opus", "mid", "midi",
    # базы / прочее
    "sqlite", "sqlite3", "db", "mdb", "pack", "idx", "dat", "blob", "pdb", "nib",
    "keystore", "jks", "p12", "pfx", "der", "cer", "crt", "key",
}

# SPEC 2.1 шаг 5: расширения, которые считаем текстом -> язык "Other".
TEXT_EXTENSIONS = {
    "txt", "text", "log", "csv", "tsv", "psv", "tab", "lst", "out",
    "tpl", "tmpl", "template", "ejs", "hbs", "handlebars", "mustache", "pug", "jade",
    "njk", "twig", "j2", "jinja", "jinja2", "mako", "eta",
    "rss", "atom", "map.json", "lock", "sum", "mod",
    "dockerignore", "npmignore", "eslintignore", "prettierignore", "babelrc",
    "eslintrc", "prettierrc", "stylelintrc", "swcrc", "browserslistrc", "nvmrc",
    "terraformrc", "clang-format", "clang-tidy", "flake8", "pylintrc", "coveragerc",
    "sqlfluff", "rubocop", "rspec", "tool-versions", "python-version",
    "dot", "gv", "puml", "plantuml", "mmd", "drawio",
    "txt2", "nfo", "readme", "license", "authors", "contributors", "notice",
    "history", "changelog", "changes", "todo", "version", "manifest",
    "strings", "stringsdict", "xcstrings", "arb",
    "htaccess", "htpasswd", "url", "webloc", "lnk", "reg",
    "mailmap", "mailmap.txt", "gitkeep", "keep", "bak", "orig", "rej",
    "zshrc", "bashrc", "bash_profile", "profile", "bash_history",
    "ttl", "nt", "rdf", "owl", "sparql", "n3",
    "srt", "vtt", "ass", "sub",
    "yaml.tmpl", "yml.tmpl", "sh.tmpl", "ps1.tmpl",
    "in", "am", "ac", "m4", "spec", "spec.ts", "spec.js", "test",
    "mk", "mak", "make", "ninja", "gyp", "gypi", "gn", "gni",
    "pem", "pub", "asc", "sig", "gpg", "sha256", "sha1", "md5",
    "cabal", "opam", "gemfile", "podspec", "nuspec", "csproj.user",
    "editorconfig2", "prettierrc.json", "eslintrc.json",
}

# SPEC 2.2: IGNORE_DIRS — сегменты пути (lower). Строго по тексту SPEC («минимум»).
IGNORE_DIRS_SPEC = [
    ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor", "dist",
    "build", "out", "target", "venv", ".venv", "env", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".tox", ".next", ".nuxt", ".svelte-kit", ".cache", "coverage",
    ".gradle", "pods", "carthage", "deriveddata", "third_party", "thirdparty",
    "external", "deps", ".idea", ".vscode", "__snapshots__", "site-packages",
]

# Осознанно ЗА ПРЕДЕЛАМИ SPEC. Не используется по умолчанию (профиль spec):
# включается только через --ignore-profile extended, чтобы не выдумывать правила,
# которых в контракте нет. Список намеренно консервативный: только заведомо
# сгенерированные/кэшевые каталоги (никаких packages/, bin/, libs/, obj/ — в них
# часто лежит настоящий исходник).
IGNORE_DIRS_EXTRA = [
    ".terraform", ".serverless", ".parcel-cache", ".turbo", ".nx", ".yarn",
    ".pnpm-store", ".eggs", "htmlcov", "buck-out", "bazel-bin", "bazel-out",
    "bazel-testlogs", ".dart_tool", ".pub-cache", ".stack-work", "jspm_packages",
    ".bundle", ".git-rewrite", ".svn-base",
]

# SPEC 2.2: IGNORE_FILES — basename (lower), строго по тексту SPEC.
IGNORE_FILES_SPEC = [
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
    "cargo.lock", "composer.lock", "gemfile.lock", "poetry.lock", "pipfile.lock",
    "go.sum", "bun.lockb", "uv.lock", "flake.lock", "packages.lock.json",
    ".ds_store", "thumbs.db",
]

IGNORE_FILES_EXTRA = [
    "bun.lock", "gradle.lockfile", "paket.lock", "mix.lock", "pubspec.lock",
]

# SPEC 2.2: IGNORE_SUFFIXES — суффиксы basename (lower), строго по тексту SPEC.
IGNORE_SUFFIXES_SPEC = [
    ".min.js", ".min.css", ".map", ".snap", ".d.ts.map", ".pyc", ".pyo",
]

IGNORE_SUFFIXES_EXTRA = [
    ".min.mjs", ".min.cjs", ".bundle.js", ".bundle.css", ".js.min", ".css.min",
]

IGNORE_PROFILE = "spec"
IGNORE_DIRS = list(IGNORE_DIRS_SPEC)
IGNORE_FILES = list(IGNORE_FILES_SPEC)
IGNORE_SUFFIXES = list(IGNORE_SUFFIXES_SPEC)
IGNORE_DIRS_SET = {d.lower() for d in IGNORE_DIRS}
IGNORE_FILES_SET = {f.lower() for f in IGNORE_FILES}
IGNORE_SUFFIXES_T = tuple(s.lower() for s in IGNORE_SUFFIXES)


def apply_ignore_profile(profile: str) -> None:
    """'spec' — строго списки из SPEC 2.2; 'extended' — + явные кэш-каталоги/локи."""
    global IGNORE_PROFILE, IGNORE_DIRS, IGNORE_FILES, IGNORE_SUFFIXES
    global IGNORE_DIRS_SET, IGNORE_FILES_SET, IGNORE_SUFFIXES_T
    if profile == "extended":
        IGNORE_DIRS = IGNORE_DIRS_SPEC + IGNORE_DIRS_EXTRA
        IGNORE_FILES = IGNORE_FILES_SPEC + IGNORE_FILES_EXTRA
        IGNORE_SUFFIXES = IGNORE_SUFFIXES_SPEC + IGNORE_SUFFIXES_EXTRA
    else:
        IGNORE_DIRS = list(IGNORE_DIRS_SPEC)
        IGNORE_FILES = list(IGNORE_FILES_SPEC)
        IGNORE_SUFFIXES = list(IGNORE_SUFFIXES_SPEC)
    IGNORE_PROFILE = profile
    IGNORE_DIRS_SET = {d.lower() for d in IGNORE_DIRS}
    IGNORE_FILES_SET = {f.lower() for f in IGNORE_FILES}
    IGNORE_SUFFIXES_T = tuple(s.lower() for s in IGNORE_SUFFIXES)

# SPEC 2.4: LINE_COMMENTS[langName] — токены СТРОЧНЫХ комментариев.
# Пустой список = язык есть, строчных комментариев не детектируем.
LINE_COMMENTS = {
    "Python": ("#",), "Ruby": ("#",), "Shell": ("#",), "Perl": ("#",), "R": ("#",),
    "Makefile": ("#",), "CMake": ("#",), "YAML": ("#",), "TOML": ("#",), "INI": ("#",),
    "Dockerfile": ("#",), "HCL": ("#",), "Nim": ("#",), "Julia": ("#",),
    "Elixir": ("#",), "PowerShell": ("#",), "Dotenv": ("#",), "Ignore List": ("#",),
    "Git Attributes": ("#",), "Git Config": ("#",), "EditorConfig": ("#",),
    "Jupyter Notebook": ("#",), "Nix": ("#",), "Just": ("#",), "RON": ("#",),
    "Gettext Catalog": ("#",), "Procfile": ("#", "//"), "Meson": ("#",),
    "Starlark": ("#",), "CUE": ("#",), "Open Policy Agent": ("#",),
    "Desktop Entry": ("#",), "Awk": ("#",), "Tcl": ("#",),
    "JavaScript": ("//",), "TypeScript": ("//",), "Java": ("//",), "C": ("//",),
    "C++": ("//",), "C#": ("//",), "Go": ("//",), "Rust": ("//",), "Kotlin": ("//",),
    "Swift": ("//",), "Scala": ("//",), "PHP": ("//",), "Dart": ("//",),
    "Groovy": ("//",), "Less": ("//",), "SCSS": ("//",), "Sass": ("//",),
    "Objective-C": ("//",), "JSON": ("//",), "V": ("//",), "Zig": ("//",),
    "Solidity": ("//",), "Crystal": ("//",), "Haxe": ("//",), "Vala": ("//",),
    "D": ("//",), "GDScript": ("#",), "F#": ("//",), "Visual Basic .NET": ("'",),
    "Lua": ("--",), "SQL": ("--",), "Haskell": ("--",), "Elm": ("--",), "Ada": ("--",),
    "VBScript": ("'",), "Fortran": ("!",), "MATLAB": ("%",), "TeX": ("%",),
    "BibTeX": ("%",), "Erlang": ("%",), "Prolog": ("%",), "Raku": ("#",),
    "Assembly": (";", "#"), "Batchfile": ("::", "rem "), "Pascal": ("//",),
    "COBOL": ("*",), "HTML": ("<!--",), "XML": ("<!--",), "SVG": ("<!--",),
    "Vue": ("<!--", "//"), "Svelte": ("<!--", "//"), "Astro": ("<!--", "//"),
    "XAML": ("<!--",), "XSLT": ("<!--",), "Markdown": (), "CSS": (),
    "reStructuredText": ("..",), "AsciiDoc": ("//",), "Diff": (), "SVG ": (),
    "HTML+ERB": ("<%#",), "HTML+Razor": ("@*",), "Liquid": (), "Haml": ("-#",),
    "Slim": ("/",), "Clojure": (";",), "OCaml": (), "Puppet": ("#",),
}

# JS String.prototype.trim(): WhiteSpace + LineTerminator. Именно этот набор, а НЕ
# python-str.strip() по умолчанию (тот дополнительно режет \x1c-\x1f и \x85).
JS_TRIM_CHARS = (
    "\t\n\v\f\r \u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

HEAD_BYTES = 8192  # SPEC 2.2: looksBinary смотрит первые 8192 байта


# =====================================================================================
# 2. ПРАВИЛА (SPEC 2.1, 2.2)
# =====================================================================================

def normalize_rel_path(path: str) -> str:
    """SPEC 2.3: путь без ведущего '/' и без './'."""
    p = path.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    return p


def detect_language(rel_path: str):
    """SPEC 2.1 detectLanguage(relPath) -> имя языка | None (порядок шагов важен)."""
    base = normalize_rel_path(rel_path).rsplit("/", 1)[-1].lower()
    if base in SPECIAL_FILENAMES:                     # 1
        return SPECIAL_FILENAMES[base]
    i = base.rfind(".")                               # 2
    if i < 0:
        return None                                   # 5b: расширения нет -> не считаем
    ext = base[i + 1:]
    if not ext:
        return None
    if ext in LANGUAGE_TABLE:                         # 3
        return LANGUAGE_TABLE[ext]
    if ext in BINARY_EXTENSIONS:                      # 4
        return None
    if ext in TEXT_EXTENSIONS:                        # 5a
        return "Other"
    return None                                       # 6


def is_ignored_path(rel_path: str, is_dir: bool = False) -> bool:
    """SPEC 2.2 isIgnoredPath(relPath). Учитывает IGNORE_DIRS/FILES/SUFFIXES.

    is_dir=True (запись-каталог) — последний сегмент тоже проверяется как каталог.
    Для файлов последний сегмент проверяется только по IGNORE_FILES/IGNORE_SUFFIXES
    (файл с именем 'vendor' игнорировать как каталог не будем).
    """
    p = normalize_rel_path(rel_path).lower()
    if not p:
        return False
    parts = [s for s in p.split("/") if s not in ("", ".")]
    if not parts:
        return False
    base = parts[-1]
    if base in IGNORE_FILES_SET:
        return True
    if base.endswith(IGNORE_SUFFIXES_T):
        return True
    dirs = parts[:-1]
    if is_dir:
        dirs = parts
    for d in dirs:
        if d in IGNORE_DIRS_SET:
            return True
    return False


def looks_binary(head: bytes) -> bool:
    """SPEC 2.2 looksBinary: NUL-байт в первых 8192 байтах."""
    return b"\x00" in head[:HEAD_BYTES]


# =====================================================================================
# 3. СЧЁТЧИК СТРОК (SPEC 2.4) — инкрементальный, без буферизации файла целиком
# =====================================================================================

class LineCounter:
    """Инкрементальный счётчик. Декодирование — потоковым UTF-8 (как TextDecoder).

    Состояние: fragments — куски текущей незавершённой строки; carry_cr — во входе
    только что был '\r', который может оказаться частью '\r\n' на границе чанков.
    """

    __slots__ = ("tokens", "count_blank", "count_comment", "decoder", "fragments",
                 "carry_cr", "lines_raw", "blank", "comment", "code", "bytes")

    def __init__(self, lang_name: str, count_blank: bool = True, count_comment: bool = True):
        self.tokens = LINE_COMMENTS.get(lang_name, ())
        self.count_blank = count_blank
        self.count_comment = count_comment
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.fragments = []
        self.carry_cr = False
        self.lines_raw = 0
        self.blank = 0
        self.comment = 0
        self.code = 0
        self.bytes = 0

    # -- внутреннее ------------------------------------------------------------------
    def _finalize(self, line: str) -> None:
        self.lines_raw += 1
        st = line.strip(JS_TRIM_CHARS)
        if not st:
            self.blank += 1
        elif any(st.startswith(tok) for tok in self.tokens):
            self.comment += 1
        else:
            self.code += 1

    def _push_text(self, text: str) -> None:
        if not text:
            return
        if self.carry_cr:
            # '\r' из прошлого чанка — терминатор (возможно, первый байт '\r\n')
            self.carry_cr = False
            self._finalize("".join(self.fragments))
            self.fragments.clear()
            if text[0] == "\n":
                text = text[1:]
                if not text:
                    return
        if text.endswith("\r"):
            self.carry_cr = True
            text = text[:-1]
            if not text:
                return
        if "\r" in text:
            text = text.replace("\r\n", "\n").replace("\r", "\n")
        if "\n" in text:
            parts = text.split("\n")
            for seg in parts[:-1]:
                if self.fragments:
                    self.fragments.append(seg)
                    self._finalize("".join(self.fragments))
                    self.fragments.clear()
                else:
                    self._finalize(seg)
            tail = parts[-1]
            if tail:
                self.fragments.append(tail)
        else:
            self.fragments.append(text)

    # -- публичное -------------------------------------------------------------------
    def push(self, chunk: bytes) -> None:
        self.bytes += len(chunk)
        self._push_text(self.decoder.decode(chunk))

    def end(self):
        tail = self.decoder.decode(b"", final=True)
        if tail:
            self._push_text(tail)
        if self.carry_cr:
            self.carry_cr = False
            self._finalize("".join(self.fragments))
            self.fragments.clear()
        elif self.fragments:
            self._finalize("".join(self.fragments))
            self.fragments.clear()
        # SPEC 2.4: code = строки, не являющиеся ни пустыми, ни комментариями;
        # lines зависит от опций countBlankLines/countCommentLines.
        lines = self.code
        if self.count_blank:
            lines += self.blank
        if self.count_comment:
            lines += self.comment
        return {
            "lines": lines,
            "code": self.code,
            "blank": self.blank,
            "comment": self.comment,
            "bytes": self.bytes,
            "linesRaw": self.lines_raw,
        }


def count_text(text: str, lang_name: str, count_blank: bool = True,
               count_comment: bool = True) -> dict:
    """Удобная обёртка для тестов: посчитать строку как один файл."""
    c = LineCounter(lang_name, count_blank, count_comment)
    c.push(text.encode("utf-8"))
    return c.end()


# =====================================================================================
# 4. ОБХОД TARBALL (SPEC 2.4 countTarball)
# =====================================================================================

class ArchiveTooLarge(Exception):
    """Сжатых байт больше maxArchiveMB (SPEC 3.3)."""


class CountingReader:
    """Обёртка потока: считает прочитанные (сжатые) байты и следит за лимитом."""

    def __init__(self, fileobj, limit_bytes: int):
        self.fileobj = fileobj
        self.limit = limit_bytes
        self.consumed = 0

    def read(self, size: int = -1) -> bytes:
        buf = self.fileobj.read(size)
        if buf:
            self.consumed += len(buf)
            if self.limit and self.consumed > self.limit:
                raise ArchiveTooLarge(
                    "сжатый архив больше лимита %s"
                    % ("%d МБ" % (self.limit // (1024 * 1024)) if self.limit >= 1048576
                       else "%d Б" % self.limit)
                )
        return buf

    def readable(self) -> bool:
        return True

    def close(self) -> None:
        try:
            self.fileobj.close()
        except Exception:
            pass


def _read_head(f, want: int) -> bytes:
    """Прочитать ровно want байт (или сколько есть) — read() может вернуть меньше."""
    buf = bytearray()
    while len(buf) < want:
        chunk = f.read(want - len(buf))
        if not chunk:
            break
        buf += chunk
    return bytes(buf)


def count_tarball(fileobj, *, count_blank: bool = True, count_comment: bool = True,
                  max_file_bytes: int = 5 * 1024 * 1024,
                  max_archive_bytes: int = 120 * 1024 * 1024,
                  chunk_size: int = 256 * 1024,
                  trace_path: str | None = None,
                  progress: bool = False) -> dict:
    """Потоковый обход tar.gz. Возвращает словарь в форме countTarball() из SPEC 2.4."""
    t0 = time.monotonic()
    # Сжатый поток: считаем байты и следим за maxArchiveMB (SPEC 3.3 — лимит по СЖАТЫМ байтам).
    reader = CountingReader(fileobj, max_archive_bytes)
    # Распакованный поток: именно его байты идут в archiveBytes (SPEC 2.4, уточнено Lead'ом).
    gz = gzip.GzipFile(fileobj=reader, mode="rb")
    plain = CountingReader(gz, 0)
    per_lang: dict[str, dict] = {}
    skipped_reasons = {"ignored": 0, "binary": 0, "tooLarge": 0, "nonFile": 0, "unknown": 0}
    no_lang = 0
    no_lang_ext: dict[str, int] = {}
    no_lang_binext = 0
    logical_bytes = 0
    entries = 0
    counted_files = 0
    counted_bytes = 0
    total_lines = 0
    root = None
    outside_root = 0
    truncated = False
    trunc_error = None
    trace = open(trace_path, "w", encoding="utf-8") if trace_path else None
    if trace:
        trace.write("path\ttype\tsize\tlang\tdecision\treason\tlines\tcode\tblank\tcomment\tbytes\n")
    last_progress = 0.0

    try:
        try:
            tf = tarfile.open(fileobj=plain, mode="r|")
        except ArchiveTooLarge:
            raise                      # лимит архива — не «нечитаемый архив»
        except Exception as exc:  # битый gzip / не tar
            raise ArchiveUnreadable(str(exc)) from exc
        try:
            for m in tf:
                entries += 1
                logical_bytes += 512 + ((m.size + 511) // 512) * 512
                name = m.name
                if root is None:
                    root = normalize_rel_path(name).split("/", 1)[0]
                rel = normalize_rel_path(name)
                if root:
                    if rel == root:
                        rel = ""
                    elif rel.startswith(root + "/"):
                        rel = rel[len(root) + 1:]
                    elif rel:
                        outside_root += 1
                is_dir = m.isdir()
                kind = ("dir" if is_dir else "symlink" if m.issym() else
                        "file" if m.isfile() else "other")
                reason = None
                lang = None
                stats = None

                if is_ignored_path(rel, is_dir=is_dir):
                    reason = "ignored"
                elif kind != "file":
                    reason = "nonFile"
                elif m.size > max_file_bytes:
                    reason = "tooLarge"
                else:
                    lang = detect_language(rel)
                    if lang is None:
                        reason = "noLanguage"
                    else:
                        fobj = tf.extractfile(m)
                        if fobj is None:
                            reason = "nonFile"
                            kind = "other"
                        else:
                            head = b""
                            if m.size > 0:
                                head = _read_head(fobj, min(m.size, HEAD_BYTES))
                            if looks_binary(head):
                                reason = "binary"
                                lang = None
                            else:
                                counter = LineCounter(lang, count_blank, count_comment)
                                counter.push(head)
                                remaining = m.size - len(head)
                                while remaining > 0:
                                    chunk = fobj.read(min(chunk_size, remaining))
                                    if not chunk:
                                        break
                                    counter.push(chunk)
                                    remaining -= len(chunk)
                                    if remaining > 0 and progress:
                                        now = time.monotonic()
                                        if now - last_progress > 0.1:
                                            last_progress = now
                                            sys.stderr.write(
                                                "[parse] %.1f МБ, %d файлов, %d записей\r"
                                                % (plain.consumed / 1048576.0, counted_files,
                                                   entries))
                                            sys.stderr.flush()
                                stats = counter.end()
                                if remaining > 0:
                                    truncated = True
                                    trunc_error = "запись %r оборвана (нужно %d Б, получено %d)" % (
                                        rel, m.size, m.size - remaining)

                if reason is not None:
                    if reason == "noLanguage":
                        # SPEC 2.4 (уточнено): текстовые файлы без определённого языка
                        # попадают в skippedReasons.unknown и не считаются.
                        reason = "unknown"
                        no_lang += 1
                        base = rel.rsplit("/", 1)[-1].lower()
                        j = base.rfind(".")
                        ext = base[j:] if j >= 0 else "(none)"
                        no_lang_ext[ext] = no_lang_ext.get(ext, 0) + 1
                        if ext != "(none)" and ext[1:] in BINARY_EXTENSIONS:
                            no_lang_binext += 1
                    skipped_reasons[reason] += 1
                    if trace:
                        trace.write("%s\t%s\t%d\t%s\t%s\t%s\t\t\t\t\t\n"
                                    % (rel, kind, m.size, lang or "", "skipped", reason))
                else:
                    counted_files += 1
                    counted_bytes += m.size
                    total_lines += stats["lines"]
                    agg = per_lang.get(lang)
                    if agg is None:
                        agg = per_lang[lang] = {"lines": 0, "code": 0, "blank": 0,
                                                "comment": 0, "files": 0, "bytes": 0}
                    agg["lines"] += stats["lines"]
                    agg["code"] += stats["code"]
                    agg["blank"] += stats["blank"]
                    agg["comment"] += stats["comment"]
                    agg["files"] += 1
                    agg["bytes"] += m.size
                    if trace:
                        trace.write("%s\t%s\t%d\t%s\t%s\t\t%d\t%d\t%d\t%d\t%d\n"
                                    % (rel, kind, m.size, lang, "counted", stats["lines"],
                                       stats["code"], stats["blank"], stats["comment"],
                                       stats["bytes"]))
                if truncated:
                    break
        finally:
            try:
                tf.close()
            except Exception:
                pass
    except ArchiveTooLarge:
        if trace:
            trace.close()
        raise
    except (tarfile.ReadError, tarfile.StreamError, EOFError, gzip.BadGzipFile,
            OSError, ValueError) as exc:
        if entries == 0:
            # ничего не разобрали — это не «обрыв посреди записи», а нечитаемый архив
            if trace:
                trace.close()
            raise ArchiveUnreadable("%s: %s" % (type(exc).__name__, exc)) from exc
        truncated = True
        trunc_error = "%s: %s" % (type(exc).__name__, exc)
    finally:
        if trace:
            trace.close()

    skipped = sum(skipped_reasons.values())
    ordered = dict(sorted(per_lang.items(), key=lambda kv: (-kv[1]["lines"], kv[0])))
    return {
        "total": total_lines,
        "files": counted_files,
        "bytes": counted_bytes,
        "perLanguage": ordered,
        "skipped": skipped,
        "skippedReasons": skipped_reasons,
        "entries": entries,
        "archiveBytes": plain.consumed,
        "truncated": truncated,
        "ms": int((time.monotonic() - t0) * 1000),
        "oracle": {
            "version": ORACLE_VERSION,
            "unknownFiles": no_lang,
            "unknownByExt": dict(sorted(no_lang_ext.items(), key=lambda kv: -kv[1])),
            "unknownBinaryExtFiles": no_lang_binext,
            "compressedBytes": reader.consumed,
            # Нижняя оценка размера tar без pax/GNU-заголовков (512 + pad(size) на запись).
            # Расхождение с archiveBytes — блоки pax 'x'/'g' и LongLink, которые tarfile
            # обрабатывает внутри себя. В контракт идёт archiveBytes = plain.consumed
            # (точное число распакованных байт потока).
            "archiveBytesNoPax": logical_bytes + 1024,
            "tarballRoot": root,
            "entriesOutsideRoot": outside_root,
            "ignoreProfile": IGNORE_PROFILE,
            "skipPrecedence": ("ignored > nonFile > tooLarge > unknown > binary; "
                               "binary = язык определён, но в первых 8192 Б есть NUL"),
            "options": {
                "countBlankLines": count_blank,
                "countCommentLines": count_comment,
                "maxFileBytes": max_file_bytes,
                "maxArchiveBytes": max_archive_bytes,
            },
            "truncError": trunc_error,
        },
    }


class ArchiveUnreadable(Exception):
    pass


# =====================================================================================
# 5. СЕТЬ
# =====================================================================================

UA = "ghloc-verify-oracle/%s (+independent-audit; python-stdlib)" % ORACLE_VERSION
API = "https://api.github.com"


class HttpError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _request(url: str, token: str = "", accept: str = "application/vnd.github+json",
             timeout: int = 30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
    })
    if token:
        req.add_header("Authorization", "Bearer %s" % token)
    return urllib.request.urlopen(req, timeout=timeout)


def _http_error(exc: urllib.error.HTTPError, private: bool | None = None) -> HttpError:
    st = exc.code
    if st == 404:
        return HttpError("private" if private else "not_found",
                         "репозиторий или ref не найдены (HTTP 404)", st)
    if st in (403, 429):
        remaining = exc.headers.get("X-RateLimit-Remaining") if exc.headers else None
        if st == 429 or remaining == "0":
            return HttpError("rate_limit", "превышен лимит запросов GitHub (HTTP %d)" % st, st)
        return HttpError("not_found", "доступ запрещён (HTTP 403)", st)
    return HttpError("network", "HTTP %d при запросе %s" % (st, exc.url), st)


def api_json(path: str, token: str = "", timeout: int = 30):
    try:
        with _request(API + path, token=token, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raise _http_error(exc) from exc
    except Exception as exc:
        raise HttpError("network", "%s: %s" % (type(exc).__name__, exc)) from exc


def open_tarball_stream(owner: str, repo: str, ref: str, token: str = "",
                        tarball_url: str | None = None):
    """Возвращает (fileobj, url). Публично — codeload; с токеном — api tarball."""
    if tarball_url:
        url = tarball_url
        headers_token = ""
    elif token:
        url = "%s/repos/%s/%s/tarball/%s" % (API, owner, repo, ref)
        headers_token = token
    else:
        url = "https://codeload.github.com/%s/%s/tar.gz/%s" % (owner, repo, ref)
        headers_token = ""
    try:
        resp = _request(url, token=headers_token, accept="application/vnd.github+json",
                        timeout=60)
    except urllib.error.HTTPError as exc:
        raise _http_error(exc) from exc
    except Exception as exc:
        raise HttpError("network", "%s: %s" % (type(exc).__name__, exc)) from exc
    return resp, url


# =====================================================================================
# 6. CLI
# =====================================================================================

def _human_summary(res: dict, where: str) -> str:
    lines = ["%s: %d строк в %d файлах (%.1f МиБ полезной нагрузки), пропущено %d, "
             "записей %d, распаковано %.1f МиБ (сжатых %.1f МиБ), %d мс%s"
             % (where, res["total"], res["files"], res["bytes"] / 1048576.0,
                res["skipped"], res["entries"], res["archiveBytes"] / 1048576.0,
                res["oracle"].get("compressedBytes", 0) / 1048576.0,
                res["ms"], " [TRUNCATED]" if res["truncated"] else "")]
    top = list(res["perLanguage"].items())[:10]
    for name, v in top:
        lines.append("    %-22s %8d строк  %6d файлов  %10d Б" %
                     (name, v["lines"], v["files"], v["bytes"]))
    reasons = res["skippedReasons"]
    lines.append("    skipped: ignored=%d binary=%d tooLarge=%d nonFile=%d unknown=%d %s"
                 % (reasons["ignored"], reasons["binary"], reasons["tooLarge"],
                    reasons["nonFile"], reasons["unknown"],
                    res["oracle"]["unknownByExt"]))
    return "\n".join(lines)


def dump_tables() -> dict:
    return {
        "ignoreProfile": IGNORE_PROFILE,
        "languageTable": LANGUAGE_TABLE,
        "specialFilenames": SPECIAL_FILENAMES,
        "binaryExtensions": sorted(BINARY_EXTENSIONS),
        "textExtensions": sorted(TEXT_EXTENSIONS),
        "ignoreDirs": IGNORE_DIRS,
        "ignoreFiles": IGNORE_FILES,
        "ignoreSuffixes": IGNORE_SUFFIXES,
        "lineComments": {k: list(v) for k, v in sorted(LINE_COMMENTS.items())},
        "headBytes": HEAD_BYTES,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="oracle.py",
        description="Независимый оракул подсчёта строк кода (SPEC.md п.2) — verify/ проекта ghloc")
    ap.add_argument("repo", nargs="?", help="owner/repo (например octocat/Spoon-Knife)")
    ap.add_argument("ref", nargs="?", help="ветка/тег/commit; по умолчанию default_branch")
    ap.add_argument("--file", dest="local_file", help="локальный .tar.gz вместо сети")
    ap.add_argument("--tarball-url", help="свой URL tarball (например фикстура по http)")
    ap.add_argument("--token", default=os.environ.get("GITHUB_TOKEN", ""),
                    help="токен GitHub (иначе публичный codeload)")
    ap.add_argument("--json-out", help="записать JSON в файл (stdout остаётся человекочитаемым)")
    ap.add_argument("--max-file-bytes", type=int, default=5 * 1024 * 1024,
                    help="SPEC 2.4 maxFileBytes (по умолчанию 5 МиБ)")
    ap.add_argument("--max-archive-mb", type=float, default=120.0,
                    help="SPEC 3.3 maxArchiveMB по СЖАТЫМ байтам; 0 = без лимита")
    ap.add_argument("--no-blank-lines", action="store_true",
                    help="countBlankLines:false — пустые строки не входят в lines")
    ap.add_argument("--no-comment-lines", action="store_true",
                    help="countCommentLines:false — строки-комментарии не входят в lines")
    ap.add_argument("--chunk-size", type=int, default=256 * 1024,
                    help="размер чанка чтения тела записи (для теста границ чанков)")
    ap.add_argument("--trace", help="TSV с классификацией каждой записи архива")
    ap.add_argument("--progress", action="store_true", help="прогресс в stderr")
    ap.add_argument("--no-meta", action="store_true",
                    help="не запрашивать мету/commit/languages через API")
    ap.add_argument("--ignore-profile", choices=("spec", "extended"), default="spec",
                    help="spec — игнор-списки строго из SPEC 2.2 (по умолчанию); "
                         "extended — плюс кэш-каталоги сверх SPEC")
    ap.add_argument("--dump-tables", action="store_true",
                    help="напечатать таблицы оракула (JSON) и выйти")
    ap.add_argument("--self-test", action="store_true",
                    help="прогнать встроенные проверки счётчика (граничные случаи SPEC 2.4)")
    args = ap.parse_args(argv)
    apply_ignore_profile(args.ignore_profile)

    if args.dump_tables:
        print(json.dumps(dump_tables(), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    if args.self_test:
        return builtin_self_test()

    if not args.local_file and not args.tarball_url and not args.repo:
        ap.error("нужен owner/repo, либо --file, либо --tarball-url")

    owner = repo = None
    ref = args.ref
    meta = {}
    if args.repo:
        if "/" not in args.repo:
            ap.error("репозиторий задаётся как owner/repo")
        owner, repo = args.repo.split("/", 1)
    if not ref and args.local_file is None and args.tarball_url is None and owner:
        if not args.no_meta:
            try:
                m = api_json("/repos/%s/%s" % (owner, repo), args.token)
                meta["repo"] = {k: m.get(k) for k in
                                ("default_branch", "private", "size", "pushed_at",
                                 "stargazers_count", "fork")}
                ref = m.get("default_branch") or "main"
            except HttpError as exc:
                sys.stderr.write("[ghloc-oracle] мета недоступна (%s), беру main\n" % exc.code)
        ref = ref or "main"

    extras = {
        "mode": ("file" if args.local_file else "url" if args.tarball_url else "repo"),
        "repo": args.repo, "ref": ref, "commit": None, "tarballUrl": None,
        "ghRepo": meta.get("repo"), "ghLanguages": None, "ghCommit": None,
        "apiErrors": [],
    }
    if owner and not args.no_meta:
        try:
            c = api_json("/repos/%s/%s/commits/%s" % (owner, repo, ref), args.token)
            extras["commit"] = c.get("sha")
        except HttpError as exc:
            extras["apiErrors"].append("commits: %s" % exc.message)
        try:
            langs = api_json("/repos/%s/%s/languages" % (owner, repo), args.token)
            extras["ghLanguages"] = langs
        except HttpError as exc:
            extras["apiErrors"].append("languages: %s" % exc.message)

    close_after = True
    fileobj = None
    try:
        if args.local_file:
            try:
                fileobj = open(args.local_file, "rb")
            except OSError as exc:
                out = {"ok": False,
                       "error": {"code": "not_found",
                                 "message": "не удалось открыть %s: %s" % (args.local_file, exc)},
                       "oracle": extras}
                _emit(out, args)
                return 2
            url = "file://" + os.path.abspath(args.local_file)
        else:
            fileobj, url = open_tarball_stream(owner or "", repo or "", ref or "",
                                               args.token, args.tarball_url)
        extras["tarballUrl"] = url
        try:
            res = count_tarball(
                fileobj,
                count_blank=not args.no_blank_lines,
                count_comment=not args.no_comment_lines,
                max_file_bytes=args.max_file_bytes,
                max_archive_bytes=(int(args.max_archive_mb * 1024 * 1024)
                                   if args.max_archive_mb else 0),
                chunk_size=args.chunk_size,
                trace_path=args.trace,
                progress=args.progress,
            )
        except ArchiveTooLarge as exc:
            out = {"ok": False, "error": {"code": "too_large", "message": str(exc)},
                   "oracle": extras}
            _emit(out, args)
            return 3
        except ArchiveUnreadable as exc:
            out = {"ok": False, "error": {"code": "unknown",
                                          "message": "не удалось открыть архив: %s" % exc},
                   "oracle": extras}
            _emit(out, args)
            return 4
    except HttpError as exc:
        out = {"ok": False, "error": {"code": exc.code, "message": exc.message},
               "oracle": extras}
        _emit(out, args)
        return 2
    finally:
        if close_after and fileobj is not None:
            try:
                fileobj.close()
            except Exception:
                pass

    res["oracle"].update(extras)
    _emit(res, args)
    if args.progress:
        sys.stderr.write("\n")
    sys.stderr.write(_human_summary(res, args.repo or url) + "\n")
    return 0


def _emit(obj: dict, args) -> None:
    text = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    else:
        print(text)


# =====================================================================================
# 7. ВСТРОЕННЫЕ ПРОВЕРКИ СЕМАНТИКИ (граничные случаи SPEC 2.4)
# =====================================================================================

SELF_TESTS = [
    # (текст, язык, ожидаемые lines/blank/comment/code)
    ("", "Python", 0, 0, 0, 0),
    ("\n", "Python", 1, 1, 0, 0),
    ("a\nb\n", "Python", 2, 0, 0, 2),
    ("a\nb", "Python", 2, 0, 0, 2),
    ("a\r\nb\rc", "Python", 3, 0, 0, 3),
    ("a\r\n", "Python", 1, 0, 0, 1),
    ("# c\nx = 1\n\n", "Python", 3, 1, 1, 1),
    ("// c\nx();", "JavaScript", 2, 0, 1, 1),
    ("   \n\t\n", "Python", 2, 2, 0, 0),
    ("/* not a line comment */\nx", "JavaScript", 2, 0, 0, 2),
    # SPEC 2.4: комментарий = trim() начинается с токена; блочные не детектируем,
    # поэтому строка "--[[ ..." для Lua ВСЁ РАВНО попадает в comment (токен "--").
    ("--[[ block ]]\nx", "Lua", 2, 0, 1, 1),
    ("-- line\nx", "Lua", 2, 0, 1, 1),
    ("\u00a0\nx", "Python", 2, 1, 0, 1),          # NBSP = whitespace в JS trim()
    ("\u2028x", "Python", 1, 0, 0, 1),            # U+2028 не разрезает строку (не \n/\r)
]


def builtin_self_test() -> int:
    bad = 0
    for text, lang, lines, blank, comment, code in SELF_TESTS:
        got = count_text(text, lang)
        ok = (got["lines"], got["blank"], got["comment"], got["code"]) == \
             (lines, blank, comment, code)
        if not ok:
            bad += 1
        print("%-4s %-12r %-11s lines=%d blank=%d comment=%d code=%d (ожидалось %d/%d/%d/%d)"
              % ("OK" if ok else "FAIL", text, lang, got["lines"], got["blank"],
                 got["comment"], got["code"], lines, blank, comment, code))
    # границы чанков: тот же текст по 1 байту должен дать тот же результат
    for text, lang, lines, blank, comment, code in SELF_TESTS:
        c = LineCounter(lang)
        for b in text.encode("utf-8"):
            c.push(bytes([b]))
        got = c.end()
        ok = (got["lines"], got["blank"], got["comment"], got["code"]) == \
             (lines, blank, comment, code)
        if not ok:
            bad += 1
            print("FAIL chunk=1 %r: %s" % (text, got))
    print("самопроверка: %d проверок, ошибок %d" % (2 * len(SELF_TESTS), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())