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
BACKUP = ROOT / "app" / ".previous"


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
        raise ValueError("Update repository must be owner/name")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Ellashop"})
    with urllib.request.urlopen(request, timeout=5, context=ssl.create_default_context()) as response:
        release = json.load(response)
    current = current_version()
    latest = str(release["tag_name"]).removeprefix("v")
    def version_parts(value):
        if not re.fullmatch(r"\d+(?:\.\d+)*", value):
            raise ValueError(f"Invalid release version: {value}")
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
        raise FileNotFoundError("No previous version is available")
    state = json.loads(manifest.read_text(encoding="utf-8"))
    for name in state["installed"]:
        if not _allowed(name):
            raise ValueError("Invalid backup manifest")
    for name in state["original"]:
        if not _allowed(name):
            raise ValueError("Invalid backup manifest")
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
                if info.filename in names or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Duplicate or linked code file in release")
                names[info.filename] = info
            if not {"VERSION", "app/server.py"} <= names.keys():
                raise ValueError("Release is missing VERSION or app/server.py")
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
                        raise ValueError(f"Linked update path: {name}")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, target.open("wb") as destination:
                        shutil.copyfileobj(source, destination)
                if "app/requirements.txt" in names and (BACKUP / "app" / "requirements.txt").read_bytes() != (
                        ROOT / "app" / "requirements.txt").read_bytes():
                    subprocess.run([sys.executable, "-m", "pip", "install", "-r",
                                    str(ROOT / "app" / "requirements.txt")], check=True)
            except Exception as error:
                rollback()
                raise RuntimeError(f"Update failed; previous code restored: {error}") from error
