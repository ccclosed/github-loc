// Таблица языков: расширение -> [имя языка (как у GitHub/linguist), байт на строку (для оценки)].
// bpl — средняя длина строки в байтах, используется только для оценки по байтам из GitHub API.
const EXT = {
  rs: ['Rust', 33], py: ['Python', 31], pyi: ['Python', 31], pyw: ['Python', 31],
  js: ['JavaScript', 34], mjs: ['JavaScript', 34], cjs: ['JavaScript', 34], jsx: ['JavaScript', 34],
  ts: ['TypeScript', 34], tsx: ['TypeScript', 34], mts: ['TypeScript', 34], cts: ['TypeScript', 34],
  java: ['Java', 33], kt: ['Kotlin', 32], kts: ['Kotlin', 32], scala: ['Scala', 34], sc: ['Scala', 34],
  c: ['C', 30], h: ['C', 29], cc: ['C++', 32], cpp: ['C++', 32], cxx: ['C++', 32], 'c++': ['C++', 32],
  hpp: ['C++', 32], hh: ['C++', 32], hxx: ['C++', 32], inl: ['C++', 32], ipp: ['C++', 32],
  cs: ['C#', 33], csx: ['C#', 33], go: ['Go', 29], rb: ['Ruby', 30], rake: ['Ruby', 30],
  php: ['PHP', 33], phtml: ['PHP', 33], pl: ['Perl', 32], pm: ['Perl', 32], t: ['Perl', 32],
  sh: ['Shell', 28], bash: ['Shell', 28], zsh: ['Shell', 28], fish: ['Shell', 28], ksh: ['Shell', 28],
  ps1: ['PowerShell', 33], psm1: ['PowerShell', 33], psd1: ['PowerShell', 30],
  swift: ['Swift', 32], dart: ['Dart', 32], lua: ['Lua', 30], r: ['R', 30], jl: ['Julia', 31],
  hs: ['Haskell', 32], lhs: ['Literate Haskell', 34], ex: ['Elixir', 31], exs: ['Elixir', 31],
  erl: ['Erlang', 30], hrl: ['Erlang', 30], clj: ['Clojure', 33], cljs: ['Clojure', 33],
  cljc: ['Clojure', 33], edn: ['Clojure', 26], fs: ['F#', 33], fsx: ['F#', 33], fsi: ['F#', 33],
  ml: ['OCaml', 32], mli: ['OCaml', 32], m: ['Objective-C', 33], mm: ['Objective-C++', 33],
  asm: ['Assembly', 25], s: ['Assembly', 25], nasm: ['Assembly', 25],
  groovy: ['Groovy', 32], gradle: ['Groovy', 32], sol: ['Solidity', 30], zig: ['Zig', 30],
  nim: ['Nim', 30], cr: ['Crystal', 31], v: ['V', 30], d: ['D', 31], vala: ['Vala', 31],
  html: ['HTML', 36], htm: ['HTML', 36], xhtml: ['HTML', 36], cshtml: ['HTML+Razor', 34],
  razor: ['HTML+Razor', 34], jsp: ['Java Server Pages', 34], aspx: ['ASP.NET', 36],
  erb: ['HTML+ERB', 36], haml: ['Haml', 30], slim: ['Slim', 30], ejs: ['EJS', 30],
  css: ['CSS', 26], scss: ['SCSS', 27], sass: ['Sass', 27], less: ['Less', 27], styl: ['Stylus', 26],
  vue: ['Vue', 32], svelte: ['Svelte', 31], astro: ['Astro', 32],
  json: ['JSON', 26], jsonc: ['JSON with Comments', 26], json5: ['JSON5', 26], geojson: ['JSON', 30],
  yaml: ['YAML', 24], yml: ['YAML', 24], toml: ['TOML', 24], ini: ['INI', 24], cfg: ['INI', 24],
  conf: ['INI', 24], properties: ['INI', 26], env: ['Dotenv', 20], editorconfig: ['EditorConfig', 22],
  xml: ['XML', 40], xsd: ['XML', 40], xsl: ['XSLT', 40], xslt: ['XSLT', 40], svg: ['SVG', 40],
  plist: ['XML Property List', 40], csproj: ['XML', 40], vbproj: ['XML', 40], resx: ['XML', 40],
  md: ['Markdown', 42], markdown: ['Markdown', 42], mdx: ['MDX', 42], qmd: ['Markdown', 42],
  rst: ['reStructuredText', 40], adoc: ['AsciiDoc', 40], tex: ['TeX', 38], sty: ['TeX', 36],
  cls: ['TeX', 36], bib: ['BibTeX', 35], rmd: ['RMarkdown', 40],
  sql: ['SQL', 30], graphql: ['GraphQL', 30], gql: ['GraphQL', 30], proto: ['Protocol Buffer', 28],
  thrift: ['Thrift', 28], avsc: ['JSON', 28],
  bat: ['Batchfile', 26], cmd: ['Batchfile', 26], vb: ['Visual Basic .NET', 32], vbs: ['VBScript', 30],
  ada: ['Ada', 30], adb: ['Ada', 30], ads: ['Ada', 30],
  f: ['Fortran', 28], f77: ['Fortran', 28], f90: ['Fortran', 28], f95: ['Fortran', 28], for: ['Fortran', 28],
  cob: ['COBOL', 30], cbl: ['COBOL', 30], pas: ['Pascal', 30], pp: ['Pascal', 30],
  tcl: ['Tcl', 30], awk: ['Awk', 28], vim: ['Vim Script', 28], el: ['Emacs Lisp', 30],
  lisp: ['Common Lisp', 30], lsp: ['Common Lisp', 30], scm: ['Scheme', 30], ss: ['Scheme', 30],
  rkt: ['Racket', 30], coffee: ['CoffeeScript', 30], litcoffee: ['Literate CoffeeScript', 32],
  hbs: ['Handlebars', 30], mustache: ['Mustache', 30], pug: ['Pug', 28], jade: ['Pug', 28],
  tf: ['HCL', 28], tfvars: ['HCL', 28], hcl: ['HCL', 28], nix: ['Nix', 28],
  mk: ['Makefile', 24], mak: ['Makefile', 24], cmake: ['CMake', 26],
  ipynb: ['Jupyter Notebook', 40], txt: ['Text', 40], text: ['Text', 40],
  csv: ['CSV', 25], tsv: ['TSV', 25], diff: ['Diff', 26], patch: ['Diff', 26],
  hx: ['Haxe', 32], as: ['ActionScript', 32], ahk: ['AutoHotkey', 30],
  ron: ['RON', 26], gleam: ['Gleam', 30], odin: ['Odin', 30], jai: ['Jai', 30],
};

// Особые имена файлов (без расширения или с хитрым) -> язык.
const SPECIAL = {
  dockerfile: 'Dockerfile', makefile: 'Makefile', gnumakefile: 'Makefile',
  'cmakelists.txt': 'CMake', 'meson.build': 'Meson', 'meson_options.txt': 'Meson',
  gemfile: 'Ruby', rakefile: 'Ruby', guardfile: 'Ruby', capfile: 'Ruby', thorfile: 'Ruby',
  berksfile: 'Ruby', brewfile: 'Ruby', podfile: 'Ruby', fastfile: 'Ruby', appfile: 'Ruby',
  matchfile: 'Ruby', scanfile: 'Ruby', deliverfile: 'Ruby', snapfile: 'Ruby',
  justfile: 'Just', procfile: 'Procfile', vagrantfile: 'Ruby',
  jenkinsfile: 'Groovy', 'build.gradle': 'Groovy', 'settings.gradle': 'Groovy',
  sconstruct: 'Python', scdescription: 'Python', wscript: 'Python', build: 'Python',
  pkgbuild: 'Shell', '.bashrc': 'Shell', '.zshrc': 'Shell', '.bash_profile': 'Shell',
  '.profile': 'Shell', '.bash_aliases': 'Shell', '.env': 'Dotenv',
  '.gitignore': 'Ignore List', '.gitattributes': 'Git Attributes', '.dockerignore': 'Ignore List',
  '.npmrc': 'INI', '.editorconfig': 'EditorConfig', '.babelrc': 'JSON', '.eslintrc': 'JSON',
  '.prettierrc': 'JSON', 'flake.nix': 'Nix', 'cargo.toml': 'TOML', 'pyproject.toml': 'TOML',
  'package.json': 'JSON', 'tsconfig.json': 'JSON with Comments',
};

const BINARY = [
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tif', 'tiff', 'psd', 'ai', 'eps',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'tar', 'jar', 'war', 'ear',
  'class', 'pyc', 'pyo', 'pyd', 'so', 'dll', 'dylib', 'exe', 'bin', 'o', 'a', 'lib', 'obj', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'm4a', 'ogg', 'oga', 'wav', 'flac', 'avi',
  'mov', 'mkv', 'webm', 'sqlite', 'sqlite3', 'db', 'dat', 'pkl', 'pickle', 'npy', 'npz', 'h5',
  'hdf5', 'parquet', 'orc', 'snappy', 'img', 'iso', 'dmg', 'apk', 'ipa', 'deb', 'rpm', 'crx',
  'msi', 'glb', 'blend', 'fbx', 'pdb', 'ilk', 'exp', 'res', 'keystore', 'jks', 'pfx', 'p12',
  'node', 'map', 'pyc', 'su', 'mo', 'aac', 'opus', 'heic', 'heif', 'psb', 'xcf',
];

// Текстовые расширения без языковой привязки -> попадут в бакет «Other».
const TEXT = ['log', 'lst', 'nfo', 'po', 'pot', 'srt', 'vtt', 'me', '1st', 'rules', 'sum', 'sig'];

// Токены строчных комментариев (только целые строки-комментарии).
const COMMENTS = {
  Rust: ['//'], Python: ['#'], JavaScript: ['//'], TypeScript: ['//'], Java: ['//'], Kotlin: ['//'],
  Scala: ['//'], C: ['//'], 'C++': ['//'], 'C#': ['//'], Go: ['//'], Ruby: ['#'], PHP: ['//', '#'],
  Perl: ['#'], Shell: ['#'], PowerShell: ['#'], Swift: ['//'], Dart: ['//'], Lua: ['--'], R: ['#'],
  Julia: ['#'], Haskell: ['--'], 'Literate Haskell': ['--'], Elixir: ['#'], Erlang: ['%'],
  Clojure: [';'], 'F#': ['//'], OCaml: ['(*'], 'Objective-C': ['//'], 'Objective-C++': ['//'],
  Assembly: [';', '#'], Groovy: ['//'], Solidity: ['//'], Zig: ['//'], Nim: ['#'], Crystal: ['#'],
  V: ['//'], D: ['//'], Vala: ['//'], HTML: ['<!--'], 'HTML+Razor': ['<!--'], 'Java Server Pages': ['<%--'],
  'ASP.NET': ['<%--'], 'HTML+ERB': ['<%#'], Haml: ['-#'], Slim: ['/'], EJS: ['<%#'],
  CSS: ['/*'], SCSS: ['//'], Sass: ['//'], Less: ['//'], Stylus: ['//'], Vue: ['<!--'], Svelte: ['<!--'],
  Astro: ['<!--'], JSON: [], 'JSON with Comments': ['//'], JSON5: ['//'], YAML: ['#'], TOML: ['#'],
  INI: [';', '#'], Dotenv: ['#'], EditorConfig: ['#', ';'], XML: ['<!--'], XSLT: ['<!--'],
  SVG: ['<!--'], 'XML Property List': ['<!--'], Markdown: ['<!--'], MDX: ['<!--'],
  reStructuredText: ['..'], AsciiDoc: ['//'], TeX: ['%'], BibTeX: ['%'], RMarkdown: ['<!--'],
  SQL: ['--'], GraphQL: ['#'], 'Protocol Buffer': ['//'], Thrift: ['//'], Batchfile: ['REM', '::'],
  'Visual Basic .NET': ["'"], VBScript: ["'"], Ada: ['--'], Fortran: ['!', 'c', 'C', '*'],
  COBOL: ['*>'], Pascal: ['//', '{'], Tcl: ['#'], Awk: ['#'], 'Vim Script': ['"'],
  'Emacs Lisp': [';'], 'Common Lisp': [';'], Scheme: [';'], Racket: [';'], CoffeeScript: ['#'],
  'Literate CoffeeScript': ['#'], Handlebars: [], Mustache: [], Pug: ['//-'], HCL: ['#', '//'],
  Nix: ['#'], Makefile: ['#'], CMake: ['#'], Meson: ['#'], Just: ['#'], Procfile: ['#'],
  'Jupyter Notebook': [], Text: [], CSV: [], TSV: [], Diff: [], Haxe: ['//'], ActionScript: ['//'],
  AutoHotkey: [';'], RON: ['//'], Gleam: ['//'], Odin: ['//'], Jai: ['//'], 'Ignore List': ['#'],
  'Git Attributes': ['#'],
};

export const LANGUAGE_TABLE = new Map(
  Object.entries(EXT).map(([k, [name, bpl]]) => [k, { name, bpl }]),
);
export const SPECIAL_FILENAMES = new Map(Object.entries(SPECIAL));
export const BINARY_EXTENSIONS = new Set(BINARY);
export const TEXT_EXTENSIONS = new Set(TEXT);
export const LINE_COMMENTS = new Map(Object.entries(COMMENTS));

/** Средняя длина строки в байтах для языка (для оценки по байтам). */
export function bytesPerLine(languageName) {
  const found = EXT_BY_NAME.get(languageName);
  return found ?? 30;
}

const EXT_BY_NAME = (() => {
  const m = new Map();
  for (const [, [name, bpl]] of Object.entries(EXT)) if (!m.has(name)) m.set(name, bpl);
  for (const [name, cm] of Object.entries(COMMENTS)) if (!m.has(name)) m.set(name, 30);
  return m;
})();

/** Расширение файла в нижнем регистре, либо '' если расширения нет. */
export function extensionOf(basename) {
  const i = basename.lastIndexOf('.');
  if (i <= 0 || i === basename.length - 1) return '';
  return basename.slice(i + 1).toLowerCase();
}

function lang(name, key) {
  return { name, key, bpl: bytesPerLine(name) };
}

/**
 * Определяет язык файла по относительному пути.
 * @returns {{name:string, key:string, bpl:number}|null} null — файл не считаем.
 */
export function detectLanguage(relPath) {
  if (!relPath) return null;
  const path = String(relPath).replace(/\\/g, '/');
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (!basename) return null;
  const lower = basename.toLowerCase();

  const special = SPECIAL_FILENAMES.get(lower);
  if (special) return lang(special, lower);

  // префиксные правила: Dockerfile.dev, Makefile.am, GNUmakefile.in и т.п.
  if (/^dockerfile([.\-_]|$)/.test(lower)) return lang('Dockerfile', 'dockerfile');
  if (/^(gnu)?makefile([.\-_]|$)/.test(lower)) return lang('Makefile', 'makefile');

  const ext = extensionOf(lower);
  if (!ext) return null;

  const entry = LANGUAGE_TABLE.get(ext);
  if (entry) return { name: entry.name, key: ext, bpl: entry.bpl };
  if (BINARY_EXTENSIONS.has(ext)) return null;
  if (TEXT_EXTENSIONS.has(ext)) return lang('Other', ext);
  return null;
}