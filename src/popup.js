import { formatInt } from './loc/format.js';

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const FIELDS = [
  'autoEstimate', 'showPerLanguage', 'autoAuth', 'countBlankLines', 'countCommentLines',
  'maxArchiveMB', 'maxFileMB', 'token',
];

let statusTimer = 0;

function setStatus(text, isError = false) {
  const node = $('status');
  node.textContent = text;
  node.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => setStatus(''), 2500);
}

function send(message) {
  return ext.runtime.sendMessage(message).catch(() => null);
}

function fill(settings) {
  $('autoEstimate').checked = settings.autoEstimate !== false;
  $('autoAuth').checked = settings.autoAuth !== false;
  $('showPerLanguage').checked = settings.showPerLanguage !== false;
  $('countBlankLines').checked = settings.countBlankLines !== false;
  $('countCommentLines').checked = settings.countCommentLines !== false;
  $('maxArchiveMB').value = settings.maxArchiveMB;
  $('maxFileMB').value = settings.maxFileMB;
  $('token').value = settings.token || '';
}

function collect() {
  return {
    autoEstimate: $('autoEstimate').checked,
    autoAuth: $('autoAuth').checked,
    showPerLanguage: $('showPerLanguage').checked,
    countBlankLines: $('countBlankLines').checked,
    countCommentLines: $('countCommentLines').checked,
    maxArchiveMB: Number($('maxArchiveMB').value),
    maxFileMB: Number($('maxFileMB').value),
    token: $('token').value.trim(),
  };
}

async function save() {
  const res = await send({ type: 'setSettings', settings: collect() });
  if (!res || !res.ok) {
    setStatus('Не удалось сохранить', true);
    return;
  }
  fill(res.settings);
  setStatus('Сохранено');
}

let saveTimer = 0;
let authTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function refreshAuth() {
  const node = $('authStatus');
  const res = await send({ type: 'authStatus' });
  if (!res || !res.ok) {
    node.textContent = 'Не удалось проверить вход на GitHub';
    return;
  }
  if (res.source === 'offline') {
    node.textContent = 'GitHub недоступен — проверить вход не удалось';
  } else if (res.authenticated) {
    node.textContent = res.source === 'token'
      ? 'Вход: по токену из настроек'
      : `Вход на GitHub обнаружен — лимит ${formatInt(res.limit)} запросов/час`;
  } else {
    node.textContent = res.autoAuth
      ? 'Вход на GitHub не обнаружен — лимит 60 запросов/час (можно указать токен)'
      : 'Автовход выключен — лимит 60 запросов/час';
  }
}

async function refreshStats() {
  const res = await send({ type: 'cacheStats' });
  if (!res || !res.ok) {
    $('stats').textContent = 'Кэш: нет данных';
    return;
  }
  $('stats').textContent =
    `Кэш: точных ${formatInt(res.exact)}, оценок ${formatInt(res.estimate)}, `
    + `мета ${formatInt(res.meta)}`;
}

async function init() {
  const res = await send({ type: 'getSettings' });
  if (res && res.ok) fill(res.settings);
  else setStatus('Нет связи с расширением', true);
  await refreshStats();
  await refreshAuth();

  for (const id of FIELDS) {
    const node = $(id);
    node.addEventListener('change', () => {
      saveSoon();
      if (id === 'autoAuth' || id === 'token') {
        clearTimeout(authTimer);
        authTimer = setTimeout(refreshAuth, 700);
      }
    });
    if (node.type === 'password' || node.type === 'number') node.addEventListener('input', saveSoon);
  }

  $('count').addEventListener('click', async () => {
    const out = await send({ type: 'countActiveTab' });
    if (out && out.ok) setStatus('Считаю на вкладке…');
    else setStatus((out && out.error && out.error.message) || 'Не получилось', true);
  });

  $('clear').addEventListener('click', async () => {
    const out = await send({ type: 'clearCache' });
    if (out && out.ok) {
      setStatus(`Удалено записей: ${formatInt(out.removed)}`);
      await refreshStats();
    } else {
      setStatus('Не удалось очистить', true);
    }
  });
}

init();