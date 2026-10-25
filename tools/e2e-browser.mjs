#!/usr/bin/env node
// E2E: поднимает headless Chromium с загруженным расширением, открывает живой github.com,
// ждёт панель под «Languages», гоняет точный подсчёт на локальной фикстуре (debugTarballUrl),
// проверяет popup и снимает скриншот панели. Управление — через CDP по WebSocket (без зависимостей).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixture, EXPECTED } from './make-e2e-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOCS = resolve(ROOT, 'docs');

const args = process.argv.slice(2);
const REPO = (args.find((a) => a.startsWith('--repo=')) || '--repo=octocat/Spoon-Knife').split('=')[1];
const CHROME = process.env.CHROME || 'chromium-browser';
const SKIP_SCREENSHOT = args.includes('--no-screenshot');
const HEADLESS = !args.includes('--headed');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: done, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else done(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`не удалось подключиться к ${url}`)), 15000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        ok();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        fail(new Error(`ошибка WebSocket ${url}`));
      }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.seq;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          fail(new Error(`таймаут CDP: ${method}`));
        }
      }, timeoutMs);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function http(port, pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const message = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error(`ошибка в странице: ${message}`);
  }
  return res.result?.value;
}

async function waitFor(fn, { timeout = 40000, interval = 300, label = 'условие' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await sleep(interval);
  }
  throw new Error(`таймаут ${timeout} мс: ${label}${lastError ? ` (последняя ошибка: ${lastError.message})` : ''}`);
}

// ------------------------------------------------------------------ браузер

async function launchBrowser() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'ghloc-e2e-'));
  const flags = [
    ...(HEADLESS ? ['--headless=new'] : []),
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1400,1000',
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const child = spawn(CHROME, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (e) => {
    stderr += `\nspawn error: ${e.message}`;
  });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  const port = await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`${CHROME} завершился: ${stderr.slice(-600)}`);
      if (!existsSync(portFile)) return null;
      const text = readFileSync(portFile, 'utf8').trim();
      return text ? Number(text.split('\n')[0]) : null;
    },
    { timeout: 25000, interval: 200, label: 'DevToolsActivePort' },
  );

  return {
    child,
    port,
    userDataDir,
    stderr: () => stderr,
    close() {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

async function openPage(port, url) {
  const target = await http(port, `/json/new?${encodeURIComponent(url)}`, 'PUT');
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(`не удалось открыть страницу ${url}: ${JSON.stringify(target).slice(0, 200)}`);
  }
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { cdp, target };
}

// ------------------------------------------------------------------ основной сценарий

async function main() {
  console.log('[ghloc] e2e: расширение', ROOT);
  const fixture = writeFixture();
  console.log(`[ghloc] фикстура: ${fixture.tarball} (${fixture.bytes} байт), эталон: ${EXPECTED.total} строк`);

  const browser = await launchBrowser();
  console.log(`[ghloc] Chromium запущен, CDP порт ${browser.port}`);

  const report = {
    startedAt: new Date().toISOString(),
    repo: REPO,
    fixture: { ...fixture, expected: EXPECTED },
    browser: { chrome: CHROME, port: browser.port, headless: HEADLESS },
    checks: results,
    consoleErrors: [],
  };

  try {
    // 1. service worker расширения
    const sw = await waitFor(
      async () => {
        const targets = await http(browser.port, '/json/list');
        return (Array.isArray(targets) ? targets : []).find(
          (t) => t.type === 'service_worker' && String(t.url).includes('/src/background.js'),
        );
      },
      { timeout: 25000, label: 'service worker расширения' },
    );
    const extensionId = new URL(sw.url).host;
    check('service worker загружен', true, `${extensionId}`);
    report.extensionId = extensionId;

    const swCdp = await Cdp.open(sw.webSocketDebuggerUrl);
    await swCdp.send('Runtime.enable');
    // Ранний attach ловит SW до того, как Chrome подключит extension-API (в chrome есть только page-API).
    await waitFor(
      async () =>
        (await evaluate(
          swCdp,
          `typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.getURL === 'function'`,
        )) === true,
      { timeout: 15000, interval: 200, label: 'инициализация extension API в service worker' },
    );

    const swErrors = [];
    swCdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        swErrors.push(msg.params?.exceptionDetails?.exception?.description || 'исключение в SW');
      }
    });

    // 2. подменяем tarball на локальную фикстуру
    const fixtureUrl = await evaluate(
      swCdp,
      `chrome.runtime.getURL(${JSON.stringify('docs/e2e-fixture.tar.gz')})`,
    );
    await evaluate(
      swCdp,
      `chrome.storage.local.set({'ghloc.settings.v1': {debugTarballUrl: ${JSON.stringify(fixtureUrl)}, autoEstimate: true, countBlankLines: true, countCommentLines: true, showPerLanguage: true, maxArchiveMB: 120, maxFileMB: 5, token: ''}}).then(() => 'ok')`,
    );
    check('настройки записаны в storage', true, fixtureUrl);

    // 3. живая страница репозитория
    const page = await openPage(browser.port, `https://github.com/${REPO}`);
    const pageErrors = [];
    const pageLogs = [];
    page.cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(msg.params?.exceptionDetails?.exception?.description || 'исключение на странице');
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params?.args || [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ');
        if (text.includes('[ghloc]')) pageLogs.push(text);
      }
    });

    const panelText = await waitFor(
      async () => {
        const text = await evaluate(
          page.cdp,
          `(() => { const p = document.querySelector('[data-ghloc]'); return p ? p.innerText : ''; })()`,
        );
        return text && text.trim().length > 3 && !text.startsWith('…') ? text : null;
      },
      { timeout: 45000, label: 'панель под Languages на живом github.com' },
    );
    check('панель вставлена под «Languages»', true, panelText.split('\n').slice(0, 2).join(' | '));
    report.panelAfterEstimate = panelText;

    let perLanguage = [];
    try {
      perLanguage = await waitFor(
        async () => {
          const rows = await evaluate(
            page.cdp,
            `Array.from(document.querySelectorAll('.ghloc-lang-lines')).map(n => n.textContent)`,
          );
          return Array.isArray(rows) && rows.length > 0 ? rows : null;
        },
        { timeout: 25000, interval: 250, label: 'подписи строк у языков' },
      );
    } catch {
      perLanguage = [];
    }
    check('строки добавлены к языкам', perLanguage.length > 0, JSON.stringify(perLanguage));

    // 4. точный подсчёт на фикстуре
    const clicked = await evaluate(
      page.cdp,
      `(() => { const b = document.querySelector('.ghloc-btn-primary'); if (!b) return false; b.click(); return true; })()`,
    );
    check('кнопка «Точный подсчёт» нажата', clicked);

    let exactText = null;
    try {
      exactText = await waitFor(
        async () => {
          const text = await evaluate(
            page.cdp,
            `(() => { const p = document.querySelector('[data-ghloc]'); return p ? p.innerText : ''; })()`,
          );
          return text.includes('точно') ? text : null;
        },
        { timeout: 45000, label: 'результат точного подсчёта' },
      );
    } catch (e) {
      const dump = await evaluate(
        page.cdp,
        `(() => { const p = document.querySelector('[data-ghloc]'); return { panel: p ? p.innerText : null, error: (document.querySelector('.ghloc-error') || {}).textContent || '' }; })()`,
      );
      console.log('[ghloc] диагностика панели:', JSON.stringify(dump, null, 2));
      console.log('[ghloc] сообщения [ghloc] со страницы:', pageLogs.slice(-8).join('\n') || '(нет)');
      report.diagnostics = { ...dump, pageLogs };
      throw e;
    }
    report.panelAfterExact = exactText;

    const totalText = await evaluate(page.cdp, `document.querySelector('.ghloc-total').textContent`);
    const expectedLabel = `${EXPECTED.total} ${EXPECTED.total % 10 === 3 ? 'строки' : 'строк'}`;
    check('точный итог совпал с эталоном фикстуры', totalText.includes(String(EXPECTED.total)),
      `панель: «${totalText}», эталон: «${expectedLabel}»`);

    await evaluate(page.cdp, `(() => { const b = document.querySelectorAll('.ghloc-btn')[2]; if (b) b.click(); return true; })()`);
    const detailRows = await evaluate(
      page.cdp,
      `Array.from(document.querySelectorAll('.ghloc-details-row')).map(r => r.innerText.replace(/\\s+/g,' '))`,
    );
    report.details = detailRows;
    const detailsOk = Object.entries(EXPECTED.perLanguage).every(([lang, stats]) =>
      (detailRows || []).some((row) => row.startsWith(lang) && row.includes(String(stats.lines))),
    );
    check('разбивка по языкам совпала', detailsOk, JSON.stringify(detailRows));

    // 5. скриншот виджета
    if (!SKIP_SCREENSHOT) {
      try {
        mkdirSync(DOCS, { recursive: true });
        const shot = await page.cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: await evaluate(
            page.cdp,
            `(() => { const row = document.querySelector('[data-ghloc]').closest('.BorderGrid-row') || document.querySelector('[data-ghloc]'); const r = row.getBoundingClientRect(); return { x: Math.max(0, r.x + window.scrollX - 12), y: Math.max(0, r.y + window.scrollY - 12), width: Math.min(560, r.width + 24), height: r.height + 24, scale: 2 }; })()`,
          ),
        });
        const file = resolve(DOCS, 'screenshot-github.png');
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        check('скриншот панели сохранён', true, file);
        report.screenshot = file;
      } catch (e) {
        check('скриншот панели сохранён', false, e.message);
      }
    }

    // 6. popup
    const popup = await openPage(browser.port, `chrome-extension://${extensionId}/src/popup.html`);
    const popupState = await waitFor(
      async () => {
        const state = await evaluate(
          popup.cdp,
          `({ title: document.querySelector('h1')?.textContent || '', stats: document.querySelector('#stats')?.textContent || '', token: Boolean(document.querySelector('#token')), count: Boolean(document.querySelector('#count')) })`,
        );
        return state.stats.includes('точных') ? state : null;
      },
      { timeout: 20000, label: 'popup с настройками и статистикой кэша' },
    );
    check('popup открывается и читает настройки', popupState.title === 'GitHub LOC' && popupState.count,
      `${popupState.title} / ${popupState.stats}`);
    const popupErrors = await evaluate(
      popup.cdp,
      `window.__ghlocErrors ? window.__ghlocErrors.length : 0`,
    );
    check('в popup нет исключений', popupErrors === 0);
    popup.cdp.close();

    check('на странице github.com нет исключений расширения', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));
    check('в service worker нет исключений', swErrors.length === 0, swErrors.slice(0, 3).join(' | '));
    report.consoleErrors = [...pageErrors, ...swErrors];

    page.cdp.close();
    swCdp.close();
  } finally {
    const failed = results.filter((r) => !r.ok);
    report.finishedAt = new Date().toISOString();
    report.passed = results.length - failed.length;
    report.failed = failed.length;
    mkdirSync(DOCS, { recursive: true });
    writeFileSync(resolve(DOCS, 'e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    browser.close();

    console.log(`\n[ghloc] итог: ${report.passed} ok, ${report.failed} fail. Отчёт: docs/e2e-report.json`);
    if (failed.length) {
      console.log('[ghloc] ПАДЕНИЯ:');
      for (const f of failed) console.log(`   - ${f.name} ${f.detail}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error('[ghloc] e2e упал:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});