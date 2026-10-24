# Build a portable Windows 7 package: dist\TractorWin7\Tractor.exe
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$src  = Join-Path $root 'node_modules\electron\dist'
$dist = Join-Path $root 'dist\TractorWin7'

if (-not (Test-Path (Join-Path $src 'electron.exe'))) {
  throw "Electron runtime not found: $src\electron.exe. Run npm install first."
}

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

Copy-Item (Join-Path $src '*') $dist -Recurse -Force

# Remove the default Electron demo app
Remove-Item (Join-Path $dist 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

# Application files
$app = Join-Path $dist 'resources\app'
New-Item -ItemType Directory -Path $app | Out-Null
Copy-Item (Join-Path $root 'main.js') $app
Copy-Item (Join-Path $root 'package.json') $app
Copy-Item (Join-Path $root 'renderer') $app -Recurse
Copy-Item (Join-Path $root 'assets') $app -Recurse

# Keep only Chinese and English locale packs
$locales = Join-Path $dist 'locales'
if (Test-Path $locales) {
  Get-ChildItem $locales -Filter '*.pak' | Where-Object { $_.Name -notin @('zh-CN.pak', 'en-US.pak') } |
    Remove-Item -Force
}

Rename-Item (Join-Path $dist 'electron.exe') 'Tractor.exe'

$size = [math]::Round((Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Portable package: $dist\Tractor.exe (~$size MB)"
