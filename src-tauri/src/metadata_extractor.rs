//! ============================================================================
//! 模块：元数据提取 (metadata_extractor.rs)
//! 职责：提取媒体文件的轻量元数据（真实 MIME 类型、图片分辨率）。
//!       全部为"文件头级"读取（各几百字节），等同于系统资源管理器的详细属性，
//!       不做任何原始文件内容的全量读取（无哈希计算，查看器定位）。
//! 依赖开源库：`image`, `infer`
//! ============================================================================

use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct DetailedMetadata {
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 解析指定文件的扩展元数据（仅读文件头，不解码全图、不读文件内容）
pub fn extract_metadata(file_path: &Path) -> DetailedMetadata {
    let mut meta = DetailedMetadata::default();

    // 1. 使用 infer 库检测真实 MIME 类型（读文件头数十字节）
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
