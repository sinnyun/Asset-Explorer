//! ============================================================================
//! 模块：IPC 异步指令路由 (commands.rs)
//! 职责：封装对外暴露给前端调用的所有非阻塞异步 Tauri 命令。
//! 严格保证：所有磁盘 I/O、数据库操作和数据聚合全部投递至后台线程池，
//! 绝不堵塞前端 UI 界面！
//! ============================================================================

use crate::aggregator::{aggregate_asset_metrics, filter_assets_by_smart_folder};
use crate::database::Database;
use crate::indexer::{scan_local_directory, scan_local_directory_incremental};
use crate::metadata_extractor::extract_metadata;
use crate::models::{AggregationReport, Asset, Collection, Folder, ScanResult, SmartFolder, Tag};
use crate::thumbnail_cache::generate_or_get_thumbnail;
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

/// 指令 1: 异步加载本地 SQLite 数据库中的全量工作区数据 (毫秒级响应)
#[tauri::command]
pub async fn load_workspace(db: State<'_, Database>) -> Result<WorkspacePayload, String> {
    let db = db.inner().clone();
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
pub async fn scan_directory(db: State<'_, Database>, path: String) -> Result<ScanResult, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let scan_res = scan_local_directory(&path)?;
        // 自动将扫描到的所有文件夹与资产写入 SQLite 数据库持久化
        db.batch_save_scan_results(&scan_res.root_folder, &scan_res.sub_folders, &scan_res.assets)?;
        Ok(scan_res)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 2c: 后台增量扫描本地目录（将添加文件进度与 UI 完全分离）
/// ------------------------------------------------------------------------
/// 相比 scan_directory 的「同步一次性返回」，此命令采用后台线程 + 事件推送：
///   1. 命令立刻返回，添加监视文件夹的模态框可立即关闭，UI 不被阻塞；
///   2. 扫描分两阶段推进，通过事件向前端实时上报：
///        scan:started  —— 目录树构建完成，携带 root/子目录与文件总数；
///        scan:chunk    —— 每批资产解析完，增量写库并推送该批资产 + 进度；
///        scan:finished —— 全部扫描完成，携带总文件数与耗时；
///        scan:failed   —— 扫描出错。
///   3. 文件边扫边显示，无需等待全部扫描结束。
#[tauri::command]
pub async fn start_scan_directory(
    db: State<'_, Database>,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let db = db.inner().clone();

    // 后台线程执行增量扫描，避免占用 Tauri 主线程而阻塞 UI。
    std::thread::spawn(move || {
        let emit_handle = app_handle.clone();

        let result = scan_local_directory_incremental(
            &path,
            // ---- 阶段回调：目录树就绪 → 写入根目录/子目录并广播 scan:started ----
            &mut |root_folder: &Folder, sub_folders: &[Folder], total_files: usize| {
                // 一次性持久化整棵目录树（UPSERT，幂等）
                db.batch_save_scan_results(root_folder, sub_folders, &[])?;
                let _ = emit_handle.emit("scan:started", serde_json::json!({
                    "root_folder": root_folder,
                    "sub_folders": sub_folders,
                    "total": total_files,
                }));
                Ok(())
            },
            // ---- 阶段回调：每批资产解析完 → 增量写库并广播 scan:chunk ----
            &mut |chunk_assets: &[Asset], done: usize, total_files: usize| {
                if chunk_assets.is_empty() {
                    // 空批次也广播进度，让前端进度条持续推进
                    let _ = emit_handle.emit("scan:chunk", serde_json::json!({
                        "assets": [],
                        "done": done,
                        "total": total_files,
                    }));
                    return Ok(());
                }
                db.batch_save_assets(chunk_assets)?;
                let _ = emit_handle.emit("scan:chunk", serde_json::json!({
                    "assets": chunk_assets,
                    "done": done,
                    "total": total_files,
                }));
                Ok(())
            },
        );

        match result {
            Ok(scan_res) => {
                let _ = emit_handle.emit("scan:finished", serde_json::json!({
                    "root_folder": scan_res.root_folder,
                    "sub_folders": scan_res.sub_folders,
                    "total_files_scanned": scan_res.total_files_scanned,
                    "total_duration_ms": scan_res.total_duration_ms,
                }));
            }
            Err(e) => {
                let _ = emit_handle.emit("scan:failed", serde_json::json!({ "error": e }));
            }
        }
    });

    Ok(())
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
pub async fn create_folder(db: State<'_, Database>, folder: Folder) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.insert_folder(&folder))
        .await
        .map_err(|e| e.to_string())?
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
pub async fn update_folder(db: State<'_, Database>, folder: Folder) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.update_folder(&folder))
        .await
        .map_err(|e| e.to_string())?
}

/// 指令 8: 后端数据库删除文件夹
#[tauri::command]
pub async fn delete_folder(db: State<'_, Database>, id: String) -> Result<(), String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_folder(&id))
        .await
        .map_err(|e| e.to_string())?
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

/// 指令 17: 提取文件元数据
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
            "sha256": meta.sha256,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 18: 生成或获取图片缩略图，生成后自动保存缩略图路径到数据库
#[tauri::command]
pub async fn get_thumbnail(db: State<'_, Database>, asset_id: String, path: String, max_dimension: u32) -> Result<String, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        // 使用数据库的 data_dir 作为缩略图缓存根目录（与数据库同目录下的 thumbnails/）
        let data_dir = db.get_data_dir().to_path_buf();
        let thumb_path = generate_or_get_thumbnail(p, max_dimension, &data_dir)?;
        let thumb_str = thumb_path.to_string_lossy().to_string();
        // 将缩略图路径持久化到数据库，下次直接从 asset.thumbnailUrl 读取
        db.update_asset_thumbnail_url(&asset_id, &thumb_str)?;
        Ok(thumb_str)
    })
    .await
    .map_err(|e| e.to_string())?
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

/// 指令 22: 本地数据完整迁移 (数据库 + 缩略图缓存 + 配置文件)
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

/// 指令 23: 安全重启软件应用 (使用迁移后的新数据库和目录)
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

/// 指令 26: 读取任意文件并以 base64 data URL 返回（用于文件预览）
/// 与 read_thumbnail_base64 类似，但面向源文件而非缩略图缓存。
/// 设定了 50MB 大小上限（原为 200MB，过高会占用 ~270MB 内存且造成严重 GC 压力），
/// 超出部分由前端回退到缩略图或 asset:// URL 方式加载。
/// 使用 tokio::task::spawn_blocking 避免大文件读取阻塞 Tauri 主线程。
#[tauri::command]
pub async fn read_file_base64(file_path: String) -> Result<String, String> {
    const MAX_PREVIEW_BYTES: u64 = 50 * 1024 * 1024; // 50MB（过高会占用 ~270MB 内存，且造成大量 GC 压力）

    let path_clone = file_path.clone();
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&path_clone);
        if !path.exists() {
            return Err(format!("文件不存在: {}", path_clone));
        }

        // 检查文件大小，防止读取超大文件到内存
        let meta = std::fs::metadata(path).map_err(|e| format!("读取文件元信息失败: {}", e))?;
        if meta.len() > MAX_PREVIEW_BYTES {
            return Err(format!("文件过大({} bytes)，超出预览限制", meta.len()));
        }

        let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);

        // 使用 mime_guess 根据扩展名推断 MIME 类型
        let mime = path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(|ext| mime_guess::from_ext(ext).first())
            .map(|m| m.essence_str().to_string())
            .unwrap_or_else(|| "application/octet-stream".to_string());

        Ok(format!("data:{};base64,{}", mime, b64))
    })
    .await
    .map_err(|e| format!("后台线程执行失败: {}", e))?
}
