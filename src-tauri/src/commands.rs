//! ============================================================================
//! 模块：IPC 异步指令路由 (commands.rs)
//! 职责：封装对外暴露给前端调用的所有非阻塞异步 Tauri 命令。
//! 严格保证：所有磁盘 I/O、数据库操作和数据聚合全部投递至后台线程池，
//! 绝不堵塞前端 UI 界面！
//! ============================================================================

use crate::aggregator::{aggregate_asset_metrics, filter_assets_by_smart_folder};
use crate::database::Database;
use crate::indexer::scan_local_directory;
use crate::metadata_extractor::extract_metadata;
use crate::models::{AggregationReport, Asset, Collection, Folder, ScanResult, SmartFolder, Tag};
use crate::thumbnail_cache::generate_or_get_thumbnail;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use tauri::State;

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
        let thumb_path = generate_or_get_thumbnail(p, max_dimension)?;
        let thumb_str = thumb_path.to_string_lossy().to_string();
        // 将缩略图路径持久化到数据库，下次直接从 asset.thumbnailUrl 读取
        db.update_asset_thumbnail_url(&asset_id, &thumb_str)?;
        Ok(thumb_str)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指令 19: 在 Windows 资源管理器中高亮定位文件
#[tauri::command]
pub async fn open_in_file_manager(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .arg(format!("/select,\"{}\"", path))
                .spawn()
                .map_err(|e| format!("打开资源管理器失败: {}", e))?;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Ok(())
        }
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
