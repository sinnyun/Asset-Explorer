import type { Asset } from '../../types';
import { apiClient, isTauriDesktop } from '../../services/api';

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Resolve a preview without copying the source file into JavaScript memory.
 * Desktop files are exposed through Tauri's streaming asset protocol, so a
 * multi-gigabyte file remains an URL rather than becoming a Base64 string.
 */
export async function resolveAssetPreviewSource(asset: Asset): Promise<string | null> {
  if (!asset?.path) return null;
  if (isTauriDesktop()) {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      return convertFileSrc(asset.path);
    } catch (error) {
      console.warn('[AssetPreview] 无法创建流式预览地址:', error);
      return null;
    }
  }
  if (isHttpUrl(asset.path)) return asset.path;
  if (asset.thumbnailUrl && isHttpUrl(asset.thumbnailUrl)) return asset.thumbnailUrl;
  if (asset.type === 'image') {
    return apiClient.getAssetThumbnail(asset.id, asset.path, asset.thumbnailUrl);
  }
  return null;
}
