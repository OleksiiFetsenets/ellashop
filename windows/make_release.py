"""Create a code-only release zip for GitHub Releases."""
# Packages updateable code files into a release archive.
# update.py downloads this archive while leaving shop data and models intact.

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))
import update


def main():
    version = update.current_version()
    output = ROOT / "dist" / f"ellashop-app-{version}.zip"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(update._code_files()):
            archive.write(file, file.relative_to(ROOT).as_posix())
    print(output)


if __name__ == "__main__":
    main()
