//! ============================================================================
//! 模块：文件监控 (watcher.rs)
//! 职责：使用 notify 监听用户已添加到工作区的文件夹变动（新增、重命名、删除），
//! 并实时更新数据库并向 Tauri 前端发送事件通知刷新视图。
//! 依赖开源库：`notify` v6, `tauri`, `chrono`
//! ============================================================================

use crate::database::Database;
use crate::indexer::{infer_category_from_extension, stable_hash};
use chrono::Utc;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::Emitter;

/// 发送给前端的事件载荷
#[derive(Clone, Serialize)]
pub struct AssetChangeEvent {
    pub asset_id: Option<String>,
    pub path: String,
    pub action: String, // "added" | "removed" | "modified"
}

/// 启动文件监控器，监听所有已监控文件夹的变更
/// 在独立的 tokio 任务中运行，不影响主线程
pub fn start_file_watcher(app_handle: tauri::AppHandle, db: Arc<Database>) {
    let monitored_folders = match db.get_monitored_folders() {
        Ok(folders) => folders,
        Err(e) => {
            eprintln!("[Watcher] 获取监控文件夹列表失败: {}", e);
            return;
        }
    };

    if monitored_folders.is_empty() {
        println!("[Watcher] 没有已监控的文件夹，跳过文件监控启动");
        return;
    }

    println!("[Watcher] 启动文件监控，共 {} 个监控文件夹", monitored_folders.len());

    let (tx, rx) = std::sync::mpsc::channel::<Result<Event, notify::Error>>();

    let mut watcher = match RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[Watcher] 创建文件监控器失败: {}", e);
            return;
        }
    };

    // 为每个监控文件夹注册递归监听
    for folder in &monitored_folders {
        let path = Path::new(&folder.path);
        if !path.exists() {
            eprintln!("[Watcher] 监控路径不存在，跳过: {}", folder.path);
            continue;
        }
        if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
            eprintln!("[Watcher] 注册监听失败 {}: {}", folder.path, e);
        } else {
            println!("[Watcher] 开始监视: {} (id: {})", folder.path, folder.id);
        }
    }

    // 后台线程处理文件变更事件
    std::thread::spawn(move || {
        while let Ok(Ok(event)) = rx.recv() {
            if let Err(e) = handle_file_event(&app_handle, &db, &event) {
                eprintln!("[Watcher] 处理文件事件失败: {}", e);
            }
        }
    });
}

/// 处理单个文件变更事件
fn handle_file_event(app_handle: &tauri::AppHandle, db: &Database, event: &Event) -> Result<(), String> {
    let path = match event.paths.first() {
        Some(p) => p,
        None => return Ok(()),
    };

    // 忽略非文件系统变更（如权限变更）
    if !path.exists() && !matches!(event.kind, EventKind::Remove(_)) {
        return Ok(());
    }

    match event.kind {
        // ============================================================
        // 文件/文件夹创建
        // ============================================================
        EventKind::Create(notify::event::CreateKind::File) => {
            // 检查文件扩展名是否支持
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let category = infer_category_from_extension(ext);
            if category == "other" {
                return Ok(()); // 不支持的格式跳过
            }

            // 检查是否已存在（避免重复处理）
            let path_str = path.to_string_lossy().to_string();
            if db.get_asset_by_path(&path_str)?.is_some() {
                return Ok(()); // 已在数据库中
            }

            // 扫描新文件并添加到数据库
            let asset = create_asset_from_path(path)?;
            // 使用批量保存函数（仅一个资产）
            db.batch_save_scan_results(
                &crate::models::Folder {
                    id: String::new(),
                    name: String::new(),
                    path: String::new(),
                    parent_id: None,
                    is_monitored: false,
                    asset_count: None,
                },
                &[],
                &[asset.clone()],
            )?;

            // 发送事件给前端
            let _ = app_handle.emit("asset:added", AssetChangeEvent {
                asset_id: Some(asset.id),
                path: path_str.clone(),
                action: "added".to_string(),
            });
            println!("[Watcher] 新文件已添加: {}", path_str);
        }

        // ============================================================
        // 文件/文件夹删除
        // ============================================================
        EventKind::Remove(_) => {
            let path_str = path.to_string_lossy().to_string();
            let deleted = db.delete_assets_by_paths(&[path_str.clone()])?;
            if deleted > 0 {
                let _ = app_handle.emit("asset:removed", AssetChangeEvent {
                    asset_id: None,
                    path: path_str.clone(),
                    action: "removed".to_string(),
                });
                println!("[Watcher] 文件已移除: {}", path_str);
            }
        }

        // ============================================================
        // 文件修改（内容或元数据变更）
        // ============================================================
        EventKind::Modify(notify::event::ModifyKind::Data(_))
        | EventKind::Modify(notify::event::ModifyKind::Metadata(_)) => {
            // 只处理文件，不处理文件夹
            if !path.is_file() {
                return Ok(());
            }

            let path_str = path.to_string_lossy().to_string();
            // 检查数据库中是否存在
            if let Some(existing) = db.get_asset_by_path(&path_str)? {
                let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
                let modified = metadata.modified().ok();
                let new_date = modified
                    .map(|t| {
                        let dt: chrono::DateTime<Utc> = t.into();
                        dt.to_rfc3339()
                    })
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                // 只更新 metadata 变更的内容
                db.update_asset_field(&existing.id, "date_modified", &new_date)?;
                db.update_asset_field(&existing.id, "size", &metadata.len().to_string())?;

                let _ = app_handle.emit("asset:modified", AssetChangeEvent {
                    asset_id: Some(existing.id),
                    path: path_str.clone(),
                    action: "modified".to_string(),
                });
                println!("[Watcher] 文件已更新: {}", path_str);
            }
        }

        _ => {}
    }

    Ok(())
}

/// 从文件路径创建资产对象
fn create_asset_from_path(path: &Path) -> Result<crate::models::Asset, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let file_size = metadata.len();
    let file_str = path.to_string_lossy().to_string();

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();

    let asset_type = infer_category_from_extension(&extension).to_string();

    let modified_time = metadata
        .modified()
        .ok()
        .map(|t| {
            let dt: chrono::DateTime<Utc> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    let id = format!("ast_{}", stable_hash(&file_str));

    Ok(crate::models::Asset {
        id,
        name: file_name,
        path: file_str,
        asset_type,
        size: file_size,
        folder_id: String::new(), // 由调用者填充
        tags: Vec::new(),
        collections: Vec::new(),
        date_modified: modified_time,
        date_added: Utc::now().to_rfc3339(),
        rating: 0,
        favorite: false,
        color: None,
        width: None,
        height: None,
        file_hash: None,
        thumbnail_url: None,
    })
}
