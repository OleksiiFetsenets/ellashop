# Assembles the Windows application and its bundled Python dependencies.
# The installer script packages the resulting build for distribution.
# Build the portable Windows application. Run from any working directory.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # the progress bar makes downloads very slow in Windows PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target = Join-Path $root 'build\Ellashop'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
foreach ($name in @('python', 'app', 'models', 'windows')) {
    New-Item -ItemType Directory -Force (Join-Path $target $name) | Out-Null
}

$pythonVersion = '3.12.10'
$pythonZip = Join-Path $env:TEMP "python-$pythonVersion-embeddable-amd64.zip"
Invoke-WebRequest "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embeddable-amd64.zip" -OutFile $pythonZip
Expand-Archive $pythonZip (Join-Path $target 'python') -Force
$pth = Join-Path $target 'python\python312._pth'
if (-not (Test-Path $pth)) { throw 'Missing python312._pth' }
$contents = (Get-Content $pth -Raw) -replace '(?m)^#import site\s*$', 'import site'
if ($contents -notmatch '(?m)^import site\s*$') { throw 'Could not enable site-packages' }
Set-Content $pth $contents -Encoding ascii

$getPip = Join-Path $env:TEMP 'ellashop-get-pip.py'
Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip
$python = Join-Path $target 'python\python.exe'
& $python $getPip
if ($LASTEXITCODE -ne 0) { throw 'get-pip.py failed' }
# pywebview needs proxy_tools, which exists only as a setup.py source package. Embeddable Python has no
# setuptools and its ._pth file hides isolated build environments, so build it here without isolation.
& $python -m pip install setuptools wheel
if ($LASTEXITCODE -ne 0) { throw 'setuptools installation failed' }
& $python -m pip install --no-build-isolation proxy_tools
if ($LASTEXITCODE -ne 0) { throw 'proxy_tools installation failed' }
& $python -m pip install -r (Join-Path $root 'app\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }

# Walk only distributable directories so private fonts and virtual environments are never read into the package.
function Copy-AppTree([string]$source, [string]$destination, [string]$relative) {
    New-Item -ItemType Directory -Force $destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
        $childRelative = if ($relative) { "$relative/$($item.Name)" } else { $item.Name }
        if ($item.PSIsContainer) {
            if ($item.Name -in @('.venv', '.previous', '__pycache__', 'models') -or
                $childRelative -eq 'static/fonts/local') { continue }
            Copy-AppTree $item.FullName (Join-Path $destination $item.Name) $childRelative
        } elseif ($item.Name -notin @('settings.json', 'update.json', 'photoroom_key.txt') -and
                  $item.Extension -notin @('.pyc', '.pyo')) {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $destination $item.Name)
        }
    }
}
Copy-AppTree (Join-Path $root 'app') (Join-Path $target 'app') ''
Copy-Item (Join-Path $root 'VERSION') $target
Copy-Item (Join-Path $root 'windows\ellashop.ico') (Join-Path $target 'windows\ellashop.ico')
Copy-Item (Join-Path $root 'windows\make_release.py') (Join-Path $target 'windows\make_release.py')

if ($env:ELLASHOP_UPDATE_REPO) {
    @{ repo = $env:ELLASHOP_UPDATE_REPO } | ConvertTo-Json -Compress |
        Set-Content (Join-Path $target 'app\update.json') -Encoding utf8
}

$env:U2NET_HOME = Join-Path $target 'models'
try {
    & $python -c "import rembg; rembg.new_session('birefnet-portrait')"
    if ($LASTEXITCODE -ne 0) { throw 'Background model download failed' }
} finally {
    Remove-Item Env:U2NET_HOME -ErrorAction SilentlyContinue
}
$face = Join-Path $target 'app\models\face_detection_yunet_2023mar.onnx'
New-Item -ItemType Directory -Force (Split-Path $face) | Out-Null
# opencv_zoo keeps models in Git LFS: raw.githubusercontent.com returns only a pointer file, media.githubusercontent.com the model.
Invoke-WebRequest 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx' -OutFile $face
if ((Get-FileHash $face -Algorithm SHA256).Hash -ne '8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4') {
    throw 'YuNet model download is incomplete'
}

$webview = Join-Path $target 'windows\MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $webview
if ((Get-Item $webview).Length -lt 100000) { throw 'WebView2 bootstrapper download is incomplete' }

foreach ($required in @('python\pythonw.exe', 'app\desktop.py', 'app\server.py',
        'app\static\icon.png', 'windows\ellashop.ico', 'windows\MicrosoftEdgeWebview2Setup.exe',
        'app\models\face_detection_yunet_2023mar.onnx')) {
    if (-not (Test-Path (Join-Path $target $required))) { throw "Missing build artifact: $required" }
}
Write-Host "Windows package ready: $target"
