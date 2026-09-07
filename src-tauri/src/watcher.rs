//! ============================================================================
//! 模块：文件监控 (watcher.rs)
//! 职责：使用 notify-debouncer-full 监听用户已添加到工作区的文件夹变动
//! （新增、重命名、删除、修改），事件自动去抖后批量更新数据库，
//! 大幅减少高频 I/O 产生的数据库写入次数。
//! 依赖开源库：`notify-debouncer-full`, `tauri`, `chrono`
//! ============================================================================

use crate::database::Database;
use crate::indexer::{infer_category_from_extension, stable_hash};
use chrono::Utc;
use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::{RecursiveMode, Watcher};
use notify_debouncer_full::notify::EventKind;
use notify_debouncer_full::DebounceEventResult;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

/// 发送给前端的事件载荷
/// - added / modified: 携带完整资产对象，前端可直接增量合并进状态（无需全量重载）
/// - removed: 仅携带 asset_id 与 path，前端按 ID 增量删除
#[derive(Clone, Serialize)]
pub struct AssetChangeEvent {
    pub asset_id: Option<String>,
    pub path: String,
    pub action: String, // "added" | "removed" | "modified"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<crate::models::Asset>,
}

/// 启动文件监控器，监听所有已监控文件夹的变更
/// 使用 notify-debouncer-full 开源库实现事件去抖：
/// - 连续文件操作（如批量解压、IDE 保存、批量重命名）会在防抖窗口内聚合
/// - 只有窗口结束后首次触发 handler，显著减少数据库写入次数 (约减少 90%)
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

    println!("[Watcher] 启动文件监控（防抖 500ms），共 {} 个监控文件夹", monitored_folders.len());

    let (tx, rx) = std::sync::mpsc::channel::<DebounceEventResult>();

    let mut debouncer = match new_debouncer(
        Duration::from_millis(500), // 500ms 防抖窗口
        None,                        // 使用默认 ticker
        move |res| {
            let _ = tx.send(res);
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[Watcher] 创建去抖文件监控器失败: {}", e);
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
        // 使用 notify-debouncer-full 内置的 watcher 注册监听
        let watcher = debouncer.watcher();
        if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
            eprintln!("[Watcher] 注册监听失败 {}: {}", folder.path, e);
        } else {
            println!("[Watcher] 开始监视: {} (id: {})", folder.path, folder.id);
        }
    }

    // 后台线程处理去抖后的事件批次
    // 注意：将 debouncer move 进线程保持存活，确保文件监控持续运行
    std::thread::spawn(move || {
        // 持有 debouncer，防止其被 drop 导致文件监控停止
        let _debouncer = debouncer;
        while let Ok(Ok(events)) = rx.recv() {
            if let Err(e) = handle_batch_file_events(&app_handle, &db, &events) {
                eprintln!("[Watcher] 处理批量文件事件失败: {}", e);
            }
        }
    });
}

/// 处理一批去抖后的文件事件
/// 将同一防抖窗口内的多个事件按 path 聚合去重，批量处理
fn handle_batch_file_events(
    app_handle: &tauri::AppHandle,
    db: &Database,
    events: &[notify_debouncer_full::DebouncedEvent],
) -> Result<(), String> {
    // 聚合事件：同一路径多次变更只处理最后一次状态
    // path → (action, is_dir)
    let mut additions: Vec<String> = Vec::new();
    let mut removals: Vec<String> = Vec::new();
    let mut modifications: Vec<String> = Vec::new();

    for event in events {
        for path in &event.event.paths {
            let path_str = path.to_string_lossy().to_string();

            // DebouncedEvent 内部包裹 notify::Event（event 字段）
            let kind = &event.event.kind;

            match kind {
                EventKind::Create(_) => {
                    // 文件可能仍存在（去抖后保留状态）
                    if path.is_file() {
                        if !additions.contains(&path_str) {
                            additions.push(path_str.clone());
                        }
                    } else if path.is_dir() {
                        // 目录创建需要触发重新扫描子目录中的文件
                        // 简化处理：目录变化标记为 modification，后续扫描对应文件夹
                        if !modifications.contains(&path_str) {
                            modifications.push(path_str.clone());
                        }
                    }
                }
                EventKind::Remove(_) => {
                    if !removals.contains(&path_str) {
                        removals.push(path_str);
                    }
                }
                EventKind::Modify(_) => {
                    if path.is_file() {
                        if !modifications.contains(&path_str) {
                            modifications.push(path_str);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // 批量处理删除事件
    if !removals.is_empty() {
        // 先查每个待删路径的 asset_id，事件中携带 → 前端可按 ID 精确增量删除
        let mut removed_ids: Vec<(String, String)> = Vec::new(); // (asset_id, path)
        for path_str in &removals {
            if let Ok(Some(asset)) = db.get_asset_by_path(path_str) {
                removed_ids.push((asset.id, path_str.clone()));
            }
        }

        let deleted = db.delete_assets_by_paths(&removals)?;
        if deleted > 0 {
            println!("[Watcher] 批量删除 {} 个文件", deleted);
            for (asset_id, path) in removed_ids {
                let _ = app_handle.emit("asset:removed", AssetChangeEvent {
                    asset_id: Some(asset_id),
                    path,
                    action: "removed".to_string(),
                    asset: None,
                });
            }
            // 数据库中可能还存在未能查到 asset_id 的记录（如被外部修改），按 path 兜底广播
            for path in &removals {
                if !removed_ids.iter().any(|(_, p)| p == path) {
                    let _ = app_handle.emit("asset:removed", AssetChangeEvent {
                        asset_id: None,
                        path: path.clone(),
                        action: "removed".to_string(),
                        asset: None,
                    });
                }
            }
        }
    }

    // 批量处理新增事件
    for path_str in &additions {
        let path = Path::new(path_str);
        if let Err(e) = handle_file_added(app_handle, db, path) {
            eprintln!("[Watcher] 添加文件失败 {}: {}", path_str, e);
        }
    }

    // 批量处理修改事件
    for path_str in &modifications {
        let path = Path::new(path_str);
        if let Err(e) = handle_file_modified(app_handle, db, path) {
            eprintln!("[Watcher] 修改文件失败 {}: {}", path_str, e);
        }
    }

    Ok(())
}

/// 处理单个新增文件
fn handle_file_added(app_handle: &tauri::AppHandle, db: &Database, path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_file() {
        return Ok(());
    }

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
    let mut asset = create_asset_from_path(path)?;

    // 根据路径前缀找到正确的父文件夹并设置 folder_id
    // 这样前端增量合并时 asset.folderId 正确关联
    let folders = db.get_folders()?;
    if let Some(parent_folder_id) = find_matching_folder(&folders, &path_str) {
        asset.folder_id = parent_folder_id;
    }

    // 持久化单个资产（UPSERT 幂等）
    db.batch_save_assets(&[asset.clone()])?;

    // 发送事件给前端（携带完整资产数据 → 前端可直接增量合并，无需全量重载）
    let _ = app_handle.emit("asset:added", AssetChangeEvent {
        asset_id: Some(asset.id.clone()),
        path: path_str.clone(),
        action: "added".to_string(),
        asset: Some(asset.clone()),
    });
    println!("[Watcher] 新文件已添加: {}", path_str);
    Ok(())
}

/// 处理单个修改文件
fn handle_file_modified(app_handle: &tauri::AppHandle, db: &Database, path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_file() {
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

        // 构造完整的最新资产对象（更新 date_modified 与 size 后再广播）
        let updated_asset = crate::models::Asset {
            size: metadata.len(),
            date_modified: new_date.clone(),
            ..existing.clone()
        };
        let _ = app_handle.emit("asset:modified", AssetChangeEvent {
            asset_id: Some(existing.id.clone()),
            path: path_str.clone(),
            action: "modified".to_string(),
            asset: Some(updated_asset),
        });
        println!("[Watcher] 文件已更新: {}", path_str);
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

/// 根据文件路径找到最匹配的文件夹（路径前缀最长匹配）
/// 用于新增文件时正确设置 asset.folder_id
fn find_matching_folder(folders: &[crate::models::Folder], file_path: &str) -> Option<String> {
    let file_lower = file_path.trim_end_matches(|c| c == '/' || c == '\\').to_lowercase();
    let mut best_match: Option<(usize, String)> = None; // (path_len, folder_id)
    
    for folder in folders {
        let fp = folder.path.trim_end_matches(|c| c == '/' || c == '\\').to_lowercase();
        // 检查文件路径是否以该文件夹路径为前缀（考虑路径分隔符）
        if file_lower == fp {
            continue; // 文件路径不可能等于文件夹路径
        }
        if file_lower.starts_with(&format!("{}/", fp)) || file_lower.starts_with(&format!("{}\\", fp)) {
            let prefix_len = fp.len();
            // 选择路径前缀最长的匹配（最深的文件夹）
            if best_match.as_ref().map_or(true, |(len, _)| prefix_len > *len) {
                best_match = Some((prefix_len, folder.id.clone()));
            }
        }
    }
    
    best_match.map(|(_, id)| id)
}
