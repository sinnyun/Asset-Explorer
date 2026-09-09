//! ============================================================================
//! 模块：实时对账 (sync.rs)
//! 职责：以"磁盘为唯一真相源"，用递归全量快照比对本地文件系统与数据库，
//!       确保新增、删除、修改、重命名无论发生在程序运行中还是关闭期间，
//!       都能被精确感知并全量实时同步到数据库与前端 UI。
//! ============================================================================

use crate::database::Database;
use crate::indexer::{infer_category_from_extension, stable_hash};
use crate::metadata_extractor;
use crate::models::{Asset, Folder};
use crate::watcher::AssetChangeEvent;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// 对账模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileMode {
    /// 兼容枚举：均执行高可靠全树递归比对
    Pruned,
    Deep,
}

/// 文件夹级事件载荷（新增/更新/删除），经事件通道推送给前端实时刷新目录树。
#[derive(Clone, Serialize)]
pub struct FolderChangeEvent {
    pub folder: Folder,
    pub action: String, // "added" | "updated" | "removed"
}

/// 一次对账的统计报告。
#[derive(Debug, Default, Serialize)]
pub struct ReconcileReport {
    pub folders_added: usize,
    pub folders_removed: usize,
    pub folders_updated: usize,
    pub assets_added: usize,
    pub assets_removed: usize,
    pub assets_updated: usize,
}

/// 是否应忽略的隐藏目录或常见构建缓存（与 indexer.rs 保持一致）。
pub fn should_ignore_dir(name: &str) -> bool {
    if name.starts_with('.') && name != "." && name != ".." {
        return true;
    }
    matches!(
        name,
        "node_modules" | "$RECYCLE.BIN" | "target" | "dist" | "System Volume Information" | "__pycache__"
    )
}

/// 读取路径的修改时间，转为 RFC3339 字符串。
pub fn mtime_of(path: &Path) -> Option<String> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok()).map(|t| {
        let dt: chrono::DateTime<Utc> = t.into();
        dt.to_rfc3339()
    })
}

/// 将文件系统路径规整为键（全部正斜杠转为反斜杠，去首尾空格与尾部分隔符，转小写），
/// 确保跨平台/Windows下哈希表查找绝对一致，杜绝斜杠/大小写导致的失配。
pub fn norm_key(p: &str) -> String {
    p.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// 格式化根路径（去首尾空白与末尾分隔符）。
pub fn normalize_root(p: &str) -> String {
    p.trim().trim_end_matches(['/', '\\']).to_string()
}

/// 判断路径是否位于根目录（含根本身）之下，兼容分隔符与大小写。
pub fn is_path_under(path: &str, root: &str) -> bool {
    let p = norm_key(path);
    let r = norm_key(root);
    if p == r {
        return true;
    }
    p.starts_with(&format!("{}\\", r)) || p.starts_with(&format!("{}/", r))
}

/// 计算目录的确定性文件夹 id（与 indexer.rs 的 `f_`+stable_hash 口径一致）。
pub fn folder_id_for(path: &str) -> String {
    format!("f_{}", stable_hash(path))
}

/// 递归走查磁盘目录树，收集目录(含 mtime)与文件(含 mtime, size, PathBuf)。
/// 仅提取文件系统属性（毫秒级），不解码图片或读大文件内容，保证快速且不阻塞。
fn walk_disk(
    dir: &Path,
    disk_dirs: &mut HashMap<String, (String, PathBuf)>,
    disk_files: &mut HashMap<String, (String, i64, PathBuf)>,
) {
    let dir_str = dir.to_string_lossy().to_string();
    let dir_mtime = mtime_of(dir).unwrap_or_else(|| Utc::now().to_rfc3339());
    disk_dirs.insert(norm_key(&dir_str), (dir_mtime, dir.to_path_buf()));

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if should_ignore_dir(&name) {
            continue;
        }

        if p.is_dir() {
            walk_disk(&p, disk_dirs, disk_files);
        } else if p.is_file() {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if infer_category_from_extension(ext) == "other" {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&p) {
                let mt = meta.modified().ok().map(|t| {
                    let dt: chrono::DateTime<Utc> = t.into();
                    dt.to_rfc3339()
                }).unwrap_or_else(|| Utc::now().to_rfc3339());
                let p_str = p.to_string_lossy().to_string();
                disk_files.insert(norm_key(&p_str), (mt, meta.len() as i64, p));
            }
        }
    }
}

/// 从磁盘文件构造资产对象（复用 indexer 的元数据提取口径）。
fn build_asset_from_disk(path: &Path, folder_id_map: &HashMap<String, String>, root_norm: &str) -> Option<Asset> {
    let metadata = std::fs::metadata(path).ok()?;
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
    if asset_type == "other" {
        return None;
    }

    let parent = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let folder_id = folder_id_map
        .get(&norm_key(&parent))
        .cloned()
        .unwrap_or_else(|| folder_id_for_root(&file_str, root_norm));

    let modified_time = metadata.modified().ok().map(|t| {
        let dt: chrono::DateTime<Utc> = t.into();
        dt.to_rfc3339()
    }).unwrap_or_else(|| Utc::now().to_rfc3339());

    let now_str = Utc::now().to_rfc3339();
    let id = format!("ast_{}", stable_hash(&file_str));

    let (width, height) = if asset_type == "image" {
        let meta = metadata_extractor::extract_metadata(path);
        (meta.width, meta.height)
    } else {
        (None, None)
    };

    Some(Asset {
        id,
        name: file_name,
        path: file_str,
        asset_type,
        size: file_size,
        folder_id,
        tags: Vec::new(),
        collections: Vec::new(),
        date_modified: modified_time,
        date_added: now_str,
        rating: 0,
        favorite: false,
        color: None,
        width,
        height,
        file_hash: None,
        thumbnail_url: None,
    })
}

/// 计算某个文件所属父目录（本身已是其父时）的确定性 id；若文件直接位于根下则用根 id。
fn folder_id_for_root(file_path: &str, root_norm: &str) -> String {
    let parent = Path::new(file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if norm_key(&parent) == norm_key(root_norm) {
        format!("f_root_{}", stable_hash(root_norm))
    } else {
        folder_id_for(&parent)
    }
}

/// 对单个监控根文件夹执行"磁盘为真相"的完整对账，产出并推送增量事件。
pub fn reconcile_root(
    app: &AppHandle,
    db: &Database,
    root_path: &Path,
    _mode: ReconcileMode,
) -> Result<ReconcileReport, String> {
    let root_str = root_path.to_string_lossy().to_string();
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!("对账路径不存在或非目录: {}", root_str));
    }
    let start = std::time::Instant::now();
    let root_norm = normalize_root(&root_str);

    // ---- 1. 读取数据库现状 ----
    let db_folders_all = db.get_folders()?;
    let mut db_folder_by_key: HashMap<String, Folder> = HashMap::new();
    let mut dir_id_map: HashMap<String, String> = HashMap::new();
    for f in db_folders_all {
        let key = norm_key(&f.path);
        dir_id_map.insert(key.clone(), f.id.clone());
        db_folder_by_key.insert(key, f);
    }

    // 数据库中本根目录下的资产签名：key -> (id, path, date_modified, size)
    let db_assets: HashMap<String, (String, String, String, i64)> = db
        .get_asset_signatures_under(&root_str)?
        .into_iter()
        .map(|(id, p, m, s)| (norm_key(&p), (id, p, m, s)))
        .collect();

    let mut report = ReconcileReport::default();

    // ---- 2. 递归走查磁盘 ----
    let mut disk_dirs: HashMap<String, (String, PathBuf)> = HashMap::new();
    let mut disk_files: HashMap<String, (String, i64, PathBuf)> = HashMap::new();
    walk_disk(root_path, &mut disk_dirs, &mut disk_files);

    // ---- 3. 文件夹对账：删除库中有但磁盘已移除的文件夹 ----
    for (key, folder) in &db_folder_by_key {
        if !is_path_under(&folder.path, &root_norm) {
            continue;
        }
        if !disk_dirs.contains_key(key) && !Path::new(&folder.path).exists() {
            let _ = db.delete_folder_tree_by_path(&folder.path);
            let _ = db.delete_assets_by_prefix(&folder.path);
            report.folders_removed += 1;
            println!("[Sync] 文件夹已从磁盘移除: {} (id: {})", folder.path, folder.id);
            let _ = app.emit("folder:removed", FolderChangeEvent {
                folder: folder.clone(),
                action: "removed".to_string(),
            });
        }
    }

    // ---- 4. 文件夹对账：新增与更新（按路径长度升序，确保父级优先处理） ----
    let mut sorted_dirs: Vec<(String, (String, PathBuf))> = disk_dirs.into_iter().collect();
    sorted_dirs.sort_by_key(|(_, (_, p))| p.as_os_str().len());

    for (key, (disk_mtime, dir_path)) in sorted_dirs {
        let path_str = dir_path.to_string_lossy().to_string();
        let is_root = norm_key(&path_str) == norm_key(&root_norm);
        let parent = dir_path.parent().map(|p| p.to_string_lossy().to_string());
        let parent_id = parent.as_ref().and_then(|pp| dir_id_map.get(&norm_key(pp))).cloned();

        match db_folder_by_key.get(&key) {
            Some(existing) => {
                let name = dir_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| existing.name.clone());
                let updated = Folder {
                    id: existing.id.clone(),
                    name,
                    path: path_str.clone(),
                    parent_id: if is_root { existing.parent_id.clone() } else { parent_id },
                    is_monitored: existing.is_monitored,
                    asset_count: None,
                    mtime: Some(disk_mtime.clone()),
                };
                let changed = updated.name != existing.name
                    || updated.parent_id != existing.parent_id
                    || existing.mtime.as_deref() != Some(disk_mtime.as_str());
                if changed {
                    let _ = db.upsert_folder(&updated);
                    report.folders_updated += 1;
                    let _ = app.emit("folder:updated", FolderChangeEvent {
                        folder: updated.clone(),
                        action: "updated".to_string(),
                    });
                }
                dir_id_map.insert(key, existing.id.clone());
            }
            None => {
                let name = dir_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.clone());
                let id = if is_root {
                    format!("f_root_{}", stable_hash(&path_str))
                } else {
                    format!("f_{}", stable_hash(&path_str))
                };
                let fresh = Folder {
                    id: id.clone(),
                    name,
                    path: path_str.clone(),
                    parent_id,
                    is_monitored: is_root,
                    asset_count: None,
                    mtime: Some(disk_mtime.clone()),
                };
                let _ = db.upsert_folder(&fresh);
                dir_id_map.insert(key, id.clone());
                report.folders_added += 1;
                let _ = app.emit("folder:added", FolderChangeEvent {
                    folder: fresh,
                    action: "added".to_string(),
                });
            }
        }
    }

    // ---- 5. 资产对账：新增与修改 ----
    let mut to_add: Vec<Asset> = Vec::new();
    for (key, (disk_mtime, disk_size, file_path)) in &disk_files {
        match db_assets.get(key) {
            Some((_, _, db_mtime, db_size)) => {
                if db_mtime != disk_mtime || db_size != disk_size {
                    if let Some(asset) = build_asset_from_disk(file_path, &dir_id_map, &root_norm) {
                        let _ = db.batch_save_assets(&[asset.clone()]);
                        report.assets_updated += 1;
                        let _ = app.emit("asset:modified", AssetChangeEvent {
                            asset_id: Some(asset.id.clone()),
                            path: asset.path.clone(),
                            action: "modified".to_string(),
                            asset: Some(asset),
                        });
                    }
                }
            }
            None => {
                if let Some(asset) = build_asset_from_disk(file_path, &dir_id_map, &root_norm) {
                    to_add.push(asset);
                }
            }
        }
    }

    if !to_add.is_empty() {
        if let Ok(_) = db.batch_save_assets(&to_add) {
            report.assets_added += to_add.len();
            for asset in &to_add {
                let _ = app.emit("asset:added", AssetChangeEvent {
                    asset_id: Some(asset.id.clone()),
                    path: asset.path.clone(),
                    action: "added".to_string(),
                    asset: Some(asset.clone()),
                });
            }
        }
    }

    // ---- 6. 资产对账：删除 ----
    let mut doomed_ids: Vec<String> = Vec::new();
    let mut doomed_paths: Vec<String> = Vec::new();
    for (key, (id, orig_path, _, _)) in &db_assets {
        if !disk_files.contains_key(key) && !Path::new(orig_path).exists() {
            doomed_ids.push(id.clone());
            doomed_paths.push(orig_path.clone());
        }
    }

    if !doomed_ids.is_empty() {
        if let Ok(n) = db.delete_assets_by_ids(&doomed_ids) {
            report.assets_removed += n;
            for (id, path) in doomed_ids.iter().zip(doomed_paths.iter()) {
                let _ = app.emit("asset:removed", AssetChangeEvent {
                    asset_id: Some(id.clone()),
                    path: path.clone(),
                    action: "removed".to_string(),
                    asset: None,
                });
            }
        }
    }

    if report.folders_added > 0 || report.folders_removed > 0 || report.folders_updated > 0
        || report.assets_added > 0 || report.assets_removed > 0 || report.assets_updated > 0 {
        println!(
            "[Sync] 对账完成: +文件夹 {} / -文件夹 {} / ~文件夹 {} || +资产 {} / -资产 {} / ~资产 {}，耗时 {:?}",
            report.folders_added,
            report.folders_removed,
            report.folders_updated,
            report.assets_added,
            report.assets_removed,
            report.assets_updated,
            start.elapsed()
        );
    }
    Ok(report)
}
