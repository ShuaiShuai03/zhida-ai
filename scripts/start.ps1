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

$Listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($Listeners) {
    Write-Host "错误: 端口 $Port 已被占用。" -ForegroundColor Red
    $Listeners | ForEach-Object {
        $ProcessName = ""
        try {
            $ProcessName = (Get-Process -Id $_.OwningProcess -ErrorAction Stop).ProcessName
        }
        catch {
            $ProcessName = "unknown"
        }
        Write-Host ("  {0}:{1} PID={2} Process={3}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess, $ProcessName)
    }
    Write-Host ""
    Write-Host "请停止旧进程，或使用其他端口，例如: powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 3001"
    exit 1
}

if (-not $env:ZHIDA_CONFIG_SECRET) {
    Write-Host "错误: 请先设置 ZHIDA_CONFIG_SECRET，用于加密保存 API 密钥。" -ForegroundColor Red
    Write-Host "示例: `$env:ZHIDA_CONFIG_SECRET = 'change-this-to-a-long-random-secret'; powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port $Port"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 Node.js。" -ForegroundColor Red
    Write-Host "请安装 Node.js 20+: https://nodejs.org/"
    exit 1
}

$nodeVersion = (& node -v)
if ($nodeVersion -notmatch '^v([0-9]+)\.') {
    Write-Host "错误: 无法解析当前 Node.js 版本: $nodeVersion" -ForegroundColor Red
    exit 1
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 20) {
    Write-Host "错误: 当前 Node.js 版本为 $nodeVersion，不符合要求。" -ForegroundColor Red
    Write-Host "本项目要求 Node.js 20+。" -ForegroundColor Red
    exit 1
}

Write-Host "检测到 Node.js 版本: $nodeVersion" -ForegroundColor Green
Write-Host "使用 Node 后端代理启动..." -ForegroundColor Yellow
Push-Location $ProjectDir
$env:ZHIDA_PORT = "$Port"
node server/server.js
Pop-Location
