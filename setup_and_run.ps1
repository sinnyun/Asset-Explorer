# ==============================================================================
# Asset Hub - 本地桌面端自动化部署脚本 (PowerShell)
# 架构: Rust + Tauri 2.x + React 19
# ==============================================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Asset Hub - Rust + Tauri Desktop Launcher"

Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host "               Asset Hub 本地桌面客户端自动化部署与启动工具 (PowerShell)" -ForegroundColor Green
Write-Host "                      架构：Rust + Tauri v2 + React 19" -ForegroundColor Yellow
Write-Host "===============================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js
Write-Host "[1/5] 检查 Node.js 运行时环境..." -ForegroundColor White
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[错误] 未检测到 Node.js，请先安装 Node.js (推荐 LTS 版本):" -ForegroundColor Red
    Write-Host "下载链接: https://nodejs.org/" -ForegroundColor Yellow
    Start-Process "https://nodejs.org/"
    Read-Host "按回车键退出..."
    exit 1
}
$nodeVer = node -v
Write-Host "[OK] 检测到 Node.js 版本: $nodeVer" -ForegroundColor Green

# 2. 检查 Rust
Write-Host "`n[2/5] 检查 Rust/Cargo 编译工具链..." -ForegroundColor White
$cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCmd) {
    Write-Host "[警告] 未检测到 Rust/Cargo 编译器。" -ForegroundColor Yellow
    Write-Host "Tauri 本地桌面客户端依赖 Rust 进行后台计算与原生系统交互。" -ForegroundColor Yellow
    Write-Host "正在为您打开 Rust 官方安装页面..." -ForegroundColor Cyan
    Start-Process "https://rustup.rs/"
    Read-Host "请下载安装 rustup-init 后，重新运行本脚本。按回车键退出..."
    exit 1
}
$cargoVer = cargo -v
Write-Host "[OK] 检测到 Rust 工具链: $cargoVer" -ForegroundColor Green

# 3. 复制与重命名初始配置文件
Write-Host "`n[3/5] 自动准备配置文件..." -ForegroundColor White
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "[OK] 已自动从 .env.example 生成 .env 文件。" -ForegroundColor Green
    }
}

# 4. 安装 Node 依赖包
Write-Host "`n[4/5] 检查并安装项目依赖包 (npm install)..." -ForegroundColor White
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] npm install 安装失败，请检查网络设置。" -ForegroundColor Red
    Read-Host "按回车键退出..."
    exit 1
}
Write-Host "[OK] 前端及 Tauri CLI 依赖安装成功！" -ForegroundColor Green

# 4.1 单实例检测与僵尸进程防卡死清理机制
Write-Host "`n[*] 执行单实例与防僵尸进程防护检查..." -ForegroundColor Cyan
$zombieProcesses = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($zombieProcesses) {
    foreach ($conn in $zombieProcesses) {
        $zPid = $conn.OwningProcess
        Write-Host "[发现] 端口 3000 已被历史残留进程 (PID: $zPid) 占用！" -ForegroundColor Yellow
        Write-Host "正在自动终止残留进程，避免重复启动造成后台卡死与僵尸进程..." -ForegroundColor Yellow
        Stop-Process -Id $zPid -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] 历史残留进程已终止，端口已释放。" -ForegroundColor Green
} else {
    Write-Host "[OK] 端口环境干净，无历史残留冲突。" -ForegroundColor Green
}
Get-Process -Name "AssetHub" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 5. 启动开发服务器与 Rust Tauri 桌面窗口
Write-Host "`n[5/5] 正在启动 Rust + Tauri 桌面应用程序..." -ForegroundColor Magenta
Write-Host "Rust 将自动完成各独立组件 (索引模块、数据聚合模块、IPC 模块) 的编译..." -ForegroundColor Cyan
Write-Host ""

npm run desktop:dev
