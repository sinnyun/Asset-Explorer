@echo off
chcp 65001 >nul
title Asset Hub - 本地桌面端自动化启动器 (Rust + Tauri)
color 0B

echo ===============================================================================
echo                Asset Hub 本地桌面客户端自动化部署与启动工具
echo                       架构：Rust + Tauri v2 + React 19
echo ===============================================================================
echo.

:: 1. 检查 Node.js 环境
echo [1/5] 检查 Node.js 运行时...
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v18+ 或 v20+):
    echo 官方下载地址: https://nodejs.org/
    echo 安装完成后，请重新双击本脚本。
    pause
    exit /b 1
)
node -v
echo [OK] Node.js 检测通过！
echo.

:: 2. 检查 Rust 编译环境
echo [2/5] 检查 Rust/Cargo 编译工具链...
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    color 0E
    echo [警告] 未检测到 Rust/Cargo 编译器。
    echo Tauri 桌面程序需要 Rust 环境。
    echo 正在为您打开 Rust 官方安装页面 (https://rustup.rs/)...
    start https://rustup.rs/
    echo.
    echo 请下载并运行 rustup-init.exe，安装时直接按回车选择默认配置。
    echo 安装完成后，请关闭并重新运行本脚本。
    pause
    exit /b 1
)
cargo -v
echo [OK] Rust 工具链检测通过！
echo.

:: 3. 准备配置文件与环境
echo [3/5] 检查并配置项目文件...
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [OK] 已自动从 .env.example 复制生成 .env 配置文件！
    )
)

:: 4. 安装 Node.js 依赖
echo [4/5] 检查并安装前端/Tauri 依赖包 (npm install)...
call npm install
if %errorlevel% neq 0 (
    color 0C
    echo [错误] npm 依赖安装失败，请检查网络或 npm 源设置！
    pause
    exit /b 1
)
echo [OK] npm 依赖安装完成！
echo.

:: 4.1 单实例检测与僵尸进程防卡死清理机制
echo [*] 执行单实例与防僵尸进程防护检查...
set FOUND_ZOMBIE=0
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo [发现] 端口 3000 已被历史残留进程 (PID: %%a) 占用！
    echo 正在自动终止残留进程，避免重复启动造成后台卡死与僵尸进程...
    taskkill /f /pid %%a >nul 2>nul
    set FOUND_ZOMBIE=1
)
taskkill /f /im AssetHub.exe >nul 2>nul
if "%FOUND_ZOMBIE%"=="1" (
    echo [OK] 已成功清理残留进程与占用端口，准备全新无锁启动。
) else (
    echo [OK] 端口环境干净，无历史残留冲突。
)
echo.

:: 5. 启动开发服务器与 Rust Tauri 桌面窗口
echo [5/5] 正在启动 Rust + Tauri 本地桌面程序 (开发热重载模式)...
echo 首次启动时 Rust 将自动下载依赖库并编译后端模块，请稍候 1-2 分钟...
echo.
color 0A
call npm run desktop:dev

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo [提示] 如果 Rust 编译报错，请确保已安装 Visual Studio C++ 生成工具 (MSVC):
    echo 推荐安装: Visual Studio Build Tools (包含 C++ 开发工作负荷)
    echo 微软官方说明: https://vcpkg.io/en/getting-started
    pause
)
