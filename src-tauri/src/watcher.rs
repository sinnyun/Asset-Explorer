//! ============================================================================
//! 模块：文件监控 (watcher.rs)
//! 职责：使用 notify 库实时感知已监控文件夹的变动，作为"事件快速通道"：
//!   - 单文件 新增/修改/删除 走快速通道秒级生效；
//!   - 目录事件只修改目标子树，不升级为监控根目录的全盘扫描。
//! 队列溢出会记录为脏状态，恢复由显式、可取消的维护任务执行。
//! 依赖开源库：`notify`, `tauri`, `chrono`, `parking_lot`
//! ============================================================================

use crate::database::Database;
use crate::event_coalescer::{ChangeKind, EventCoalescer, RawFsEvent};
use crate::index_jobs::IndexCoordinator;
use crate::indexer::{infer_category_from_extension, scan_local_subtree_streaming, stable_hash, ScanBatch};
use crate::metadata_extractor;
use crate::models::{Asset, Folder};
use crate::sync::FolderChangeEvent;
use chrono::Utc;
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
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
    pub fn new(app_handle: AppHandle, db: Arc<Database>, coordinator: IndexCoordinator) -> Result<Self, String> {
        let (tx, rx) = mpsc::sync_channel::<Result<Event, notify::Error>>(8_192);

        let mut watcher = notify::recommended_watcher(
            move |res: Result<Event, notify::Error>| {
                if let Err(error) = tx.try_send(res) {
                    crate::metrics::global().record_watcher_drop();
                    eprintln!("[Watcher] 有界事件队列已满或关闭，已丢弃事件并等待显式恢复: {error}");
                }
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
            event_processing_loop(&app_handle, &handle_db, &coordinator, &rx);
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
    coordinator: &IndexCoordinator,
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
                    flush_events(app_handle, db, coordinator, &pending);
                    pending.clear();
                    last_flush = Instant::now();
                }
            }
            Ok(Err(e)) => {
                eprintln!("[Watcher] 文件监控错误: {}", e);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !pending.is_empty() && last_flush.elapsed() >= FLUSH_INTERVAL {
                    flush_events(app_handle, db, coordinator, &pending);
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

/// 简易路径规范化（去首尾空白与末尾分隔符），用于目录比对。
fn norm_path(p: &str) -> String {
    p.trim().trim_end_matches(['/', '\\']).to_string()
}

/// 批量处理积累的文件事件（事件快速通道）：
/// - 文件级 增/删/改 直接处理；
/// - 目录级 创建/重命名/移动 下沉为受范围子树对账，保证目录树正确性。
fn flush_events(app_handle: &AppHandle, db: &Database, coordinator: &IndexCoordinator, events: &[Event]) {
    if events.is_empty() {
        return;
    }

    let mut folder_cache: HashMap<String, String> = HashMap::new();

    let mut additions: HashSet<String> = HashSet::new();
    let mut removals: HashSet<String> = HashSet::new();
    let mut modifications: HashSet<String> = HashSet::new();
    let mut directories: HashMap<String, ChangeKind> = HashMap::new();
    let now = Instant::now();
    let mut coalescer = EventCoalescer::new(8_192, Duration::ZERO);

    for event in events {
        for path in &event.paths {
            let path_text = path.to_string_lossy().to_string();
            let known_directory = db.get_folder_by_path(&path_text).ok().flatten().is_some();
            let is_directory = path.is_dir() || known_directory;
            let kind = match &event.kind {
                EventKind::Create(_) => ChangeKind::Create,
                EventKind::Remove(_) => ChangeKind::Remove,
                EventKind::Modify(ModifyKind::Name(_)) if path.exists() => ChangeKind::Create,
                EventKind::Modify(ModifyKind::Name(_)) => ChangeKind::Remove,
                EventKind::Modify(_) => ChangeKind::Modify,
                _ => continue,
            };
            let raw = if is_directory {
                RawFsEvent::directory("watcher", &path_text, kind, now)
            } else {
                RawFsEvent::file("watcher", &path_text, kind, now)
            };
            let _ = coalescer.push(raw);
        }
    }

    for change in coalescer.drain_ready(now) {
        if change.is_directory {
            directories.insert(change.normalized_path, change.kind);
            continue;
        }
        match change.kind {
            ChangeKind::Create | ChangeKind::Replace => {
                additions.insert(change.normalized_path);
            }
            ChangeKind::Modify => {
                modifications.insert(change.normalized_path);
            }
            ChangeKind::Remove => {
                removals.insert(change.normalized_path);
            }
        }
    }

    for (directory, kind) in &directories {
        match kind {
            ChangeKind::Remove => remove_folder_tree(app_handle, db, Path::new(directory)),
            ChangeKind::Create | ChangeKind::Replace | ChangeKind::Modify => {
                if let Err(error) = schedule_subtree_scan(app_handle, db, coordinator, directory) {
                    eprintln!("[Watcher] 安排子树扫描失败 {}: {}", directory, error);
                }
            }
        }
    }

    // 处理删除（文件级）
    if !removals.is_empty() {
        handle_removals(app_handle, db, &removals);
    }

    // 处理新增（批量：共享目录缓存 + 单事务入库，超大目录拖入时显著减少 DB 往返）
    if !additions.is_empty() {
        if let Err(e) = handle_file_additions(app_handle, db, &additions, &mut folder_cache) {
            eprintln!("[Watcher] 批量添加文件失败: {}", e);
        }
    }

    // 处理修改
    for path_str in &modifications {
        if let Err(e) = handle_file_modified(app_handle, db, Path::new(path_str)) {
            eprintln!("[Watcher] 修改文件失败 {}: {}", path_str, e);
        }
    }

}

fn schedule_subtree_scan(
    app_handle: &AppHandle,
    db: &Database,
    coordinator: &IndexCoordinator,
    directory: &str,
) -> Result<String, String> {
    let job_key = format!("subtree:{}", crate::database::normalize_windows_path(directory));
    let path = directory.to_string();
    let db = db.clone();
    let app = app_handle.clone();
    coordinator.start(job_key, move |cancelled| {
        let mut subtree_root: Option<Folder> = None;
        scan_local_subtree_streaming(&path, cancelled.as_ref(), &mut |batch| {
            match batch {
                ScanBatch::Started(mut root) => {
                    root.parent_id = Path::new(&root.path).parent()
                        .and_then(|parent| db.get_folder_by_path(&parent.to_string_lossy()).ok().flatten())
                        .map(|parent| parent.id);
                    db.batch_save_scan_results(&root, &[], &[])?;
                    subtree_root = Some(root);
                }
                ScanBatch::Folders(folders) => {
                    let root = subtree_root.as_ref().ok_or("子树根目录尚未初始化")?;
                    db.batch_save_scan_results(root, &folders, &[])?;
                }
                ScanBatch::Assets(assets) => db.batch_save_assets(&assets)?,
                ScanBatch::Progress(done) => {
                    let _ = app.emit("query:invalidated", serde_json::json!({
                        "pathPrefix": path,
                        "indexed": done,
                    }));
                }
                ScanBatch::Finished(_) => {
                    let _ = app.emit("query:invalidated", serde_json::json!({ "pathPrefix": path }));
                }
            }
            Ok(())
        }).map(|_| ())
    })
}

/// 删除某目录及其整棵子孙树（文件夹行级联删资产），并广播 folder:removed、
/// 清理不在该目录结构下的孤儿资产。
fn remove_folder_tree(app_handle: &AppHandle, db: &Database, path: &Path) {
    let ps = path.to_string_lossy().to_string();
    let norm = norm_path(&ps);

    // 广播 folder:removed（取其库内原文件夹对象）
    if let Ok(Some(folder)) = db.get_folder_by_path(&norm) {
        let _ = app_handle.emit("folder:removed", FolderChangeEvent {
            folder,
            action: "removed".to_string(),
        });
    }

    // 先清理不在该目录结构下的孤儿资产（如文件夹行已缺失、仅路径前缀匹配的资产）
    let _ = db.delete_assets_by_prefix(&norm);

    // 删除文件夹树（子文件夹与资产经外键级联）
    let _ = db.delete_folder_tree_by_path(&norm);

    // 若仍存在前缀匹配的资产（文件夹行不存在导致的孤儿），按路径前缀兜底清理
    let _ = db.delete_assets_by_prefix(&norm);
    println!("[Watcher] 目录已删除: {}", norm);
}

/// 批量处理删除事件（文件级）
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

/// 批量处理新增文件（快速通道）：
/// 先在内存中构建全部资产并解析归属（目录 id 走本批共享缓存），
/// 再一次性事务入库，最后统一广播事件。避免逐文件 get_folders()/单条 SAVE
/// 的 N 次数据库往返，支撑超大目录拖入时的入库吞吐。
fn handle_file_additions(
    app_handle: &AppHandle,
    db: &Database,
    additions: &HashSet<String>,
    folder_cache: &mut HashMap<String, String>,
) -> Result<(), String> {
    let mut new_assets: Vec<Asset> = Vec::new();

    for path_str in additions {
        let path = Path::new(path_str);
        if !path.exists() || !path.is_file() {
            continue;
        }
        // 与 indexer 保持一致：不按扩展名过滤，所有文件均纳入索引
        // （初始扫描的 build_asset 不区分 "other"，运行时监控也需一致，否则改名后会"消失"）
        // 已在库中则跳过（幂等）
        if db.get_asset_by_path(path_str)?.is_some() {
            continue;
        }
        let mut asset = create_asset_from_path(path)?;
        asset.folder_id = resolve_folder_id(app_handle, db, path, folder_cache)?;
        new_assets.push(asset);
    }

    if new_assets.is_empty() {
        return Ok(());
    }

    // 单事务批量入库（batch_save_assets 内部为事务包裹）
    db.batch_save_assets(&new_assets)?;
    println!("[Watcher] 批量新增 {} 个文件入库", new_assets.len());

    for asset in &new_assets {
        let _ = app_handle.emit("asset:added", AssetChangeEvent {
            asset_id: Some(asset.id.clone()),
            path: asset.path.clone(),
            action: "added".to_string(),
            asset: Some(asset.clone()),
        });
    }
    Ok(())
}

/// 处理单个文件修改（快速通道）：
/// 除 mtime/size 外，联动重读图片宽高（仅读文件头），保证前端详情面板
/// 展示的尺寸随内容变化保持准确。不读取文件内容计算哈希。
fn handle_file_modified(app_handle: &AppHandle, db: &Database, path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_file() {
        return Ok(());
    }

    let path_str = path.to_string_lossy().to_string();
    if let Some(existing) = db.get_asset_by_path(&path_str)? {
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        let new_size = metadata.len();
        let new_date = metadata
            .modified()
            .ok()
            .map(|t| {
                let dt: chrono::DateTime<Utc> = t.into();
                dt.to_rfc3339()
            })
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        // 内容级联动重读：图片重新提取宽高（仅读文件头，不解码不读内容）。
        // 本应用为"资源管理器式查看器"，运行时不吞吐原始文件内容：
        // 签名增量对账依赖文件系统自带的 mtime/size，无需内容级 SHA-256。
        let (new_width, new_height) = if existing.asset_type == "image" {
            let meta = metadata_extractor::extract_metadata(path);
            (meta.width, meta.height)
        } else {
            (existing.width, existing.height)
        };

        db.update_asset_signature(
            &existing.id,
            &new_date,
            new_size,
            new_width,
            new_height,
            existing.file_hash.as_deref(),
        )?;

        let updated_asset = Asset {
            size: new_size,
            date_modified: new_date.clone(),
            width: new_width,
            height: new_height,
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

/// 解析文件所属文件夹 id：优先查本批共享的目录缓存（避免逐文件全表查询），
/// 未命中时向上补建缺失的目录链（确定性 id），并把结果回写缓存。
fn resolve_folder_id(
    app_handle: &AppHandle,
    db: &Database,
    path: &Path,
    folder_cache: &mut HashMap<String, String>,
) -> Result<String, String> {
    let parent = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if parent.is_empty() {
        return Ok(String::new());
    }
    let parent_norm = norm_path(&parent);
    // 缓存命中：直接复用（大目录拖入时绝大多数文件都命中此路径）
    if let Some(id) = folder_cache.get(&parent_norm) {
        return Ok(id.clone());
    }
    // 未命中：补建/查找目录链，并回填缓存供本批后续文件复用
    let id = ensure_dir_chain(app_handle, db, Path::new(&parent))?;
    folder_cache.insert(parent_norm, id.clone());
    Ok(id)
}

/// 自下而上补建缺失的目录链，返回最底层目录（叶）的 folder id。
fn ensure_dir_chain(app_handle: &AppHandle, db: &Database, dir: &Path) -> Result<String, String> {
    let dir_str = dir.to_string_lossy().to_string();
    let dir_norm = norm_path(&dir_str);
    // 已存在则直接返回
    if let Some(existing) = db.get_folder_by_path(&dir_norm)? {
        return Ok(existing.id);
    }

    // 递归保证父目录存在
    let parent_id = match dir.parent() {
        Some(p) if !p.as_os_str().is_empty() && norm_path(&p.to_string_lossy()) != dir_norm => {
            Some(ensure_dir_chain(app_handle, db, p)?)
        }
        _ => None,
    };

    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir_norm.clone());

    let folder = Folder {
        id: format!("f_{}", stable_hash(&dir_str)),
        name,
        path: dir_str.clone(),
        parent_id,
        is_monitored: false,
        asset_count: None,
        mtime: None,
    };
    db.upsert_folder(&folder)?;
    let _ = app_handle.emit("folder:added", FolderChangeEvent {
        folder: folder.clone(),
        action: "added".to_string(),
    });
    Ok(folder.id)
}

/// 从文件路径创建资产对象（folder_id 交由调用方通过 resolve_folder_id 修正）。
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
        folder_id: String::new(), // 由 resolve_folder_id 修正
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

/// 供外部在"开启本地监视工作区"时调用：将该已存在目录下尚未入库的既有文件
/// 一次性补齐索引进数据库，并向前端广播 asset:added，使监视开启前的历史素材也能即时显示。
/// 幂等：已入库文件会跳过、重复调用安全。
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

    let mut new_assets: Vec<Asset> = Vec::new();
    let mut skipped_existing = 0usize;
    let skipped_other = 0usize;

    // 目录 路径→id 缓存：补齐索引通常涉及大量文件，避免逐文件全表查询目录
    let mut folder_cache: HashMap<String, String> = db
        .get_folders()
        .map(|fs| fs.iter().map(|f| (norm_path(&f.path), f.id.clone())).collect())
        .unwrap_or_default();

    let total_files = files.len();
    for file_path in &files {
        let path_str = file_path.to_string_lossy().to_string();

        // 已在库中则跳过
        if db.get_asset_by_path(&path_str)?.is_some() {
            skipped_existing += 1;
            continue;
        }
        // 非资产扩展名跳过：已移除——与初始扫描的 build_asset 行为保持一致，
        // 否则 .cdr/.ai/.indd 等设计文件改名后会从库中"消失"（初始能入库、运行时却被过滤）

        let mut asset = create_asset_from_path(file_path)?;
        // 补齐索引时同样复用目录缓存，传入 app_handle 以支持未命中时的目录链补建
        asset.folder_id = resolve_folder_id(app_handle, db, file_path, &mut folder_cache)?;
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

/// 保留：根据文件路径找到最匹配的文件夹（路径前缀最长匹配）。
/// 已不被快速通道使用（改由 resolve_folder_id 精确挂载），保留以服务后续可能场景。
#[allow(dead_code)]
fn find_matching_folder(folders: &[Folder], file_path: &str) -> Option<String> {
    let file_lower = norm_path(file_path).to_lowercase();
    let mut best_match: Option<(usize, String)> = None;

    for folder in folders {
        let fp = norm_path(&folder.path).to_lowercase();
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
