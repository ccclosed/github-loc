// Форматирование чисел и разбор URL — чистая логика, общая для UI и тестов.
const NBSP = '\u00A0';

export function formatInt(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? '−' : '';
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += NBSP;
    out += digits[i];
  }
  return sign + out;
}

function trimDecimal(value) {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace('.', ',');
}

export function formatCompact(value) {
  const n = Math.abs(Math.round(Number(value) || 0));
  if (n < 1000) return formatInt(n);
  if (n < 1e6) {
    const k = n / 1000;
    return `${k < 10 ? trimDecimal(k) : formatInt(Math.round(k))}${NBSP}тыс.`;
  }
  if (n < 1e9) {
    const m = n / 1e6;
    return `${m < 10 ? trimDecimal(m) : formatInt(Math.round(m))}${NBSP}млн`;
  }
  const b = n / 1e9;
  return `${b < 10 ? trimDecimal(b) : formatInt(Math.round(b))}${NBSP}млрд`;
}

/** Русская плюрализация: plural(n, ['строка','строки','строк']). */
export function plural(n, forms) {
  const value = Math.abs(Math.round(Number(n) || 0)) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

export function formatBytes(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1024) return `${formatInt(n)}${NBSP}Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n / 1024;
  let unit = 0;
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024;
    unit += 1;
  }
  return `${v < 10 ? trimDecimal(v) : formatInt(Math.round(v))}${NBSP}${units[unit]}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total}${NBSP}мс`;
  const seconds = total / 1000;
  if (seconds < 10) return `${trimDecimal(seconds)}${NBSP}с`;
  if (seconds < 60) return `${Math.round(seconds)}${NBSP}с`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}${NBSP}мин ${rest}${NBSP}с`;
}

export const RESERVED_OWNERS = new Set([
  'settings', 'orgs', 'organizations', 'marketplace', 'explore', 'topics', 'collections',
  'sponsors', 'notifications', 'new', 'login', 'logout', 'join', 'features', 'about', 'pricing',
  'security', 'enterprise', 'apps', 'dashboard', 'pulls', 'issues', 'codesearch', 'search',
  'users', 'account', 'projects', 'stars', 'trending', 'events', 'gist', 'site', 'contact',
  'git-lfs', 'assets', 'images', 'static', 'favicon.ico', 'robots.txt', 'sitemap.xml',
  'manifest.json', 'opensearch.xml', 'apple-touch-icon.png', 'fluidicon.png', 'readme',
  'home', 'watching', 'stars', 'discussions', 'codespaces', 'copilot', 'models', 'customer-stories',
  'team', 'solutions', 'resources', 'partners', 'premium', 'nonprofit', 'education',
]);

/**
 * Разбирает путь GitHub.
 * @returns {{owner:string, repo:string, ref:string|null}|null}
 */
export function repoFromPath(pathname) {
  if (!pathname) return null;
  const path = String(pathname).split('?')[0].split('#')[0];
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repoRaw = parts[1];
  if (!owner || !repoRaw) return null;
  if (owner.startsWith('.') || owner.startsWith('-')) return null;
  if (repoRaw.startsWith('-')) return null;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const repo = repoRaw.replace(/\.git$/i, '');
  if (!repo) return null;
  const rest = parts.slice(2);
  let ref = null;
  if (rest.length >= 2 && (rest[0] === 'tree' || rest[0] === 'blob')) {
    try {
      ref = decodeURIComponent(rest[1]);
    } catch {
      ref = rest[1];
    }
  } else if (rest.length >= 3 && rest[0] === 'releases' && rest[1] === 'tag') {
    try {
      ref = decodeURIComponent(rest[2]);
    } catch {
      ref = rest[2];
    }
  }
  return { owner, repo, ref };
}