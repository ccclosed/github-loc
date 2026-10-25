// Service worker: сеть, кэш, точный подсчёт. Весь тяжёлый I/O — здесь:
// content script в MV3 подчиняется CORS страницы, поэтому tarball качаем только отсюда.
import { countTarball } from './loc/count.js';
import { estimateLines } from './loc/estimate.js';
import { normalizeSettings, countOptionsFrom } from './loc/settings.js';

const ext = globalThis.browser ?? globalThis.chrome;

const SETTINGS_KEY = 'ghloc.settings.v1';
const META_KEY = (owner, repo) => `ghloc.meta.v1.${owner}/${repo}`;
const EST_KEY = (owner, repo, ref) => `ghloc.est.v1.${owner}/${repo}@${ref}`;
const LOC_KEY = (owner, repo, ref) => `ghloc.loc.v1.${owner}/${repo}@${ref}`;

const TTL = {
  meta: 6 * 60 * 60 * 1000,
  estimate: 24 * 60 * 60 * 1000,
  exact: 7 * 24 * 60 * 60 * 1000,
};

// Состояние авторизации: узнаём его из заголовка x-ratelimit-limit, не читая cookies.
// 60 запросов/час — анонимно, 5000+/час — вход на github.com или токен.
const authState = { checked: false, authenticated: false, limit: 0, source: 'unknown' };

function noteAuthFrom(res, settings) {
  const limit = Number(res.headers.get('x-ratelimit-limit') || 0);
  if (settings.token) {
    authState.checked = true;
    authState.authenticated = true;
    authState.limit = limit || 5000;
    authState.source = 'token';
    return;
  }
  if (!Number.isFinite(limit) || limit <= 0) return;
  authState.checked = true;
  authState.limit = limit;
  authState.authenticated = limit > 100;
  authState.source = authState.authenticated ? 'session' : 'anonymous';
}

/** Нужно ли отправлять cookies github.com вместе с запросом (вход в GitHub). */
function useCookies(settings) {
  return !settings.token && settings.autoAuth !== false;
}

function appError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function describeError(e) {
  if (!e) return { code: 'unknown', message: 'Неизвестная ошибка.' };
  if (e.name === 'AbortError') return { code: 'aborted', message: 'Подсчёт отменён.' };
  const code = typeof e.code === 'string' ? e.code : 'unknown';
  if (e.message) return { code, message: e.message };
  const fallback = {
    not_found: 'Репозиторий не найден.',
    private: 'Приватный репозиторий: нужен токен GitHub в настройках расширения.',
    rate_limit: 'GitHub ограничил запросы. Добавьте токен в настройках расширения.',
    too_large: 'Архив слишком большой для точного подсчёта.',
    network: 'Не удалось скачать данные с GitHub.',
    aborted: 'Подсчёт отменён.',
  };
  return { code, message: fallback[code] ?? 'Что-то пошло не так.' };
}

// ------------------------------------------------------------------ настройки и кэш

async function getSettings() {
  const raw = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(raw ? raw[SETTINGS_KEY] : null);
}

async function saveSettings(patch) {
  const next = normalizeSettings({ ...(await getSettings()), ...(patch || {}) });
  await ext.storage.local.set({ [SETTINGS_KEY]: next });
  // токен/режим авторизации могли измениться — перепроверим на следующем запросе
  authState.checked = false;
  authState.source = 'unknown';
  return next;
}

/** Проверяет, авторизован ли браузер на github.com (по лимиту API), без чтения cookies. */
async function probeAuth() {
  const settings = await getSettings();
  if (settings.token) {
    authState.checked = true;
    authState.authenticated = true;
    authState.source = 'token';
    return authState;
  }
  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: apiHeaders(settings),
      credentials: useCookies(settings) ? 'include' : 'omit',
      cache: 'no-store',
    });
    noteAuthFrom(res, settings);
  } catch {
    authState.checked = true;
    authState.authenticated = false;
    authState.source = 'offline';
  }
  return authState;
}

async function cacheGet(key, ttl) {
  const raw = await ext.storage.local.get(key);
  const entry = raw ? raw[key] : null;
  if (!entry || typeof entry !== 'object') return null;
  if (ttl && typeof entry.ts === 'number' && Date.now() - entry.ts > ttl) return null;
  return entry;
}

async function cacheSet(key, value) {
  await ext.storage.local.set({ [key]: { ...value, ts: Date.now() } });
}

// ------------------------------------------------------------------ GitHub API

function apiHeaders(settings) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  return headers;
}

async function ghJson(url, settings, signal) {
  let res;
  try {
    res = await fetch(url, {
      headers: apiHeaders(settings),
      signal,
      credentials: useCookies(settings) ? 'include' : 'omit',
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw appError('aborted', 'Подсчёт отменён.');
    throw appError('network', 'Нет связи с api.github.com.');
  }
  noteAuthFrom(res, settings);
  if (res.status === 404) {
    throw appError('not_found', 'Репозиторий не найден или приватный (нужен токен).');
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw appError(
      'rate_limit',
      remaining === '0'
        ? 'Исчерпан лимит GitHub API (60 запросов в час без токена). Добавьте токен в настройках расширения.'
        : 'GitHub отклонил запрос (403/429). Попробуйте позже или добавьте токен.',
    );
  }
  if (!res.ok) throw appError('network', `GitHub API ответил ${res.status}.`);
  return res.json();
}

async function getMeta(owner, repo, settings, signal) {
  const key = META_KEY(owner, repo);
  const hit = await cacheGet(key, TTL.meta);
  if (hit) return hit;
  const data = await ghJson(`https://api.github.com/repos/${owner}/${repo}`, settings, signal);
  const meta = {
    default_branch: data.default_branch || 'HEAD',
    size_kb: Number(data.size) || 0,
    private: Boolean(data.private),
    pushed_at: data.pushed_at || null,
  };
  await cacheSet(key, meta);
  return meta;
}

// ------------------------------------------------------------------ оценка

async function buildEstimate(owner, repo, ref, settings, signal) {
  const meta = await getMeta(owner, repo, settings, signal);
  const useRef = ref || meta.default_branch;

  const exact = await cacheGet(LOC_KEY(owner, repo, resolveRef(useRef)), TTL.exact);
  if (exact && exact.result) {
    return {
      ok: true,
      method: 'exact',
      total: exact.result.total,
      perLanguage: exact.result.perLanguage,
      result: exact.result,
      cached: true,
      ref: exact.ref || useRef,
      meta,
    };
  }

  const estKey = EST_KEY(owner, repo, resolveRef(useRef));
  const cachedEstimate = await cacheGet(estKey, TTL.estimate);
  if (cachedEstimate) {
    return {
      ok: true,
      method: 'estimate',
      total: cachedEstimate.total,
      perLanguage: cachedEstimate.perLanguage,
      cached: true,
      ref: useRef,
      meta,
    };
  }

  const bytes = await ghJson(
    `https://api.github.com/repos/${owner}/${repo}/languages`,
    settings,
    signal,
  );
  const estimate = estimateLines(bytes);
  await cacheSet(estKey, estimate);
  return {
    ok: true,
    method: 'estimate',
    total: estimate.total,
    perLanguage: estimate.perLanguage,
    cached: false,
    ref: useRef,
    meta,
  };
}

// ref может быть веткой («main») или коммитом; для кэша нормализуем регистр и слэши.
function resolveRef(ref) {
  return String(ref || 'HEAD').replace(/\s+/g, '');
}

// ------------------------------------------------------------------ точный подсчёт

async function runExactCount(job, { owner, repo, ref, force }) {
  const settings = await getSettings();
  const meta = await getMeta(owner, repo, settings, job.signal);
  const useRef = ref || meta.default_branch;

  if (!force) {
    const hit = await cacheGet(LOC_KEY(owner, repo, resolveRef(useRef)), TTL.exact);
    if (hit && hit.result) {
      job.port.postMessage({
        type: 'count',
        ok: true,
        cached: true,
        ref: hit.ref || useRef,
        elapsedMs: 0,
        result: hit.result,
      });
      return;
    }
  }

  const url = tarballUrl(owner, repo, useRef, settings);
  job.port.postMessage({
    type: 'progress',
    phase: 'meta',
    bytes: 0,
    files: 0,
    message: 'Запрашиваю архив…',
  });

  const headers = { Accept: '*/*' };
  const useToken = Boolean(settings.token) && !settings.debugTarballUrl;
  if (useToken && url.startsWith('https://api.github.com/')) {
    headers.Authorization = `Bearer ${settings.token}`;
    headers.Accept = 'application/vnd.github+json';
  }
  // Приватные репозитории отдаются только через api.github.com; вход — по cookies сессии.
  const sendCookies = !settings.debugTarballUrl && useCookies(settings);

  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: job.signal,
      credentials: sendCookies ? 'include' : 'omit',
      redirect: 'follow',
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw appError('aborted', 'Подсчёт отменён.');
    throw appError('network', 'Не удалось начать загрузку архива.');
  }
  if (res.status === 404) {
    throw meta.private
      ? appError('private', 'Приватный репозиторий: добавьте токен GitHub в настройках расширения.')
      : appError('not_found', 'GitHub не отдал архив (404). Возможно, репозиторий пуст.');
  }
  if (res.status === 403 || res.status === 429) {
    throw appError('rate_limit', 'GitHub ограничил загрузку архива. Добавьте токен в настройках.');
  }
  if (!res.ok || !res.body) throw appError('network', `Не удалось скачать архив (${res.status}).`);

  const limitBytes = settings.maxArchiveMB * 1024 * 1024;
  const started = Date.now();
  let compressed = 0;
  let lastMessage = 0;

  const metered = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        compressed += chunk.length;
        if (compressed > limitBytes) {
          job.limitHit = true;
          try {
            job.controller.abort();
          } catch {
            /* уже отменено */
          }
          controller.error(
            appError('too_large', `Архив больше ${settings.maxArchiveMB} МБ — точный подсчёт остановлен.`),
          );
          return;
        }
        controller.enqueue(chunk);
        const now = Date.now();
        if (now - lastMessage > 250) {
          lastMessage = now;
          job.port.postMessage({
            type: 'progress',
            phase: 'download',
            bytes: compressed,
            files: 0,
            message: 'Скачиваю архив…',
          });
        }
      },
    }),
  );

  let result;
  try {
    const gunzipped = metered.pipeThrough(new DecompressionStream('gzip'));
    result = await countTarball(gunzipped, {
      options: countOptionsFrom(settings),
      signal: job.signal,
      onProgress: (p) => {
        job.port.postMessage({
          type: 'progress',
          phase: 'parse',
          bytes: p.bytes,
          compressed,
          files: p.files,
          message: 'Считаю строки…',
        });
      },
    });
  } catch (e) {
    if (job.limitHit) {
      throw appError('too_large', `Архив больше ${settings.maxArchiveMB} МБ — точный подсчёт остановлен.`);
    }
    if (e && e.name === 'AbortError') throw appError('aborted', 'Подсчёт отменён.');
    if (e && e.code === 'aborted') throw appError('aborted', 'Подсчёт отменён.');
    if (e && e.code === 'too_large') throw e;
    if (e && e.code === 'truncated') throw appError('network', 'Архив пришёл обрезанным — попробуйте ещё раз.');
    throw appError('unknown', `Не удалось распаковать архив: ${e && e.message ? e.message : 'неизвестная ошибка'}`);
  }

  await cacheSet(LOC_KEY(owner, repo, resolveRef(useRef)), { result, ref: useRef });
  job.port.postMessage({
    type: 'count',
    ok: true,
    cached: false,
    ref: useRef,
    elapsedMs: Date.now() - started,
    compressedBytes: compressed,
    result,
  });
}

function tarballUrl(owner, repo, ref, settings) {
  if (settings.debugTarballUrl) return settings.debugTarballUrl;
  const safeRef = encodeURIComponent(ref);
  // Токен или вход на github.com (cookies) — идём через api.github.com:
  // именно этот эндпоинт умеет отдавать приватные архивы с сессионной авторизацией.
  const authenticated = Boolean(settings.token) || (settings.autoAuth !== false && authState.authenticated);
  if (authenticated) {
    return `https://api.github.com/repos/${owner}/${repo}/tarball/${safeRef}`;
  }
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${safeRef}`;
}

// ------------------------------------------------------------------ порт из content script

const jobs = new Map();

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ghloc') return;

  const job = {
    port,
    controller: new AbortController(),
    limitHit: false,
    busy: false,
    get signal() {
      return job.controller.signal;
    },
  };
  jobs.set(port, job);

  port.onDisconnect.addListener(() => {
    jobs.delete(port);
    try {
      job.controller.abort();
    } catch {
      /* ignore */
    }
  });

  port.onMessage.addListener((msg) => {
    handlePortMessage(job, msg).catch((e) => {
      try {
        port.postMessage({ type: 'error', error: describeError(e) });
      } catch {
        /* порт закрыт */
      }
    });
  });
});

async function handlePortMessage(job, msg) {
  if (!msg || typeof msg !== 'object') return;
  const { port } = job;

  switch (msg.type) {
    case 'hello': {
      port.postMessage({ type: 'hello', settings: await getSettings() });
      return;
    }
    case 'settings': {
      const settings = await saveSettings(msg.settings);
      port.postMessage({ type: 'settings', ok: true, settings });
      return;
    }
    case 'estimate': {
      try {
        const settings = await getSettings();
        const estimate = await buildEstimate(msg.owner, msg.repo, msg.ref, settings, job.signal);
        port.postMessage({ type: 'estimate', ...estimate });
      } catch (e) {
        port.postMessage({ type: 'estimate', ok: false, error: describeError(e) });
      }
      return;
    }
    case 'cancel': {
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
      job.controller = new AbortController();
      port.postMessage({ type: 'cancelled' });
      return;
    }
    case 'count': {
      if (job.busy) {
        port.postMessage({ type: 'error', error: { code: 'busy', message: 'Подсчёт уже идёт.' } });
        return;
      }
      job.busy = true;
      job.limitHit = false;
      if (job.controller.signal.aborted) job.controller = new AbortController();
      try {
        await runExactCount(job, msg);
      } catch (e) {
        port.postMessage({ type: 'count', ok: false, error: describeError(e) });
      } finally {
        job.busy = false;
      }
      return;
    }
    default:
      port.postMessage({ type: 'error', error: { code: 'unknown', message: `Неизвестный запрос: ${msg.type}` } });
  }
}

// ------------------------------------------------------------------ одноразовые сообщения (popup)

async function handleOneShot(msg, sender) {
  switch (msg && msg.type) {
    case 'getSettings':
      return { ok: true, settings: await getSettings() };

    case 'setSettings':
      return { ok: true, settings: await saveSettings(msg.settings) };

    case 'clearCache': {
      const all = await ext.storage.local.get(null);
      const keys = Object.keys(all || {}).filter((k) => k.startsWith('ghloc.') && k !== SETTINGS_KEY);
      if (keys.length) await ext.storage.local.remove(keys);
      return { ok: true, removed: keys.length };
    }

    case 'authStatus': {
      const settings = await getSettings();
      const state = await probeAuth();
      return {
        ok: true,
        settings,
        authenticated: state.authenticated,
        source: state.source,
        limit: state.limit,
        hasToken: Boolean(settings.token),
        autoAuth: settings.autoAuth !== false,
      };
    }

    case 'cacheStats': {
      const all = await ext.storage.local.get(null);
      const stats = { exact: 0, estimate: 0, meta: 0 };
      for (const key of Object.keys(all || {})) {
        if (key.startsWith('ghloc.loc.')) stats.exact += 1;
        else if (key.startsWith('ghloc.est.')) stats.estimate += 1;
        else if (key.startsWith('ghloc.meta.')) stats.meta += 1;
      }
      return { ok: true, ...stats };
    }

    case 'countActiveTab': {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { ok: false, error: { code: 'no_tab', message: 'Нет активной вкладки.' } };
      try {
        await ext.tabs.sendMessage(tab.id, { type: 'ghloc:count' });
        return { ok: true, tabId: tab.id };
      } catch {
        return {
          ok: false,
          error: { code: 'no_content', message: 'Откройте страницу репозитория на github.com.' },
        };
      }
    }

    case 'openUrl': {
      const url = String(msg.url || '');
      if (!/^https?:\/\//.test(url)) return { ok: false, error: { code: 'bad_url', message: 'Некорректная ссылка.' } };
      await ext.tabs.create({ url });
      return { ok: true };
    }

    default:
      return { ok: false, error: { code: 'unknown', message: `Неизвестный запрос: ${msg && msg.type}` } };
  }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleOneShot(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: describeError(e) }));
  return true; // ответ асинхронный
});

// Прогреваем настройки, чтобы первый запуск не ждал инициализации хранилища.
getSettings().catch(() => {});