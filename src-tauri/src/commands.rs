//! ============================================================================
//! 模块：IPC 异步指令路由 (commands.rs)
//! 职责：封装对外暴露给前端调用的所有非阻塞异步 Tauri 命令。
//! 严格保证：所有磁盘 I/O、数据库操作和数据聚合全部投递至后台线程池，
//! 绝不堵塞前端 UI 界面！
//! ============================================================================

use crate::aggregator::{aggregate_asset_metrics, filter_assets_by_smart_folder};
use crate::database::Database;
use crate::index_jobs::{IndexCoordinator, JobSnapshot};
use crate::indexer::{scan_local_directory, scan_local_directory_streaming, ScanBatch};
use crate::metadata_extractor::extract_metadata;
use crate::models::{
    AggregationReport, Asset, AssetDetail, AssetPage, AssetQuery, Collection, Folder,
    FolderPage, FolderQuery, ScanResult, SmartFolder, Tag, WorkspaceShell,
};
use crate::metrics::DiagnosticsSnapshot;
use crate::thumbnail_cache::generate_or_get_thumbnail;
use crate::thumbnail_jobs::ThumbnailCoordinator;
use crate::sync::FolderChangeEvent;
use crate::watcher::{backfill_existing_assets, WatcherRegistry};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{Emitter, State};

/// 前端初始化全量工作区状态
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspacePayload {
    pub folders: Vec<Folder>,
    pub tags: Vec<Tag>,
    pub collections: Vec<Collection>,
    pub smart_folders: Vec<SmartFolder>,
    pub assets: Vec<Asset>,
}

#[tauri::command]
pub async fn get_workspace_shell_v2(db: State<'_, Database>) -> Result<WorkspaceShell, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        Ok(WorkspaceShell {
            roots: db.get_monitored_folders()?,
            tags: db.get_tags()?,
            collections: db.get_collections()?,
            smart_folders: db.get_smart_folders()?,
            revision: db.current_revision()?,
        })
    })
    .await
    .map_err(|e| format!("V2 工作区任务失败: {e}"))?
}

#[tauri::command]
pub async fn query_assets_v2(
    db: State<'_, Database>,
    query: AssetQuery,
) -> Result<AssetPage, String> {
    let db = db.inner().clone();
    let started = std::time::Instant::now();
    let result = tokio::task::spawn_blocking(move || db.query_assets(&query))
        .await
        .map_err(|e| format!("V2 资产查询任务失败: {e}"))?;
    crate::metrics::global().record_query(started.elapsed(), result.is_ok());
    result
}

#[tauri::command]
pub async fn query_folders_v2(
    db: State<'_, Database>,
    query: FolderQuery,
) -> Result<FolderPage, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.query_folders(&query))
        .await
        .map_err(|e| format!("V2 文件夹查询任务失败: {e}"))?
}

#[tauri::command]
pub async fn get_asset_details_v2(
    db: State<'_, Database>,
    ids: Vec<String>,
) -> Result<Vec<AssetDetail>, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.get_asset_details(&ids))
        .await
        .map_err(|e| format!("V2 资产详情任务失败: {e}"))?
}

/// 指令 1: 异步加载本地 SQLite 数据库中的全量工作区数据。
/// 启动加载只读缓存；磁盘对账由后台监控任务负责，避免阻塞首屏。
#[tauri::command]
pub async fn load_workspace(
    app_handle: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<WorkspacePayload, String> {
    let db = db.inner().clone();
    let _ = app_handle;
    tokio::task::spawn_blocking(move || {
        let folders = db.get_folders()?;
        let tags = db.get_tags()?;
        let collections = db.get_collections()?;
        let smart_folders = db.get_smart_folders()?;
        let assets = db.get_all_assets()?;

        Ok(WorkspacePayload {
            folders,
            tags,
            collections,
            smart_folders,
            assets,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 2: 异步扫描本地目录并写入持久化数据库
#[tauri::command]
pub async fn scan_directory(
    db: State<'_, Database>,
    registry: State<'_, WatcherRegistry>,
    path: String,
) -> Result<ScanResult, String> {
    let db = db.inner().clone();

    // 将路径注册到文件监控器
    let _ = registry.add_folder(&path);

    tokio::task::spawn_blocking(move || {
        let scan_res = scan_local_directory(&path)?;
        // 自动将扫描到的所有文件夹与资产写入 SQLite 数据库持久化
        db.batch_save_scan_results(&scan_res.root_folder, &scan_res.sub_folders, &scan_res.assets)?;
        Ok(scan_res)
    })
    .await
    .map_err(|e| e.to_string())?
}


/// 指令 2d: 动态注册文件夹到文件监控器（运行时添加监视文件夹时调用）
#[tauri::command]
pub fn watch_folder(
    registry: tauri::State<'_, WatcherRegistry>,
    path: String,
) -> Result<(), String> {
    registry.add_folder(&path)
}

/// 指令 2e: 动态从文件监控器注销文件夹（删除监视文件夹时调用）
#[tauri::command]
pub fn unwatch_folder(
    registry: tauri::State<'_, WatcherRegistry>,
    path: String,
) -> Result<(), String> {
    registry.remove_folder(&path)
}

/// 指令 2c: 后台增量扫描本地目录（将添加文件进度与 UI 完全分离）
/// ------------------------------------------------------------------------
/// 相比 scan_directory 的「同步一次性返回」，此命令采用后台线程 + 事件推送：
///   1. 命令立刻返回，添加监视文件夹的模态框可立即关闭，UI 不被阻塞；
///   2. 扫描按固定内存批次推进，通过紧凑事件向前端上报：
///        scan:started  —— 根目录已登记；
///        scan:progress —— 已持久化数量，前端据此刷新当前查询；
///        scan:finished —— 全部扫描完成，携带总文件数与耗时；
///        scan:failed   —— 扫描出错。
///   3. 文件边扫边显示，无需等待全部扫描结束。
#[tauri::command]
pub async fn start_scan_directory(
    db: State<'_, Database>,
    registry: State<'_, WatcherRegistry>,
    coordinator: State<'_, IndexCoordinator>,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    let db = db.inner().clone();

    // 立即将新路径注册到文件监控器，保证后续文件变更能被实时捕获
    if let Err(e) = registry.add_folder(&path) {
        eprintln!("[Watcher] start_scan_directory 注册监控失败: {}", e);
    }

    let root_id = format!("f_root_{}", crate::indexer::stable_hash(&path));
    coordinator.start(root_id, move |cancelled| {
        let emit_handle = app_handle.clone();

        let mut scan_identity: Option<(String, i64)> = None;
        let mut last_progress = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(200))
            .unwrap_or_else(std::time::Instant::now);
        let result = scan_local_directory_streaming(
            &path,
            cancelled.as_ref(),
            &mut |batch| {
                match batch {
                    ScanBatch::Started(root) => {
                        let generation = db.begin_root_scan(&root)?;
                        scan_identity = Some((root.id.clone(), generation));
                        let _ = emit_handle.emit("scan:started", serde_json::json!({
                            "rootId": root.id,
                            "path": root.path,
                            "generation": generation,
                        }));
                    }
                    ScanBatch::Folders(folders) => {
                        let (root_id, generation) = scan_identity.as_ref()
                            .ok_or("扫描根目录尚未初始化")?;
                        db.upsert_scan_folders(root_id, *generation, &folders)?;
                    }
                    ScanBatch::Assets(items) => {
                        let (root_id, generation) = scan_identity.as_ref()
                            .ok_or("扫描根目录尚未初始化")?;
                        db.upsert_scan_assets(root_id, *generation, &items)?;
                    }
                    ScanBatch::Progress(done) => {
                        if last_progress.elapsed() >= std::time::Duration::from_millis(200) {
                            let _ = emit_handle.emit("scan:progress", serde_json::json!({
                                "done": done,
                            }));
                            last_progress = std::time::Instant::now();
                        }
                    }
                    ScanBatch::Finished(summary) => {
                        let (root_id, generation) = scan_identity.as_ref()
                            .ok_or("扫描根目录尚未初始化")?;
                        let removed = db.complete_root_scan(root_id, *generation)?;
                        let _ = emit_handle.emit("scan:finished", serde_json::json!({
                            "rootId": summary.root_folder.id,
                            "totalFilesScanned": summary.total_files_scanned,
                            "totalDurationMs": summary.total_duration_ms,
                            "removedStaleAssets": removed,
                        }));
                    }
                }
                Ok(())
            }
        );

        if let Err(error) = &result {
            let _ = emit_handle.emit("scan:failed", serde_json::json!({ "error": error }));
        }
        result.map(|_| ())
    })
}

#[tauri::command]
pub fn cancel_job_v2(
    coordinator: State<'_, IndexCoordinator>,
    job_id: String,
) -> Result<bool, String> {
    Ok(coordinator.cancel(&job_id))
}

#[tauri::command]
pub fn get_job_status_v2(
    coordinator: State<'_, IndexCoordinator>,
    job_id: String,
) -> Result<JobSnapshot, String> {
    coordinator.status(&job_id).ok_or_else(|| format!("未知任务: {job_id}"))
}

#[tauri::command]
pub fn get_diagnostics_v2(
    db: State<'_, Database>,
    coordinator: State<'_, IndexCoordinator>,
    thumbnails: State<'_, ThumbnailCoordinator>,
) -> Result<DiagnosticsSnapshot, String> {
    Ok(crate::metrics::global().snapshot(
        coordinator.active_job_count(),
        db.write_queue_depth(),
        thumbnails.queued(),
        db.asset_count()?,
    ))
}

/// 指令 2b: 全文搜索资产（SQLite FTS5）
#[tauri::command]
pub async fn search_assets(db: State<'_, Database>, query: String, limit: Option<usize>) -> Result<Vec<Asset>, String> {
    let db = db.inner().clone();
    let limit = limit.unwrap_or(100);
    tokio::task::spawn_blocking(move || db.search_assets(&query, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 3: 后端数据库更新资产评分
#[tauri::command]
pub async fn set_asset_rating(db: State<'_, Database>, id: String, rating: u8) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.set_asset_rating(&id, rating))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 4: 后端数据库更新资产收藏状态
#[tauri::command]
pub async fn set_asset_favorite(db: State<'_, Database>, id: String, favorite: bool) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.set_asset_favorite(&id, favorite))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5: 后端数据库批量删除资产
#[tauri::command]
pub async fn delete_assets(db: State<'_, Database>, ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_assets(&ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5b: 同步设置单个资产的标签关联
#[tauri::command]
pub async fn sync_asset_tags(db: State<'_, Database>, asset_id: String, tag_ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.sync_asset_tags(&asset_id, &tag_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5c: 同步设置单个资产的集合关联
#[tauri::command]
pub async fn sync_asset_collections(db: State<'_, Database>, asset_id: String, collection_ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.sync_asset_collections(&asset_id, &collection_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5d: 批量同步多个资产的标签关联
#[tauri::command]
pub async fn sync_many_asset_tags(db: State<'_, Database>, asset_ids: Vec<String>, tag_ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.sync_many_asset_tags(&asset_ids, &tag_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5e: 批量同步多个资产的集合关联
#[tauri::command]
pub async fn sync_many_asset_collections(db: State<'_, Database>, asset_ids: Vec<String>, collection_ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.sync_many_asset_collections(&asset_ids, &collection_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5f: 从资产移除指定标签
#[tauri::command]
pub async fn remove_asset_tags(db: State<'_, Database>, asset_id: String, tag_ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.remove_asset_tags(&asset_id, &tag_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 5g: 从资产移除指定集合
#[tauri::command]
pub async fn remove_asset_collections(db: State<'_, Database>, asset_id: String, collection_ids: Vec<String>) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.remove_asset_collections(&asset_id, &collection_ids))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 6: 后端数据库创建文件夹
#[tauri::command]
pub async fn create_folder(
    db: State<'_, Database>,
    registry: State<'_, WatcherRegistry>,
    folder: Folder,
) -> Result<(), String> {
    let db = db.inner().clone();
    let is_monitored = folder.is_monitored;
    let folder_path = folder.path.clone();

    tokio::task::spawn_blocking(move || db.insert_folder(&folder))
        .await
        .map_err(|e| e.to_string())??;

    // 若文件夹标记为监控，动态注册到文件监控器
    if is_monitored {
        if let Err(e) = registry.add_folder(&folder_path) {
            eprintln!("[Watcher] create_folder 注册监控失败: {}", e);
        }
    }
    Ok(())
}

/// 指令 7: 后端数据库重命名文件夹
#[tauri::command]
pub async fn rename_folder(db: State<'_, Database>, id: String, new_name: String) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.rename_folder(&id, &new_name))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 7b: 后端数据库更新文件夹完整属性
#[tauri::command]
pub async fn update_folder(
    db: State<'_, Database>,
    registry: State<'_, WatcherRegistry>,
    app_handle: tauri::AppHandle,
    folder: Folder,
) -> Result<(), String> {
    let db = db.inner().clone();
    let is_monitored = folder.is_monitored;
    let folder_id = folder.id.clone();
    let folder_path = folder.path.clone();

    // 更新前先读取该文件夹旧状态，判断"本地监视工作区"开关是否发生变化
    let was_monitored: Option<bool> = db
        .get_folders()
        .ok()
        .and_then(|folders| folders.into_iter().find(|f| f.id == folder.id))
        .map(|f| f.is_monitored);
    println!(
        "[Watcher] update_folder 收到更新请求: id={}, path={}, 目标 is_monitored={}, 库中原值={:?}",
        folder_id, folder_path, is_monitored, was_monitored
    );

    // 先持久化该文件夹最新属性（name / path / parent_id / is_monitored）
    // 注意：db 为 Arc<Database>，此处 clone 一份进入阻塞任务，保留外层 db 供后续补齐索引使用
    let persist_db = db.clone();
    tokio::task::spawn_blocking(move || persist_db.update_folder(&folder))
        .await
        .map_err(|e| e.to_string())??;
    println!(
        "[Watcher] update_folder 已更新数据库: id={}, is_monitored={}",
        folder_id, is_monitored
    );

    // 仅当开关状态发生改变时才同步文件监控器注册/注销
    if was_monitored == Some(is_monitored) {
        println!("[Watcher] update_folder 监视状态未变化，跳过注册/注销: id={}", folder_id);
        return Ok(());
    }

    if is_monitored {
        // 关→开：注册到文件监控器，保证该目录新增/删除/修改文件被实时捕获
        match registry.add_folder(&folder_path) {
            Ok(()) => println!("[Watcher] update_folder 开启监视成功，已注册监听: id={}, path={}", folder_id, folder_path),
            Err(e) => {
                eprintln!("[Watcher] update_folder 注册文件监听失败: id={}, path={}, err={}", folder_id, folder_path, e);
                return Err(format!("注册文件监听失败: {}", e));
            }
        }

        // 关键补充：开启监视时把该目录【已存在的既有文件】也补齐索引进库并推送前端，
        // 否则 notify 只监听"开启之后的未来事件"，历史素材永远不会显示（这正是"重启后仍无数据"的根因）。
        let backfill_path = std::path::PathBuf::from(folder_path);
        let emit_handle = app_handle.clone();
        let backfill_db = db.clone();
        std::thread::spawn(move || {
            println!("[Watcher] update_folder 开始后台补齐该目录既有文件索引: {}", backfill_path.display());
            match backfill_existing_assets(&emit_handle, &backfill_db, &backfill_path, "update_folder") {
                Ok(n) => println!("[Watcher] update_folder 既有文件补齐完成，共新增 {} 个资产: {}", n, backfill_path.display()),
                Err(e) => eprintln!("[Watcher] update_folder 既有文件补齐失败: {}", e),
            }
        });
    } else {
        // 开→关：从文件监控器注销，避免无效监听
        match registry.remove_folder(&folder_path) {
            Ok(()) => println!("[Watcher] update_folder 关闭监视成功，已注销监听: id={}, path={}", folder_id, folder_path),
            Err(e) => eprintln!("[Watcher] update_folder 注销文件监听失败: id={}, path={}, err={}", folder_id, folder_path, e),
        }
    }
    Ok(())
}

/// 指令 8: 后端数据库删除文件夹
#[tauri::command]
pub async fn delete_folder(
    db: State<'_, Database>,
    registry: State<'_, WatcherRegistry>,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let db = db.inner().clone();

    // 先查询完整文件夹对象：用于（1）注销文件监控器（2）广播 folder:removed 事件
    let folder_obj: Option<Folder> = {
        let folders = db.get_folders().unwrap_or_default();
        folders.into_iter().find(|f| f.id == id)
    };
    let folder_path = folder_obj.as_ref().map(|f| f.path.clone());

    tokio::task::spawn_blocking(move || db.delete_folder(&id))
        .await
        .map_err(|e| e.to_string())??;

    // 若该文件夹之前是监控目录，从文件监控器注销
    if let Some(path) = folder_path {
        let _ = registry.remove_folder(&path);
    }

    // 广播 folder:removed：前端监听器会移除该文件夹及其整棵子孙树、清理其下全部资产，
    // 否则界面状态（尤其资产列表）会与数据库脱节，需重启才刷新。
    if let Some(folder) = folder_obj {
        let _ = app_handle.emit("folder:removed", FolderChangeEvent {
            folder,
            action: "removed".to_string(),
        });
    }
    Ok(())
}

/// 指令 9: 后端数据库创建标签
#[tauri::command]
pub async fn create_tag(db: State<'_, Database>, tag: Tag) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.insert_tag(&tag))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 9b: 后端数据库更新标签
#[tauri::command]
pub async fn update_tag(db: State<'_, Database>, id: String, tag: Tag) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.update_tag(&id, &tag))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 10: 后端数据库删除标签
#[tauri::command]
pub async fn delete_tag(db: State<'_, Database>, id: String) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_tag(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 11: 后端数据库创建集合
#[tauri::command]
pub async fn create_collection(db: State<'_, Database>, collection: Collection) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.insert_collection(&collection))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 11b: 后端数据库更新集合
#[tauri::command]
pub async fn update_collection(db: State<'_, Database>, id: String, collection: Collection) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.update_collection(&id, &collection))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 12: 后端数据库删除集合
#[tauri::command]
pub async fn delete_collection(db: State<'_, Database>, id: String) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_collection(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 13: 后端数据库保存智能文件夹
#[tauri::command]
pub async fn save_smart_folder(db: State<'_, Database>, smart_folder: SmartFolder) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.insert_smart_folder(&smart_folder))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 14: 后端数据库删除智能文件夹
#[tauri::command]
pub async fn delete_smart_folder(db: State<'_, Database>, id: String) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_smart_folder(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 15: 多维数据聚合计算 (Rayon 多核并发，异步非阻塞)
#[tauri::command]
pub async fn aggregate_data(assets: Vec<Asset>) -> Result<AggregationReport, String> {
    tokio::task::spawn_blocking(move || aggregate_asset_metrics(&assets))
        .await
        .map_err(|e| e.to_string())
}

/// 指令 16: 智能文件夹规则多核过滤
#[tauri::command]
pub async fn filter_by_smart_folder(assets: Vec<Asset>, smart_folder: SmartFolder) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || filter_assets_by_smart_folder(&assets, &smart_folder))
        .await
        .map_err(|e| e.to_string())
}

/// 指令 17: 提取文件元数据（仅文件头级：MIME 与图片尺寸，不读文件内容）
#[tauri::command]
pub async fn get_file_metadata(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.exists() {
            return Err(format!("文件不存在: {}", path));
        }
        let meta = extract_metadata(p);
        Ok(serde_json::json!({
            "mimeType": meta.mime_type,
            "width": meta.width,
            "height": meta.height,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 18: 生成或获取图片缩略图，生成后自动保存缩略图路径到数据库
#[tauri::command]
pub async fn get_thumbnail(
    db: State<'_, Database>,
    coordinator: State<'_, ThumbnailCoordinator>,
    asset_id: String,
    path: String,
    max_dimension: u32,
) -> Result<String, String> {
    let db = db.inner().clone();
    let reservation = coordinator.reserve()?;
    let permit = reservation.acquire().await?;
    let result = tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        // 使用数据库的 data_dir 作为缩略图缓存根目录（与数据库同目录下的 thumbnails/）
        let data_dir = db.get_data_dir().to_path_buf();
        let thumb_path = generate_or_get_thumbnail(p, max_dimension, &data_dir)?;
        let thumb_str = thumb_path.to_string_lossy().to_string();
        // Preserve the command argument while V2 returns the derived cache path directly.
        let _ = asset_id;
        Ok(thumb_str)
    })
    .await
    .map_err(|e| e.to_string())?;
    drop(permit);
    drop(reservation);
    result
}

/// 指令 19: 在系统文件管理器中高亮定位文件
/// 使用 opener 开源库替代手写 explorer 命令，支持跨平台
#[tauri::command]
pub async fn open_in_file_manager(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        opener::reveal(&path).map_err(|e| format!("在文件管理器中定位文件失败: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 20: 获取本地系统运行时基本信息
#[tauri::command]
pub fn get_system_info() -> serde_json::Value {
    serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "runtime": "Tauri v2 + Rust SQLite Engine",
        "isWindows": cfg!(target_os = "windows"),
        "version": env!("CARGO_PKG_VERSION")
    })
}

/// 指令 21: 获取本地存储与数据库空间统计
#[tauri::command]
pub async fn get_storage_stats(db: State<'_, Database>) -> Result<crate::database::StorageStats, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        Ok(db.get_storage_stats())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 22: V2 尚未开放存储位置选择；返回明确错误，不触碰任何文件。
#[tauri::command]
pub async fn migrate_data_storage(db: State<'_, Database>, new_path: String) -> Result<String, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&new_path);
        db.migrate_storage(p)?;
        Ok(format!("数据已成功迁移至: {}", new_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 23: 安全重启软件应用
#[tauri::command]
pub fn restart_application(app_handle: tauri::AppHandle) {
    println!("[Lifecycle] 收到应用重启指令，正在安全重启...");
    app_handle.restart();
}

/// 指令 24: 启动时校验资产有效性（删除数据库中文件已不存在的资产记录）
#[derive(Serialize)]
pub struct ValidationResult {
    pub deleted_count: usize,
    pub total_checked: usize,
}

#[tauri::command]
pub async fn validate_assets(db: State<'_, Database>) -> Result<ValidationResult, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let (total, deleted) = db.validate_assets()?;
        Ok(ValidationResult {
            deleted_count: deleted,
            total_checked: total,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 25: 读取缩略图文件并以 base64 data URL 返回（绕过浏览器 file:// 安全限制）
/// 使用 mime_guess 开源库替代手写 MIME 推断
#[tauri::command]
pub async fn read_thumbnail_base64(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        if !path.exists() {
            return Err(format!("缩略图文件不存在: {}", file_path));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("读取缩略图失败: {}", e))?;
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);

        // 使用 mime_guess 根据扩展名推断 MIME 类型
        let mime = path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(|ext| mime_guess::from_ext(ext).first())
            .map(|m| m.essence_str().to_string())
            .unwrap_or_else(|| "image/png".to_string());

        Ok(format!("data:{};base64,{}", mime, b64))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 27: 轻量检查本地文件是否存在
/// 用于前端缩略图加载前验证缓存文件有效性，避免 asset:// URL 404
#[tauri::command]
pub fn file_exists(file_path: String) -> bool {
    std::path::Path::new(&file_path).exists()
}

/// 指令 28: 对全部已监控根文件夹执行一次廉价剪枝对账
/// 以磁盘为真相源，用目录/文件 mtime 做增量，纠正 notify 事件漏检；
/// 幂等，可安全重复调用。返回聚合后的对账报告供前端/日志查看。
#[tauri::command]
pub async fn reconcile_monitored_folders(
    db: State<'_, Database>,
    app_handle: tauri::AppHandle,
) -> Result<crate::sync::ReconcileReport, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        use crate::sync::{reconcile_root, ReconcileMode};
        let folders = db.get_monitored_folders()?;
        let mut total = crate::sync::ReconcileReport::default();
        for f in &folders {
            let p = Path::new(&f.path);
            if !p.exists() || !p.is_dir() {
                continue;
            }
            match reconcile_root(&app_handle, &db, p, ReconcileMode::Pruned) {
                Ok(r) => {
                    total.folders_added += r.folders_added;
                    total.folders_removed += r.folders_removed;
                    total.folders_updated += r.folders_updated;
                    total.assets_added += r.assets_added;
                    total.assets_removed += r.assets_removed;
                    total.assets_updated += r.assets_updated;
                }
                Err(e) => eprintln!("[Cmd] reconcile_monitored_folders 对账失败 {}: {}", f.path, e),
            }
        }
        Ok(total)
    })
    .await
    .map_err(|e| e.to_string())?
}
