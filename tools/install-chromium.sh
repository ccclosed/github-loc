#!/usr/bin/env bash
# Установка расширения в Chromium «по-настоящему»: подписанный CRX3 кладётся в профиль
# через механизм внешних расширений Chromium (External Extensions).
# Так расширение включается для ВСЕХ профилей браузера и переживает перезапуски,
# без флагов командной строки. Дополнительно создаётся launcher с --load-extension (запасной путь).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
CHROME_USER_DATA="${CHROME_USER_DATA:-$HOME/.config/chromium}"
EXT_DIR="${GH_LOC_EXT_DIR:-$HOME/.local/share/github-loc-extension}"
CRX_DIR="${GH_LOC_CRX_DIR:-$HOME/.local/share/github-loc}"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
CHROME_BIN="${CHROME_BIN:-/usr/bin/chromium-browser}"

echo "[ghloc] сборка дистрибутива и CRX3…"
node "$ROOT/tools/build.mjs" >/dev/null
node "$ROOT/tools/make-crx.mjs" >/dev/null

EXT_ID="$(tr -d '[:space:]' < "$ROOT/dist/extension-id.txt")"
VERSION="$(node -p "require('$ROOT/dist/github-loc/manifest.json').version")"

# 1. Распакованная копия (для --load-extension и ручной загрузки)
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -a "$ROOT/dist/github-loc/." "$EXT_DIR/"

# 2. CRX в стабильное место
mkdir -p "$CRX_DIR"
cp -f "$ROOT/dist/github-loc.crx" "$CRX_DIR/github-loc.crx"

# 3. Внешнее расширение Chromium: ставится во все профили при следующем запуске
mkdir -p "$CHROME_USER_DATA/External Extensions"
cat > "$CHROME_USER_DATA/External Extensions/$EXT_ID.json" <<JSON
{
  "external_crx": "$CRX_DIR/github-loc.crx",
  "external_version": "$VERSION"
}
JSON

# 4. Launcher и пункт меню (запасной путь, если политика браузера блокирует внешние CRX)
mkdir -p "$BIN_DIR" "$DESKTOP_DIR"
cat > "$BIN_DIR/github-loc-chromium" <<WRAP
#!/usr/bin/env bash
exec "$CHROME_BIN" --load-extension="$EXT_DIR" "\$@"
WRAP
chmod +x "$BIN_DIR/github-loc-chromium"

cat > "$DESKTOP_DIR/chromium-browser-ghloc.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Chromium (GitHub LOC)
GenericName=Web Browser
Comment=Chromium с расширением GitHub LOC
Exec=$BIN_DIR/github-loc-chromium %U
Icon=chromium-browser
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
DESK

echo "[ghloc] id расширения : $EXT_ID"
echo "[ghloc] версия        : $VERSION"
echo "[ghloc] CRX           : $CRX_DIR/github-loc.crx"
echo "[ghloc] External Ext. : $CHROME_USER_DATA/External Extensions/$EXT_ID.json"
echo "[ghloc] launcher      : $BIN_DIR/github-loc-chromium"
echo
echo "[ghloc] Готово. Внешние расширения подхватываются при запуске Chromium,"
echo "        поэтому после установки браузер нужно один раз перезапустить."