//! ============================================================================
//! 模块：元数据提取 (metadata_extractor.rs)
//! 职责：提取媒体文件的深度元数据（包括图片分辨率、真实 MIME 类型、文件 Hash 校验值等）。
//! 依赖开源库：`image`, `infer`, `sha2`, `hex`
//! ============================================================================

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct DetailedMetadata {
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sha256: Option<String>,
}

/// 解析指定文件的扩展元数据
pub fn extract_metadata(file_path: &Path) -> DetailedMetadata {
    let mut meta = DetailedMetadata::default();

    // 1. 使用 infer 库检测真实 MIME 类型
    if let Ok(Some(inferred)) = infer::get_from_path(file_path) {
        meta.mime_type = Some(inferred.mime_type().to_string());
    }

    // 2. 如果是图片，读取图片尺寸 (使用 image 库快速读取头信息，不解码全图)
    if let Ok(dimensions) = image::image_dimensions(file_path) {
        meta.width = Some(dimensions.0);
        meta.height = Some(dimensions.1);
    }

    meta
}

/// 计算指定文件的 SHA256 哈希值 (分块流式读取，内存占用极低)
pub fn compute_sha256(file_path: &Path) -> Result<String, String> {
    let mut file = File::open(file_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536]; // 64KB 缓冲区

    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    let result = hasher.finalize();
    Ok(hex::encode(result))
}
