/**
 * ============================================================================
 * 工具：将 Asset 解析为 open-file-viewer 可加载的预览源
 *
 * open-file-viewer 的 FileViewer 接受 File | Blob | string | ArrayBuffer 作为
 * 文件源。其中 string 会被当作一个 URL，由内部 fetch 加载后交给对应插件渲染。
 *
 * 【修复背景】在桌面 Tauri 环境中直接使用 convertFileSrc() 生成的 asset:// URL
 * 传给 open-file-viewer 时，其内部某些插件（图片/文本/Office/PDF）会通过
 * fetch() 加载该 URL，而 asset:// 协议响应不携带 Access-Control-Allow-Origin
 * 头，导致跨域请求被浏览器拦截（CORS 错误）。
 *
 * 【修复方案】桌面环境下，对需要 fetch 文件内容的资产类型，改经 Rust IPC
 * 读取文件为 base64 data URL 返回（data: URL 可被 fetch 安全加载）。
 * 视频/音频等超大媒体文件仍使用 asset:// URL（HTML5 <video>/<audio> 标签
 * 可跨源加载，不触发 CORS），且无需将整个文件读入内存。
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
 * 判断某类资产是否需要 open-file-viewer 内部 fetch 文件内容。
 * - 视频/音频：open-file-viewer 的 video/audio 插件使用 HTML5 标签直接加载
 *   file.url（无需 fetch），因此可以安全使用 asset:// URL。
 * - 图片/文本/文档/Office/PDF/3D 模型等：open-file-viewer 插件内部需要
 *   fetch 读取文件字节数据来解析/渲染，因此在桌面环境必须走 data URL 方案。
 */
function needsFileContentFetch(type: string): boolean {
  return type !== 'video' && type !== 'audio';
}

/**
 * 通过 Rust IPC 读取本地文件为 base64 data URL。
 * 文件过大（>200MB）或读取失败时返回 null。
 */
async function readLocalFileAsDataUrl(path: string): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dataUrl = await invoke<string>('read_file_base64', { filePath: path });
    return dataUrl || null;
  } catch (e) {
    console.warn('[AssetPreview] read_file_base64 失败，回退处理:', e);
    return null;
  }
}

/**
 * 将 Asset 解析为可加载的预览源 URL。
 * 返回 null 表示当前无法解析（例如文件类型不支持或读取失败）。
 */
export async function resolveAssetPreviewSource(asset: Asset): Promise<string | null> {
  if (!asset) return null;

  // ============================================================
  // 1. 桌面 Tauri 环境
  // ============================================================
  if (isDesktopEnv()) {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      if (!asset.path) return null;

      // 1a. 视频/音频等超大媒体文件：使用 asset:// URL（HTML5 标签加载，无 CORS 问题）
      if (!needsFileContentFetch(asset.type)) {
        return convertFileSrc(asset.path);
      }

      // 1b. 其他需要 fetch 内容的类型：优先用 Rust IPC 读取为 base64 data URL
      //     规避 asset:// URL 的 CORS 限制（fetch data: URL 不触发跨域检查）
      const dataUrl = await readLocalFileAsDataUrl(asset.path);
      if (dataUrl) return dataUrl;

      // 1c. 读取失败（如文件过大）：
      //      - 图片可降级为缩略图 data URL（尺寸较小，规避大文件读取限制）
      //      - 其他类型回退到 asset:// URL（尽力而为，虽可能 CORS 受限）
      if (asset.type === 'image') {
        try {
          const thumbUrl = await apiClient.getAssetThumbnail(asset.id, asset.path, asset.thumbnailUrl);
          if (thumbUrl) return thumbUrl;
        } catch (e) {
          console.warn('[AssetPreview] 大文件图片降级缩略图失败:', e);
        }
      }
      return convertFileSrc(asset.path);
    } catch (e) {
      console.warn('[AssetPreview] convertFileSrc 失败，降级处理:', e);
    }
  }

  // ============================================================
  // 2. Web 环境：asset.path 为 http(s) 远程 URL 时直接使用
  // ============================================================
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
