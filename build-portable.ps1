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
Copy-Item (Join-Path $root 'voice-host.js') $app
Copy-Item (Join-Path $root 'preload.js') $app
Copy-Item (Join-Path $root 'package.json') $app
Copy-Item (Join-Path $root 'renderer') $app -Recurse
Copy-Item (Join-Path $root 'assets') $app -Recurse

# 运行时依赖：语音通道需要 ws（无子依赖）
$wsSrc = Join-Path $root 'node_modules\ws'
if (-not (Test-Path $wsSrc)) { throw "ws module not found: $wsSrc. Run npm install first." }
$appModules = Join-Path $app 'node_modules'
New-Item -ItemType Directory -Path $appModules | Out-Null
Copy-Item $wsSrc $appModules -Recurse

# Keep only Chinese and English locale packs
$locales = Join-Path $dist 'locales'
if (Test-Path $locales) {
  Get-ChildItem $locales -Filter '*.pak' | Where-Object { $_.Name -notin @('zh-CN.pak', 'en-US.pak') } |
    Remove-Item -Force
}

Rename-Item (Join-Path $dist 'electron.exe') 'Tractor.exe'

# 把 Electron 默认图标换成游戏图标（资源管理器 / 任务栏 / 快捷方式都用它）
$rcedit = Join-Path $root 'node_modules\rcedit\bin\rcedit-x64.exe'
if (Test-Path $rcedit) {
  & $rcedit (Join-Path $dist 'Tractor.exe') --set-icon (Join-Path $root 'assets\tractor.ico')
  if ($LASTEXITCODE -ne 0) { Write-Warning '图标写入失败，exe 仍是 Electron 默认图标' }
} else {
  Write-Warning "未安装 rcedit，跳过 exe 图标（npm install 后再打包）"
}

$size = [math]::Round((Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Portable package: $dist\Tractor.exe (~$size MB)"
