// [已废弃] 已被 src/services/api/providers/web.ts 替代，保留仅为兼容旧引用。
/**
 * ============================================================================
 * 模块：Web API 客户端 (webApiClient.ts)
 * 职责：
 * 1. 在 Web 模式下，封装前端对 Express API 的所有 HTTP 调用。
 * 2. 自动获取 Firebase 认证令牌并附加到请求头中。
 * 3. 统一处理请求错误、超时和重试逻辑。
 * 4. 提供与 desktopBridge.ts 一致的接口签名，便于 DataService 统一调用。
 * ============================================================================
 */

import { getEnvironment, getApiBaseUrl } from './environment';
import type { Asset, Folder, Tag, Collection, SmartFolder } from '../types';

/**
 * Web API 操作结果接口
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * 工作区数据载荷（与 desktopBridge.ts 中的 RustWorkspacePayload 保持一致）
 */
export interface WebWorkspacePayload {
  folders: Folder[];
  tags: Tag[];
  collections: Collection[];
  assets: Asset[];
  smartFolders: SmartFolder[];
}

/**
 * 存储统计信息
 */
export interface WebStorageStats {
  data_dir: string;
  db_size_bytes: number;
  thumbnails_size_bytes: number;
  total_size_bytes: number;
  asset_count: number;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取 Firebase 当前用户的认证令牌
 * 如果未登录，返回 null
 */
async function getAuthToken(): Promise<string | null> {
  try {
    const { auth } = await import('../lib/firebase');
    const user = auth.currentUser;
    if (!user) {
      console.warn('[WebApiClient] 用户未登录，无法获取认证令牌');
      return null;
    }
    return await user.getIdToken();
  } catch (err) {
    console.warn('[WebApiClient] 获取认证令牌失败:', err);
    return null;
  }
}

/**
 * 发起带认证的 API 请求
 * @param endpoint API 路径（如 /api/workspace）
 * @param options 请求选项（method, body 等）
 * @returns 解析后的响应数据
 */
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  // 获取认证令牌
  const token = await getAuthToken();

  // 构建请求头
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      // 远程环境超时 30 秒，本地环境超时 15 秒
      signal: AbortSignal.timeout(
        getEnvironment().isRemoteWeb ? 30000 : 15000
      ),
    });

    // 处理 401 未授权错误
    if (response.status === 401) {
      console.warn('[WebApiClient] 认证失败（401），尝试刷新令牌...');
      return { success: false, error: 'Unauthorized' };
    }

    // 处理其他 HTTP 错误
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[WebApiClient] HTTP ${response.status}: ${errorBody}`);
      return { success: false, error: `HTTP ${response.status}: ${errorBody}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(`[WebApiClient] 请求超时: ${url}`);
      return { success: false, error: 'Request timeout' };
    }
    console.error(`[WebApiClient] 请求失败: ${url}`, err);
    return { success: false, error: err.message || 'Network error' };
  }
}

// ============================================================================
// 公开 API 方法
// ============================================================================

/**
 * 检查 API 服务器是否可达
 */
export async function checkHealth(): Promise<boolean> {
  const result = await apiRequest<{ status: string }>('/api/health');
  return result.success && result.data?.status === 'ok';
}

/**
 * 获取环境配置信息
 */
export async function getEnvironmentInfo(): Promise<ApiResponse<{
  appEnv: string;
  appUrl: string;
  hasGeminiKey: boolean;
  serverTime: string;
}>> {
  return await apiRequest('/api/environment');
}

/**
 * 加载完整工作区数据
 */
export async function loadWorkspace(): Promise<ApiResponse<WebWorkspacePayload>> {
  return await apiRequest<WebWorkspacePayload>('/api/workspace');
}

// ==========================================================================
// 文件夹 API
// ==========================================================================

/**
 * 获取所有文件夹
 */
export async function getFolders(): Promise<ApiResponse<Folder[]>> {
  return await apiRequest<Folder[]>('/api/folders');
}

/**
 * 创建文件夹
 */
export async function createFolder(folder: {
  name: string;
  parentId?: string;
  path?: string;
}): Promise<ApiResponse<Folder>> {
  return await apiRequest<Folder>('/api/folders', {
    method: 'POST',
    body: JSON.stringify(folder),
  });
}

/**
 * 更新文件夹
 */
export async function updateFolder(
  id: string,
  updates: Partial<Folder>
): Promise<ApiResponse<Folder>> {
  return await apiRequest<Folder>(`/api/folders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/**
 * 删除文件夹
 */
export async function deleteFolder(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return await apiRequest(`/api/folders/${id}`, { method: 'DELETE' });
}

// ==========================================================================
// 标签 API
// ==========================================================================

/**
 * 获取所有标签
 */
export async function getTags(): Promise<ApiResponse<Tag[]>> {
  return await apiRequest<Tag[]>('/api/tags');
}

/**
 * 创建标签
 */
export async function createTag(tag: { name: string; color?: string }): Promise<ApiResponse<Tag>> {
  return await apiRequest<Tag>('/api/tags', {
    method: 'POST',
    body: JSON.stringify(tag),
  });
}

/**
 * 更新标签
 */
export async function updateTag(
  id: string,
  updates: Partial<Tag>
): Promise<ApiResponse<Tag>> {
  return await apiRequest<Tag>(`/api/tags/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/**
 * 删除标签
 */
export async function deleteTag(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return await apiRequest(`/api/tags/${id}`, { method: 'DELETE' });
}

// ==========================================================================
// 集合 API
// ==========================================================================

/**
 * 获取所有集合
 */
export async function getCollections(): Promise<ApiResponse<Collection[]>> {
  return await apiRequest<Collection[]>('/api/collections');
}

/**
 * 创建集合
 */
export async function createCollection(col: { name: string }): Promise<ApiResponse<Collection>> {
  return await apiRequest<Collection>('/api/collections', {
    method: 'POST',
    body: JSON.stringify(col),
  });
}

/**
 * 更新集合
 */
export async function updateCollection(
  id: string,
  updates: { name: string }
): Promise<ApiResponse<Collection>> {
  return await apiRequest<Collection>(`/api/collections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/**
 * 删除集合
 */
export async function deleteCollection(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return await apiRequest(`/api/collections/${id}`, { method: 'DELETE' });
}

// ==========================================================================
// 资产 API
// ==========================================================================

/**
 * 获取所有资产
 */
export async function getAssets(): Promise<ApiResponse<Asset[]>> {
  return await apiRequest<Asset[]>('/api/assets');
}

/**
 * 更新资产评分
 */
export async function updateAssetRating(
  id: string,
  rating: number
): Promise<ApiResponse<{ success: boolean }>> {
  return await apiRequest(`/api/assets/${id}/rating`, {
    method: 'PATCH',
    body: JSON.stringify({ rating }),
  });
}

/**
 * 批量删除资产
 */
export async function batchDeleteAssets(
  ids: string[]
): Promise<ApiResponse<{ success: boolean; deletedCount: number }>> {
  return await apiRequest('/api/assets/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

// ==========================================================================
// 智能文件夹 API
// ==========================================================================

/**
 * 获取所有智能文件夹
 */
export async function getSmartFolders(): Promise<ApiResponse<SmartFolder[]>> {
  return await apiRequest<SmartFolder[]>('/api/smart-folders');
}

/**
 * 创建或更新智能文件夹
 */
export async function saveSmartFolder(sf: {
  id?: string;
  name: string;
  matchAll?: boolean;
  rulesJson?: string;
}): Promise<ApiResponse<SmartFolder>> {
  return await apiRequest<SmartFolder>('/api/smart-folders', {
    method: 'POST',
    body: JSON.stringify(sf),
  });
}

/**
 * 删除智能文件夹
 */
export async function deleteSmartFolder(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return await apiRequest(`/api/smart-folders/${id}`, { method: 'DELETE' });
}

// ==========================================================================
// 存储统计 API
// ==========================================================================

/**
 * 获取存储统计信息
 */
export async function getStorageStats(): Promise<ApiResponse<WebStorageStats>> {
  return await apiRequest<WebStorageStats>('/api/storage/stats');
}