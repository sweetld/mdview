# One-step installer for MD View on Windows 10 and later. From a clone:
#   powershell -ExecutionPolicy Bypass -File install.ps1     (or double-click install.cmd)
# Builds the installer on this machine and runs it silently: per-user, no
# administrator rights, Start Menu and desktop shortcuts, .md/.excalidraw
# registered. A locally built installer carries no download mark, so SmartScreen
# does not intervene.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20 or newer is required. Install it from https://nodejs.org and re-run.'
}
if ([int]((node -p 'process.versions.node.split(".")[0]')) -lt 20) {
  throw "Node.js 20 or newer is required (found $(node -v))."
}

Write-Host 'Installing dependencies...'
npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Write-Host 'Building the installer (a few minutes the first time)...'
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
npx electron-builder --win nsis --x64 --publish never
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$setup = Get-ChildItem dist -Filter '*Setup*.exe' | Select-Object -First 1
if (-not $setup) { throw 'build finished but no installer was found in dist\.' }

Write-Host "Installing $($setup.Name)..."
Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait
Write-Host 'Installed. Find MD View in the Start Menu.'
