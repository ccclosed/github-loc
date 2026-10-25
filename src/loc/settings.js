// Настройки расширения: дефолты, нормализация, преобразование в опции подсчёта.
export const DEFAULT_SETTINGS = {
  countBlankLines: true,
  countCommentLines: true,
  showPerLanguage: true,
  autoEstimate: true,
  autoAuth: true,
  maxArchiveMB: 120,
  maxFileMB: 5,
  token: '',
  debugTarballUrl: '',
};

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Приводит произвольный объект к полному набору валидных настроек. */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    countBlankLines: asBool(src.countBlankLines, DEFAULT_SETTINGS.countBlankLines),
    countCommentLines: asBool(src.countCommentLines, DEFAULT_SETTINGS.countCommentLines),
    showPerLanguage: asBool(src.showPerLanguage, DEFAULT_SETTINGS.showPerLanguage),
    autoEstimate: asBool(src.autoEstimate, DEFAULT_SETTINGS.autoEstimate),
    autoAuth: asBool(src.autoAuth, DEFAULT_SETTINGS.autoAuth),
    maxArchiveMB: Math.round(asNumber(src.maxArchiveMB, DEFAULT_SETTINGS.maxArchiveMB, 1, 4096)),
    maxFileMB: asNumber(src.maxFileMB, DEFAULT_SETTINGS.maxFileMB, 0.1, 64),
    token: asString(src.token),
    debugTarballUrl: asString(src.debugTarballUrl),
  };
}

/** Настройки -> опции countTarball. */
export function countOptionsFrom(settings) {
  const s = normalizeSettings(settings);
  return {
    countBlankLines: s.countBlankLines,
    countCommentLines: s.countCommentLines,
    maxFileBytes: Math.round(s.maxFileMB * 1024 * 1024),
    ignoreDirs: true,
    extraIgnoreDirs: [],
  };
}