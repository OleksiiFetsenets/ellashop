#!/bin/zsh
# Starts the local photo server in a desktop window on macOS.
# Falls back to the browser when the window package is unavailable.
# Double-click to start the Ellashop photo tool.
cd "$(dirname "$0")"
if [[ -x app/.venv/bin/python3 ]]; then
  if app/.venv/bin/python3 -c 'import webview' >/dev/null 2>&1; then
    exec app/.venv/bin/python3 app/desktop.py
  fi
  exec app/.venv/bin/python3 app/server.py
fi
exec python3 app/server.py
