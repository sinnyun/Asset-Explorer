/**
 * ============================================================================
 * 工具：将 Asset 解析为 open-file-viewer 可加载的预览源 (URL)
 *
 * open-file-viewer 的 FileViewer 接受 File | Blob | string | ArrayBuffer 作为
 * 文件源。其中 string 会被当作一个 URL，由内部 fetch 加载后交给对应插件渲染。
 *
 * 由于本项目无法直接使用 file:// 路径，需依据运行环境将 asset 转成可 fetch 的 URL：
 *   - 桌面 Tauri 环境：使用 convertFileSrc() 生成 asset:// 协议 URL
 *     （tauri.conf.json 已配置 assetProtocol.scope.allow: ["**"]，可访问任意本地文件）
 *   - Web 环境：优先使用 asset.path（若为 http(s) 远程 URL）；
 *     否则回退到缩略图 URL / 动态生成 base64 data URL
 * ============================================================================
 */
import type { Asset } from '../../types';
import { apiClient } from '../../services/api';

/** 是否为 Tauri 桌面环境（与 ThumbnailImage 中的判断保持一致） */
function isDesktopEnv(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof (window as any).__TAURI__ !== 'undefined' ||
    typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' ||
    typeof (window as any).__TAURI_IPC__ !== 'undefined'
  );
}

/** 判断字符串是否为 http(s) 远程 URL */
function isHttpUrl(str: string): boolean {
  return /^https?:\/\//i.test(str);
}

/**
 * 将 Asset 解析为可 fetch/加载的预览源 URL。
 * 返回 null 表示当前无法解析（例如 Web 模式下文件既非远程 URL 也非图片）。
 */
export async function resolveAssetPreviewSource(asset: Asset): Promise<string | null> {
  if (!asset) return null;

  // 1. 桌面 Tauri 环境：convertFileSrc 生成 asset:// URL（可访问本地任意文件）
  if (isDesktopEnv()) {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      if (asset.path) return convertFileSrc(asset.path);
    } catch (e) {
      console.warn('[AssetPreview] convertFileSrc 失败，降级处理:', e);
    }
  }

  // 2. Web 环境：asset.path 为 http(s) 远程 URL 时直接使用
  if (isHttpUrl(asset.path)) {
    return asset.path;
  }

  // 3. asset.thumbnailUrl 为 http(s) URL（Web 上传资产 / 演示数据）
  if (asset.thumbnailUrl && isHttpUrl(asset.thumbnailUrl)) {
    return asset.thumbnailUrl;
  }

  // 4. 图片：通过统一 API 生成 base64 data URL（data: URL 也可被 fetch 加载）
  if (asset.type === 'image') {
    try {
      const url = await apiClient.getAssetThumbnail(asset.id, asset.path, asset.thumbnailUrl);
      if (url) return url;
    } catch (e) {
      console.warn('[AssetPreview] 生成图片 data URL 失败:', e);
    }
  }

  // 5. 无法解析
  return null;
}
