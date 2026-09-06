//! ============================================================================
//! 模块：缩略图生成与系统缓存提取器 (thumbnail_cache.rs)
//! 职责：
//! 1. 优先使用 Windows 自带的缩略图缓存 (Windows Shell Thumbnail Cache, SIIGBF_INCACHEONLY)
//! 2. 若系统缓存不存在，自动调用 Windows Shell 提取器 (IShellItemImageFactory) 提取生成
//! 3. 跨平台/格式兜底：调用 Rust `image` 开源库解码缩放
//! 4. 自动持久化在本地缓存目录，避免重复调用
//! ============================================================================

use std::fs;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};

/// 获取全局缩略图本地缓存目录 (默认 Windows 对应 %LOCALAPPDATA%\AssetHub\thumbnails)
pub fn get_cache_dir() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("./.data"));
    dir.push("AssetHub");
    dir.push("thumbnails");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 计算缓存唯一文件路径 (根据文件源路径哈希与目标尺寸)
pub fn get_cache_file_path(source_path: &Path, max_dimension: u32) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(source_path.to_string_lossy().as_bytes());
    let hash_hex = hex::encode(hasher.finalize());
    let filename = format!("{}_{}px.png", &hash_hex[..16], max_dimension);
    get_cache_dir().join(filename)
}

/// 核心接口：获取或提取缩略图
pub fn generate_or_get_thumbnail(source_path: &Path, max_dimension: u32) -> Result<PathBuf, String> {
    if !source_path.exists() {
        return Err(format!("源文件不存在: {:?}", source_path));
    }

    let target_cache_path = get_cache_file_path(source_path, max_dimension);
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
    let img = image::open(source_path).map_err(|e| format!("Rust image 解码失败: {}", e))?;
    let thumbnail = img.thumbnail(max_dimension, max_dimension);
    thumbnail
        .save(target_cache_path)
        .map_err(|e| format!("保存缩略图至磁盘失败: {}", e))?;
    Ok(target_cache_path.to_path_buf())
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    // 注意：windows-sys 0.52 中 HBITMAP 定义在 Graphics::Gdi 模块（0.59+ 才移至 Foundation）
    use windows_sys::Win32::Foundation::{HWND, S_OK};
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDIBits, GetObjectW, HBITMAP, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows_sys::core::GUID;

    // IShellItemImageFactory GUID: bcc18b79-ba16-442f-80c4-8a59c30c463b
    const IID_ISHELLITEMIMAGEFACTORY: GUID = GUID {
        data1: 0xbcc18b79,
        data2: 0xba16,
        data3: 0x442f,
        data4: [0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b],
    };

    // Windows Shell 缩略图提取标志
    const SIIGBF_RESIZETOFIT: i32 = 0x00000000;
    const SIIGBF_BIGGERSIZEOK: i32 = 0x00000001;
    const SIIGBF_INCACHEONLY: i32 = 0x00000020; // 仅从 Windows 现存缓存中读取，若无则快速失败

    #[repr(C)]
    struct SIZE {
        cx: i32,
        cy: i32,
    }

    #[repr(C)]
    struct IShellItemImageFactoryVtbl {
        pub QueryInterface: unsafe extern "system" fn(this: *mut std::ffi::c_void, riid: *const GUID, ppv: *mut *mut std::ffi::c_void) -> i32,
        pub AddRef: unsafe extern "system" fn(this: *mut std::ffi::c_void) -> u32,
        pub Release: unsafe extern "system" fn(this: *mut std::ffi::c_void) -> u32,
        pub GetImage: unsafe extern "system" fn(this: *mut std::ffi::c_void, size: SIZE, flags: i32, phbm: *mut HBITMAP) -> i32,
    }

    #[repr(C)]
    struct IShellItemImageFactory {
        pub lpVtbl: *const IShellItemImageFactoryVtbl,
    }

    extern "system" {
        fn SHCreateItemFromParsingName(
            pszPath: *const u16,
            pbc: *mut std::ffi::c_void,
            riid: *const GUID,
            ppv: *mut *mut std::ffi::c_void,
        ) -> i32;
    }

    /// 从 Windows Shell 提取缩略图 (优先读 Windows 缓存，未命中则触发 Windows 生成)
    pub fn extract_windows_shell_thumbnail(
        source_path: &Path,
        max_dimension: u32,
        target_cache_path: &Path,
    ) -> Result<PathBuf, String> {
        let wide_path: Vec<u16> = OsStr::new(source_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            // 初始化 COM 库
            let _ = CoInitializeEx(std::ptr::null_mut(), COINIT_MULTITHREADED as u32);

            let mut factory_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hr = SHCreateItemFromParsingName(
                wide_path.as_ptr(),
                std::ptr::null_mut(),
                &IID_ISHELLITEMIMAGEFACTORY,
                &mut factory_ptr,
            );

            if hr != S_OK || factory_ptr.is_null() {
                CoUninitialize();
                return Err(format!("SHCreateItemFromParsingName 失败 (HRESULT: 0x{:08X})", hr));
            }

            let factory = factory_ptr as *mut IShellItemImageFactory;
            let size = SIZE {
                cx: max_dimension as i32,
                cy: max_dimension as i32,
            };

            let mut hbitmap: HBITMAP = 0;

            // 1. 【优先策略】尝试从 Windows 自带缓存中直接提取 (SIIGBF_INCACHEONLY)
            let mut hr_get = ((*(*factory).lpVtbl).GetImage)(
                factory_ptr,
                SIZE { cx: size.cx, cy: size.cy },
                SIIGBF_INCACHEONLY,
                &mut hbitmap,
            );

            // 2. 【次选策略】如果 Windows 自带缓存未命中，调用 Windows Shell 实时提取 (SIIGBF_BIGGERSIZEOK)
            if hr_get != S_OK || hbitmap == 0 {
                hr_get = ((*(*factory).lpVtbl).GetImage)(
                    factory_ptr,
                    SIZE { cx: size.cx, cy: size.cy },
                    SIIGBF_BIGGERSIZEOK | SIIGBF_RESIZETOFIT,
                    &mut hbitmap,
                );
            }

            // 释放 ShellItem
            ((*(*factory).lpVtbl).Release)(factory_ptr);
            CoUninitialize();

            if hr_get != S_OK || hbitmap == 0 {
                return Err(format!("Windows Shell GetImage 提取失败 (0x{:08X})", hr_get));
            }

            // 将 HBITMAP 转换并保存为 PNG 缓存
            let save_res = convert_hbitmap_to_png(hbitmap, target_cache_path);
            DeleteObject(hbitmap);

            save_res.map(|_| target_cache_path.to_path_buf())
        }
    }

    /// 将 Windows GDI HBITMAP 位图转换为 PNG 图片文件
    unsafe fn convert_hbitmap_to_png(hbm: HBITMAP, out_path: &Path) -> Result<(), String> {
        let mut bm: BITMAP = std::mem::zeroed();
        let get_bm_res = GetObjectW(
            hbm,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bm as *mut _ as *mut std::ffi::c_void,
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
        bi.bmiHeader.biCompression = BI_RGB as u32;

        let mut buffer: Vec<u8> = vec![0u8; (width * height * 4) as usize];
        let hdc = windows_sys::Win32::Graphics::Gdi::GetDC(0 as HWND);

        let lines = GetDIBits(
            hdc,
            hbm,
            0,
            height,
            buffer.as_mut_ptr() as *mut _,
            &mut bi,
            DIB_RGB_COLORS,
        );
        windows_sys::Win32::Graphics::Gdi::ReleaseDC(0 as HWND, hdc);

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
