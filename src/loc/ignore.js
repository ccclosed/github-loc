// Правила игнорирования: что не считаем «своим» кодом (vendored, сгенерированное, бинарное).

export const IGNORE_DIRS = [
  '.git', '.hg', '.svn', '.bzr',
  'node_modules', 'bower_components', 'jspm_packages', '.yarn', '.pnpm-store',
  'vendor', 'vendors', 'third_party', 'thirdparty', 'external', 'extern', 'deps',
  'dist', 'build', 'out', 'output', 'target', 'bin', 'obj', 'artifacts',
  'venv', '.venv', 'env', '.env', 'virtualenv', 'site-packages', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', 'eggs', '.eggs',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.angular', '.parcel-cache', '.turbo',
  '.cache', '.gradle', '.m2', '.idea', '.vscode', '.vs', '.history',
  'coverage', 'htmlcov', 'lcov-report', 'Pods', 'Carthage', 'DerivedData',
  '__snapshots__', 'minified', 'bundle',
];

export const IGNORE_FILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb',
  'cargo.lock', 'composer.lock', 'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock',
  'go.sum', 'flake.lock', 'packages.lock.json', 'pdm.lock', 'conda-lock.yml',
  '.ds_store', 'thumbs.db', 'desktop.ini', '.gitattributes.lock',
];

export const IGNORE_SUFFIXES = [
  '.min.js', '.min.css', '.min.mjs', '.map', '.snap', '.pyc', '.pyo', '.pyd',
  '.d.ts.map', '.js.map', '.css.map', '.generated.cs', '.designer.cs', '.g.dart',
  '.freezed.dart', '.pb.go', '_pb2.py', '.pb.cc', '.pb.h', '.grpc.pb.go',
];

// Пользовательские дополнительные игнорируемые сегменты (заполняется из настроек).
export const DEFAULT_IGNORE_DIRS_EXTRA = [];

const DIR_SET = new Set(IGNORE_DIRS.map((d) => d.toLowerCase()));
const FILE_SET = new Set(IGNORE_FILES.map((f) => f.toLowerCase()));
const SUFFIX_LIST = IGNORE_SUFFIXES.map((s) => s.toLowerCase());

/**
 * Игнорируется ли путь (относительный, внутри архива).
 * @param {string} relPath
 * @param {{extraDirs?: string[]}} [opts]
 */
export function isIgnoredPath(relPath, opts = {}) {
  if (!relPath) return true;
  let path = String(relPath).replace(/\\/g, '/');
  if (path.startsWith('./')) path = path.slice(2);
  if (path.startsWith('/')) path = path.slice(1);
  if (!path) return true;

  const segments = path.split('/');
  const basename = segments[segments.length - 1].toLowerCase();
  const dirSegments = segments.slice(0, -1).map((s) => s.toLowerCase());

  const extra = opts.extraDirs && opts.extraDirs.length
    ? opts.extraDirs.map((d) => String(d).toLowerCase())
    : null;

  for (const seg of dirSegments) {
    if (!seg) continue;
    if (DIR_SET.has(seg)) return true;
    if (extra && extra.includes(seg)) return true;
  }

  if (FILE_SET.has(basename)) return true;
  for (const suffix of SUFFIX_LIST) if (basename.endsWith(suffix)) return true;

  // файлы вида «что-то.min.js» уже покрыты суффиксами; «что-то.bundle.js» — тоже мусор сборки
  if (/\.bundle\.(js|css)$/.test(basename)) return true;

  return false;
}

/** Похоже ли содержимое на бинарное: NUL-байт в первых 8192 байтах. */
export function looksBinary(uint8) {
  if (!uint8 || uint8.length === 0) return false;
  const n = Math.min(uint8.length, 8192);
  for (let i = 0; i < n; i++) if (uint8[i] === 0) return true;
  return false;
}