// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aggregator;
mod asset_query;
mod commands;
mod database;
mod index_jobs;
mod indexer;
mod metadata_extractor;
mod models;
mod sync;
mod thumbnail_cache;
mod watcher;

#[cfg(test)]
mod database_v2_tests;

use commands::*;
use database::Database;
use index_jobs::IndexCoordinator;
use std::sync::Arc;
use tauri::Manager;
use watcher::WatcherRegistry;

fn main() {
    // Open only the V2 database. Report initialization failure visibly before exiting.
    let db = match Database::init_v2() {
        Ok(db) => db,
        Err(error) => {
            show_initialization_error(&error);
            std::process::exit(1);
        }
    };

    // 克隆一份用于 setup 闭包，避免 move 后 on_window_event 无法使用
    let db_for_setup = db.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 机制 1：单实例运行防护 (使用 tauri-plugin-single-instance 开源库替代手写 Windows Mutex)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 当检测到第二个实例启动时，将已运行的窗口恢复到前台
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            println!("[SingleInstance] 检测到已有 AssetHub 实例正在运行，已唤醒已有窗口，新进程自动退出。");
        }))
        .manage(db.clone())
        .manage(IndexCoordinator::new(2, 32))
        // Startup only opens storage and registers watchers. Expensive filesystem
        // maintenance is always an explicit, cancellable job.
        .setup(move |app| {
            println!("[Startup] Tauri 应用启动中，开始初始化监控...");
            // 创建全局文件监控注册表，支持运行时动态添加/移除监控文件夹
            let app_handle = app.handle().clone();
            match WatcherRegistry::new(app_handle.clone(), Arc::new(db_for_setup.clone())) {
                Ok(registry) => {
                    app.manage(registry);
                    println!("[Startup] 文件监控器初始化完成");
                }
                Err(e) => {
                    eprintln!("[Startup] 文件监控器初始化失败: {}", e);
                }
            }

            println!("[Startup] Tauri 初始化完成，开始监听窗口事件...");
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
            get_workspace_shell_v2,
            query_assets_v2,
            query_folders_v2,
            get_asset_details_v2,
            load_workspace,
            scan_directory,
            start_scan_directory,
            cancel_job_v2,
            get_job_status_v2,
            watch_folder,
            unwatch_folder,
            search_assets,
            set_asset_rating,
            set_asset_favorite,
            delete_assets,
            sync_asset_tags,
            sync_asset_collections,
            sync_many_asset_tags,
            sync_many_asset_collections,
            remove_asset_tags,
            remove_asset_collections,
            create_folder,
            rename_folder,
            update_folder,
            delete_folder,
            create_tag,
            update_tag,
            delete_tag,
            create_collection,
            update_collection,
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
            validate_assets,
            read_thumbnail_base64,
            read_file_base64,
            file_exists,
            reconcile_monitored_folders
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 桌面客户端失败");
}

fn show_initialization_error(error: &str) {
    let message = format!("初始化 Asset Explorer V2 数据库失败：\n{error}");
    eprintln!("{message}");
    #[cfg(windows)]
    {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND};
        let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        // The native modal dialog works before Tauri exists and in release builds without a console.
        unsafe {
            MessageBoxW(None, PCWSTR(message.as_ptr()), w!("Asset Explorer V2"), MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
        }
    }
}
