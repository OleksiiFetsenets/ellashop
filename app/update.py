"""Code-only release updates for a local Ellashop installation."""
# Checks published releases and installs code-only updates for server.py.
# Backs up replaced files so the update endpoint can roll back a failed install.

import json
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
# The replaced files plus manifest.json (what was installed and what existed before), kept for rollback.
BACKUP = ROOT / "app" / ".previous"


# Imported on use: server.py imports this module, so a top-level import would be circular.
def tr(id, *args):
    from server import tr as translate
    return translate(id, *args)


def current_version():
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


# Admit only distributable code paths; reject traversal, generated files and this computer's own fonts.
def _allowed(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        return False
    if any(part.startswith(".") or part == "__pycache__" for part in path.parts) or path.suffix in {".pyc", ".pyo"}:
        return False
    if path.parts[:4] == ("app", "static", "fonts", "local"):  # this computer's own fonts: never shipped or replaced
        return False
    if name in {"VERSION", "Ellashop.command", "app/requirements.txt",
                "app/setup_offline_bg.command"}:
        return True
    if len(path.parts) == 2 and path.parts[0] == "app" and path.suffix == ".py":
        return True
    if len(path.parts) >= 3 and path.parts[:2] == ("app", "static"):
        return True
    return len(path.parts) >= 2 and path.parts[0] == "windows"


# Inventory installed code for backup before replacing a release.
def _code_files():
    roots = [ROOT / "VERSION", ROOT / "Ellashop.command", ROOT / "app" / "requirements.txt",
             ROOT / "app" / "setup_offline_bg.command"]
    roots.extend((ROOT / "app").glob("*.py"))
    for folder in (ROOT / "app" / "static", ROOT / "windows"):
        if folder.exists():
            roots.extend(folder.rglob("*"))
    return [path for path in roots if path.is_file() and not path.is_symlink() and
            _allowed(path.relative_to(ROOT).as_posix())]


# Compare release versions and locate the matching code archive.
def check(repo):
    if not isinstance(repo, str) or len(repo.split("/")) != 2 or not all(
            part and all(c.isalnum() or c in "-_." for c in part) for part in repo.split("/")):
        raise ValueError(tr('server_update_repository'))
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Ellashop"})
    with urllib.request.urlopen(request, timeout=5, context=ssl.create_default_context()) as response:
        release = json.load(response)
    current = current_version()
    # Tags look like v1.2.3; the code archive attached to the release must be named ellashop-app-<version>.zip.
    latest = str(release["tag_name"]).removeprefix("v")
    # "1.10.0" -> (1, 10, 0), so versions compare numerically rather than as text.
    def version_parts(value):
        if not re.fullmatch(r"\d+(?:\.\d+)*", value):
            raise ValueError(tr('server_invalid_release_version', value))
        return tuple(int(part) for part in value.split("."))
    asset_name = f"ellashop-app-{latest}.zip"
    asset_url = next((item["browser_download_url"] for item in release.get("assets", [])
                      if item.get("name") == asset_name), None)
    return {"current": current, "latest": latest, "available": version_parts(latest) > version_parts(current),
            "notes": release.get("body") or "", "asset_url": asset_url}


# Remove newly installed code and restore the prior manifest-backed files.
def rollback():
    manifest = BACKUP / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(tr('server_no_previous_version'))
    state = json.loads(manifest.read_text(encoding="utf-8"))
    # Validate every manifest path before touching disk: the manifest is a file and could be altered.
    for name in state["installed"]:
        if not _allowed(name):
            raise ValueError(tr('server_invalid_backup_manifest'))
    for name in state["original"]:
        if not _allowed(name):
            raise ValueError(tr('server_invalid_backup_manifest'))
    # Delete what the update installed (so files that did not exist before disappear), then copy the originals back.
    for name in state["installed"]:
        path = ROOT / name
        if path.is_file():
            path.unlink()
    for name in state["original"]:
        target = ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BACKUP / name, target)


# Download and validate the release before replacing installed code.
# Copy the previous version to .previous, then roll back if any install step fails.
def apply(asset_url):
    with tempfile.TemporaryDirectory(prefix="ellashop-update-") as temporary:
        archive_path = Path(temporary) / "release.zip"
        with urllib.request.urlopen(asset_url, timeout=30, context=ssl.create_default_context()) as response, \
                archive_path.open("wb") as target:
            shutil.copyfileobj(response, target)
        with zipfile.ZipFile(archive_path) as archive:
            names = {}
            for info in archive.infolist():
                if info.is_dir() or not _allowed(info.filename):
                    continue
                # Reject duplicate entries and symbolic links (Unix file type 0o120000 in the upper attribute bits).
                if info.filename in names or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError(tr('server_duplicate_release_file'))
                names[info.filename] = info
            # Sanity check that this really is an app archive before replacing anything.
            if not {"VERSION", "app/server.py"} <= names.keys():
                raise ValueError(tr('server_missing_release_files'))
            # Back up current code in a temp folder first, then swap it in as app/.previous, so a failed
            # backup never destroys the previous backup.
            original = [p.relative_to(ROOT).as_posix() for p in _code_files()]
            staging = Path(temporary) / "previous"
            for name in original:
                backup = staging / name
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, backup)
            (staging / "manifest.json").write_text(
                json.dumps({"original": original, "installed": list(names)}), encoding="utf-8")
            if BACKUP.exists():
                shutil.rmtree(BACKUP)
            shutil.copytree(staging, BACKUP)
            try:
                for name, info in names.items():
                    target = ROOT / name
                    if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != ROOT):
                        raise ValueError(tr('server_linked_update_path', name))
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, target.open("wb") as destination:
                        shutil.copyfileobj(source, destination)
                # Install Python dependencies only when requirements.txt actually changed.
                if "app/requirements.txt" in names and (BACKUP / "app" / "requirements.txt").read_bytes() != (
                        ROOT / "app" / "requirements.txt").read_bytes():
                    subprocess.run([sys.executable, "-m", "pip", "install", "-r",
                                    str(ROOT / "app" / "requirements.txt")], check=True)
            except Exception as error:
                rollback()
                raise RuntimeError(tr('server_update_failed', error)) from error
