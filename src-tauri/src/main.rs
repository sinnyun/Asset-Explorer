// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aggregator;
mod commands;
mod database;
mod indexer;
mod metadata_extractor;
mod models;
mod thumbnail_cache;
mod watcher;

use commands::*;
use database::Database;
use std::sync::Arc;

fn main() {
    // ========================================================================
    // 机制 1：单实例运行防护 (Windows 原生命名互斥锁)
    // 防止重复启动应用、避免多个进程竞争 SQLite 数据库或端口产生僵尸进程
    // ========================================================================
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };

        let mutex_name: Vec<u16> = "Global\\AssetHub_Desktop_SingleInstance\0"
            .encode_utf16()
            .collect();
        let _h_mutex = CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr());

        if GetLastError() == ERROR_ALREADY_EXISTS {
            let win_title: Vec<u16> = "Asset Hub\0".encode_utf16().collect();
            let hwnd = FindWindowW(std::ptr::null(), win_title.as_ptr());
            if hwnd != 0 {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
            }
            eprintln!("[SingleInstance] 检测到已有 AssetHub 实例正在运行，已唤醒已有窗口，新进程自动退出。");
            std::process::exit(0);
        }
    }

    // 初始化本地 SQLite 数据库 (高并发 WAL 模式)
    let db = Database::init().unwrap_or_else(|err| {
        eprintln!("[Warning] 本地文件数据库初始化失败，切换至内存模式: {}", err);
        Database::init_in_memory().expect("初始化数据库失败")
    });

    // 克隆一份用于 setup 闭包，避免 move 后 on_window_event 无法使用
    let db_for_setup = db.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(db.clone())
        // ====================================================================
        // 机制 2：启动时自动校验资产有效性并挂载文件监听器
        // ====================================================================
        .setup(move |app| {
            // 启动时自动校验：删除数据库中文件已不存在的资产记录
            match db_for_setup.validate_assets() {
                Ok((total, deleted)) => {
                    if deleted > 0 {
                        println!("[Startup] 启动校验完成: 检查 {} 个资产, 清理了 {} 个无效路径", total, deleted);
                    }
                }
                Err(e) => {
                    eprintln!("[Startup] 启动资产校验失败: {}", e);
                }
            }

            // 启动文件监控器，监听已监控文件夹的变更
            let app_handle = app.handle().clone();
            watcher::start_file_watcher(app_handle, Arc::new(db_for_setup.clone()));
            Ok(())
        })
        // ====================================================================
        // 机制 3：完善完整的界面退出机制
        // 关闭主窗口时，主动刷新数据库事务 WAL 检查点，并退出整个应用进程，
        // 彻底终结所有后台 Tokio/Rayon/Notify 监听线程，坚决避免僵尸进程！
        // ====================================================================
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                println!("[Shutdown] 用户关闭主界面窗口，正在安全刷盘数据库并清理所有后台进程...");
                db.checkpoint();
                // 终止当前进程及其派生线程，避免僵尸进程遗留
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            scan_directory,
            set_asset_rating,
            set_asset_favorite,
            delete_assets,
            create_folder,
            rename_folder,
            delete_folder,
            create_tag,
            delete_tag,
            create_collection,
            delete_collection,
            save_smart_folder,
            delete_smart_folder,
            aggregate_data,
            filter_by_smart_folder,
            get_file_metadata,
            get_thumbnail,
            open_in_file_manager,
            get_system_info,
            get_storage_stats,
            migrate_data_storage,
            restart_application,
            validate_assets
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 桌面客户端失败");
}
