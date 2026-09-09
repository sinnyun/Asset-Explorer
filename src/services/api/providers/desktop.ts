/**
 * ============================================================================
 * 统一 API 中间件 - 桌面 Provider（Rust IPC 实现）
 *
 * 在 Tauri 桌面环境中运行，通过 IPC 调用 Rust 后端，
 * 底层使用本地 SQLite 数据库与原生文件系统操作。
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

// ============================================================================
// Rust IPC 类型定义
// ============================================================================

/** Rust 后端返回的工作区载荷 */
interface RustWorkspacePayload {
  folders: any[];
  tags: any[];
  collections: any[];
  smart_folders: any[];
  assets: any[];
}

/** Rust 后端返回的扫描结果 */
interface RustScanPayload {
  root_folder: any;
  sub_folders: any[];
  assets: any[];
  total_files_scanned: number;
  total_duration_ms: number;
}

// ============================================================================
// Rust IPC 工具函数
// ============================================================================

/** 检测是否为 Tauri 桌面环境 */
export function isTauriDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

/** 封装安全的 Tauri invoke 调用 */
async function callRust<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriDesktop()) {
    console.warn(`[DesktopApi] 非桌面环境，跳过 Rust 命令: ${cmd}`);
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (err: any) {
    if (err instanceof Error && (err.message?.includes('import') || err.message?.includes('module'))) {
      console.warn(`[DesktopApi] 动态导入 @tauri-apps/api/core 失败（可能 Vite HMR 未就绪）:`, err.message);
    } else {
      console.warn(`[DesktopApi] 调用 Rust 命令 ${cmd} 失败:`, err);
    }
    return null;
  }
}

// ============================================================================
// Desktop Provider 实现
// ============================================================================

class DesktopApiProvider implements ApiProvider {
  readonly isDesktop = true;
  readonly platform = 'desktop' as const;
  readonly envLabel = '[环境:桌面·Rust]';

  // ------------------------------------------------------------------------
  // 数据加载与扫描
  // ------------------------------------------------------------------------

  /** 加载完整工作区数据（Rust SQLite） */
  async loadWorkspace(): Promise<Partial<AssetState>> {
    // 尝试加载，最多重试 2 次（解决 Vite HMR 初始化期间 IPC 可能失败的问题）
    let payload: RustWorkspacePayload | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      payload = await callRust<RustWorkspacePayload>('load_workspace');
      if (payload !== null) break;
      if (attempt < 2) {
        console.warn(`[DesktopApi] Rust IPC 返回空（第 ${attempt} 次），等待 500ms 后重试...`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (payload === null) {
      // IPC 暂时不可用不是“空工作区”，让上层进入重试.
      throw new Error('[DesktopApi] 无法加载工作区：Rust IPC 不可用');
    }

    // 标准化：确保 parentId 为 null 时转 undefined、tags/collections 不为 undefined
    const folders = normalizeFolders(payload.folders);
    const assets = normalizeAssets(payload.assets);

    // 标准化 SmartFolder：rules/matchAll 字段
    const customSmartFolders = (payload.smart_folders || []).map((sf: any) => ({
      ...sf,
      rules: sf.rules ?? [],
      matchAll: sf.matchAll ?? true,
    }));

    return {
      folders,
      tags: payload.tags || [],
      collections: payload.collections || [],
      customSmartFolders,
      assets,
    };
  }

  /** 扫描本地目录（Rust walkdir 索引） */
  async scanDirectory(path: string): Promise<ScanResult | null> {
    const raw = await callRust<RustScanPayload>('scan_directory', { path });
    if (!raw) return null;

    return {
      root_folder: normalizeFolders([raw.root_folder])[0],
      sub_folders: normalizeFolders(raw.sub_folders),
      assets: normalizeAssets(raw.assets),
      total_files_scanned: raw.total_files_scanned,
      total_duration_ms: raw.total_duration_ms,
    };
  }

  /** 后台增量扫描本地目录（scan:started / scan:chunk / scan:finished / scan:failed 事件流） */
  async startScanDirectory(path: string): Promise<void> {
    await callRust<void>('start_scan_directory', { path });
  }

  /** 懒加载获取资产缩略图 (优先使用 Tauri 原生 asset 协议，避免 Base64 IPC 内存开销) */
  async getAssetThumbnail(assetId: string, path: string, existingThumbnailUrl?: string): Promise<string | null> {
    // ================================================================
    // 场景 1：已有缩略图缓存路径 → 验证文件确实存在于磁盘后再使用
    // convertFileSrc 零拷贝流式渲染。
    //
    // 【修复原因】数据库中的 thumbnailUrl 可能已失效：
    //   ① 用户手动清理了缩略图缓存目录
    //   ② 数据迁移后 DB 未同步更新 thumbnailUrl 路径
    //   ③ 外接存储盘符变更导致路径失效
    // 此时直接 convertFileSrc 会返回一个 404 的 asset:// URL。
    // 因此必须通过 Rust IPC 做文件存在性校验，保证 URL 可用。
    // ================================================================
    if (existingThumbnailUrl) {
      // 通过 Rust IPC 轻量检查文件是否存在（仅 stat，不读取内容）
      const fileExists = await callRust<boolean>('file_exists', { filePath: existingThumbnailUrl });
      if (fileExists) {
        try {
          const { convertFileSrc } = await import('@tauri-apps/api/core');
          const assetUrl = convertFileSrc(existingThumbnailUrl);
          if (assetUrl) return assetUrl;
        } catch {
          // convertFileSrc 导入失败 → 降级使用 base64
        }
        // 降级：通过 IPC 读取为 base64 data URL
        const dataUrl = await callRust<string>('read_thumbnail_base64', { filePath: existingThumbnailUrl });
        if (dataUrl) return dataUrl;
      }
      // 缓存文件不存在 → 自动降级到场景 2 重新生成
    }

    // ================================================================
    // 场景 2：调用 Rust 从源文件生成/获取缩略图。
    // generate_or_get_thumbnail 内部会检查缓存文件是否存在：
    //   - 已存在 → 立即返回路径（快速命中）
    //   - 不存在 → 自动重新生成并更新数据库中的 thumbnailUrl
    // 因此本方法返回的路径一定是当前数据目录中真实有效的文件。
    // ================================================================
    const thumbPath = await callRust<string>('get_thumbnail', { assetId, path, maxDimension: 256 });
    if (thumbPath) {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const assetUrl = convertFileSrc(thumbPath);
        if (assetUrl) return assetUrl;
      } catch {
        // convertFileSrc 导入失败 → 降级使用 base64
      }
      const dataUrl = await callRust<string>('read_thumbnail_base64', { filePath: thumbPath });
      if (dataUrl) return dataUrl;
    }

    // ================================================================
    // 兜底：get_thumbnail 失败（如源文件已被移动/删除），
    // 但 existingThumbnailUrl 可能仍指向独立有效的缩略图缓存。
    // 此时优先通过 read_thumbnail_base64 直接读取文件返回 data URL，
    // 相比 convertFileSrc 能绕过 asset:// 协议可能出现的 404 问题。
    // ================================================================
    if (existingThumbnailUrl) {
      // 直接读取为 base64 data URL（绕过 asset:// 协议，最可靠的展示方式）
      const dataUrl = await callRust<string>('read_thumbnail_base64', { filePath: existingThumbnailUrl });
      if (dataUrl) return dataUrl;
      // base64 也失败 → 退回 convertFileSrc 尽力尝试
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const assetUrl = convertFileSrc(existingThumbnailUrl);
        if (assetUrl) return assetUrl;
      } catch {
        // ignore - return null below
      }
    }
    return null;
  }

  /** 校验资产有效性 */
  async validateAssets(): Promise<void> {
    const result = await callRust<{ deleted_count: number; total_checked: number }>('validate_assets');
    if (result && result.deleted_count > 0) {
      console.log(`[DesktopApi] 资产有效性校验: 检查 ${result.total_checked} 个, 清理 ${result.deleted_count} 个无效路径`);
    }
  }

  /** 对全部监视文件夹执行一次完整的磁盘对账同步 */
  async reconcileMonitoredFolders(): Promise<any> {
    return await callRust('reconcile_monitored_folders');
  }

  // ------------------------------------------------------------------------
  // 资产操作
  // ------------------------------------------------------------------------

  async setAssetRating(id: string, rating: number): Promise<void> {
    await callRust<void>('set_asset_rating', { id, rating });
  }

  async setAssetFavorite(id: string, favorite: boolean): Promise<void> {
    await callRust<void>('set_asset_favorite', { id, favorite });
  }

  async deleteAssets(ids: string[]): Promise<void> {
    await callRust<void>('delete_assets', { ids });
  }

  async syncAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    await callRust<void>('sync_asset_tags', { assetId, tagIds });
  }

  async syncAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    await callRust<void>('sync_asset_collections', { assetId, collectionIds });
  }

  async syncManyAssetTags(assetIds: string[], tagIds: string[]): Promise<void> {
    await callRust<void>('sync_many_asset_tags', { assetIds, tagIds });
  }

  async syncManyAssetCollections(assetIds: string[], collectionIds: string[]): Promise<void> {
    await callRust<void>('sync_many_asset_collections', { assetIds, collectionIds });
  }

  async removeAssetTags(assetId: string, tagIds: string[]): Promise<void> {
    await callRust<void>('remove_asset_tags', { assetId, tagIds });
  }

  async removeAssetCollections(assetId: string, collectionIds: string[]): Promise<void> {
    await callRust<void>('remove_asset_collections', { assetId, collectionIds });
  }

  // ------------------------------------------------------------------------
  // 文件夹 CRUD
  // ------------------------------------------------------------------------

  async createFolder(folder: Folder): Promise<void> {
    await callRust<void>('create_folder', { folder });
  }

  async updateFolder(folder: Folder): Promise<void> {
    const res = await callRust<void>('update_folder', { folder });
    console.log(
      `[Monitor][Rust] update_folder 调用返回 ${res === null ? '失败(见上方警告)' : '成功'}: ` +
      `id=${folder.id}, path=${folder.path}, isMonitored=${folder.isMonitored}`
    );
  }

  async deleteFolder(id: string): Promise<void> {
    await callRust<void>('delete_folder', { id });
  }

  // ------------------------------------------------------------------------
  // 标签 CRUD
  // ------------------------------------------------------------------------

  async createTag(tag: Tag): Promise<void> {
    await callRust<void>('create_tag', { tag });
  }

  async updateTag(tag: Tag): Promise<void> {
    await callRust<void>('update_tag', { id: tag.id, tag });
  }

  async deleteTag(id: string): Promise<void> {
    await callRust<void>('delete_tag', { id });
  }

  // ------------------------------------------------------------------------
  // 集合 CRUD
  // ------------------------------------------------------------------------

  async createCollection(col: Collection): Promise<void> {
    await callRust<void>('create_collection', { collection: col });
  }

  async updateCollection(col: Collection): Promise<void> {
    await callRust<void>('update_collection', { id: col.id, collection: col });
  }

  async deleteCollection(id: string): Promise<void> {
    await callRust<void>('delete_collection', { id });
  }

  // ------------------------------------------------------------------------
  // 智能文件夹 CRUD
  // ------------------------------------------------------------------------

  async saveSmartFolder(sf: SmartFolder): Promise<void> {
    await callRust<void>('save_smart_folder', { smartFolder: sf });
  }

  async deleteSmartFolder(id: string): Promise<void> {
    await callRust<void>('delete_smart_folder', { id });
  }

  // ------------------------------------------------------------------------
  // 系统操作
  // ------------------------------------------------------------------------

  /** 打开资源管理器 */
  async openInExplorer(path: string): Promise<void> {
    await callRust<void>('open_in_file_manager', { path });
  }

  /** 弹出文件夹选取对话框（Tauri v2 plugin-dialog） */
  async pickDirectory(): Promise<string | null> {
    if (!isTauriDesktop()) return null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      return typeof selected === 'string' ? selected : null;
    } catch (e) {
      console.warn("[DesktopApi] 文件夹选取失败:", e);
    }
    return null;
  }

  /** 获取存储统计 */
  async getStorageStats(): Promise<StorageStats> {
    const stats = await callRust<any>('get_storage_stats');
    if (stats) {
      return {
        data_dir: stats.data_dir || '',
        db_size_bytes: stats.db_size_bytes || 0,
        thumbnails_size_bytes: stats.thumbnails_size_bytes || 0,
        total_size_bytes: stats.total_size_bytes || 0,
        asset_count: stats.asset_count || 0,
      };
    }
    // 降级默认值
    return { data_dir: '', db_size_bytes: 0, thumbnails_size_bytes: 0, total_size_bytes: 0, asset_count: 0 };
  }

  /** 完整数据迁移 */
  async migrateDataStorage(newPath: string): Promise<string> {
    const res = await callRust<string>('migrate_data_storage', { newPath });
    if (res) return res;
    throw new Error("Rust 后端迁移返回空响应");
  }

  /** 重启应用 */
  async restartApplication(): Promise<void> {
    await callRust<void>('restart_application');
  }
}

/** 桌面 Provider 单例 */
export const desktopProvider = new DesktopApiProvider();
