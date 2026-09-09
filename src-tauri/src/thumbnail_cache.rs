//! ============================================================================
//! 模块：缩略图生成与系统缓存提取器 (thumbnail_cache.rs)
//! 职责：
//! 1. 优先使用 Windows 自带的缩略图缓存 (Windows Shell Thumbnail Cache, SIIGBF_INCACHEONLY)
//! 2. 若系统缓存不存在，自动调用 Windows Shell 提取器 (IShellItemImageFactory) 提取生成
//! 3. 跨平台/格式兜底：调用 Rust `image` 开源库解码缩放
//! 4. 自动持久化在本地缓存目录，避免重复调用
//!
//! Windows COM 安全改造：
//! 旧版使用 windows-sys 裸 FFI + 手写 COM vtable（IShellItemImageFactoryVtbl），
//! 手动 dispatch QueryInterface/AddRef/Release，包含大量手写 unsafe。
//! 新版改用 `windows` crate 官方高层绑定，由 crate 自动生成并管理
//! COM 接口的 vtable 调用与引用计数，代码更安全、可维护。
//! ============================================================================

use std::fs;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};

/// 获取缩略图本地缓存目录 (路径为 {data_dir}/thumbnails/)
pub fn get_cache_dir(data_dir: &Path) -> PathBuf {
    let dir = data_dir.join("thumbnails");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 计算缓存唯一文件路径 (根据文件源路径哈希与目标尺寸)
pub fn get_cache_file_path(source_path: &Path, max_dimension: u32, data_dir: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source_path)
        .map_err(|error| format!("读取缩略图源文件属性失败: {error}"))?;
    let modified_ns = metadata.modified().ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(source_path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_ns.to_le_bytes());
    let hash_hex = hex::encode(hasher.finalize());
    let filename = format!("{}_{}px.png", &hash_hex[..16], max_dimension.clamp(32, 1024));
    Ok(get_cache_dir(data_dir).join(filename))
}

/// 核心接口：获取或提取缩略图
/// data_dir: 数据库所在的数据根目录，缩略图保存在 {data_dir}/thumbnails/ 下
pub fn generate_or_get_thumbnail(source_path: &Path, max_dimension: u32, data_dir: &Path) -> Result<PathBuf, String> {
    if !source_path.exists() {
        return Err(format!("源文件不存在: {:?}", source_path));
    }

    let max_dimension = max_dimension.clamp(32, 1024);
    let target_cache_path = get_cache_file_path(source_path, max_dimension, data_dir)?;
    if target_cache_path.exists() {
        return Ok(target_cache_path);
    }

    // 步骤 1 & 2: 在 Windows 平台下，优先调用 Windows 自带的缩略图缓存与 Shell 提取器
    #[cfg(target_os = "windows")]
    {
        match extract_windows_shell_thumbnail(source_path, max_dimension, &target_cache_path) {
            Ok(path) => return Ok(path),
            Err(e) => {
                // 如果 Windows Shell 提取未命中，则继续走 Rust 开源库兜底
                eprintln!("[Thumbnail] Windows Shell 提取提示: {}, 切换至 Rust image 库兜底", e);
            }
        }
    }

    // 步骤 3: Rust 开源库 (image crate) 解码缩放兜底
    extract_via_image_crate(source_path, max_dimension, &target_cache_path)
}

/// 使用 Rust image 开源库解码并缩放保存
fn extract_via_image_crate(source_path: &Path, max_dimension: u32, target_cache_path: &Path) -> Result<PathBuf, String> {
    let reader = image::ImageReader::open(source_path)
        .map_err(|e| format!("打开图片失败: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("识别图片格式失败: {e}"))?;
    let (width, height) = reader.into_dimensions()
        .map_err(|e| format!("读取图片尺寸失败: {e}"))?;
    validate_image_dimensions(width, height)?;
    let img = image::ImageReader::open(source_path)
        .map_err(|e| format!("打开图片失败: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("识别图片格式失败: {e}"))?
        .decode()
        .map_err(|e| format!("Rust image 解码失败: {e}"))?;
    let thumbnail = img.thumbnail(max_dimension, max_dimension);
    thumbnail
        .save(target_cache_path)
        .map_err(|e| format!("保存缩略图至磁盘失败: {}", e))?;
    Ok(target_cache_path.to_path_buf())
}

pub fn validate_image_dimensions(width: u32, height: u32) -> Result<(), String> {
    const MAX_PIXELS: u64 = 100_000_000;
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0 || height == 0 || pixels > MAX_PIXELS {
        return Err(format!("图片声明尺寸不安全: {width}x{height}"));
    }
    Ok(())
}

// ============================================================================
// Windows 平台 — windows crate 官方高层绑定（消除手写 COM vtable）
// ============================================================================
#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, HBITMAP, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SIIGBF_BIGGERSIZEOK, SIIGBF_INCACHEONLY, SIIGBF_RESIZETOFIT,
        SHCreateItemFromParsingName,
    };

    /// 从 Windows Shell 提取缩略图 (优先读 Windows 缓存，未命中则触发 Windows 生成)
    /// 使用 windows crate 的 IShellItemImageFactory COM 接口官方绑定，
    /// 不再需要手写 vtable 和手动调用 AddRef/Release。
    pub fn extract_windows_shell_thumbnail(
        source_path: &Path,
        max_dimension: u32,
        target_cache_path: &Path,
    ) -> Result<PathBuf, String> {
        unsafe {
            // 初始化 COM 库
            let _ = CoInitializeEx(Some(std::ptr::null()), COINIT_MULTITHREADED);

            // 将 Rust Path 转换为 Windows wide string
            let wide_path: Vec<u16> = source_path
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let path_str = PCWSTR(wide_path.as_ptr());

            // 创建 IShellItemImageFactory COM 对象
            // windows crate 通过 SHCreateItemFromParsingName 函数自动实例化
            let factory: Result<IShellItemImageFactory, windows::core::Error> =
                SHCreateItemFromParsingName(path_str, None);

            if let Err(e) = factory {
                CoUninitialize();
                return Err(format!("SHCreateItemFromParsingName 失败: {}", e));
            }

            let factory = factory.unwrap();

            let size = SIZE {
                cx: max_dimension as i32,
                cy: max_dimension as i32,
            };

            // 1.【优先策略】尝试从 Windows 自带缓存中直接提取
            let mut result = factory.GetImage(size, SIIGBF_INCACHEONLY);

            // 2.【次选策略】缓存未命中时，调用 Windows Shell 实时提取
            if result.is_err() {
                result = factory.GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK);
            }

            // windows crate 的 IShellItemImageFactory 在 Drop 时自动 Release
            CoUninitialize();

            let hbitmap = match result {
                Ok(h) if !h.is_invalid() => h,
                Ok(_) => return Err("Windows Shell 返回空位图".to_string()),
                Err(e) => return Err(format!("Windows Shell GetImage 提取失败: {}", e)),
            };

            // 将 HBITMAP 转换为 PNG 并保存
            let save_res = convert_hbitmap_to_png(hbitmap, target_cache_path);
            let _ = DeleteObject(hbitmap.into());

            save_res.map(|_| target_cache_path.to_path_buf())
        }
    }

    /// 将 Windows GDI HBITMAP 位图转换为 PNG 图片文件
    unsafe fn convert_hbitmap_to_png(hbm: HBITMAP, out_path: &Path) -> Result<(), String> {
        let mut bm: BITMAP = std::mem::zeroed();
        let get_bm_res = GetObjectW(
            hbm.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut std::ffi::c_void),
        );

        if get_bm_res == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
            return Err("获取 Windows 位图尺寸失败".to_string());
        }

        let width = bm.bmWidth as u32;
        let height = bm.bmHeight.unsigned_abs() as u32;

        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = bm.bmWidth;
        bi.bmiHeader.biHeight = -((height as i32)); // 负数表示从上往下的 DIB
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;

        let mut buffer: Vec<u8> = vec![0u8; (width * height * 4) as usize];
        let hdc = GetDC(None);

        let lines = GetDIBits(
            hdc,
            hbm,
            0,
            height,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
        let _ = ReleaseDC(None, hdc);

        if lines == 0 {
            return Err("GetDIBits 拷贝位图内存失败".to_string());
        }

        // BGRA -> RGBA 转换
        for chunk in buffer.chunks_exact_mut(4) {
            let b = chunk[0];
            let r = chunk[2];
            chunk[0] = r;
            chunk[2] = b;
            // 处理 Alpha 通道：如果全是 0，赋予不透明 255
            if chunk[3] == 0 {
                chunk[3] = 255;
            }
        }

        let img_buf = image::RgbaImage::from_raw(width, height, buffer)
            .ok_or_else(|| "构建 RgbaImage 缓冲区失败".to_string())?;

        img_buf
            .save(out_path)
            .map_err(|e| format!("保存 Windows 提取缩略图失败: {}", e))?;

        Ok(())
    }
}

#[cfg(target_os = "windows")]
use windows_impl::extract_windows_shell_thumbnail;
