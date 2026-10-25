#!/usr/bin/env node
// Сборка дистрибутива: dist/github-loc/ (только нужные файлы), zip и пакет для установки.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist');
const OUT = join(DIST, 'github-loc');

const FILES = ['manifest.json'];
const DIRS = ['src'];

function bytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of FILES) cpSync(join(ROOT, file), join(OUT, file));
for (const dir of DIRS) cpSync(join(ROOT, dir), join(OUT, dir), { recursive: true });

// скриншоты и прочее из docs/ в пакет не тянем — только README с инструкцией
const readme = `# GitHub LOC — установка

Расширение показывает под виджетом «Languages» на странице репозитория GitHub
общее число строк кода: мгновенную оценку по байтам из GitHub API и точный подсчёт
потоковым разбором tarball.

## Chromium / Chrome / Brave / Edge / Helium

1. Откройте \`chrome://extensions/\`.
2. Включите «Режим разработчика» (Developer mode).
3. «Загрузить распакованное расширение» (Load unpacked) и укажите папку \`dist/github-loc\`.
4. Откройте любой репозиторий на github.com — под списком языков появится панель.

Или запустите браузер сразу с расширением:

\`\`\`bash
chromium-browser --load-extension=${OUT} https://github.com/astral-sh/uv
\`\`\`

## Firefox

Временное дополнение: \`about:debugging\` → «Этот Firefox» → «Загрузить временное
дополнение» → выберите \`dist/firefox/manifest.json\`.

## Настройки

Иконка расширения → попап: токен GitHub (для приватных репозиториев и лимитов API),
лимиты архива и файла, учёт пустых строк и комментариев, очистка кэша.
`;
writeFileSync(join(OUT, 'README.txt'), readme);

// zip для переноса на другую машину
const zipPath = join(DIST, 'github-loc.zip');
rmSync(zipPath, { force: true });
try {
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: OUT, stdio: 'ignore' });
} catch (e) {
  console.warn('[ghloc] zip не создан:', e.message);
}

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
const total = ['src/background.js', 'src/content.js', 'src/loc/count.js', 'src/loc/tar.js']
  .map((f) => `${f.split('/').pop()}: ${bytes(join(OUT, f))} Б`);

console.log(`[ghloc] собрано: ${OUT}`);
console.log(`[ghloc] версия ${manifest.version}, файлов src: ${DIRS.length ? 'см. ниже' : ''}`);
for (const line of total) console.log(`        ${line}`);
console.log(`[ghloc] архив: ${zipPath} (${bytes(zipPath)} Б)`);
// ------------------------------------------------------------------ сборка для Firefox
// Firefox не поддерживает background.service_worker (MV3 event page) и ключ "key",
// поэтому манифест конвертируется, а файлы переиспользуются из той же папки src/.
const FFOUT = join(DIST, 'firefox');
rmSync(FFOUT, { recursive: true, force: true });
mkdirSync(FFOUT, { recursive: true });
cpSync(join(OUT, 'src'), join(FFOUT, 'src'), { recursive: true });

const ff = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
delete ff.key;
delete ff.minimum_chrome_version;
ff.background = { scripts: ['src/background.js'], type: 'module' };
ff.browser_specific_settings = {
  gecko: { id: 'github-loc@local', strict_min_version: '115.0' },
};
writeFileSync(join(FFOUT, 'manifest.json'), `${JSON.stringify(ff, null, 2)}\n`);
writeFileSync(join(FFOUT, 'README.txt'), readme.replaceAll(OUT, FFOUT));

console.log(`[ghloc] firefox: ${FFOUT} (MV3, background.scripts)`);
