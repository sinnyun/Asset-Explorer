//! ============================================================================
//! 模块：实时对账 (sync.rs)
//! 职责：以"磁盘为唯一真相源"，用递归全量快照比对本地文件系统与数据库，
//!       确保新增、删除、修改、重命名无论发生在程序运行中还是关闭期间，
//!       都能被精确感知并全量实时同步到数据库与前端 UI。
//! ============================================================================

#[cfg(test)]
use crate::database::Database;
#[cfg(test)]
use crate::indexer::{infer_category_from_extension, stable_hash};
#[cfg(test)]
use crate::metadata_extractor;
#[cfg(test)]
use crate::models::Asset;
use crate::models::Folder;
#[cfg(test)]
use crate::watcher::AssetChangeEvent;
#[cfg(test)]
use chrono::Utc;
use serde::Serialize;
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::path::{Path, PathBuf};

/// 文件夹级事件载荷（新增/更新/删除），经事件通道推送给前端实时刷新目录树。
#[derive(Clone, Serialize)]
pub struct FolderChangeEvent {
    pub folder: Folder,
    pub action: String, // "added" | "updated" | "removed"
}

/// 一次对账的统计报告。
#[cfg(test)]
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
#[cfg(test)]
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
#[cfg(test)]
pub fn mtime_of(path: &Path) -> Option<String> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok()).map(|t| {
        let dt: chrono::DateTime<Utc> = t.into();
        dt.to_rfc3339()
    })
}

/// 将文件系统路径规整为键（全部正斜杠转为反斜杠，去首尾空格与尾部分隔符，转小写），
/// 确保跨平台/Windows下哈希表查找绝对一致，杜绝斜杠/大小写导致的失配。
#[cfg(test)]
pub fn norm_key(p: &str) -> String {
    crate::database::normalize_windows_path(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_disk_walk_does_not_publish_a_partial_snapshot() {
        // A file cannot be traversed as a directory; no external fixture is needed.
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let mut dirs = HashMap::new();
        let mut files = HashMap::new();
        let _ = walk_disk(&path, &mut dirs, &mut files);
        assert!(dirs.is_empty() && files.is_empty(), "an unsuccessful traversal must not publish a snapshot for cleanup");
    }
}

/// 格式化根路径（去首尾空白与末尾分隔符）。
#[cfg(test)]
pub fn normalize_root(p: &str) -> String {
    norm_key(p)
}

/// 判断路径是否位于根目录（含根本身）之下，兼容分隔符与大小写。
#[cfg(test)]
pub fn is_path_under(path: &str, root: &str) -> bool {
    let p = norm_key(path);
    let r = norm_key(root);
    if p == r {
        return true;
    }
    p.starts_with(&format!("{}\\", r.trim_end_matches('\\')))
}

/// 计算目录的确定性文件夹 id（与 indexer.rs 的 `f_`+stable_hash 口径一致）。
#[cfg(test)]
pub fn folder_id_for(path: &str) -> String {
    format!("f_{}", stable_hash(path))
}

/// 递归走查磁盘目录树，收集目录(含 mtime)与文件(含 mtime, size, PathBuf)。
/// 仅提取文件系统属性（毫秒级），不解码图片或读大文件内容，保证快速且不阻塞。
#[cfg(test)]
fn walk_disk(
    dir: &Path,
    disk_dirs: &mut HashMap<String, (String, PathBuf)>,
    disk_files: &mut HashMap<String, (String, i64, PathBuf)>,
) -> Result<(), String> {
    // Publish only a complete traversal; failed snapshots must never drive cleanup.
    let mut complete_dirs = HashMap::new();
    let mut complete_files = HashMap::new();
    walk_disk_entries(dir, &mut complete_dirs, &mut complete_files)?;
    disk_dirs.extend(complete_dirs);
    disk_files.extend(complete_files);
    Ok(())
}

#[cfg(test)]
fn walk_disk_entries(
    dir: &Path,
    disk_dirs: &mut HashMap<String, (String, PathBuf)>,
    disk_files: &mut HashMap<String, (String, i64, PathBuf)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("遍历目录 {} 失败: {e}", dir.display()))?;
    let dir_mtime = mtime_of(dir)
        .ok_or_else(|| format!("读取目录时间失败: {}", dir.display()))?;
    disk_dirs.insert(norm_key(&dir.to_string_lossy()), (dir_mtime, dir.to_path_buf()));
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {e}"))?;
        let path = entry.path();
        if should_ignore_dir(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| format!("读取文件类型失败: {e}"))?;
        if file_type.is_dir() {
            walk_disk_entries(&path, disk_dirs, disk_files)?;
        } else if file_type.is_file() {
            let metadata = entry.metadata().map_err(|e| format!("读取文件属性失败: {e}"))?;
            let modified = metadata.modified().map_err(|e| format!("读取文件时间失败: {e}"))?;
            let modified: chrono::DateTime<Utc> = modified.into();
            disk_files.insert(norm_key(&path.to_string_lossy()), (modified.to_rfc3339(), metadata.len() as i64, path));
        }
    }
    Ok(())
}

/// 从磁盘文件构造资产对象（复用 indexer 的元数据提取口径）。
#[cfg(test)]
fn build_asset_from_disk(path: &Path, folder_id_map: &HashMap<String, String>, root_norm: &str) -> Result<Asset, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("读取对账文件 {} 失败: {e}", path.display()))?;
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
    // 与 indexer 初始扫描保持一致：不再过滤 "other" 类型，避免设计文件无法被对账入库

    let parent = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let folder_id = folder_id_map
        .get(&norm_key(&parent))
        .cloned()
        .unwrap_or_else(|| folder_id_for_root(&file_str, root_norm));

    let modified: chrono::DateTime<Utc> = metadata.modified()
        .map_err(|e| format!("读取对账文件时间失败: {e}"))?.into();
    let modified_time = modified.to_rfc3339();

    let now_str = Utc::now().to_rfc3339();
    let id = format!("ast_{}", stable_hash(&file_str));

    let (width, height) = if asset_type == "image" {
        let meta = metadata_extractor::extract_metadata(path);
        (meta.width, meta.height)
    } else {
        (None, None)
    };

    Ok(Asset {
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
#[cfg(test)]
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

/// Keep filesystem/database reconciliation testable without constructing a desktop window.
#[cfg(test)]
pub(crate) fn reconcile_with_events(
    db: &Database,
    root_path: &Path,
    emit: &dyn Fn(&str, serde_json::Value),
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
    walk_disk(root_path, &mut disk_dirs, &mut disk_files)?;

    // ---- 4. 文件夹对账：新增与更新（按路径长度升序，确保父级优先处理） ----
    let mut sorted_dirs: Vec<_> = disk_dirs.iter().collect();
    sorted_dirs.sort_by_key(|(_, (_, p))| p.as_os_str().len());

    for (key, (disk_mtime, dir_path)) in sorted_dirs {
        let path_str = dir_path.to_string_lossy().to_string();
        let is_root = norm_key(&path_str) == norm_key(&root_norm);
        let parent = dir_path.parent().map(|p| p.to_string_lossy().to_string());
        let parent_id = parent.as_ref().and_then(|pp| dir_id_map.get(&norm_key(pp))).cloned();

        match db_folder_by_key.get(key) {
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
                    db.upsert_folder(&updated)?;
                    report.folders_updated += 1;
                    emit("folder:updated", serde_json::json!(FolderChangeEvent {
                        folder: updated.clone(),
                        action: "updated".to_string(),
                    }));
                }
                dir_id_map.insert(key.clone(), existing.id.clone());
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
                db.upsert_folder(&fresh)?;
                dir_id_map.insert(key.clone(), id.clone());
                report.folders_added += 1;
                emit("folder:added", serde_json::json!(FolderChangeEvent {
                    folder: fresh,
                    action: "added".to_string(),
                }));
            }
        }
    }

    // ---- 5. 资产对账：新增与修改 ----
    let mut to_add: Vec<Asset> = Vec::new();
    for (key, (disk_mtime, disk_size, file_path)) in &disk_files {
        match db_assets.get(key) {
            Some((_, _, db_mtime, db_size)) => {
                if db_mtime != disk_mtime || db_size != disk_size {
                    {
                        let asset = build_asset_from_disk(file_path, &dir_id_map, &root_norm)?;
                        db.batch_save_assets(&[asset.clone()])?;
                        report.assets_updated += 1;
                        emit("asset:modified", serde_json::json!(AssetChangeEvent {
                            asset_id: Some(asset.id.clone()),
                            path: asset.path.clone(),
                            action: "modified".to_string(),
                            asset: Some(asset),
                        }));
                    }
                }
            }
            None => {
                to_add.push(build_asset_from_disk(file_path, &dir_id_map, &root_norm)?);
            }
        }
    }

    if !to_add.is_empty() {
        {
            db.batch_save_assets(&to_add)?;
            report.assets_added += to_add.len();
            for asset in &to_add {
                emit("asset:added", serde_json::json!(AssetChangeEvent {
                    asset_id: Some(asset.id.clone()),
                    path: asset.path.clone(),
                    action: "added".to_string(),
                    asset: Some(asset.clone()),
                }));
            }
        }
    }

    // Stage removals only after all reads and writes succeed. Permission errors are not absence.
    let mut missing_folders = Vec::new();
    for (key, folder) in &db_folder_by_key {
        if is_path_under(&folder.path, &root_norm)
            && !disk_dirs.contains_key(key)
            && !Path::new(&folder.path).try_exists().map_err(|e| format!("检查目录失败: {e}"))?
        {
            missing_folders.push(folder);
        }
    }
    let mut doomed_ids = Vec::new();
    let mut doomed_paths = Vec::new();
    for (key, (id, path, _, _)) in &db_assets {
        if !disk_files.contains_key(key)
            && !Path::new(path).try_exists().map_err(|e| format!("检查文件失败: {e}"))?
        {
            doomed_ids.push(id.clone());
            doomed_paths.push(path.clone());
        }
    }

    if !missing_folders.is_empty() || !doomed_ids.is_empty() {
        // Recheck the root before cleanup so a disconnected root is not treated as empty.
        std::fs::read_dir(root_path).map_err(|e| format!("清理前检查根目录失败: {e}"))?;
        let paths: Vec<String> = missing_folders.iter().map(|folder| folder.path.clone()).collect();
        let (folders_removed, assets_removed) = if paths.is_empty() {
            (0, db.delete_assets_by_ids(&doomed_ids)?)
        } else {
            db.complete_scan_removals(&paths, &doomed_ids)?
        };
        report.folders_removed += folders_removed;
        report.assets_removed += assets_removed;
        for folder in missing_folders {
            emit("folder:removed", serde_json::json!(FolderChangeEvent {
                folder: folder.clone(), action: "removed".to_string(),
            }));
        }
        for (id, path) in doomed_ids.iter().zip(doomed_paths.iter()) {
            emit("asset:removed", serde_json::json!(AssetChangeEvent {
                asset_id: Some(id.clone()), path: path.clone(),
                action: "removed".to_string(), asset: None,
            }));
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
