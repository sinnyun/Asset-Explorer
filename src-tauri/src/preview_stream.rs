use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const MAX_ASSET_RANGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRange {
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub total_size: u64,
    pub eof: bool,
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("无法访问路径 {}: {error}", path.display()))
}

fn is_authorized(target: &Path, roots: &[PathBuf]) -> Result<bool, String> {
    let target = canonical(target)?;
    for root in roots {
        let root = canonical(root)?;
        if target.starts_with(root) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn read_asset_range(
    path: &Path,
    roots: &[PathBuf],
    offset: u64,
    length: usize,
) -> Result<AssetRange, String> {
    if length == 0 || length > MAX_ASSET_RANGE_BYTES {
        return Err(format!("读取长度必须在 1 到 {} 字节之间", MAX_ASSET_RANGE_BYTES));
    }
    offset
        .checked_add(length as u64)
        .ok_or_else(|| "读取区间溢出".to_string())?;
    if !is_authorized(path, roots)? {
        return Err("拒绝读取未注册监控目录之外的文件".to_string());
    }

    let mut file = File::open(path).map_err(|error| format!("打开文件失败: {error}"))?;
    let metadata = file.metadata().map_err(|error| format!("读取文件属性失败: {error}"))?;
    if !metadata.is_file() {
        return Err("目标路径不是文件".to_string());
    }
    let total_size = metadata.len();
    if offset >= total_size {
        return Ok(AssetRange { bytes: Vec::new(), offset, total_size, eof: true });
    }

    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("定位文件失败: {error}"))?;
    let available = total_size.saturating_sub(offset).min(length as u64) as usize;
    let mut bytes = vec![0; available];
    file.read_exact(&mut bytes).map_err(|error| format!("读取文件区间失败: {error}"))?;
    Ok(AssetRange {
        bytes,
        offset,
        total_size,
        eof: offset.saturating_add(available as u64) >= total_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("asset-hub-range-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn range_reads_are_bounded_and_root_authorized() {
        let root = test_dir("authorized");
        let path = root.join("sample.bin");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"0123456789").unwrap();

        let range = read_asset_range(&path, std::slice::from_ref(&root), 3, 4).unwrap();
        assert_eq!(range.bytes, b"3456");
        assert!(!range.eof);
        assert!(read_asset_range(&path, &[root.join("elsewhere")], 0, 1).is_err());
        assert!(read_asset_range(&path, std::slice::from_ref(&root), 0, MAX_ASSET_RANGE_BYTES + 1).is_err());
        assert!(read_asset_range(&root, std::slice::from_ref(&root), 0, 1).is_err());
    }

    #[test]
    fn large_file_reads_only_the_requested_window() {
        let root = test_dir("large");
        let path = root.join("large.bin");
        let mut file = File::create(&path).unwrap();
        let total_size = 8 * 1024 * 1024;
        file.set_len(total_size).unwrap();
        file.seek(SeekFrom::Start(total_size - 3)).unwrap();
        file.write_all(b"end").unwrap();

        let range = read_asset_range(&path, &[root], total_size - 3, 3).unwrap();
        assert_eq!(range.bytes, b"end");
        assert!(range.eof);
    }
}
