//! ============================================================================
//! 模块：索引文件夹 (indexer.rs)
//! 职责：负责扫描本地磁盘目录、解析文件夹层级树、并发发现文件并建立资产数据结构。
//! 依赖开源库：`ignore`(WalkBuilder), `rayon`, `chrono`, `sha2`, `mime_guess`
//! ============================================================================

use crate::metadata_extractor;
use crate::models::{Asset, Folder, ScanResult};
use chrono::Utc;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 检查路径是否为应忽略的隐藏目录或常见构建缓存
/// 额外使用 ignore 开源库的 WalkBuilder 支持 .gitignore 规则
fn is_ignored_entry(entry: &ignore::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    if name.starts_with('.') && name != "." && name != ".." {
        return true;
    }
    // Windows/开发环境常见忽略目录
    matches!(
        name.as_ref(),
        "node_modules" | "$RECYCLE.BIN" | "target" | "dist" | "System Volume Information" | "__pycache__"
    )
}

/// 根据文件后缀名快速推断大类类型
/// 使用 mime_guess 开源库将扩展名映射为 MIME 类型，再归入业务大类。
/// 3D 文件格式不被 mime_guess 完整覆盖，额外保留补充映射。
pub fn infer_category_from_extension(ext: &str) -> &'static str {
    let ext_lower = ext.to_lowercase();

    // 优先使用 mime_guess 开源库获取标准 MIME 类型
    let mime = mime_guess::from_ext(&ext_lower)
        .first()
        .map(|m| m.essence_str().to_string())
        .unwrap_or_default();

    // 1. 基于 MIME 顶层类型快速归类
    if mime.starts_with("image/") {
        return "image";
    }
    if mime.starts_with("video/") {
        return "video";
    }
    if mime.starts_with("audio/") {
        return "audio";
    }

    // 2. 基于 MIME essence 精确匹配文档/归档类型
    match mime.as_str() {
        // 文档类型
        "application/pdf" | "text/plain" | "text/markdown" | "text/x-markdown" | "application/rtf"
        | "application/msword"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.ms-excel"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.ms-powerpoint"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
            return "document"
        }
        // 归档压缩
        "application/zip" | "application/x-rar-compressed" | "application/x-7z-compressed"
        | "application/x-tar" | "application/gzip" | "application/x-gzip"
        | "application/x-bzip2" | "application/x-bzip" | "application/x-compressed" => {
            return "archive"
        }
        _ => {}
    }

    // 3. mime_guess 未覆盖的扩展名补充映射（3D/归档/文档等不常见格式）
    match ext_lower.as_str() {
        // 3D 文件格式
        "obj" | "fbx" | "gltf" | "glb" | "blend" | "stl" | "dae" | "3ds" | "max" | "c4d" => "3d",
        // 归档文件（mime_guess 可能未识别）
        "rar" | "7z" | "zip" | "tar" | "gz" | "bz2" | "xz" => "archive",
        // 文档补充格式
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "md" => "document",
        _ => "other",
    }
}

/// 使用 sha2 生成稳定的确定性哈希字符串
/// 替代原有的 DefaultHasher（SipHash 带进程随机种子，重启后 ID 会漂移）
/// 取 SHA-256 前 8 字节（16 hex 字符），确保 ID 稳定且紧凑
pub fn stable_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..8])
}

/// 是否是需要提取尺寸的媒体格式（图片直接读取文件头提取尺寸，视频可留待后续）
fn should_extract_deep_metadata(asset_type: &str) -> bool {
    matches!(asset_type, "image")
}

/// 由单个文件路径构造一个资产对象（并行解析元数据与 SHA-256）
/// 该辅助函数被完整扫描与增量分批扫描共用，保证 ID/字段计算逻辑一致。
fn build_asset(
    file_path: &Path,
    path_to_id: &std::collections::HashMap<PathBuf, String>,
    root_id: &str,
    now_str: &str,
) -> Option<Asset> {
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
        .unwrap_or_else(|| root_id.to_string());

    let modified_time = metadata
        .modified()
        .ok()
        .map(|t| {
            let datetime: chrono::DateTime<Utc> = t.into();
            datetime.to_rfc3339()
        })
        .unwrap_or_else(|| now_str.to_string());

    let id = format!("ast_{}", stable_hash(&file_str));

    // ==================================================================
    // 元数据提取链路：仅对图片读取文件头提取尺寸（不解码全图、不读文件内容）
    // 设计原则：本应用定位为"资源管理器式查看器"，运行时不吞吐原始文件内容；
    // 增量对账依赖文件系统自带的 mtime/size 签名，无需内容级 SHA-256。
    // ==================================================================
    let (width, height) = if should_extract_deep_metadata(&asset_type) {
        let meta = metadata_extractor::extract_metadata(file_path);
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
        date_added: now_str.to_string(),
        rating: 0,
        favorite: false,
        color: None,
        width,
        height,
        file_hash: None, // 运行时不读取文件内容计算哈希（查看器定位，详阅模块注释）
        thumbnail_url: None,
    })
}


/// 扫描指定本地目录并返回完整的文件夹树与资产列表
/// 使用 ignore::WalkBuilder 支持 .gitignore 规则
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

    let root_id = format!("f_root_{}", stable_hash(root_path_str));

    let root_folder = Folder {
        id: root_id.clone(),
        name: root_folder_name,
        path: root_path_str.to_string(),
        parent_id: None,
        is_monitored: true,
        asset_count: None,
        mtime: None,
    };

    // 1. 使用 ignore crate 的 WalkBuilder 遍历目录
    //    自动读取 .gitignore / .ignore 规则文件，支持 git 风格忽略规则
    let mut discovered_dirs: Vec<PathBuf> = Vec::new();
    let mut discovered_files: Vec<PathBuf> = Vec::new();

    // WalkBuilder 默认支持读取 .gitignore 与全局 ignore 规则
    // hidden(false) 表示不跳过隐藏文件目录，交由 is_ignored_entry 精确控制，
    // 避免将 `.gitignore` / `.git` 等文件本身直接过滤掉
    let walker = ignore::WalkBuilder::new(&root_path)
        .min_depth(Some(1))
        .hidden(false) // 我们自研处理，控制更精细
        .parents(true) // 支持读取父目录中的 .gitignore
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .filter_entry(|e| !is_ignored_entry(e))
        .build();

    for entry_result in walker {
        match entry_result {
            Ok(entry) => {
                let path = entry.path().to_path_buf();
                if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    discovered_dirs.push(path);
                } else if entry.file_type().is_some_and(|ft| ft.is_file()) {
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
        let folder_id = format!("f_{}", stable_hash(&dir_str));
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
            mtime: None,
        });
    }

    // 3. 使用 Rayon 并行并发解析文件元数据与资产结构
    //    同时调用 metadata_extractor 提取图片尺寸/SHA256 等深度元数据
    let now_str = Utc::now().to_rfc3339();

    let assets: Vec<Asset> = discovered_files
        .par_iter()
        .filter_map(|file_path| build_asset(file_path, &path_to_id, &root_id, &now_str))
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

// ============================================================================
// 增量扫描（两阶段）
// ----------------------------------------------------------------------------
// 阶段 1：WalkBuilder 快速遍历磁盘，收集全部目录与文件清单，从而得知
//         文件总数 total，并一次性构建好目录树。
// 阶段 2：将文件清单按固定块大小分批，用 Rayon 并行解析每批资产，
//         每批完成后回调 on_chunk，由调用方（commands.rs）负责增量写库
//         并通过事件实时推送给前端，实现「边扫边显示、UI 不卡死」。
// ============================================================================

/// 增量分批扫描本地目录
///
/// on_start：目录树构建完成、资产分批前回调，用于先持久化并广播根目录/子目录与文件总数。
/// on_chunk：每解析完一批资产回调，用于增量写库并上报进度，实现边扫边显示。
pub fn scan_local_directory_incremental(
    root_path_str: &str,
    on_start: &mut dyn FnMut(&Folder, &[Folder], usize) -> Result<(), String>,
    on_chunk: &mut dyn FnMut(&[Asset], usize, usize) -> Result<(), String>,
) -> Result<ScanResult, String> {
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

    let root_id = format!("f_root_{}", stable_hash(root_path_str));

    let root_folder = Folder {
        id: root_id.clone(),
        name: root_folder_name,
        path: root_path_str.to_string(),
        parent_id: None,
        is_monitored: true,
        asset_count: None,
        mtime: None,
    };

    // ---- 阶段 1：遍历收集目录与文件清单 ----
    let mut discovered_dirs: Vec<PathBuf> = Vec::new();
    let mut discovered_files: Vec<PathBuf> = Vec::new();

    let walker = ignore::WalkBuilder::new(&root_path)
        .min_depth(Some(1))
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .filter_entry(|e| !is_ignored_entry(e))
        .build();

    for entry_result in walker {
        match entry_result {
            Ok(entry) => {
                let path = entry.path().to_path_buf();
                if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    discovered_dirs.push(path);
                } else if entry.file_type().is_some_and(|ft| ft.is_file()) {
                    discovered_files.push(path);
                }
            }
            Err(e) => {
                eprintln!("[Indexer] 遍历警告: {}", e);
            }
        }
    }

    // ---- 构建目录层级与 ID 映射 ----
    let mut sub_folders: Vec<Folder> = Vec::with_capacity(discovered_dirs.len());
    let mut path_to_id: std::collections::HashMap<PathBuf, String> = std::collections::HashMap::new();
    path_to_id.insert(root_path.clone(), root_id.clone());

    for dir_path in &discovered_dirs {
        let dir_str = dir_path.to_string_lossy().to_string();
        let folder_id = format!("f_{}", stable_hash(&dir_str));
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
            mtime: None,
        });
    }

    let now_str = Utc::now().to_rfc3339();
    let total_files = discovered_files.len();

    // 调用方先持久化根目录与子目录，并上报扫描开始
    on_start(&root_folder, &sub_folders, total_files)?;

    // ---- 阶段 2：分批并行解析资产 ----
    let mut all_assets: Vec<Asset> = Vec::with_capacity(total_files);
    const CHUNK_SIZE: usize = 200;

    let mut processed = 0usize;
    for chunk in discovered_files.chunks(CHUNK_SIZE) {
        let assets_in_chunk: Vec<Asset> = chunk
            .par_iter()
            .filter_map(|fp| build_asset(fp, &path_to_id, &root_id, &now_str))
            .collect();
        processed += assets_in_chunk.len();
        // 调用方增量写库并推送进度 / 资产
        on_chunk(&assets_in_chunk, processed, total_files)?;
        all_assets.extend(assets_in_chunk);
    }

    let total_scanned = all_assets.len();
    let duration = start_time.elapsed().as_millis();

    Ok(ScanResult {
        root_folder,
        sub_folders,
        assets: all_assets,
        total_files_scanned: total_scanned,
        total_duration_ms: duration,
    })
}
