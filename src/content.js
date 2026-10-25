// Content script: находит виджет «Languages» и добавляет под ним панель с числом строк.
// Классический скрипт (без ES-импортов), поэтому мини-хелперы форматирования продублированы
// и обязаны совпадать по поведению с src/loc/format.js.
(() => {
  'use strict';

  const ext = globalThis.browser ?? globalThis.chrome;
  const PANEL_ATTR = 'data-ghloc';
  const NBSP = '\u00A0';
  const log = (...args) => console.log('[ghloc]', ...args);

  // -------------------------------------------------------------- формат (копия src/loc/format.js)

  function formatInt(value) {
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
    return String(Math.round(value * 10) / 10).replace('.', ',');
  }

  function formatCompact(value) {
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

  function plural(n, forms) {
    const value = Math.abs(Math.round(Number(n) || 0)) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return forms[2];
    if (last === 1) return forms[0];
    if (last >= 2 && last <= 4) return forms[1];
    return forms[2];
  }

  function formatBytes(value) {
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

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    if (total < 1000) return `${total}${NBSP}мс`;
    const seconds = total / 1000;
    if (seconds < 10) return `${trimDecimal(seconds)}${NBSP}с`;
    if (seconds < 60) return `${Math.round(seconds)}${NBSP}с`;
    return `${Math.floor(seconds / 60)}${NBSP}мин ${Math.round(seconds % 60)}${NBSP}с`;
  }

  const RESERVED = new Set([
    'settings', 'orgs', 'organizations', 'marketplace', 'explore', 'topics', 'collections',
    'sponsors', 'notifications', 'new', 'login', 'logout', 'join', 'features', 'about', 'pricing',
    'security', 'enterprise', 'apps', 'dashboard', 'pulls', 'issues', 'codesearch', 'search',
    'users', 'account', 'projects', 'stars', 'trending', 'events', 'gist', 'site', 'contact',
    'git-lfs', 'assets', 'images', 'static', 'favicon.ico', 'robots.txt', 'sitemap.xml',
    'manifest.json', 'opensearch.xml', 'apple-touch-icon.png', 'fluidicon.png', 'readme', 'home',
    'watching', 'discussions', 'codespaces', 'copilot', 'models', 'customer-stories',
  ]);

  function repoFromPath(pathname) {
    const parts = String(pathname || '').split('?')[0].split('#')[0].split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repoRaw = parts[1];
    if (!owner || !repoRaw) return null;
    if (owner.startsWith('.') || owner.startsWith('-') || repoRaw.startsWith('-')) return null;
    if (RESERVED.has(owner.toLowerCase())) return null;
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
    }
    return { owner, repo, ref };
  }

  // -------------------------------------------------------------- состояние

  const state = {
    port: null,
    settings: null,
    repoKey: null,
    repo: null,
    panel: null,
    parts: null,
    data: null, // {method, total, perLanguage}
    busy: false,
    mountTimer: 0,
  };

  // -------------------------------------------------------------- порт в background

  function ensurePort() {
    if (state.port) return state.port;
    let port;
    try {
      port = ext.runtime.connect({ name: 'ghloc' });
    } catch (e) {
      log('нет связи с background:', e && e.message);
      return null;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
    });
    state.port = port;
    port.postMessage({ type: 'hello' });
    return port;
  }

  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello':
        state.settings = msg.settings;
        if (state.panel && state.settings && !state.settings.autoEstimate && !state.data) {
          setTotal('Нажмите «Точный подсчёт»', 'оценка отключена в настройках');
        }
        return;
      case 'estimate':
        if (msg.ok === false) {
          renderError(msg.error);
          return;
        }
        state.data = {
          method: msg.method,
          total: msg.total,
          perLanguage: msg.perLanguage,
        };
        renderData(Boolean(msg.cached));
        return;
      case 'progress':
        renderProgress(msg);
        return;
      case 'count':
        state.busy = false;
        if (msg.ok === false) {
          renderProgress(null);
          renderError(msg.error);
          renderButtons();
          return;
        }
        state.data = { method: 'exact', total: msg.result.total, perLanguage: msg.result.perLanguage };
        renderProgress(null);
        renderData(false, msg.result, msg.elapsedMs, msg.cached);
        renderButtons();
        return;
      case 'settings':
        state.settings = msg.settings;
        return;
      case 'cancelled':
        state.busy = false;
        renderProgress(null);
        renderButtons();
        setTotal('Подсчёт отменён', '');
        return;
      default:
        if (msg.error) renderError(msg.error);
    }
  }

  // -------------------------------------------------------------- поиск виджета

  const LANGUAGE_ROW_RE = /^(.+?)\s*\d+(?:[.,]\d+)?\s*%$/;

  /** Список языков внутри контейнера: ищем ul, чьи li похожи на «Язык 12.3%». */
  function findLanguageList(root) {
    if (!root) return null;
    const lists = root.querySelectorAll('ul');
    for (const ul of lists) {
      for (const li of ul.querySelectorAll('li')) {
        const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
        if (LANGUAGE_ROW_RE.test(text)) return ul;
      }
    }
    for (const ul of lists) if (ul.querySelector('li')) return ul;
    return null;
  }

  /**
   * Виджет «Languages» есть в двух разметках GitHub:
   * старая — .BorderGrid-row с ul, новая (React) — sidebarSection и languageList (CSS-модули).
   * Поэтому поднимаемся от заголовка вверх, пока не найдём контейнер с подходящим списком.
   */
  function findLanguagesWidget() {
    const headings = document.querySelectorAll('h2, h3');
    for (const heading of headings) {
      const text = (heading.textContent || '').trim().toLowerCase();
      if (text !== 'languages' && !text.startsWith('languages ')) continue;
      let node = heading.parentElement;
      for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
        const list = findLanguageList(node);
        if (list) return { heading, row: node, list };
      }
      const row = heading.closest('.BorderGrid-row') || heading.parentElement;
      return { heading, row, list: null };
    }
    return null;
  }

  function languageRows(list) {
    if (!list) return [];
    return Array.from(list.querySelectorAll('li'));
  }

  function languageNameFromRow(li) {
    const named = li.querySelector('[itemprop="keywords"]');
    if (named && named.textContent.trim()) return named.textContent.trim();
    const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(LANGUAGE_ROW_RE);
    return match ? match[1].trim() : null;
  }

  // -------------------------------------------------------------- отрисовка

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildPanel() {
    const panel = el('div', 'ghloc-panel');
    panel.setAttribute(PANEL_ATTR, '1');

    const mainRow = el('div', 'ghloc-row');
    const total = el('span', 'ghloc-total', '…');
    const note = el('span', 'ghloc-note', '');
    mainRow.append(total, note);

    const actions = el('div', 'ghloc-row ghloc-actions');
    const countBtn = el('button', 'ghloc-btn ghloc-btn-primary', 'Точный подсчёт');
    countBtn.type = 'button';
    const cancelBtn = el('button', 'ghloc-btn', 'Отмена');
    cancelBtn.type = 'button';
    cancelBtn.hidden = true;
    const detailsBtn = el('button', 'ghloc-btn', 'Подробнее');
    detailsBtn.type = 'button';
    detailsBtn.hidden = true;
    actions.append(countBtn, cancelBtn, detailsBtn);

    const progress = el('div', 'ghloc-progress');
    progress.hidden = true;
    const bar = el('div', 'ghloc-progress-bar');
    progress.append(bar);
    const progressText = el('div', 'ghloc-note ghloc-progress-text', '');
    progressText.hidden = true;

    const details = el('div', 'ghloc-details');
    details.hidden = true;

    const error = el('div', 'ghloc-error');
    error.hidden = true;
    error.setAttribute('role', 'status');

    panel.append(mainRow, actions, progress, progressText, error, details);

    countBtn.addEventListener('click', () => startCount(true));
    cancelBtn.addEventListener('click', () => {
      if (state.port) state.port.postMessage({ type: 'cancel' });
    });
    detailsBtn.addEventListener('click', () => {
      details.hidden = !details.hidden;
      detailsBtn.textContent = details.hidden ? 'Подробнее' : 'Свернуть';
    });

    return {
      panel, total, note, countBtn, cancelBtn, detailsBtn, progress, bar, progressText, details, error,
    };
  }

  function setTotal(text, note) {
    if (!state.parts) return;
    state.parts.total.textContent = text;
    state.parts.note.textContent = note || '';
  }

  function renderButtons() {
    if (!state.parts) return;
    const hasExact = state.data && state.data.method === 'exact';
    state.parts.countBtn.textContent = hasExact ? 'Обновить' : 'Точный подсчёт';
    state.parts.countBtn.disabled = state.busy;
    state.parts.cancelBtn.hidden = !state.busy;
    state.parts.detailsBtn.hidden = !(state.data && state.data.perLanguage);
  }

  function renderData(fromCache, rawResult, elapsedMs, cached) {
    if (!state.parts) return;
    const data = state.data;
    if (!data) return;
    const parts = state.parts;
    parts.error.hidden = true;

    const word = plural(data.total, ['строка', 'строки', 'строк']);
    if (data.method === 'exact') {
      const suffix = cached || fromCache ? ' (из кэша)' : '';
      const time = elapsedMs ? ` · за ${formatDuration(elapsedMs)}` : '';
      setTotal(`${formatInt(data.total)} ${word}`, `точно${suffix}${time}`);
      if (rawResult) {
        const skipped = rawResult.skipped
          ? ` · пропущено ${formatInt(rawResult.skipped)} (vendored, бинарные, крупные)`
          : '';
        parts.note.textContent = `точно${suffix} · ${rawResult.files} файлов${skipped}${time}`;
        if (rawResult.truncated) parts.note.textContent += ' · архив обрезан';
      }
    } else {
      setTotal(`≈ ${formatInt(data.total)} ${word}`, 'оценка по байтам из GitHub API');
    }

    renderPerLanguage();
    renderDetails(rawResult);
    renderButtons();
  }

  function renderProgress(msg) {
    if (!state.parts) return;
    const parts = state.parts;
    if (!msg) {
      parts.progress.hidden = true;
      parts.progressText.hidden = true;
      parts.bar.style.width = '0%';
      return;
    }
    state.busy = true;
    parts.progress.hidden = false;
    parts.progressText.hidden = false;
    parts.error.hidden = true;
    renderButtons();

    if (msg.phase === 'download') {
      parts.progress.classList.add('ghloc-indeterminate');
      parts.progressText.textContent = `Скачано ${formatBytes(msg.bytes)}`;
    } else if (msg.phase === 'parse') {
      parts.progress.classList.remove('ghloc-indeterminate');
      parts.progressText.textContent =
        `Считаю строки: ${formatInt(msg.files)} файлов, ${formatInt(msg.total || 0)} строк`;
    } else {
      parts.progress.classList.add('ghloc-indeterminate');
      parts.progressText.textContent = msg.message || 'Готовлю…';
    }
  }

  function renderError(error) {
    if (!state.parts || !error) return;
    state.parts.error.hidden = false;
    state.parts.error.textContent = error.message || 'Не удалось получить данные.';
    if (state.data) renderData(false);
  }

  /**
   * Подписи «· 812 тыс. строк» рядом с каждым языком.
   * В новой разметке GitHub li — display:inline, а ссылка внутри — inline-flex/nowrap,
   * поэтому подпись кладём ВНУТРЬ ссылки (после процентов): снаружи li она выпадает
   * из строки и визуально «переезжает» на соседний язык.
   */
  function renderPerLanguage() {
    if (!state.parts) return;
    const list = state.widgetList;
    if (!list) return;
    const enabled = !state.settings || state.settings.showPerLanguage !== false;
    const perLanguage = state.data ? state.data.perLanguage || {} : {};
    const lower = new Map(Object.keys(perLanguage).map((k) => [k.toLowerCase(), k]));

    for (const li of languageRows(list)) {
      const link = li.querySelector('a') || li;
      const existing = li.querySelector('.ghloc-lang-lines');
      const name = languageNameFromRow(li);
      const key = name ? lower.get(name.toLowerCase()) : null;
      if (!enabled || !key) {
        if (existing) existing.remove();
        continue;
      }
      const stats = perLanguage[key];
      const label = `· ${formatCompact(stats.lines)} ${plural(stats.lines, ['строка', 'строки', 'строк'])}`;
      const title = `${formatInt(stats.lines)} ${plural(stats.lines, ['строка', 'строки', 'строк'])}`
        + (stats.files !== undefined ? ` · ${formatInt(stats.files)} файлов` : '');
      if (existing) {
        existing.textContent = label;
        existing.title = title;
        if (existing.parentElement !== link) link.append(existing);
      } else {
        const span = el('span', 'ghloc-lang-lines', label);
        span.title = title;
        link.append(span);
      }
    }
  }

  function renderDetails(rawResult) {
    if (!state.parts) return;
    const parts = state.parts;
    const perLanguage = (state.data && state.data.perLanguage) || {};
    const entries = Object.entries(perLanguage).sort((a, b) => b[1].lines - a[1].lines);
    parts.details.textContent = '';
    if (entries.length === 0) {
      parts.details.hidden = true;
      parts.detailsBtn.hidden = true;
      return;
    }
    const head = el('div', 'ghloc-details-head');
    head.append(
      el('span', '', 'Язык'),
      el('span', '', 'Строк'),
      el('span', '', 'Файлов'),
    );
    parts.details.append(head);
    for (const [name, stats] of entries) {
      const row = el('div', 'ghloc-details-row');
      row.append(
        el('span', 'ghloc-details-name', name),
        el('span', 'ghloc-details-lines', formatInt(stats.lines)),
        el('span', 'ghloc-details-files', stats.files === undefined ? '—' : formatInt(stats.files)),
      );
      parts.details.append(row);
    }
    parts.detailsBtn.hidden = false;
    if (rawResult && rawResult.skipped) {
      const skipped = el(
        'div',
        'ghloc-details-skipped',
        `Пропущено файлов: ${formatInt(rawResult.skipped)} `
        + `(vendored ${formatInt(rawResult.skippedReasons.ignored)}, `
        + `бинарные ${formatInt(rawResult.skippedReasons.binary)}, `
        + `> лимита ${formatInt(rawResult.skippedReasons.tooLarge)}, `
        + `без языка ${formatInt(rawResult.skippedReasons.unknown)}, `
        + `не файлы ${formatInt(rawResult.skippedReasons.nonFile)})`,
      );
      parts.details.append(skipped);
    }
  }

  // -------------------------------------------------------------- действия

  function startEstimate() {
    const port = ensurePort();
    if (!port || !state.repo) return;
    setTotal('Считаю…', 'оценка по байтам');
    port.postMessage({
      type: 'estimate',
      owner: state.repo.owner,
      repo: state.repo.repo,
      ref: state.repo.ref,
    });
  }

  function startCount(force) {
    const port = ensurePort();
    if (!port || !state.repo || state.busy) return;
    state.busy = true;
    renderButtons();
    port.postMessage({
      type: 'count',
      owner: state.repo.owner,
      repo: state.repo.repo,
      ref: state.repo.ref,
      force: Boolean(force),
    });
  }

  // -------------------------------------------------------------- монтирование

  function mount() {
    try {
      const repo = repoFromPath(location.pathname);
      const existing = document.querySelector(`[${PANEL_ATTR}]`);

      if (!repo) {
        if (existing) existing.remove();
        state.panel = null;
        state.parts = null;
        state.repoKey = null;
        state.repo = null;
        state.widgetList = null;
        return;
      }

      const widget = findLanguagesWidget();
      if (!widget) {
        if (existing) {
          existing.remove();
          state.panel = null;
          state.parts = null;
        }
        return;
      }

      const key = `${repo.owner}/${repo.repo}@${repo.ref || ''}`;
      if (existing && state.repoKey === key && existing.isConnected) return;

      if (existing) existing.remove();
      state.repoKey = key;
      state.repo = repo;
      state.data = null;
      state.busy = false;
      state.widgetList = widget.list;

      const parts = buildPanel();
      state.parts = parts;
      state.panel = parts.panel;

      const anchor = widget.list || widget.heading;
      if (anchor && anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', parts.panel);
      } else {
        widget.row.append(parts.panel);
      }

      setTotal('Считаю…', '');
      ensurePort();
      const settings = state.settings;
      if (!settings || settings.autoEstimate !== false) {
        startEstimate();
      } else {
        setTotal('—', 'оценка отключена в настройках');
        renderButtons();
      }
    } catch (e) {
      log('ошибка монтирования:', e && e.message);
    }
  }

  function scheduleMount() {
    clearTimeout(state.mountTimer);
    state.mountTimer = setTimeout(() => {
      try {
        mount();
      } catch (e) {
        log('ошибка:', e && e.message);
      }
    }, 300);
  }

  window.addEventListener('turbo:load', scheduleMount, true);
  document.addEventListener('pjax:end', scheduleMount, true);
  window.addEventListener('popstate', scheduleMount, true);

  const observer = new MutationObserver(scheduleMount);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'ghloc:count') {
      startCount(false);
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  scheduleMount();
})();