"""Native Ellashop window around the existing loopback HTTP server."""
# Opens server.py in a native window and routes focus to an existing instance.
# Keeps the local server and background helper tied to the window lifetime.

import multiprocessing
import os
from pathlib import Path
import sys
import threading


ROOT = Path(__file__).resolve().parent.parent
# Embeddable Python (Windows package) ignores the script folder when its ._pth file is present.
sys.path.insert(0, str(ROOT / "app"))
if os.name == "nt":
    os.environ.setdefault("ELLASHOP_DATA", str(Path.home() / "Documents" / "Ellashop"))
    if (ROOT / "models").is_dir():
        os.environ.setdefault("ELLASHOP_MODELS", str(ROOT / "models"))
# pythonw.exe has no console: keep output and crashes in a log instead of failing on a missing stderr.
if sys.stderr is None or sys.stdout is None:
    _log_dir = Path(os.environ.get("ELLASHOP_DATA") or ROOT / "photos")
    _log_dir.mkdir(parents=True, exist_ok=True)
    sys.stdout = sys.stderr = open(_log_dir / "ellashop.log", "a", encoding="utf-8", buffering=1)

import server

# Window icon: Windows (WinForms) needs an .ico; passing the PNG there stops the app from starting.
ICON = ROOT / "windows" / "ellashop.ico" if os.name == "nt" else server.STATIC / "icon.png"


# Start one local server, focus an existing window when present, and own shutdown.
# Restart the process after an installed update requests a new code version.
def main():
    # Imported here so the window library is only needed when this launcher runs.
    import webview

    httpd, already_running = server.acquire_server()
    if already_running:
        return
    with httpd:
        server.prepare()
        url = f"http://127.0.0.1:{httpd.server_port}"
        # Window opens at 1400x900 and cannot shrink below 1100x700 (the layout needs that width).
        window = webview.create_window(server.tr("server_window_title"), url, width=1400, height=900,
                                       min_size=(1100, 700))

        def focus():
            window.show()
            window.restore()

        # Hooks used by server.py: focus when a second launch happens, close the window to restart after an update.
        httpd.focus_hook = focus
        httpd.restart_hook = window.destroy
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            # Not private mode, with a fixed storage folder: the page's localStorage (last order, view
            # settings) survives restarts.
            webview.start(private_mode=False, storage_path=str(server.DATA / ".webview"),
                          icon=str(ICON) if ICON.is_file() else None)
        finally:
            # Window closed: stop the server thread and the background-removal helper.
            httpd.shutdown()
            worker.join()
            server.BACKGROUND_REMOVER.stop()
    if getattr(httpd, "restart_requested", False):
        os.execv(sys.executable, [sys.executable] + sys.argv)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    try:
        main()
    except BaseException:
        import traceback
        traceback.print_exc()
        raise
