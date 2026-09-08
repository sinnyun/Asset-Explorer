// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aggregator;
mod commands;
mod database;
mod indexer;
mod metadata_extractor;
mod models;
mod sync;
mod thumbnail_cache;
mod watcher;

use commands::*;
use database::Database;
use std::sync::Arc;
use tauri::Manager;
use watcher::WatcherRegistry;

fn main() {
    // 初始化本地 SQLite 数据库 (高并发 WAL 模式)
    // 若主库文件损坏或无法打开，自动备份原文件并重建全新数据库；
    // 仅在极端异常（文件系统问题等）下回退到内存模式，仍保持有效 data_dir。
    let db = match Database::init() {
        Ok(db) => db,
        Err(err) => {
            eprintln!("[Warning] 本地文件数据库初始化失败，尝试重建: {}", err);
            match Database::init() {
                Ok(db) => db,
                Err(err2) => {
                    eprintln!("[Warning] 重建文件数据库仍失败，切换至内存模式: {}", err2);
                    Database::init_in_memory(None).expect("初始化数据库失败")
                }
            }
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
        // ====================================================================
        // 机制 2：启动时自动校验资产有效性并挂载文件监听器
        // ====================================================================
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

            // 后台周期对账兜底：每 60s 以廉价剪枝模式对全部已监控根做一次对账，
            // 纠正 notify 事件可能存在的漏检（结构变化必定冒泡到目录 mtime，能被剪枝路径捕获）。
            let per_app = app_handle.clone();
            let per_db = db_for_setup.clone();
            std::thread::spawn(move || {
                use crate::sync::{reconcile_root, ReconcileMode};
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    if let Ok(folders) = per_db.get_monitored_folders() {
                        for f in &folders {
                            let p = std::path::Path::new(&f.path);
                            if p.exists() {
                                let _ = reconcile_root(&per_app, &per_db, p, ReconcileMode::Pruned);
                            }
                        }
                    }
                }
            });

            // 资产有效性校验移至后台线程异步执行，不阻塞 Tauri 主线程与首帧渲染
            // 前端 useAppState 不再调用 validate_assets + 二次 loadWorkspace，
            // 避免每次启动都做全量数据拉取两次。
            let validate_db = db_for_setup.clone();
            std::thread::spawn(move || {
                match validate_db.validate_assets() {
                    Ok((total, deleted)) => {
                        println!("[Startup] 启动资产校验完成: 检查 {} 个资产, 清理了 {} 个无效路径", total, deleted);
                    }
                    Err(e) => {
                        eprintln!("[Startup] 启动资产校验失败: {}", e);
                    }
                }
            });
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
            // 窗口重新获得焦点时，做一次廉价剪枝对账兜底，确保用户回到应用后
            // 界面与磁盘一致（覆盖来自外部资源管理器等在中途的目录增删改）。
            if let tauri::WindowEvent::Focused(true) = event {
                if _window.label() == "main" {
                    let focus_app = _window.app_handle().clone();
                    let focus_db = db.clone();
                    std::thread::spawn(move || {
                        use crate::sync::{reconcile_root, ReconcileMode};
                        if let Ok(folders) = focus_db.get_monitored_folders() {
                            for f in &folders {
                                let p = std::path::Path::new(&f.path);
                                if p.exists() {
                                    let _ = reconcile_root(&focus_app, &focus_db, p, ReconcileMode::Pruned);
                                }
                            }
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            scan_directory,
            start_scan_directory,
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
