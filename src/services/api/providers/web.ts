/**
 * ============================================================================
 * 统一 API 中间件 - Web Provider（Express HTTP API 实现）
 *
 * 在 Web 环境（本地开发 / 远程部署）中运行，
 * 通过 HTTP 请求访问 Express 后端，底层使用 PostgreSQL 数据库。
 *
 * 遵循统一 ApiProvider 接口，前端无需感知此实现差异。
 * ============================================================================
 */

import type {
  Folder, Tag, Collection, SmartFolder,
  AssetState, StorageStats,
} from '../../../types';
import type { ApiProvider, ScanResult } from '../types';
import { normalizeFolders, normalizeAssets } from '../utils';

/** Web API 统一响应结构 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Web 工作区载荷结构 */
export interface WebWorkspacePayload {
  folders: any[];
  tags: any[];
  collections: any[];
  assets: any[];
  smartFolders: any[];
}

// ============================================================================
// Web HTTP 请求工具
// ============================================================================

/**
 * 获取 API 基础 URL
 * 优先使用环境变量，否则自动检测
 */
function getApiBaseUrl(): string {
  // 检查 Vite 注入的环境变量
  if (typeof import.meta !== 'undefined') {
    const envUrl = (import.meta as any).env?.VITE_API_BASE_URL;
    if (envUrl) return envUrl;
    const appUrl = (import.meta as any).env?.VITE_APP_URL;
    if (appUrl) return appUrl;
  }
  // 远程环境使用当前页面源
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return window.location.origin;
    }
  }
  // 默认本地开发
  return 'http://localhost:3000';
}

/** 获取 Firebase 认证令牌 */
async function getAuthToken(): Promise<string | null> {
  try {
    const { auth } = await import('../../../lib/firebase');
    const user = auth.currentUser;
    if (!user) {
      console.warn('[WebApi] 用户未登录，无法获取认证令牌');
      return null;
    }
    return await user.getIdToken();
  } catch (err) {
    console.warn('[WebApi] 获取认证令牌失败:', err);
    return null;
  }
}

/**
 * 发起带认证的 HTTP 请求
 */
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  const token = await getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    // 请求超时: 远程 30s / 本地 15s
    const isRemote = !url.includes('localhost') && !url.includes('127.0.0.1');
    const response = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(isRemote ? 30000 : 15000),
    });

    if (response.status === 401) {
      console.warn('[WebApi] 认证失败（401）');
      return { success: false, error: 'Unauthorized' };
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[WebApi] HTTP ${response.status}: ${errorBody}`);
      return { success: false, error: `HTTP ${response.status}: ${errorBody}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(`[WebApi] 请求超时: ${url}`);
      return { success: false, error: 'Request timeout' };
    }
    console.error(`[WebApi] 请求失败: ${url}`, err);
    return { success: false, error: err.message || 'Network error' };
  }
}

// ============================================================================
// Web Provider 实现
// ============================================================================

class WebApiProvider implements ApiProvider {
  readonly isDesktop = false;
  readonly platform = 'web' as const;
  readonly envLabel = '[环境:Web·HTTP]';

  // ------------------------------------------------------------------------
  // 数据加载与扫描
  // ------------------------------------------------------------------------

  /** 加载完整工作区数据（Express + PostgreSQL） */
  async loadWorkspace(): Promise<Partial<AssetState>> {
    const result = await apiRequest<WebWorkspacePayload>('/api/workspace');
    if (!result.success || !result.data) {
      console.warn('[WebApi] 加载工作区失败:', result.error);
      return { folders: [], tags: [], collections: [], customSmartFolders: [], assets: [] };
    }

    const { folders, tags, collections, assets, smartFolders } = result.data;

    return {
      folders: normalizeFolders(folders || []),
      tags: tags || [],
      collections: collections || [],
      customSmartFolders: smartFolders || [],
      assets: normalizeAssets(assets || []),
    };
  }

  /** Web 模式暂不支持本地目录扫描 */
  async scanDirectory(_path: string): Promise<ScanResult | null> {
    console.warn('[WebApi] Web 模式不支持本地文件扫描');
    return null;
  }

  /** Web 模式使用 HTTP 缩略图 URL */
  async getAssetThumbnail(_assetId: string, _path: string, existingThumbnailUrl?: string): Promise<string | null> {
    // Web 模式下缩略图直接使用 asset.thumbnailUrl（HTTP URL）
    return existingThumbnailUrl || null;
  }

  /** Web 模式无本地资产校验需求 */
  async validateAssets(): Promise<void> {
    // No-op in Web mode
  }

  // ------------------------------------------------------------------------
  // 资产操作
  // ------------------------------------------------------------------------

  async setAssetRating(id: string, rating: number): Promise<void> {
    await apiRequest(`/api/assets/${id}/rating`, {
      method: 'PATCH',
      body: JSON.stringify({ rating }),
    });
  }

  async setAssetFavorite(_id: string, _favorite: boolean): Promise<void> {
    // Web schema 暂无收藏字段，保留接口兼容
  }

  async deleteAssets(ids: string[]): Promise<void> {
    await apiRequest('/api/assets/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  async syncAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    await apiRequest(`/api/assets/${assetId}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tagIds }),
    });
  }

  async syncAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    await apiRequest(`/api/assets/${assetId}/collections`, {
      method: 'PUT',
      body: JSON.stringify({ collectionIds }),
    });
  }

  async syncManyAssetTags(assetIds: string[], tagIds: string[]): Promise<void> {
    await apiRequest('/api/assets/batch-tags', {
      method: 'POST',
      body: JSON.stringify({ assetIds, tagIds }),
    });
  }

  async syncManyAssetCollections(assetIds: string[], collectionIds: string[]): Promise<void> {
    await apiRequest('/api/assets/batch-collections', {
      method: 'POST',
      body: JSON.stringify({ assetIds, collectionIds }),
    });
  }

  async removeAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    await apiRequest(`/api/assets/${assetId}/tags`, {
      method: 'DELETE',
      body: JSON.stringify({ tagIds }),
    });
  }

  async removeAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    await apiRequest(`/api/assets/${assetId}/collections`, {
      method: 'DELETE',
      body: JSON.stringify({ collectionIds }),
    });
  }

  // ------------------------------------------------------------------------
  // 文件夹 CRUD
  // ------------------------------------------------------------------------

  async createFolder(folder: Folder): Promise<void> {
    await apiRequest<Folder>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({
        name: folder.name,
        parentId: folder.parentId,
        path: folder.path,
      }),
    });
  }

  async updateFolder(folder: Folder): Promise<void> {
    await apiRequest<Folder>(`/api/folders/${folder.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: folder.name,
        parentId: folder.parentId,
        path: folder.path,
        isMonitored: folder.isMonitored,
      }),
    });
  }

  async deleteFolder(id: string): Promise<void> {
    await apiRequest(`/api/folders/${id}`, { method: 'DELETE' });
  }

  // ------------------------------------------------------------------------
  // 标签 CRUD
  // ------------------------------------------------------------------------

  async createTag(tag: Tag): Promise<void> {
    await apiRequest<Tag>('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ name: tag.name, color: tag.color }),
    });
  }

  async updateTag(tag: Tag): Promise<void> {
    await apiRequest<Tag>(`/api/tags/${tag.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: tag.name,
        color: tag.color,
        description: tag.description,
        isPinned: tag.isPinned,
      }),
    });
  }

  async deleteTag(id: string): Promise<void> {
    await apiRequest(`/api/tags/${id}`, { method: 'DELETE' });
  }

  // ------------------------------------------------------------------------
  // 集合 CRUD
  // ------------------------------------------------------------------------

  async createCollection(col: Collection): Promise<void> {
    await apiRequest<Collection>('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ name: col.name }),
    });
  }

  async updateCollection(col: Collection): Promise<void> {
    await apiRequest<Collection>(`/api/collections/${col.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: col.name }),
    });
  }

  async deleteCollection(id: string): Promise<void> {
    await apiRequest(`/api/collections/${id}`, { method: 'DELETE' });
  }

  // ------------------------------------------------------------------------
  // 智能文件夹 CRUD
  // ------------------------------------------------------------------------

  async saveSmartFolder(sf: SmartFolder): Promise<void> {
    await apiRequest<SmartFolder>('/api/smart-folders', {
      method: 'POST',
      body: JSON.stringify({
        id: sf.id,
        name: sf.name,
        matchAll: sf.matchAll,
        rulesJson: JSON.stringify(sf.rules || []),
      }),
    });
  }

  async deleteSmartFolder(id: string): Promise<void> {
    await apiRequest(`/api/smart-folders/${id}`, { method: 'DELETE' });
  }

  // ------------------------------------------------------------------------
  // 系统操作
  // ------------------------------------------------------------------------

  /** Web 模式不支持打开资源管理器 */
  async openInExplorer(_path: string): Promise<void> {
    // No-op in Web mode
  }

  /** Web 模式不支持原生文件夹选取 */
  async pickDirectory(): Promise<string | null> {
    return null;
  }

  /** 获取存储统计 */
  async getStorageStats(): Promise<StorageStats> {
    const result = await apiRequest<StorageStats>('/api/storage/stats');
    if (result.success && result.data) {
      return result.data;
    }
    return { data_dir: '', db_size_bytes: 0, thumbnails_size_bytes: 0, total_size_bytes: 0, asset_count: 0 };
  }

  /** Web 模式模拟迁移 */
  async migrateDataStorage(newPath: string): Promise<string> {
    console.warn('[WebApi] Web 模式模拟数据迁移');
    await new Promise(r => setTimeout(r, 1200));
    return `[模拟成功] 数据已迁移至 ${newPath}，应用将重启。`;
  }

  /** 重启应用（Web 模式刷新页面） */
  async restartApplication(): Promise<void> {
    window.location.reload();
  }
}

/** Web Provider 单例 */
export const webProvider = new WebApiProvider();
