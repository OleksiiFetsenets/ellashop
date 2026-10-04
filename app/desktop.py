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


# Start one local server, focus an existing window when present, and own shutdown.
# Restart the process after an installed update requests a new code version.
def main():
    import webview

    httpd, already_running = server.acquire_server()
    if already_running:
        return
    with httpd:
        server.prepare()
        url = f"http://127.0.0.1:{httpd.server_port}"
        window = webview.create_window("Ellashop", url, width=1400, height=900,
                                       min_size=(1100, 700))

        def focus():
            window.show()
            window.restore()

        httpd.focus_hook = focus
        httpd.restart_hook = window.destroy
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            webview.start(private_mode=False, storage_path=str(server.DATA / ".webview"),
                          icon=str(server.STATIC / "icon.png"))
        finally:
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
