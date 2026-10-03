# 下载并安装 Electron 运行时
# 某些网络环境下 `npm install` 里的 @electron/get 会卡住或写不进系统缓存目录，
# 这时用这个脚本手动补上：下载 zip -> 解压到 node_modules/electron/dist -> 写 path.txt
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/install-electron.ps1 [版本号]

param([string]$Version = '44.5.1')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$zip = Join-Path $root ".electron-cache\electron-v$Version-win32-x64.zip"
$pkgDir = Join-Path $root 'node_modules\electron'
$dest = Join-Path $pkgDir 'dist'

if (-not (Test-Path (Join-Path $pkgDir 'package.json'))) {
  Write-Host '先安装 npm 依赖…'
  Push-Location $root
  npm install --no-audit --no-fund
  Pop-Location
}

if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 100MB) {
  Write-Host '下载 Electron 运行时…'
  Push-Location $root
  node scripts/fetch-electron.js $Version
  Pop-Location
}

Write-Host '解压到 node_modules/electron/dist …'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
Set-Content -Path (Join-Path $pkgDir 'path.txt') -Value 'electron.exe' -NoNewline

$exe = Join-Path $dest 'electron.exe'
if (Test-Path $exe) {
  Write-Host "完成：$exe"
  & $exe --version
} else {
  throw "安装失败：找不到 $exe"
}
