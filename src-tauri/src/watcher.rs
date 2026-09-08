//! ============================================================================
//! 模块：文件监控 (watcher.rs)
//! 职责：使用 notify 库实时监控已监控文件夹的变动
//! (新增、删除、修改、重命名)，事件经轻量级去抖聚合后批量更新数据库。
//! 支持运行时动态注册/注销监控文件夹，解决"新添加文件夹不实时监控"问题。
//! 依赖开源库：`notify`, `tauri`, `chrono`, `parking_lot`
//! ============================================================================

use crate::database::Database;
use crate::indexer::{infer_category_from_extension, stable_hash};
use chrono::Utc;
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 发送给前端的事件载荷
#[derive(Clone, Serialize)]
pub struct AssetChangeEvent {
    pub asset_id: Option<String>,
    pub path: String,
    pub action: String, // "added" | "removed" | "modified"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<crate::models::Asset>,
}

/// 全局文件监控注册表
///
/// 使用 notify::RecommendedWatcher 提供跨平台实时文件变更检测。
/// - add_folder / remove_folder 支持运行时动态添加/移除监控路径
/// - 事件通过 channel 发送至后台线程，经轻量去抖聚合后批量处理
pub struct WatcherRegistry {
    watcher: Mutex<RecommendedWatcher>,
    watched_paths: Mutex<HashSet<String>>,
}

impl WatcherRegistry {
    /// 创建全局文件监控器，注册所有已监控的文件夹，并启动后台事件处理线程。
    pub fn new(app_handle: AppHandle, db: Arc<Database>) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();

        let mut watcher = notify::recommended_watcher(
            move |res: Result<Event, notify::Error>| {
                let _ = tx.send(res);
            },
        )
        .map_err(|e| format!("创建文件监控器失败: {}", e))?;

        let watched_paths = Mutex::new(HashSet::new());

        // 注册启动时已存在的所有监控文件夹
        let mut registered_count: usize = 0;
        let mut skipped_count: usize = 0;
        if let Ok(folders) = db.get_monitored_folders() {
            println!("[Watcher] 启动时从数据库读取到 {} 个已监视文件夹(DB is_monitored=1)", folders.len());
            for folder in &folders {
                let path = Path::new(&folder.path);
                if !path.exists() {
                    eprintln!("[Watcher] 监控路径不存在，跳过: {}", folder.path);
                    skipped_count += 1;
                    continue;
                }
                if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
                    eprintln!("[Watcher] 注册监听失败 {}: {}", folder.path, e);
                    skipped_count += 1;
                } else {
                    watched_paths.lock().insert(folder.path.clone());
                    registered_count += 1;
                    println!("[Watcher] 开始监视: {} (id: {})", folder.path, folder.id);
                }
            }
            println!("[Watcher] 启动注册完成: 成功 {} 个, 跳过/失败 {} 个", registered_count, skipped_count);
        } else {
            println!("[Watcher] 启动时读取已监视文件夹失败（DB 无记录或出错）");
        }

        // 启动后台事件处理线程
        let handle_db = db.clone();
        std::thread::spawn(move || {
            event_processing_loop(&app_handle, &handle_db, &rx);
        });

        Ok(WatcherRegistry {
            watcher: Mutex::new(watcher),
            watched_paths,
        })
    }

    /// 动态注册一个文件夹到监控列表
    pub fn add_folder(&self, path: &str) -> Result<(), String> {
        {
            let paths = self.watched_paths.lock();
            if paths.contains(path) {
                return Ok(());
            }
        }

        let p = Path::new(path);
        if !p.exists() {
            return Err(format!("监控路径不存在: {}", path));
        }
        if !p.is_dir() {
            return Err(format!("路径不是有效目录: {}", path));
        }

        let mut w = self.watcher.lock();
        w.watch(p, RecursiveMode::Recursive)
            .map_err(|e| format!("注册文件监听失败 {}: {}", path, e))?;
        drop(w);

        self.watched_paths.lock().insert(path.to_string());
        println!("[Watcher] 动态添加监控: {}", path);
        Ok(())
    }

    /// 动态注销一个文件夹
    pub fn remove_folder(&self, path: &str) -> Result<(), String> {
        let was_watched = self.watched_paths.lock().contains(path);
        if !was_watched {
            return Ok(());
        }

        let p = Path::new(path);
        let mut w = self.watcher.lock();
        let _ = w.unwatch(p);
        drop(w);

        self.watched_paths.lock().remove(path);
        println!("[Watcher] 动态移除监控: {}", path);
        Ok(())
    }

    /// 返回当前所有正在被监控的文件夹路径
    #[allow(dead_code)]
    pub fn get_watched_paths(&self) -> Vec<String> {
        self.watched_paths.lock().iter().cloned().collect()
    }
}

/// 后台事件处理循环
fn event_processing_loop(
    app_handle: &AppHandle,
    db: &Database,
    rx: &mpsc::Receiver<Result<Event, notify::Error>>,
) {
    println!("[Watcher] 事件处理线程已启动");

    let mut pending: Vec<Event> = Vec::new();
    let mut last_flush = Instant::now();
    const FLUSH_INTERVAL: Duration = Duration::from_millis(300);
    const MAX_BATCH_SIZE: usize = 200;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(event)) => {
                pending.push(event);
                if pending.len() >= MAX_BATCH_SIZE || last_flush.elapsed() >= FLUSH_INTERVAL {
                    flush_events(app_handle, db, &pending);
                    pending.clear();
                    last_flush = Instant::now();
                }
            }
            Ok(Err(e)) => {
                eprintln!("[Watcher] 文件监控错误: {}", e);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !pending.is_empty() && last_flush.elapsed() >= FLUSH_INTERVAL {
                    flush_events(app_handle, db, &pending);
                    pending.clear();
                    last_flush = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("[Watcher] 事件通道已断开，监控线程退出");
                break;
            }
        }
    }
}

/// 批量处理积累的文件事件
fn flush_events(app_handle: &AppHandle, db: &Database, events: &[Event]) {
    if events.is_empty() {
        return;
    }

    let mut additions: HashSet<String> = HashSet::new();
    let mut removals: HashSet<String> = HashSet::new();
    let mut modifications: HashSet<String> = HashSet::new();

    for event in events {
        match &event.kind {
            EventKind::Create(_) => {
                for path in &event.paths {
                    if path.is_file() {
                        additions.insert(path.to_string_lossy().to_string());
                    } else if path.is_dir() {
                        // 目录创建：扫描其中包含的文件并加入索引
                        if let Err(e) = scan_new_directory(app_handle, db, path) {
                            eprintln!("[Watcher] 扫描新目录失败 {}: {}", path.display(), e);
                        }
                    }
                }
            }
            EventKind::Remove(_) => {
                for path in &event.paths {
                    removals.insert(path.to_string_lossy().to_string());
                }
            }
            EventKind::Modify(kind) => match kind {
                ModifyKind::Data(_) | ModifyKind::Metadata(_) | ModifyKind::Any => {
                    // 内容或元数据修改
                    for path in &event.paths {
                        if path.is_file() {
                            let path_str = path.to_string_lossy().to_string();
                            if db.get_asset_by_path(&path_str).ok().flatten().is_some() {
                                modifications.insert(path_str);
                            } else {
                                additions.insert(path_str);
                            }
                        }
                    }
                }
                ModifyKind::Name(_) => {
                    // 重命名/移动事件
                    handle_rename_event(app_handle, db, event, &mut additions, &mut removals, &mut modifications);
                }
                _ => {}
            },
            _ => {}
        }
    }

    // 处理删除
    if !removals.is_empty() {
        handle_removals(app_handle, db, &removals);
    }

    // 处理新增
    for path_str in &additions {
        if let Err(e) = handle_file_added(app_handle, db, Path::new(path_str)) {
            eprintln!("[Watcher] 添加文件失败 {}: {}", path_str, e);
        }
    }

    // 处理修改
    for path_str in &modifications {
        if let Err(e) = handle_file_modified(app_handle, db, Path::new(path_str)) {
            eprintln!("[Watcher] 修改文件失败 {}: {}", path_str, e);
        }
    }

    // 调试汇总：每批事件处理完后打印本批分类统计，便于确认"事件是否被正确感知与落库"
    println!(
        "[Watcher] 事件批处理完成: 原始事件 {} 个, 待新增 {} 个, 待删除 {} 个, 待修改 {} 个",
        events.len(),
        additions.len(),
        removals.len(),
        modifications.len()
    );
}

/// 处理重命名事件
fn handle_rename_event(
    _app_handle: &AppHandle,
    db: &Database,
    event: &Event,
    additions: &mut HashSet<String>,
    removals: &mut HashSet<String>,
    modifications: &mut HashSet<String>,
) {
    // 收集事件涉及的所有路径
    let all_paths: Vec<String> = event.paths.iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    for path_str in all_paths {
        let p = Path::new(&path_str);
        let in_db = db.get_asset_by_path(&path_str).ok().flatten().is_some();

        if in_db && !p.exists() {
            // 旧路径：在 DB 但磁盘上已不存在 → 删除
            removals.insert(path_str);
        } else if !in_db && p.exists() && p.is_file() {
            // 新路径：磁盘上存在但不在 DB → 添加
            additions.insert(path_str);
        } else if in_db && p.exists() && p.is_file() {
            // 同名路径修改
            modifications.insert(path_str);
        }
    }
}

/// 扫描新创建的目录中的文件，批量加入索引
fn scan_new_directory(app_handle: &AppHandle, db: &Database, dir_path: &Path) -> Result<(), String> {
    if !dir_path.exists() || !dir_path.is_dir() {
        return Ok(());
    }

    // 递归收集所有子目录中的文件
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![dir_path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                files.push(p);
            }
        }
    }

    if files.is_empty() {
        return Ok(());
    }

    // 获取文件夹列表用于匹配 folder_id
    let folders = db.get_folders()?;
    let mut new_assets: Vec<crate::models::Asset> = Vec::new();

    for file_path in files {
        let path_str = file_path.to_string_lossy().to_string();
        if db.get_asset_by_path(&path_str)?.is_some() {
            continue;
        }

        let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if infer_category_from_extension(ext) == "other" {
            continue;
        }

        let mut asset = create_asset_from_path(&file_path)?;
        if let Some(folder_id) = find_matching_folder(&folders, &path_str) {
            asset.folder_id = folder_id;
        }
        new_assets.push(asset);
    }

    if !new_assets.is_empty() {
        db.batch_save_assets(&new_assets)?;
        for asset in &new_assets {
            let _ = app_handle.emit("asset:added", AssetChangeEvent {
                asset_id: Some(asset.id.clone()),
                path: asset.path.clone(),
                action: "added".to_string(),
                asset: Some(asset.clone()),
            });
        }
        println!("[Watcher] 新目录扫描完成，索引 {} 个文件", new_assets.len());
    }

    Ok(())
}

/// 供外部在"开启本地监视工作区"时调用：将该已存在目录下尚未入库的既有文件
/// 一次性补齐索引进数据库，并向前端广播 asset:added，使监视开启前的历史素材也能即时显示。
/// 与 scan_new_directory 逻辑一致，幂等：已入库文件会跳过、重复调用安全。
pub fn backfill_existing_assets(
    app_handle: &AppHandle,
    db: &Database,
    dir_path: &Path,
    origin: &str,
) -> Result<usize, String> {
    if !dir_path.exists() || !dir_path.is_dir() {
        eprintln!("[Watcher] [{}] 补齐索引失败: 目录不存在或不是目录: {}", origin, dir_path.display());
        return Ok(0);
    }

    // 递归收集所有子目录中的文件
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![dir_path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[Watcher] [{}] 读取子目录失败 {}: {}", origin, dir.display(), e);
                continue;
            }
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                files.push(p);
            }
        }
    }

    if files.is_empty() {
        println!("[Watcher] [{}] 补齐索引: 目录内无可索引文件: {}", origin, dir_path.display());
        return Ok(0);
    }

    let folders = db.get_folders()?;
    let mut new_assets: Vec<crate::models::Asset> = Vec::new();
    let mut skipped_existing = 0usize;
    let mut skipped_other = 0usize;

    let total_files = files.len();
    for file_path in &files {
        let path_str = file_path.to_string_lossy().to_string();

        // 已在库中则跳过
        if db.get_asset_by_path(&path_str)?.is_some() {
            skipped_existing += 1;
            continue;
        }
        // 非资产扩展名跳过
        let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if infer_category_from_extension(ext) == "other" {
            skipped_other += 1;
            continue;
        }

        let mut asset = create_asset_from_path(file_path)?;
        if let Some(folder_id) = find_matching_folder(&folders, &path_str) {
            asset.folder_id = folder_id;
        }
        new_assets.push(asset);
    }

    let added = new_assets.len();
    println!(
        "[Watcher] [{}] 补齐索引结果: 扫描 {} 个文件, 新增入库 {} 个, 已存在跳过 {} 个, 非资产跳过 {} 个, 目录: {}",
        origin,
        total_files,
        added,
        skipped_existing,
        skipped_other,
        dir_path.display()
    );

    if !new_assets.is_empty() {
        db.batch_save_assets(&new_assets)?;
        for asset in &new_assets {
            println!("[Watcher] [{}] 补齐入库并广播: {}", origin, asset.path);
            let _ = app_handle.emit("asset:added", AssetChangeEvent {
                asset_id: Some(asset.id.clone()),
                path: asset.path.clone(),
                action: "added".to_string(),
                asset: Some(asset.clone()),
            });
        }
    }

    Ok(added)
}

/// 批量处理删除事件
fn handle_removals(app_handle: &AppHandle, db: &Database, removals: &HashSet<String>) {
    let removals_vec: Vec<String> = removals.iter().cloned().collect();
    if removals_vec.is_empty() {
        return;
    }

    let mut removed_ids: Vec<(String, String)> = Vec::new();
    for path_str in &removals_vec {
        if let Ok(Some(asset)) = db.get_asset_by_path(path_str) {
            removed_ids.push((asset.id, path_str.clone()));
        }
    }

    let deleted = match db.delete_assets_by_paths(&removals_vec) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("[Watcher] 批量删除资产失败: {}", e);
            return;
        }
    };

    if deleted > 0 {
        println!("[Watcher] 批量删除 {} 个文件", deleted);
        let mut emitted: HashSet<String> = HashSet::new();
        for (asset_id, path) in &removed_ids {
            emitted.insert(path.clone());
            let _ = app_handle.emit("asset:removed", AssetChangeEvent {
                asset_id: Some(asset_id.clone()),
                path: path.clone(),
                action: "removed".to_string(),
                asset: None,
            });
        }
        // 未能查到 asset_id 的删除路径也广播
        for path in &removals_vec {
            if !emitted.contains(path) {
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

/// 处理单个新增文件
fn handle_file_added(app_handle: &AppHandle, db: &Database, path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_file() {
        return Ok(());
    }

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if infer_category_from_extension(ext) == "other" {
        return Ok(());
    }

    let path_str = path.to_string_lossy().to_string();
    if db.get_asset_by_path(&path_str)?.is_some() {
        return Ok(());
    }

    let mut asset = create_asset_from_path(path)?;
    let folders = db.get_folders()?;
    if let Some(folder_id) = find_matching_folder(&folders, &path_str) {
        asset.folder_id = folder_id;
    }

    db.batch_save_assets(&[asset.clone()])?;

    let _ = app_handle.emit("asset:added", AssetChangeEvent {
        asset_id: Some(asset.id.clone()),
        path: path_str.clone(),
        action: "added".to_string(),
        asset: Some(asset.clone()),
    });
    println!("[Watcher] 新文件已添加: {}", path_str);
    Ok(())
}

/// 处理单个文件修改
fn handle_file_modified(app_handle: &AppHandle, db: &Database, path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_file() {
        return Ok(());
    }

    let path_str = path.to_string_lossy().to_string();
    if let Some(existing) = db.get_asset_by_path(&path_str)? {
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        let new_date = metadata
            .modified()
            .ok()
            .map(|t| {
                let dt: chrono::DateTime<Utc> = t.into();
                dt.to_rfc3339()
            })
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        db.update_asset_field(&existing.id, "date_modified", &new_date)?;
        db.update_asset_field(&existing.id, "size", &metadata.len().to_string())?;

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
        folder_id: String::new(),
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
fn find_matching_folder(folders: &[crate::models::Folder], file_path: &str) -> Option<String> {
    let file_lower = file_path.trim_end_matches(|c| c == '/' || c == '\\').to_lowercase();
    let mut best_match: Option<(usize, String)> = None;

    for folder in folders {
        let fp = folder.path.trim_end_matches(|c| c == '/' || c == '\\').to_lowercase();
        if file_lower == fp {
            continue;
        }
        if file_lower.starts_with(&format!("{}/", fp)) || file_lower.starts_with(&format!("{}\\", fp)) {
            let prefix_len = fp.len();
            if best_match.as_ref().map_or(true, |(len, _)| prefix_len > *len) {
                best_match = Some((prefix_len, folder.id.clone()));
            }
        }
    }

    best_match.map(|(_, id)| id)
}
