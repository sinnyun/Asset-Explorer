//! ============================================================================
//! 模块：实时对账 (sync.rs)
//! 职责：以"磁盘为唯一真相源"，用目录 mtime（结构级信号）与文件 mtime/size
//!       （内容级信号）做增量对账，保证数据库（可丢弃缓存）始终与磁盘一致，
//!       并为 notify 事件快速通道提供正确性兜底。
//! 关键保证：单文件/小文件的内容修改绝不引发父目录重扫（无向上级联），
//!       详阅 PLAN_realtime_reconcile.md。
//! 依赖开源库：`chrono`, `sha2`(经 indexer), `tauri`
//! ============================================================================

use crate::database::Database;
use crate::indexer::{infer_category_from_extension, stable_hash};
use crate::metadata_extractor;
use crate::models::{Asset, Folder};
use crate::watcher::AssetChangeEvent;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter};

/// 对账模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileMode {
    /// 目录 mtime 与库内不一致的子树才深扫；mtime 未变的子树整体剪枝跳过（廉价）。
    Pruned,
    /// 无条件全量走查所有目录并按文件 mtime/size 差异重读（事件批量后/建夹后用）。
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

/// 是否应忽略的隐藏目录或常见构建缓存（与 indexer.rs 保持一致，避免索引口径漂移）。
fn should_ignore_dir(name: &str) -> bool {
    if name.starts_with('.') && name != "." && name != ".." {
        return true;
    }
    matches!(
        name,
        "node_modules" | "$RECYCLE.BIN" | "target" | "dist" | "System Volume Information" | "__pycache__"
    )
}

/// 读取路径的修改时间，转为 RFC3339 字符串。
fn mtime_of(path: &Path) -> Option<String> {
    fs_metadata_modified(path).map(|t| {
        let dt: chrono::DateTime<Utc> = t.into();
        dt.to_rfc3339()
    })
}

/// 包一层 fs::metadata().modified()，避免污染调用处。
fn fs_metadata_modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

/// 递归走查磁盘目录树，收集目录(含 mtime)与文件(含 mtime,size)。
///
/// - `db_dir_mtimes`：库内已记录的 目录路径→mtime，用于 Pruned 剪枝判断。
/// - 返回值：`(disk_dirs, disk_files)`。`disk_dirs` 仅包含本次需要处理的目录
///   （Pruned 下被剪枝跳过的子树不包括在内）；`disk_files` 为已走查目录下的文件。
fn walk_disk(
    dir: &Path,
    mode: ReconcileMode,
    db_dir_mtimes: &HashMap<String, String>,
    disk_dirs: &mut HashMap<String, String>,
    disk_files: &mut HashMap<String, (String, i64)>,
) {
    let dir_str = dir.to_string_lossy().to_string();

    // 读取磁盘目录 mtime
    let disk_mtime = match mtime_of(dir) {
        Some(m) => m,
        None => return, // 目录不可读时静默跳过
    };

    // Pruned 剪枝：若目录 mtime 与库内一致，说明其"直接子项集合"未变，
    // 整棵子树视为未变化，直接跳过（不再深扫），从而避免无谓重扫。
    if mode == ReconcileMode::Pruned
        && db_dir_mtimes.get(&dir_str).map(|s| s == &disk_mtime).unwrap_or(false)
    {
        return;
    }

    // 处理该目录：它属于需要处理（新增/已有但结构变化）的目录。
    disk_dirs.insert(dir_str.clone(), disk_mtime.clone());

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            // 按文件名字段判断忽略（隐藏/构建缓存），避免整段路径误判
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if should_ignore_dir(&name) {
                continue;
            }
            walk_disk(&p, mode, db_dir_mtimes, disk_dirs, disk_files);
        } else if p.is_file() {
            let fdir = p.to_string_lossy().to_string();
            if let Some(meta) = std::fs::metadata(&p).ok() {
                let mt = meta.modified().ok().map(|t| {
                    let dt: chrono::DateTime<Utc> = t.into();
                    dt.to_rfc3339()
                });
                if let Some(mt) = mt {
                    disk_files.insert(fdir, (mt, meta.len() as i64));
                }
            }
        }
    }
}

/// 格式化根路径（去首尾空白与末尾分隔符）。
fn normalize_root(p: &str) -> String {
    p.trim().trim_end_matches(['/', '\\']).to_string()
}

/// 判断路径是否位于根目录（含根本身）之下，兼容分隔符与大小写。
fn is_path_under(path: &str, root: &str) -> bool {
    let p = path.to_lowercase();
    let r = root.to_lowercase();
    if p == r {
        return true;
    }
    p.starts_with(&format!("{}/", r)) || p.starts_with(&format!("{}\\", r))
}

/// 计算目录的确定性文件夹 id（与 indexer.rs 的 `f_`+stable_hash 口径一致）。
fn folder_id_for(path: &str) -> String {
    format!("f_{}", stable_hash(path))
}

/// 根据磁盘目录构造一个 Folder（name / parent_id / id / is_monitored）。
/// `dir_id_map`：已处理的 目录路径→文件夹id，用于解析 parent_id。
fn build_folder(
    path: &Path,
    mtime: &str,
    dir_id_map: &HashMap<String, String>,
    root_norm: &str,
) -> Folder {
    let path_str = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());

    let normalized = normalize_root(&path_str);
    let id = dir_id_map
        .get(&path_str)
        .cloned()
        .unwrap_or_else(|| folder_id_for(&path_str));
    let is_monitored = normalized == root_norm;

    let parent_id = path
        .parent()
        .and_then(|p| dir_id_map.get(&p.to_string_lossy().to_string()))
        .cloned();

    Folder {
        id,
        name,
        path: path_str,
        parent_id,
        is_monitored,
        asset_count: None,
        mtime: Some(mtime.to_string()),
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

    // 所属文件夹 id：优先取父目录在 folder_id_map 中的 id，否则按确定性 id 计算。
    let folder_id = path
        .parent()
        .and_then(|p| folder_id_map.get(&p.to_string_lossy().to_string()))
        .cloned()
        .unwrap_or_else(|| folder_id_for_root(&file_str, root_norm));

    let modified_time = metadata.modified().ok().map(|t| {
        let dt: chrono::DateTime<Utc> = t.into();
        dt.to_rfc3339()
    }).unwrap_or_else(|| Utc::now().to_rfc3339());

    let now_str = Utc::now().to_rfc3339();
    let id = format!("ast_{}", stable_hash(&file_str));

    // 仅对图片读取文件头提取尺寸（不解码、不读内容，"资源管理器式查看器"定位：
    // 运行时不吞吐原始文件内容，增量对账依赖文件系统自带的 mtime/size 签名）
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
        file_hash: None, // 不读取文件内容计算哈希
        thumbnail_url: None,
    })
}

/// 计算某个文件所属父目录（本身已是其父时）的确定性 id；若文件直接位于根下则用根 id。
fn folder_id_for_root(file_path: &str, root_norm: &str) -> String {
    let parent = Path::new(file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if normalize_root(&parent) == root_norm {
        // 根目录 id 由 indexer 生成（f_root_ 前缀）
        format!("f_root_{}", stable_hash(root_norm))
    } else {
        folder_id_for(&parent)
    }
}

/// 对单个监控根文件夹执行"磁盘为真相"的对账，产出并推送增量事件。
pub fn reconcile_root(
    app: &AppHandle,
    db: &Database,
    root_path: &Path,
    mode: ReconcileMode,
) -> Result<ReconcileReport, String> {
    let root_str = root_path.to_string_lossy().to_string();
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!("对账路径不存在或非目录: {}", root_str));
    }
    let start = std::time::Instant::now();
    let root_norm = normalize_root(&root_str);
    println!("[Sync] 开始对账: {} (模式: {:?})", root_str, mode);

    // ---- 库内现状 ----
    // 使用全量文件夹集：尽管本次只对账 root 子树，但仍需全量目录映射才能正确解析
    // 祖先的 parent_id（尤其当 root 本身是某个监控根下的子目录时）。
    let db_folders_all = db.get_folders()?;
    // 目录路径→(库内 mtime)，用于剪枝
    let db_dir_mtimes: HashMap<String, String> = db_folders_all
        .iter()
        .filter_map(|f| f.mtime.clone().map(|m| (f.path.clone(), m)))
        .collect();
    // 目录路径→文件夹（含 id），用于复用已存在的 id 与监视标记
    let db_folder_by_path: HashMap<String, Folder> = db_folders_all
        .into_iter()
        .map(|f| (f.path.clone(), f))
        .collect();
    // 文件路径→(库内 date_modified, size)
    let db_assets: HashMap<String, (String, i64)> = db
        .get_asset_signatures_under(&root_str)?
        .into_iter()
        .map(|(p, m, s)| (p, (m, s)))
        .collect();

    let mut report = ReconcileReport::default();

    // ---- 走查磁盘（Pruned 剪枝 / Deep 全量） ----
    let mut disk_dirs: HashMap<String, String> = HashMap::new();
    let mut disk_files: HashMap<String, (String, i64)> = HashMap::new();
    walk_disk(root_path, mode, &db_dir_mtimes, &mut disk_dirs, &mut disk_files);

    // ---- 对外可访问的 id 映射：目录路径→文件夹id（先装入库内已有，合并磁盘新增） ----
    let mut dir_id_map: HashMap<String, String> = db_folder_by_path
        .iter()
        .map(|(p, f)| (p.clone(), f.id.clone()))
        .collect();

    // ---- 1. 删除：库中存在但磁盘已不存在的文件夹（仅限对账根子树；含其整棵子树，资产经级联） ----
    for (path, folder) in &db_folder_by_path {
        // 只处理位于本次对账根（root_norm）之下的文件夹，避免误删其它监控根的记录
        if !is_path_under(path, &root_norm) {
            continue;
        }
        if !Path::new(path).exists() {
            if let Err(e) = db.delete_folder_tree_by_path(path) {
                eprintln!("[Sync] 删除缺失文件夹失败 {}: {}", path, e);
            } else {
                report.folders_removed += 1;
                println!("[Sync] 文件夹已从磁盘移除: {} (id: {})", path, folder.id);
            }
            let ev = FolderChangeEvent {
                folder: folder.clone(),
                action: "removed".to_string(),
            };
            let _ = app.emit("folder:removed", ev);
        }
    }

    // ---- 2. 文件夹新增 / 更新 ----
    // 按磁盘目录列表处理（Pruned 下仅包含变化/新增目录）。
    for (path, disk_mtime) in &disk_dirs {
        match db_folder_by_path.get(path) {
            // 已在库：复用已有 id，保留其监视标记，仅更新 name/parent/mtime。
            Some(existing) => {
                let mut fresh = Folder {
                    name: Path::new(path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| existing.name.clone()),
                    path: path.clone(),
                    is_monitored: existing.is_monitored,
                    asset_count: None,
                    mtime: Some(disk_mtime.clone()),
                    parent_id: None,
                    id: existing.id.clone(),
                };
                fresh.parent_id = build_folder(Path::new(path), disk_mtime, &dir_id_map, &root_norm).parent_id;
                let changed = fresh.name != existing.name
                    || fresh.parent_id != existing.parent_id
                    || existing.mtime.as_deref() != Some(disk_mtime.as_str());
                if changed {
                    if let Err(e) = db.upsert_folder(&fresh) {
                        eprintln!("[Sync] 更新文件夹失败 {}: {}", path, e);
                    } else {
                        report.folders_updated += 1;
                        println!("[Sync] 文件夹更新: {}", path);
                    }
                    let ev = FolderChangeEvent { folder: fresh, action: "updated".to_string() };
                    let _ = app.emit("folder:updated", ev);
                }
                dir_id_map.insert(path.clone(), existing.id.clone());
            }
            // 磁盘新增文件夹：确定性 id。
            None => {
                let fresh = build_folder(Path::new(path), disk_mtime, &dir_id_map, &root_norm);
                if let Err(e) = db.upsert_folder(&fresh) {
                    eprintln!("[Sync] 新增文件夹失败 {}: {}", path, e);
                } else {
                    report.folders_added += 1;
                    println!("[Sync] 新增文件夹: {} (id: {})", path, fresh.id);
                }
                dir_id_map.insert(path.clone(), fresh.id.clone());
                let ev = FolderChangeEvent { folder: fresh, action: "added".to_string() };
                let _ = app.emit("folder:added", ev);
            }
        }
    }

    // ---- 3. 资产：新增 / 更新（仅处理已走查目录 disk_files 中的文件） ----
    let mut to_add: Vec<Asset> = Vec::new();
    for (path, (disk_mtime, disk_size)) in &disk_files {
        match db_assets.get(path) {
            Some((db_mtime, db_size)) => {
                // 内容或体积变化 → 深度重读更新
                if db_mtime != disk_mtime || db_size != disk_size {
                    if let Some(asset) = build_asset_from_disk(Path::new(path), &dir_id_map, &root_norm) {
                        if let Err(e) = db.batch_save_assets(&[asset.clone()]) {
                            eprintln!("[Sync] 更新资产失败 {}: {}", path, e);
                        } else {
                            report.assets_updated += 1;
                            println!("[Sync] 资产更新: {}", path);
                        }
                        let _ = app.emit("asset:modified", AssetChangeEvent {
                            asset_id: Some(asset.id.clone()),
                            path: path.clone(),
                            action: "modified".to_string(),
                            asset: Some(asset),
                        });
                    }
                }
            }
            None => {
                if let Some(asset) = build_asset_from_disk(Path::new(path), &dir_id_map, &root_norm) {
                    to_add.push(asset);
                }
            }
        }
    }
    if !to_add.is_empty() {
        if let Err(e) = db.batch_save_assets(&to_add) {
            eprintln!("[Sync] 批量新增资产失败: {}", e);
        } else {
            report.assets_added += to_add.len();
            for asset in &to_add {
                println!("[Sync] 新增资产: {}", asset.path);
                let _ = app.emit("asset:added", AssetChangeEvent {
                    asset_id: Some(asset.id.clone()),
                    path: asset.path.clone(),
                    action: "added".to_string(),
                    asset: Some(asset.clone()),
                });
            }
        }
    }

    // ---- 4. 资产删除：库内存在、但其父目录在本次已走查（disk_dirs）且文件已不在磁盘 ----
    // 父目录 mtime 改变必然导致父目录被走查；父目录未被走查（剪枝）时子树视为未变，不处理。
    let mut doomed: Vec<String> = Vec::new();
    for (path, (_, _)) in &db_assets {
        if !is_path_under(path, &root_norm) {
            continue;
        }
        if disk_files.contains_key(path) {
            continue; // 仍在磁盘
        }
        // 父目录是否在本次走查范围内
        let parent = Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if disk_dirs.contains_key(&parent) {
            // 父目录被走查但该文件未被发现且磁盘已不存在 → 已删除
            if !Path::new(path).exists() {
                doomed.push(path.clone());
            }
        }
    }
    if !doomed.is_empty() {
        if let Ok(n) = db.delete_assets_by_paths(&doomed) {
            report.assets_removed += n;
            for path in &doomed {
                println!("[Sync] 资产已删除: {}", path);
                let _ = app.emit("asset:removed", AssetChangeEvent {
                    asset_id: None,
                    path: path.clone(),
                    action: "removed".to_string(),
                    asset: None,
                });
            }
        }
    }

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
    Ok(report)
}