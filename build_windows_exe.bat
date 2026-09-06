@echo off
chcp 65001 >nul
title Asset Hub - 一键打包发布 Windows 独立 EXE 安装程序
color 0A

echo ===============================================================================
echo                Asset Hub - Windows 独立可执行程序 (EXE) 打包工具
echo                       架构：Rust + Tauri v2 生产构建
echo ===============================================================================
echo.

echo [1/3] 正在编译前端生产资源 (vite build)...
call npm run build
if %errorlevel% neq 0 (
    color 0C
    echo [错误] 前端构建失败！
    pause
    exit /b 1
)

echo.
echo [2/3] 正在使用 Rust 编译器生成最高性能的独立 Windows 二进制文件与安装包...
echo 开启 LTO 链接时优化与二进制体积精简...
call npm run desktop:build

if %errorlevel% neq 0 (
    color 0C
    echo [错误] Rust 打包失败，请检查编译错误输出。
    pause
    exit /b 1
)

echo.
echo ===============================================================================
echo [3/3] 打包大功告成！
echo 独立 EXE 和 MSI 安装程序已生成至以下目录：
echo  - src-tauri\target\release\
echo  - src-tauri\target\release\bundle\msi\
echo ===============================================================================
echo.
pause
