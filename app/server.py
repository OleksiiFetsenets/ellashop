"""Ellashop photo tool — local server for the printing office."""
# Serves the browser UI and local photo, order, workspace, and cleanup APIs.
# Owns optional face detection and background removal; desktop.py launches it in a window.
import http.server
import io
import importlib.util
import json
import multiprocessing
import mimetypes
import os
import re
import subprocess
import threading
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
import webbrowser
import zipfile
from datetime import datetime
from pathlib import Path
import update

# Hide OpenCV's harmless startup notices (e.g. "setPreferableTarget ... not supported") in the terminal.
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")

PORT = int(os.environ.get("ELLASHOP_PORT", "8765"))
APP = Path(__file__).parent
STATIC = APP / "static"
ROOT = APP.parent
DATA = Path(os.environ.get("ELLASHOP_DATA") or ROOT / "photos")
INCOMING = DATA / "incoming"
PRINT_READY = DATA / "print_ready"
ORDERS = DATA / "orders"
WORKSPACE = DATA / "workspace"
if os.environ.get("ELLASHOP_MODELS"):
    os.environ["U2NET_HOME"] = os.environ["ELLASHOP_MODELS"]
# Order ids look like 20260131-142530 (date-time), with -2, -3... added when two are created in one second.
ORDER_ID = re.compile(r"\d{8}-\d{6}(?:-\d+)?\Z")
# Held while creating orders/files and clearing workspaces so concurrent requests cannot interleave.
ORDER_LOCK = threading.Lock()
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".gif"}
BG_IDLE_SECONDS = 120  # helper process exits after this long without work, freeing ~2–5 GB
FACE_MODEL = APP / "models" / "face_detection_yunet_2023mar.onnx"
# One shared detector, created on first use; FACE_LOCK because OpenCV's detector is not thread-safe.
FACE_LOCK = threading.Lock()
FACE_DETECTOR = None


def _yunet(image, longest, pad):
    """Run YuNet on `image` padded by `pad`·size on each side and scaled to `longest` px.
    Returns raw rows mapped back to the unpadded image's pixel coordinates."""
    import cv2
    import numpy as np
    height, width = image.shape[:2]
    px, py = round(width * pad), round(height * pad)
    if pad:
        image = cv2.copyMakeBorder(image, py, py, px, px, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    ph, pw = image.shape[:2]
    scale = min(1.0, longest / max(pw, ph))
    small = cv2.resize(image, (max(1, round(pw * scale)), max(1, round(ph * scale)))) if scale < 1 else image
    sh, sw = small.shape[:2]
    global FACE_DETECTOR
    with FACE_LOCK:
        if FACE_DETECTOR is None:
            # Arguments: score threshold 0.6, NMS (overlap) threshold 0.3, keep at most 50 candidates.
            FACE_DETECTOR = cv2.FaceDetectorYN.create(str(FACE_MODEL), "", (sw, sh), 0.6, 0.3, 50)
        FACE_DETECTOR.setInputSize((sw, sh))
        _, found = FACE_DETECTOR.detect(small)
    # Each row has 15 values: x, y, w, h, five landmark (x, y) pairs, then the score.
    if found is None:
        return np.zeros((0, 15))
    rows = found.copy()
    rows[:, 0:14:2] = rows[:, 0:14:2] * pw / sw - px   # x, w (w offset fixed below), landmark xs
    rows[:, 1:14:2] = rows[:, 1:14:2] * ph / sh - py   # y, h, landmark ys
    rows[:, 2] += px; rows[:, 3] += py                  # w/h are sizes, not positions
    return rows


# Decode the image, retry weak close-up detections with padding, and return face landmarks.
# The browser uses these coordinates to place print crops and passport heads.
def detect_faces(image_bytes):
    import cv2
    import numpy as np
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(tr('server_decode_image'))
    height, width = image.shape[:2]
    # First pass: scaled to at most 1280 px, no padding.
    found = _yunet(image, 1280, 0)
    # YuNet misses faces that fill most of the frame (close-up passport selfies):
    # retry on a padded copy so the face looks smaller, and keep the more confident result.
    # Column 14 is the confidence score; below 0.8 counts as weak. The retry pads 50% on each side.
    if not len(found) or found[:, 14].max() < 0.8:
        padded = _yunet(image, 800, 0.5)
        if len(padded) and (not len(found) or padded[:, 14].max() > found[:, 14].max()):
            found = padded
    faces = []
    for face in found:
        x, y, w, h = (float(v) for v in face[:4])
        faces.append({"x": x, "y": y, "w": w, "h": h, "score": float(face[14]),
                      # YuNet landmarks 4..7: the person's right eye, then left eye
                      "eyes": [[float(face[4]), float(face[5])], [float(face[6]), float(face[7])]]})
    return {"width": width, "height": height, "faces": faces}


# Background-removal model: best edges and hair, ~16 s/photo on an M1.
BG_MODEL = "birefnet-portrait"


# Keep the removal model loaded in a child process and return each cutout over a pipe.
# Messages over the pipe: bytes in; ("ok", png_bytes) or ("error", text) out.
def _bg_worker(conn, model):
    """Helper process: load the background-removal model once, then cut out every image sent over the pipe."""
    import onnxruntime
    import rembg
    # No memory arena: the helper then holds ~2.4 GB between photos instead of
    # 5–7 GB, and runs slightly faster (measured on an M1, 3000×3000 photos).
    options = onnxruntime.SessionOptions()
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    session = rembg.new_session(model, sess_opts=options)
    while True:
        try:
            data = conn.recv_bytes()
        except EOFError:
            return
        try:
            conn.send(("ok", rembg.remove(data, session=session)))
        except Exception as e:  # bad image etc.: report it, keep the model loaded
            conn.send(("error", str(e)))


class BackgroundRemover:
    """Runs rembg in a separate process that is stopped after BG_IDLE_SECONDS without work.
    The model needs 2–5 GB of RAM while loaded; stopping the process gives all of it back,
    so the server sits at ~20 MB between customers. Requests are handled one at a time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.proc = self.conn = self.timer = None
        self.generation = 0
        self.model = None

    # Serialize requests so one helper session serves all cutouts.
    # Reset the idle deadline after each job; a dead helper is recreated on the next request.
    def remove(self, data):
        with self.lock:
            # generation counts requests; the idle timer only stops the helper if no newer request arrived.
            self.generation += 1
            if self.timer:
                self.timer.cancel()
            try:
                model = BG_MODEL
                if self.proc is None or not self.proc.is_alive():
                    self.model = model
                    ctx = multiprocessing.get_context("spawn")
                    self.conn, child = ctx.Pipe()
                    self.proc = ctx.Process(target=_bg_worker, args=(child, model), daemon=True)
                    self.proc.start()
                    child.close()
                self.conn.send_bytes(data)
                status, result = self.conn.recv()
            except (EOFError, OSError):  # helper died (e.g. out of memory): start fresh next time
                self._stop()
                raise RuntimeError(tr('server_background_stopped'))
            generation = self.generation
            self.timer = threading.Timer(BG_IDLE_SECONDS, self._stop_if_idle, args=(generation,))
            self.timer.daemon = True
            self.timer.start()
        if status != "ok":
            raise RuntimeError(result)
        return result

    # Stop only if no newer request has superseded this timer.
    def _stop_if_idle(self, generation):
        with self.lock:
            if generation == self.generation:  # no request arrived since this timer was set
                self._stop()

    def stop(self):
        """Release the helper process when the application closes."""
        with self.lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            self._stop()

    def _stop(self):
        if self.conn:
            self.conn.close()
        if self.proc:
            self.proc.join(5)
            if self.proc.is_alive():
                self.proc.kill()
        self.proc = self.conn = None


BACKGROUND_REMOVER = BackgroundRemover()

# Cached result of the update check, refreshed in the background at most once an hour (see update_status).
UPDATE_CACHE = {"value": {"enabled": False}, "checked": 0}
UPDATE_LOCK = threading.Lock()


# GitHub repo ("owner/name") from app/update.json; empty means update checks are off.
def update_repo():
    config = APP / "update.json"
    if not config.is_file():
        return ""
    return json.loads(config.read_text(encoding="utf-8")).get("repo", "")


def refresh_update():
    try:
        repo = update_repo()
        result = update.check(repo) if repo else {"enabled": False}
    except Exception as error:
        result = {"error": str(error)}
    with UPDATE_LOCK:
        UPDATE_CACHE.update(value=result, checked=time.time())


def update_status():
    with UPDATE_LOCK:
        result = UPDATE_CACHE["value"]
        stale = time.time() - UPDATE_CACHE["checked"] >= 3600
        if stale:
            UPDATE_CACHE["checked"] = time.time()
    if stale:
        threading.Thread(target=refresh_update, daemon=True).start()
    return result


def open_folder(path):
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    elif os.name == "nt":
        os.startfile(str(path))
    else:
        subprocess.Popen(["xdg-open", str(path)])


# Stop the server shortly after the response is sent; main() then re-executes the process.
def schedule_restart(server):
    server.restart_requested = True
    def stop():
        time.sleep(0.25)
        server.shutdown()
        if hook := getattr(server, "restart_hook", None):
            hook()
    threading.Thread(target=stop, daemon=True).start()

# Finished files are kept in hours (print them the same day), the working folders in days. 0 = off.
AUTO_CLEAN_DEFAULTS = {"incoming_days": 7, "orders_days": 0, "print_ready_hours": 12}
AUTO_CLEAN_LIMITS = {"incoming_days": 3650, "orders_days": 3650, "print_ready_hours": 87600}
AUTO_CLEAN_EVERY = 3600  # seconds between automatic clean-ups while the app is open
CLEAN_LOG = DATA / "cleanup.log"


# Accept only a whole number in range (bool and float are rejected); `unit` only picks the error text.
def clean_days(value, minimum=0, maximum=3650, unit="days"):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(tr('server_hours_integer_range' if unit == 'hours' else 'server_days_integer_range', minimum, maximum))
    return value


def auto_clean_value(key, value):
    return clean_days(value, 0, AUTO_CLEAN_LIMITS[key], "hours" if key.endswith("_hours") else "days")


# Retention settings from app/settings.json, defaults for missing keys; 0 turns a rule off.
def auto_clean_settings():
    path = APP / "settings.json"
    if path.is_symlink():
        raise ValueError(tr('server_invalid_settings_path'))
    if not path.exists():
        return AUTO_CLEAN_DEFAULTS.copy()
    data = json.loads(path.read_text(encoding="utf-8"))
    settings = data.get("auto_clean", {})
    if not isinstance(settings, dict):
        raise ValueError(tr('server_invalid_auto_clean_settings'))
    return {key: auto_clean_value(key, settings.get(key, default)) for key, default in AUTO_CLEAN_DEFAULTS.items()}


def read_settings():
    path = APP / "settings.json"
    if path.is_symlink():
        raise ValueError(tr('server_invalid_settings_path'))
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


LANG_DIR = STATIC / "lang"
# Language folder names such as "en" or "pt-BR".
LANG_CODE = re.compile(r"[a-z]{2}(-[A-Za-z]{2,4})?")


def ui_language():
    """The UI language from settings.json ("language"), English when unset or not installed."""
    try:
        lang = str(read_settings().get("language") or "en")
    except (ValueError, json.JSONDecodeError):
        return "en"
    return lang if LANG_CODE.fullmatch(lang) and (LANG_DIR / lang).is_dir() else "en"


def ui_languages():
    languages = []
    for folder in LANG_DIR.iterdir():
        if not folder.is_dir() or not LANG_CODE.fullmatch(folder.name) or not any(folder.glob("*.json")):
            continue
        name = None
        for file in sorted(folder.glob("*.json")):
            name = json.loads(file.read_text(encoding="utf-8")).get("language_name", name)
        languages.append({"code": folder.name, "name": name if isinstance(name, str) and name else folder.name})
    return sorted(languages, key=lambda item: (item["code"] != "en", item["name"]))


def ui_strings(lang):
    """Merge lang/en/*.json, then overlay lang/<lang>/*.json; untranslated ids fall back to English."""
    strings = {}
    for code in dict.fromkeys(["en", lang]):
        for file in sorted((LANG_DIR / code).glob("*.json")):
            strings.update(json.loads(file.read_text(encoding="utf-8")))
    return strings


def tr(id, *args):
    """Server-side t(): the same ids and %1$s placeholders as the browser."""
    strings = ui_strings(ui_language())
    text = strings.get(id, id)
    if isinstance(text, dict):
        text = text.get("one" if args and args[0] == 1 else "other", id)

    def fill(m):
        i = int(m[1] or 1) - 1
        if m[3] == "%":
            return "%"
        if i >= len(args):
            return m[0]
        if m[3] == "d":
            return str(round(float(args[i])))
        return f"{float(args[i]):.{int(m[2])}f}" if m[3] == "f" and m[2] else str(args[i])
    text = re.sub(r"%(?:(\d+)\$)?(?:\.(\d+))?([sdf%])", fill, text)
    if strings.get("language_direction") == "rtl":  # same left-to-right isolation of sizes/ranges as i18n.js
        text = re.sub(r"\d+(?:\.\d+)?%?(?:\s*[×–:/-]\s*\d+(?:\.\d+)?%?)+", lambda m: "\u2066" + m[0] + "\u2069", text)
    return text


def write_settings(**changes):
    """Update keys in app/settings.json, keeping the others."""
    try:
        data = read_settings()
    except (ValueError, json.JSONDecodeError):
        data = {}
    data.update(changes)
    write_state(APP, "settings.json", data)


def save_auto_clean_settings(settings):
    if not isinstance(settings, dict) or set(settings) != set(AUTO_CLEAN_DEFAULTS):
        raise ValueError(tr('server_expected_settings', ', '.join(AUTO_CLEAN_DEFAULTS)))
    settings = {key: auto_clean_value(key, settings[key]) for key in AUTO_CLEAN_DEFAULTS}
    if (APP / "settings.json").is_symlink():
        raise ValueError(tr('server_invalid_settings_path'))
    write_settings(auto_clean=settings)
    return settings


# Walk storage without following linked directories so cleanup stays within its root.
def scanned_files(root):
    """Yield regular files below root without following any symbolic link."""
    if root.is_symlink() or not root.is_dir():
        return
    stack = [root]
    while stack:
        folder = stack.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    yield Path(entry.path), stat.st_size, stat.st_mtime


# Counts files, bytes and photos (by extension) under root.
def file_stats(root):
    files = list(scanned_files(root))
    return {"files": len(files), "bytes": sum(size for _, size, _ in files),
            "photos": sum(path.suffix.lower() in IMAGE_EXT for path, _, _ in files)}


# Report storage totals and per-order details for the settings panel.
def storage_data():
    orders = []
    if ORDERS.is_dir() and not ORDERS.is_symlink():
        for path in ORDERS.iterdir():
            if path.is_symlink() or not path.is_dir() or not ORDER_ID.fullmatch(path.name):
                continue
            try:
                data = order_data(path.name)
            except (ValueError, FileNotFoundError):
                continue
            orders.append(order_summary(data) | file_stats(path))
    # Newest first.
    orders.sort(key=lambda item: (datetime.fromisoformat(item["updated"]).timestamp(), item["id"]), reverse=True)
    workspace = {}
    for tab in ("canvas", "passport", "collage"):
        try:
            workspace[tab] = file_stats(workspace_path(tab))
        except ValueError:  # A linked workspace is never traversed.
            workspace[tab] = {"files": 0, "bytes": 0, "photos": 0}
    incoming_items = [{"name": path.name, "bytes": size, "mtime": mtime}
                      for path, size, mtime in scanned_files(INCOMING)]
    folders = []
    if PRINT_READY.is_dir() and not PRINT_READY.is_symlink():
        loose = []
        with os.scandir(PRINT_READY) as entries:
            for entry in entries:
                if entry.is_symlink():
                    continue
                path = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    items = [{"name": str(file.relative_to(path)), "bytes": size, "mtime": mtime}
                             for file, size, mtime in scanned_files(path)]
                    folders.append({"name": path.name, "files": len(items),
                                    "bytes": sum(item["bytes"] for item in items),
                                    "newest": max((item["mtime"] for item in items), default=None),
                                    "items": items})
                elif entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    loose.append({"name": path.name, "bytes": stat.st_size, "mtime": stat.st_mtime})
        # Files directly in print_ready (saved without an order folder) are shown as one pseudo-folder.
        if loose:
            folders.append({"name": "(loose files)", "files": len(loose),
                            "bytes": sum(item["bytes"] for item in loose),
                            "newest": max(item["mtime"] for item in loose), "items": loose})
    folders.sort(key=lambda item: item["name"])
    return {"orders": {"items": orders, "files": sum(item["files"] for item in orders),
                       "photos": sum(item["photos"] for item in orders),
                       "bytes": sum(item["bytes"] for item in orders)},
            "workspace": workspace,
            "incoming": {"files": len(incoming_items), "bytes": sum(item["bytes"] for item in incoming_items),
                         "oldest": min((item["mtime"] for item in incoming_items), default=None),
                         "items": incoming_items},
            "print_ready": {"files": sum(item["files"] for item in folders),
                            "bytes": sum(item["bytes"] for item in folders), "folders": folders},
            "helper": {"running": BACKGROUND_REMOVER.proc is not None and BACKGROUND_REMOVER.proc.is_alive()},
            "settings": {"auto_clean": auto_clean_settings()}}


# Remove an order folder; returns its file stats for the totals.
def delete_order(ident):
    path = order_path(ident)
    order_data(ident)
    result = file_stats(path)
    shutil.rmtree(path)
    return result


def log_cleanup(reason, target, path, size, mtime):
    """Append one deleted file to photos/cleanup.log (kept under ~1 MB by dropping the oldest half)."""
    try:
        if CLEAN_LOG.exists() and CLEAN_LOG.stat().st_size > 1_000_000:
            lines = CLEAN_LOG.read_text(encoding="utf-8").splitlines(keepends=True)
            CLEAN_LOG.write_text("".join(lines[len(lines) // 2:]), encoding="utf-8")
        age = (time.time() - mtime) / 3600
        with CLEAN_LOG.open("a", encoding="utf-8") as log:
            log.write(f"{datetime.now():%Y-%m-%d %H:%M:%S}\t{reason}\t{target}\t{path}\t{size / 1024 ** 2:.1f} MB\t{age:.1f} h old\n")
    except OSError:  # logging must never block the clean-up itself
        pass


# Apply age limits to the selected storage area, preserving a nominated order.
# Log each deletion and remove only empty finished-output folders.
def clean_storage(target, days=None, keep=None, hours=None, reason="manual"):
    if target not in ("orders", "incoming", "print_ready"):
        raise ValueError(tr('server_invalid_cleanup_target'))
    # Automatic print_ready cleaning passes hours; everything else passes days. Cutoff is a Unix time.
    if hours is not None:
        clean_days(hours, 1, AUTO_CLEAN_LIMITS["print_ready_hours"], "hours")
        cutoff = time.time() - hours * 3600
    else:
        # Defaults when no age is given.
        if days is None:
            days = {"orders": 14, "incoming": 0, "print_ready": 30}[target]
        clean_days(days, 1 if target == "print_ready" else 0)
        cutoff = time.time() - days * 86400
    if keep is not None and (target != "orders" or not isinstance(keep, str) or not ORDER_ID.fullmatch(keep)):
        raise ValueError(tr('server_invalid_kept_order'))
    removed = {"deleted_files": 0, "freed_bytes": 0}
    if target == "orders":
        for item in storage_data()["orders"]["items"]:
            if item["id"] == keep or datetime.fromisoformat(item["updated"]).timestamp() >= cutoff:
                continue
            stats = delete_order(item["id"])
            log_cleanup(reason, target, f"order {item['folder']} ({stats['files']} files)", stats["bytes"],
                        datetime.fromisoformat(item["updated"]).timestamp())
            removed["deleted_files"] += stats["files"]
            removed["freed_bytes"] += stats["bytes"]
        return removed
    root = INCOMING if target == "incoming" else PRINT_READY
    for path, size, mtime in scanned_files(root):
        # Incoming with days == 0 means delete everything regardless of age.
        if (target == "incoming" and days == 0) or mtime < cutoff:
            path.unlink()
            log_cleanup(reason, target, path.relative_to(root), size, mtime)
            removed["deleted_files"] += 1
            removed["freed_bytes"] += size
    if target == "print_ready":
        remove_empty_folders(root)
    return removed


# Remove folders left empty under root (deepest first); root itself stays.
def remove_empty_folders(root):
    if root.is_dir() and not root.is_symlink():
        for folder, _, _ in os.walk(root, topdown=False, followlinks=False):
            if Path(folder) != root and not Path(folder).is_symlink():
                try:
                    Path(folder).rmdir()
                except OSError:  # New files or retained files keep the folder.
                    pass


# Clear every working and finished photo, including all persistent workspaces.
# Keep the deletion log and return totals for the confirmation flow.
def full_clean():
    """Delete everything the shop produced: incoming, every Prints order, workspaces, and finished files."""
    removed = {"deleted_files": 0, "freed_bytes": 0}
    def add(result):
        for field in removed:
            removed[field] += result[field]
    add(clean_storage("incoming", 0, reason="full"))
    add(clean_storage("orders", 0, reason="full"))
    for path, size, mtime in scanned_files(PRINT_READY):
        path.unlink()
        log_cleanup("full", "print_ready", path.relative_to(PRINT_READY), size, mtime)
        add({"deleted_files": 1, "freed_bytes": size})
    remove_empty_folders(PRINT_READY)
    with ORDER_LOCK:
        for tab in ("canvas", "passport", "collage"):
            path = workspace_path(tab)
            if not path.exists():
                continue
            if (path / "files").is_symlink() or (path / "state.json").is_symlink():
                raise ValueError(tr('server_invalid_workspace_path'))
            files = scanned_files(path / "files") if (path / "files").is_dir() else []
            for file, size, mtime in files:
                log_cleanup("full", f"{tab} workspace", file.name, size, mtime)
                add({"deleted_files": 1, "freed_bytes": size})
            shutil.rmtree(path)
    return removed


# Read current retention settings and keep the newest order during scheduled cleanup.
def run_auto_clean():
    settings = auto_clean_settings()
    # Items are sorted newest first, so the first one is the order in use: never auto-delete it.
    latest = next(iter(storage_data()["orders"]["items"]), None) if settings["orders_days"] else None
    removed = {"deleted_files": 0, "freed_bytes": 0}
    for target, key in (("incoming", "incoming_days"), ("orders", "orders_days"),
                        ("print_ready", "print_ready_hours")):
        if settings[key]:
            keep = latest["id"] if target == "orders" and latest else None
            if key.endswith("_hours"):
                result = clean_storage(target, keep=keep, hours=settings[key], reason="auto")
            else:
                result = clean_storage(target, settings[key], keep, reason="auto")
            for field in removed:
                removed[field] += result[field]
    return removed


# Strip any directory part and replace unusual characters, so a client-supplied name stays inside its folder.
def safe_name(name):
    name = Path(name).name
    name = re.sub(r"[^\w.\- ]+", "_", name, flags=re.UNICODE).strip() or "photo.jpg"
    return name


# folder/name, or name_2, name_3... if it already exists, so nothing is overwritten.
def unique_path(folder, name):
    path = folder / name
    stem, ext = path.stem, path.suffix
    n = 2
    while path.exists():
        path = folder / f"{stem}_{n}{ext}"
        n += 1
    return path


# Safe folder name for an export (also used for names typed by the user).
def order_folder(name):
    return safe_name(name).strip(". ") or "order"


# Resolve only validated order identifiers inside the working-order directory.
def order_path(ident):
    if not ORDER_ID.fullmatch(ident):
        raise ValueError(tr('server_invalid_order_id'))
    path = ORDERS / ident
    if path.is_symlink():
        raise ValueError(tr('server_invalid_order_path'))
    return path


# Read an order and validate its persisted state before returning it.
def order_data(ident):
    path = order_path(ident) / "order.json"
    if path.is_symlink():
        raise ValueError(tr('server_invalid_order_path'))
    if not path.is_file():
        raise FileNotFoundError(ident)
    return json.loads(path.read_text(encoding="utf-8"))


# List/response view of an order. `folder` is the name, or the date-time taken from the id when unnamed.
def order_summary(data):
    state = data.get("state") or {}
    counts = {}
    for key, field in (("prints", "items"),):
        section = state.get(key)
        items = section.get(field) if isinstance(section, dict) else None
        counts[key] = len(items) if isinstance(items, list) else 0
    ident = data["id"]
    return {key: data[key] for key in ("id", "name", "created", "updated")} | {
        "folder": data["name"] or f"{ident[:4]}-{ident[4:6]}-{ident[6:8]}_{ident[9:11]}-{ident[11:13]}",
        "counts": counts,
    }


# Persist JSON state alongside its stored source photos.
# Written to a temp file and renamed over the target, so a crash never leaves half a JSON file.
def write_state(path, filename, data):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path, prefix=".state-", delete=False) as tmp:
        json.dump(data, tmp, ensure_ascii=False)
        name = tmp.name
    try:
        os.replace(name, path / filename)
    finally:
        if os.path.exists(name):
            os.unlink(name)


# Persist order metadata under the order lock.
def write_order(path, data):
    write_state(path, "order.json", data)


# Keep Canvas, Passport, and Collage work outside the selected Prints order.
def workspace_path(tab):
    if tab not in ("canvas", "passport", "collage"):
        raise ValueError(tr('server_invalid_workspace_tab'))
    if WORKSPACE.is_symlink():
        raise ValueError(tr('server_invalid_workspace_path'))
    path = WORKSPACE / tab
    if path.is_symlink():
        raise ValueError(tr('server_invalid_workspace_path'))
    return path


# Resolve a stored photo for download; the name must already be in its safe form.
def stored_file(path, name):
    name = urllib.parse.unquote(name)
    if name != safe_name(name) or name in (".", ".."):
        raise ValueError(tr('server_invalid_file_name'))
    folder = path / "files"
    file = folder / name
    if folder.is_symlink() or file.is_symlink():
        raise ValueError(tr('server_invalid_file_path'))
    if not file.is_file():
        raise FileNotFoundError(name)
    return file


# Store an uploaded source image under a safe, unique filename.
def upload_file(path, raw, body):
    if raw != Path(raw).name or raw in (".", "..") or "/" in raw or "\\" in raw:
        raise ValueError(tr('server_invalid_file_name'))
    folder = path / "files"
    if folder.is_symlink():
        raise ValueError(tr('server_invalid_file_path'))
    folder.mkdir(exist_ok=True)
    with ORDER_LOCK:
        file = unique_path(folder, safe_name(raw))
        file.write_bytes(body)
    return file.name


def local_fonts():
    """Optional fonts installed on this computer only: app/static/fonts/local/fonts.json, a list of
    {"name", "regular", "bold"?} with the font files in the same folder (the folder is never shipped)."""
    folder = STATIC / "fonts" / "local"
    try:
        entries = json.loads((folder / "fonts.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    fonts = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or not re.fullmatch(r"[\w .-]{1,40}", str(entry.get("name", ""))):
            continue
        files = {key: entry.get(key) for key in ("regular", "bold") if entry.get(key)}
        if "regular" in files and all(isinstance(f, str) and "/" not in f and "\\" not in f
                                      and (folder / f).is_file() for f in files.values()):
            fonts.append({"name": entry["name"], **files})
    return fonts


# Saved state of a workspace tab, or the empty state of that tab when nothing was saved yet.
def workspace_data(tab, path):
    state_file = path / "state.json"
    if state_file.is_symlink():
        raise ValueError(tr('server_invalid_workspace_state'))
    if state_file.is_file():
        return json.loads(state_file.read_text(encoding="utf-8"))
    if tab == "canvas":
        return {"items": [], "sel": 0}
    if tab == "collage":
        return {"photos": [], "sheets": [], "active": 0}
    return {"jobs": [], "active": 0}


# Routes the local HTTP API while serving index.html and other static assets.
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        pass

    # Sent with every response, including static files.
    def end_headers(self):
        # Always serve fresh files so updated scripts are never stale in the browser cache.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def read_json(self):
        data = json.loads(self.read_body())
        if not isinstance(data, dict):
            raise ValueError(tr('server_expected_json_object'))
        return data

    # 404 for a missing file/order, 400 for any other validation error.
    def order_error(self, error):
        return self.send_json({"error": str(error)}, 404 if isinstance(error, FileNotFoundError) else 400)

    def send_file(self, file):
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # Return saved state, source photos, settings, or static browser assets.
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/version":
            return self.send_json({"version": update.current_version(), "update": update_status()})
        if url.path == "/api/languages":
            return self.send_json({"current": ui_language(), "languages": ui_languages()})
        if url.path == "/api/storage":
            try:
                return self.send_json(storage_data())
            except (ValueError, json.JSONDecodeError) as e:
                return self.order_error(e)
        if url.path == "/api/orders":
            ORDERS.mkdir(parents=True, exist_ok=True)
            orders = []
            for path in ORDERS.iterdir():
                if path.is_dir() and not path.is_symlink() and ORDER_ID.fullmatch(path.name) and (path / "order.json").is_file():
                    orders.append(order_summary(order_data(path.name)))
            return self.send_json(sorted(orders, key=lambda x: (x["updated"], x["id"]), reverse=True))
        match = re.fullmatch(r"/api/orders/([^/]+)", url.path)
        if match:
            try:
                data = order_data(match[1])
                return self.send_json(data | {"folder": order_summary(data)["folder"]})
            except (ValueError, FileNotFoundError) as e:
                return self.order_error(e)
        match = re.fullmatch(r"/orders/([^/]+)/files/(.+)", url.path)
        if match:
            try:
                return self.send_file(stored_file(order_path(match[1]), match[2]))
            except (ValueError, FileNotFoundError) as e:
                return self.order_error(e)
        match = re.fullmatch(r"/api/workspace/([^/]+)", url.path)
        if match:
            try:
                path = workspace_path(match[1])
                return self.send_json(workspace_data(match[1], path))
            except ValueError as e:
                return self.order_error(e)
        match = re.fullmatch(r"/workspace/([^/]+)/files/(.+)", url.path)
        if match:
            try:
                return self.send_file(stored_file(workspace_path(match[1]), match[2]))
            except (ValueError, FileNotFoundError) as e:
                return self.order_error(e)
        # Language file generated on the fly: the chosen language's strings merged over English.
        if url.path == "/lang.js":
            lang = ui_language()
            body = f"'use strict';\nconst LANG = {json.dumps(lang)};\nconst STRINGS = {json.dumps(ui_strings(lang), ensure_ascii=False)};\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if url.path == "/api/local-fonts":
            return self.send_json(local_fonts())
        # Which optional features are installed (background removal, face detection).
        if url.path == "/api/config":
            return self.send_json({"localBg": importlib.util.find_spec("rembg") is not None,
                                   "faces": importlib.util.find_spec("cv2") is not None and FACE_MODEL.is_file()})
        if url.path == "/api/incoming":
            INCOMING.mkdir(parents=True, exist_ok=True)
            files = sorted(
                (p for p in INCOMING.iterdir() if p.suffix.lower() in IMAGE_EXT),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            return self.send_json([p.name for p in files])
        if url.path.startswith("/incoming/"):
            path = INCOMING / safe_name(urllib.parse.unquote(url.path[len("/incoming/"):]))
            if not path.is_file():
                return self.send_error(404)
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        # Anything under these prefixes that matched no route above is a malformed path, not a static file.
        if url.path.startswith(("/api/orders/", "/orders/", "/api/workspace/", "/workspace/")):
            return self.send_json({"error": tr('server_invalid_order_path')}, 400)
        return super().do_GET()

    # Handle uploads, edits, exports, cleanup, and update requests from the UI.
    # Routes are tried in order: exact paths first, then pattern routes; unmatched requests end with 404.
    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)

        # Another launch of the app asks this instance to bring its window forward (see connect_existing).
        if url.path == "/api/focus":
            hook = getattr(self.server, "focus_hook", None)
            if hook:
                threading.Thread(target=hook, daemon=True).start()
            return self.send_json({"ok": True})

        if url.path == "/api/language":
            try:
                code = self.read_json().get("language")
                if not isinstance(code, str) or code not in {item["code"] for item in ui_languages()}:
                    raise ValueError(tr('server_invalid_language'))
                write_settings(language=code)
                return self.send_json({"language": code})
            except (ValueError, json.JSONDecodeError) as e:
                return self.order_error(e)

        # After a successful update or rollback the reply goes out first, then the server restarts itself.
        if url.path in ("/api/update", "/api/update/rollback"):
            try:
                if url.path.endswith("/rollback"):
                    update.rollback()
                else:
                    repo = update_repo()
                    if not repo:
                        return self.send_json({"error": tr('server_updates_disabled')}, 400)
                    latest = update.check(repo)
                    if not latest["available"] or not latest["asset_url"]:
                        return self.send_json({"error": tr('server_no_update_available')}, 400)
                    update.apply(latest["asset_url"])
                self.send_json({"ok": True, "restart": True})
                schedule_restart(self.server)
                return
            except Exception as error:
                return self.send_json({"error": str(error)}, 500)

        # Needs the exact confirmation body so a stray request cannot wipe everything.
        if url.path == "/api/storage/full-clean":
            try:
                if self.read_json() != {"confirm": "everything"}:
                    raise ValueError(tr('server_full_cleanup_confirmation'))
                return self.send_json(full_clean())
            except (ValueError, json.JSONDecodeError) as e:
                return self.order_error(e)

        if url.path in ("/api/storage/clean", "/api/storage/settings"):
            try:
                body = self.read_json()
                if url.path.endswith("/settings"):
                    return self.send_json({"auto_clean": save_auto_clean_settings(body.get("auto_clean"))})
                if set(body) - {"target", "days", "keep"}:
                    raise ValueError(tr('server_invalid_cleanup_options'))
                if "days" in body:
                    clean_days(body["days"], 1 if body.get("target") == "print_ready" else 0)
                return self.send_json(clean_storage(body.get("target"), body.get("days"), body.get("keep")))
            except (ValueError, json.JSONDecodeError) as e:
                return self.order_error(e)

        # /api/workspace/<tab> saves state, /files uploads a photo, /clear deletes the whole workspace.
        match = re.fullmatch(r"/api/workspace/([^/]+)(?:/(files|clear))?", url.path)
        if match:
            try:
                tab, action = match.groups()
                path = workspace_path(tab)
                if action == "clear":
                    with ORDER_LOCK:
                        WORKSPACE.mkdir(parents=True, exist_ok=True)
                        if path.exists():
                            if (path / "files").is_symlink() or (path / "state.json").is_symlink():
                                raise ValueError(tr('server_invalid_workspace_path'))
                            shutil.rmtree(path)
                    return self.send_json({"ok": True})
                path.mkdir(parents=True, exist_ok=True)
                if action == "files":
                    file = upload_file(path, query.get("name", ["photo.jpg"])[0], self.read_body())
                    return self.send_json({"file": file}, 201)
                state = self.read_json()
                if (path / "state.json").is_symlink():
                    raise ValueError(tr('server_invalid_workspace_state'))
                write_state(path, "state.json", state)
                return self.send_json(state)
            except (ValueError, json.JSONDecodeError) as e:
                return self.order_error(e)
        if url.path.startswith("/api/workspace/"):
            return self.send_json({"error": tr('server_invalid_workspace_path')}, 400)

        if url.path == "/api/orders":
            try:
                body = self.read_json()
                name = body.get("name", "")
                if not isinstance(name, str):
                    raise ValueError(tr('server_invalid_order_name'))
                with ORDER_LOCK:
                    ORDERS.mkdir(parents=True, exist_ok=True)
                    # Same-second collisions get a -2, -3... suffix (see ORDER_ID).
                    base = datetime.now().strftime("%Y%m%d-%H%M%S")
                    ident = base
                    n = 2
                    while (ORDERS / ident).exists():
                        ident = f"{base}-{n}"; n += 1
                    path = ORDERS / ident
                    (path / "files").mkdir(parents=True)
                    now = datetime.now().astimezone().isoformat()
                    data = {"id": ident, "name": name, "created": now, "updated": now, "state": {}}
                    write_order(path, data)
                return self.send_json(data | order_summary(data), 201)
            except (ValueError, json.JSONDecodeError) as e:
                return self.order_error(e)
        # /api/orders/<id>/state saves the order, /files uploads a photo into it, /delete removes it.
        match = re.fullmatch(r"/api/orders/([^/]+)/(state|files|delete)", url.path)
        if match:
            ident, action = match.groups()
            try:
                path = order_path(ident)
                data = order_data(ident)
                if action == "state":
                    body = self.read_json()
                    if not isinstance(body.get("name"), str) or not isinstance(body.get("state"), dict):
                        raise ValueError(tr('server_expected_name_state'))
                    data["name"] = body["name"]
                    data["state"] = body["state"]
                    data["updated"] = datetime.now().astimezone().isoformat()
                    write_order(path, data)
                    return self.send_json(data | {"folder": order_summary(data)["folder"]})
                if action == "files":
                    file = upload_file(path, query.get("name", ["photo.jpg"])[0], self.read_body())
                    return self.send_json({"file": file}, 201)
                delete_order(ident)
                return self.send_json({"ok": True})
            except (ValueError, FileNotFoundError, json.JSONDecodeError) as e:
                return self.order_error(e)
        if url.path.startswith("/api/orders/"):
            return self.send_json({"error": tr('server_invalid_order_path')}, 400)

        if url.path == "/api/faces":
            try:
                return self.send_json(detect_faces(self.read_body()))
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)

        # Extract only image files from an uploaded zip into incoming, skipping folders, hidden files and
        # macOS metadata; refuses archives over 2 GB unpacked or 2000 images (zip bomb guard).
        if url.path == "/api/unzip":
            try:
                with zipfile.ZipFile(io.BytesIO(self.read_body())) as archive:
                    images = []
                    total = 0
                    for info in archive.infolist():
                        parts = info.filename.replace("\\", "/").split("/")
                        name = parts[-1]
                        if (info.is_dir() or "__MACOSX" in parts or not name or
                                name.startswith(".") or Path(name).suffix.lower() not in IMAGE_EXT):
                            continue
                        total += info.file_size
                        images.append(info)
                        if total > 2 * 1024 ** 3 or len(images) > 2000:
                            return self.send_json({"error": tr('server_zip_too_large')}, 400)
                    INCOMING.mkdir(parents=True, exist_ok=True)
                    names = []
                    for info in images:
                        name = safe_name(info.filename.replace("\\", "/").split("/")[-1])
                        path = unique_path(INCOMING, name)
                        with archive.open(info) as source, path.open("wb") as target:
                            while chunk := source.read(1024 * 1024):
                                target.write(chunk)
                        names.append(path.name)
                return self.send_json({"files": names})
            except (zipfile.BadZipFile, EOFError, ValueError):
                return self.send_json({"error": tr('server_invalid_zip')}, 400)

        # Export: the body is the finished JPEG; with `folder` it goes to print_ready/<folder>, else loose.
        if url.path == "/api/save":
            folder = query.get("folder", [""])[0]
            target = PRINT_READY / order_folder(folder) if folder else PRINT_READY
            target.mkdir(parents=True, exist_ok=True)
            path = unique_path(target, safe_name(query.get("name", ["photo.jpg"])[0]))
            path.write_bytes(self.read_body())
            return self.send_json({"saved": f"{target.name}/{path.name}" if folder else path.name})

        # Opens the order's export folder in the file manager, or print_ready itself if it does not exist yet.
        if url.path == "/api/open-folder":
            PRINT_READY.mkdir(parents=True, exist_ok=True)
            folder = query.get("folder", [""])[0]
            target = PRINT_READY / order_folder(folder) if folder else PRINT_READY
            open_folder(target if target.is_dir() else PRINT_READY)
            return self.send_json({"ok": True})

        if url.path == "/api/remove-bg-local":
            try:
                png = BACKGROUND_REMOVER.remove(self.read_body())
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            return

        self.send_error(404)


# Startup: update check in the background, data folders, one clean-up now and an hourly loop.
def prepare():
    """Initialize the data folders and run the existing startup cleanup."""
    threading.Thread(target=refresh_update, daemon=True).start()
    INCOMING.mkdir(parents=True, exist_ok=True)
    PRINT_READY.mkdir(parents=True, exist_ok=True)
    auto_clean_once()
    threading.Thread(target=auto_clean_loop, daemon=True).start()


def auto_clean_once():
    try:  # a broken settings.json or locked file must never stop the shop from starting
        cleaned = run_auto_clean()
        print(f"Auto-clean: removed {cleaned['deleted_files']} files ({cleaned['freed_bytes'] / 1024 ** 2:.1f} MB)")
    except Exception as e:
        print(f"Auto-clean skipped: {e}")


# Run retention cleanup at startup and on the hourly schedule.
def auto_clean_loop():
    """Repeat the automatic clean-up every hour while the app stays open (shops run it all day)."""
    while True:
        time.sleep(AUTO_CLEAN_EVERY)
        auto_clean_once()


# ThreadingHTTPServer: each request gets its own thread, so a slow cutout does not block the UI.
def make_server(port):
    """Create a loopback-only server; port 0 asks the OS for a free port."""
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)


# Ask an already running instance to show its desktop window.
def connect_existing(port):
    """Focus a running Ellashop on this port, if there is one."""
    base = f"http://127.0.0.1:{port}"
    try:
        with urllib.request.urlopen(base + "/api/version", timeout=1) as response:
            payload = json.load(response)
            if not isinstance(payload, dict) or not isinstance(payload.get("version"), str):
                return False
        request = urllib.request.Request(base + "/api/focus", data=b"", method="POST")
        with urllib.request.urlopen(request, timeout=1) as response:
            return response.status == 200
    except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
        return False


# Reuse an existing local instance when the port is already occupied.
def acquire_server(port=PORT):
    """Return (server, already_running), choosing a free port after a collision."""
    try:
        return make_server(port), False
    # Port busy: if it is another Ellashop, just focus it; otherwise use any free port.
    except OSError:
        if connect_existing(port):
            return None, True
        return make_server(0), False


# Prepare storage, start periodic cleanup, and serve the local application.
def main():
    multiprocessing.freeze_support()
    httpd, already_running = acquire_server()
    if already_running:
        return
    with httpd:
        prepare()
        url = f"http://127.0.0.1:{httpd.server_port}"
        httpd.focus_hook = lambda: webbrowser.open(url)
        print(f"Ellashop running at {url}  (close this window or Ctrl+C to stop)")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        finally:
            BACKGROUND_REMOVER.stop()
    # Set by schedule_restart after an update: start the new code in place of this process.
    if getattr(httpd, "restart_requested", False):
        os.execv(sys.executable, [sys.executable] + sys.argv)


if __name__ == "__main__":
    main()
