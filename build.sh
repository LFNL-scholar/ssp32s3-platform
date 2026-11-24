#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Building frontend (web/)..."
cd "$ROOT_DIR/web"
if [ ! -d node_modules ]; then
    npm install
fi
npm run build

echo "==> Building ESP-IDF firmware..."
cd "$ROOT_DIR"
if [ -z "${IDF_PATH:-}" ]; then
    if [ -f "$HOME/.espressif/tools/activate_idf_v5.5.4.sh" ]; then
        # shellcheck source=/dev/null
        source "$HOME/.espressif/tools/activate_idf_v5.5.4.sh"
    elif [ -f "$HOME/.espressif/v5.5.4/esp-idf/export.sh" ]; then
        # shellcheck source=/dev/null
        source "$HOME/.espressif/v5.5.4/esp-idf/export.sh"
    else
        echo "Error: IDF_PATH is not set and ESP-IDF v5.5.4 activation script not found."
        exit 1
    fi
fi

if [ ! -f "$ROOT_DIR/sdkconfig" ]; then
    idf.py set-target esp32s3
fi
idf.py build
echo "==> Build complete!"
