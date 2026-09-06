//! ============================================================================
//! 模块：索引文件夹 (indexer.rs)
//! 职责：负责扫描本地磁盘目录、解析文件夹层级树、并发发现文件并建立资产数据结构。
//! 依赖开源库：`walkdir`, `rayon`, `chrono`, `sha2`
//! ============================================================================

use crate::models::{Asset, Folder, ScanResult};
use chrono::Utc;
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::{DirEntry, WalkDir};

/// 检查路径是否为应忽略的隐藏目录或常见构建缓存
fn is_ignored_entry(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    if name.starts_with('.') && name != "." {
        return true;
    }
    // Windows/开发环境常见忽略目录
    matches!(
        name.as_ref(),
        "node_modules" | "$RECYCLE.BIN" | "target" | "dist" | "System Volume Information" | "__pycache__"
    )
}

/// 根据文件后缀名快速推断大类类型
pub fn infer_category_from_extension(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" | "tiff" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "flv" | "wmv" => "video",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" => "document",
        "obj" | "fbx" | "gltf" | "glb" | "blend" | "stl" | "dae" => "3d",
        "zip" | "rar" | "7z" | "tar" | "gz" => "archive",
        _ => "other",
    }
}

/// 扫描指定本地目录并返回完整的文件夹树与资产列表
/// 使用多线程加速处理与元数据获取
pub fn scan_local_directory(root_path_str: &str) -> Result<ScanResult, String> {
    let start_time = Instant::now();
    let root_path = PathBuf::from(root_path_str);

    if !root_path.exists() {
        return Err(format!("目录不存在: {}", root_path_str));
    }
    if !root_path.is_dir() {
        return Err(format!("路径不是有效目录: {}", root_path_str));
    }

    let root_folder_name = root_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path_str.to_string());

    let root_id = format!("f_root_{:x}", md5_hash(root_path_str));

    let root_folder = Folder {
        id: root_id.clone(),
        name: root_folder_name,
        path: root_path_str.to_string(),
        parent_id: None,
        is_monitored: true,
        asset_count: None,
    };

    // 1. 使用 WalkDir 收集所有子目录与文件路径
    let mut discovered_dirs: Vec<PathBuf> = Vec::new();
    let mut discovered_files: Vec<PathBuf> = Vec::new();

    let walker = WalkDir::new(&root_path)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !is_ignored_entry(e));

    for entry_result in walker {
        match entry_result {
            Ok(entry) => {
                let path = entry.path().to_path_buf();
                if entry.file_type().is_dir() {
                    discovered_dirs.push(path);
                } else if entry.file_type().is_file() {
                    discovered_files.push(path);
                }
            }
            Err(e) => {
                eprintln!("[Indexer] 遍历警告: {}", e);
            }
        }
    }

    // 2. 映射文件夹层级关系
    let mut sub_folders: Vec<Folder> = Vec::with_capacity(discovered_dirs.len());
    let mut path_to_id: std::collections::HashMap<PathBuf, String> = std::collections::HashMap::new();
    path_to_id.insert(root_path.clone(), root_id.clone());

    for dir_path in &discovered_dirs {
        let dir_str = dir_path.to_string_lossy().to_string();
        let folder_id = format!("f_{:x}", md5_hash(&dir_str));
        path_to_id.insert(dir_path.clone(), folder_id.clone());

        let name = dir_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Folder".to_string());

        let parent_id = dir_path
            .parent()
            .and_then(|p| path_to_id.get(p).cloned())
            .or_else(|| Some(root_id.clone()));

        sub_folders.push(Folder {
            id: folder_id,
            name,
            path: dir_str,
            parent_id,
            is_monitored: false,
            asset_count: None,
        });
    }

    // 3. 使用 Rayon 并行并发解析文件元数据与资产结构
    let now_str = Utc::now().to_rfc3339();
    let root_path_ref = &root_path;

    let assets: Vec<Asset> = discovered_files
        .par_iter()
        .filter_map(|file_path| {
            let metadata = fs::metadata(file_path).ok()?;
            let file_size = metadata.len();
            let file_str = file_path.to_string_lossy().to_string();

            let file_name = file_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown".to_string());

            let extension = file_path
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default();

            let asset_type = infer_category_from_extension(&extension).to_string();

            // 查找所属文件夹 ID
            let folder_id = file_path
                .parent()
                .and_then(|p| path_to_id.get(p).cloned())
                .unwrap_or_else(|| root_id.clone());

            let modified_time = metadata
                .modified()
                .ok()
                .map(|t| {
                    let datetime: chrono::DateTime<Utc> = t.into();
                    datetime.to_rfc3339()
                })
                .unwrap_or_else(|| now_str.clone());

            let id = format!("ast_{:x}", md5_hash(&file_str));

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
                date_added: now_str.clone(),
                rating: 0,
                favorite: false,
                color: None,
                width: None,
                height: None,
                file_hash: None,
                thumbnail_url: None,
            })
        })
        .collect();

    let total_scanned = assets.len();
    let duration = start_time.elapsed().as_millis();

    Ok(ScanResult {
        root_folder,
        sub_folders,
        assets,
        total_files_scanned: total_scanned,
        total_duration_ms: duration,
    })
}

/// 简易高效哈希生成函数 (用于生成稳定的路径 ID 与哈希)
fn md5_hash(input: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}
