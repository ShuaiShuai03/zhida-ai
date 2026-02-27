# 智答 AI — 本地启动脚本 (Windows PowerShell)
param(
    [int]$Port = 3000
)

$ProjectDir = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  智答 AI — 本地开发服务器" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  项目目录: $ProjectDir"
Write-Host "  访问地址: http://localhost:$Port" -ForegroundColor Green
Write-Host "  按 Ctrl+C 停止"
Write-Host ""

# Try Python first, then Node.js
$python = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }

if ($python) {
    Write-Host "使用 Python 启动..." -ForegroundColor Yellow
    Push-Location $ProjectDir
    & $python.Source -m http.server $Port
    Pop-Location
}
elseif (Get-Command npx -ErrorAction SilentlyContinue) {
    Write-Host "使用 npx serve 启动..." -ForegroundColor Yellow
    Push-Location $ProjectDir
    npx serve . -p $Port
    Pop-Location
}
else {
    Write-Host "错误: 未找到 Python 或 Node.js。" -ForegroundColor Red
    Write-Host "请安装以下任一工具:"
    Write-Host "  - Python 3: https://www.python.org/downloads/"
    Write-Host "  - Node.js:  https://nodejs.org/"
    exit 1
}
