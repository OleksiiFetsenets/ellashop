# Windows package

Build on a Windows x64 PC with PowerShell and [Inno Setup 6](https://jrsoftware.org/isinfo.php):

1. Run `powershell -ExecutionPolicy Bypass -File windows\build.ps1` from the project root. The script downloads Python 3.12 x64, dependencies, the background removal model, YuNet, and the WebView2 bootstrapper.
2. Compile with `ISCC.exe /DAppVersion=<VERSION> windows\ellashop.iss`. The installer appears under `dist/`.
3. Test install, launch, background removal, face detection, saving, update/restart and uninstall on a real Windows PC before distribution.

The installer contains Python, dependencies, code, static assets and the models. Plan for roughly 1.5 GB unpacked (the background removal model alone is about 930 MB); the exact size depends on dependency and model versions. The installer installs per user under `%LOCALAPPDATA%\Programs\Ellashop` without administrator rights. The desktop app saves customer photos and workspaces under `%USERPROFILE%\Documents\Ellashop`; uninstall leaves that data in place.

Code updates use a GitHub Release containing `ellashop-app-<version>.zip` from `python windows/make_release.py`. GitHub Actions writes `app/update.json` into the installer using the repository name. The server checks the latest release in the background and caches the result for an hour. Applying an update backs up the prior code in `app/.previous/`; rollback restores it. Updates do not replace the bundled Python, installed dependencies, models, settings or customer data. If requirements change, the updater runs pip in the bundled Python and reports a failure if installation fails.
