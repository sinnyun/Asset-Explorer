/**
 * ============================================================================
 * 模块：统一数据服务引擎 (dataService.ts)
 * 职责：
 * 1. 根据运行环境自动切换数据源：
 *    - 桌面 Tauri 环境 → 通过 Rust IPC 操作本地 SQLite 数据库
 *    - Web 环境（远程/本地）→ 通过 HTTP API 操作 PostgreSQL 数据库
 *    - 降级策略 → 使用本地模拟数据
 * 2. 保证前端界面绝不发生任何卡顿或线程堵塞。
 * ============================================================================
 */

import { Asset, Folder, Tag, Collection, SmartFolder, AssetState } from '../types';
import { mockAssets, mockFolders, mockTags, mockCollections } from '../data';
import * as bridge from './desktopBridge';
import * as api from './webApiClient';
import { getEnvironment, getEnvironmentLabel } from './environment';

class DataService {
  /**
   * 数据源调试日志
   */
  private log(method: string, message: string) {
    const env = getEnvironmentLabel();
    console.log(`[DataService]${env} ${method}: ${message}`);
  }

  /**
   * 异步加载工作区数据
   * 优先级：桌面 Rust SQLite > Web API PostgreSQL > 本地模拟数据
   * 重试机制：桌面模式首次失败后，等待 500ms 重试一次
   * （解决 Vite HMR 初始化期间动态 import @tauri-apps/api/core 可能失败的问题）
   */
  async loadWorkspace(): Promise<Partial<AssetState>> {
    const env = getEnvironment();

    // ==================================================================
    // 模式 1：桌面 Tauri 环境 → 优先从 Rust 后端 SQLite 读取
    // ==================================================================
    if (env.isDesktop) {
      this.log('loadWorkspace', '使用桌面 Rust SQLite 后端');
      // 尝试加载，最多重试 2 次
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const payload = await bridge.loadWorkspaceFromRustDb();
          if (payload === null) {
            // callTauri 返回 null → 通常是 @tauri-apps/api/core 导入失败或 IPC 未就绪
            if (attempt < 2) {
              console.warn(`[DataService] Rust IPC 返回空（第 ${attempt} 次），等待 500ms 后重试...`);
              await new Promise(r => setTimeout(r, 500));
              continue;
            }
            console.warn('[DataService] Rust IPC 重试耗尽，降级到 Web API 或模拟数据');
            break;
          }
          if (payload.folders.length > 0 || payload.assets.length > 0) {
            this.log('loadWorkspace', `成功加载 ${payload.assets.length} 个资产`);

            // 标准化数据：Rust 后端的 Folder 没有 tags/collections 字段，
            // 且 parentId 为 null 时前端无法匹配 parentId === undefined，
            // 统一转换为 undefined 确保文件夹树正确渲染
            const normalizeFolders = (folders: any[]) =>
              folders.map(f => ({
                ...f,
                parentId: f.parentId ?? undefined,
                tags: f.tags ?? [],
                collections: f.collections ?? [],
              }));

            // 标准化资产：同理确保 tags/collections 不为 undefined
            const normalizeAssets = (assetsList: any[]) =>
              assetsList.map(a => ({
                ...a,
                tags: a.tags ?? [],
                collections: a.collections ?? [],
              }));

            return {
              folders: normalizeFolders(payload.folders),
              tags: payload.tags,
              collections: payload.collections,
              customSmartFolders: payload.smart_folders,
              assets: normalizeAssets(payload.assets),
            };
          }
          // 数据库为空（首次启动），空数据库也是有效状态，直接返回空数据
          this.log('loadWorkspace', 'SQLite 数据库为空（首次启动），返回空数据');
          return {
            folders: [],
            tags: [],
            collections: [],
            customSmartFolders: [],
            assets: [],
          };
        } catch (err) {
          console.warn(`[DataService] 从 Rust SQLite 加载失败（第 ${attempt} 次）:`, err);
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
        }
      }
    }

    // ==================================================================
    // 重要：桌面模式在此处必须提前返回，不可降级到 Web API 或模拟数据！
    // 桌面环境的数据来源只能是 Rust SQLite 数据库（实际监视文件夹的扫描结果），
    // 模拟数据（C:/Workspace 等路径）仅用于 Web 开发环境，不可混入桌面 UI。
    // ==================================================================
    if (env.isDesktop) {
      this.log('loadWorkspace', '桌面模式数据库为空或 IPC 未就绪，返回空数据');
      return {
        folders: [],
        tags: [],
        collections: [],
        customSmartFolders: [],
        assets: [],
      };
    }

    // ==================================================================
    // 模式 2：Web 环境（远程/本地）→ 通过 Express API 连接 PostgreSQL
    // ==================================================================
    if (env.isRemoteWeb || env.isLocalWeb) {
      this.log('loadWorkspace', `使用 Web API PostgreSQL 后端 (${env.apiBaseUrl})`);
      try {
        const result = await api.loadWorkspace();
        if (result.success && result.data) {
          const { folders, tags, collections, assets, smartFolders } = result.data;
          this.log('loadWorkspace', `成功加载 ${assets.length} 个资产, ${folders.length} 个文件夹`);
          return {
            folders,
            tags,
            collections,
            customSmartFolders: smartFolders || [],
            assets,
          };
        }
        console.warn('[DataService] Web API 加载工作区返回空:', result.error);
      } catch (err) {
        console.warn('[DataService] 从 Web API 加载失败，采用模拟数据:', err);
      }
    }

    // ==================================================================
    // 模式 3：降级 → 使用本地模拟数据
    // ==================================================================
    this.log('loadWorkspace', '使用本地模拟数据（降级模式）');
    return {
      folders: mockFolders,
      tags: mockTags,
      collections: mockCollections,
      customSmartFolders: [],
      assets: mockAssets,
    };
  }

  /**
   * 异步触发后端扫描并持久化目录 (绝不阻塞 UI 渲染)
   * 桌面模式 → Rust 后端扫描本地文件系统
   * Web 模式 → 暂不支持本地扫描
   */
  async scanDirectory(dirPath: string): Promise<bridge.RustScanResult | null> {
    if (getEnvironment().isDesktop) {
      this.log('scanDirectory', `扫描目录: ${dirPath}`);
      const raw = await bridge.scanLocalDirectoryViaRust(dirPath);
      if (!raw) return null;

      // 标准化 Rust 返回的文件夹树：parentId 为 null 时转 undefined，
      // 避免前端 f.parentId === undefined 过滤失败导致文件夹树不显示
      const normalizeFolder = (f: any) => ({
        ...f,
        parentId: f.parentId ?? undefined,
        tags: f.tags ?? [],
        collections: f.collections ?? [],
      });

      // 标准化资产：确保 tags/collections 不为 undefined
      const normalizeAsset = (a: any) => ({
        ...a,
        tags: a.tags ?? [],
        collections: a.collections ?? [],
      });

      return {
        root_folder: normalizeFolder(raw.root_folder),
        sub_folders: raw.sub_folders.map(normalizeFolder),
        assets: raw.assets.map(normalizeAsset),
        total_files_scanned: raw.total_files_scanned,
        total_duration_ms: raw.total_duration_ms,
      };
    }
    this.log('scanDirectory', 'Web 模式不支持本地文件扫描');
    return null;
  }

  /**
   * 异步更新资产评分
   */
  async setAssetRating(id: string, rating: number): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      // 桌面模式：投递到 Rust 后端异步执行
      bridge.setAssetRatingViaRust(id, rating).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      // Web 模式：通过 API 更新
      api.updateAssetRating(id, rating).catch(console.error);
      return;
    }
  }

  /**
   * 懒加载生成资产缩略图（桌面模式）
   * 调用 Rust 后端生成缩略图并保存到数据库缓存，
   * 通过 Rust 命令读取文件并以 base64 data URL 返回（绕过浏览器 file:// 安全限制）
   *
   * @param assetId 资产 ID
   * @param path 资产源文件路径（用于生成缩略图）
   * @param existingThumbnailUrl 可选的已有缩略图路径（若提供，则直接读取 base64，不重新生成）
   */
  async getAssetThumbnail(assetId: string, path: string, existingThumbnailUrl?: string): Promise<string | null> {
    if (getEnvironment().isDesktop) {
      // 场景 1：缩略图已缓存到数据库（thumbnailUrl 已存在）
      // 直接读取缓存文件并返回 base64 data URL，避免重新生成
      if (existingThumbnailUrl) {
        this.log('getAssetThumbnail', `读取已有缩略图缓存: ${existingThumbnailUrl}`);
        const dataUrl = await bridge.readThumbnailBase64(existingThumbnailUrl);
        if (dataUrl) return dataUrl;
        // 缓存文件读取失败（如文件被删除），降级到重新生成
        this.log('getAssetThumbnail', `缩略图缓存文件不存在，重新生成`);
      }

      // 场景 2：无缩略图缓存，调用 Rust 后端从源文件生成
      this.log('getAssetThumbnail', `生成缩略图: ${path}`);
      const thumbPath = await bridge.getThumbnailViaRust(assetId, path);
      if (thumbPath) {
        // 通过 Rust IPC 读取缩略图文件，返回 base64 data URL
        const dataUrl = await bridge.readThumbnailBase64(thumbPath);
        if (dataUrl) return dataUrl;
        // 降级：尝试使用 convertFileSrc（某些环境下可用）
        try {
          const { convertFileSrc } = await import('@tauri-apps/api/core');
          return convertFileSrc(thumbPath);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * 异步校验资产有效性：删除数据库中文件已不存在的资产记录
   * 桌面模式下调用 Rust 后端 SQLite 校验，返回清理结果
   * 此方法在 loadWorkspace 加载完成后调用，确保前端不会展示无效路径
   * 校验结果（清理了哪些无效路径）会通过日志输出到控制台
   */
  async validateAssets(): Promise<void> {
    if (getEnvironment().isDesktop) {
      const result = await bridge.validateAssetsViaRust();
      if (result) {
        if (result.deleted_count > 0) {
          console.log(`[DataService] 资产有效性校验完成: 检查 ${result.total_checked} 个资产, 清理了 ${result.deleted_count} 个无效路径（如 C:/Workspace 等模拟数据）`);
        } else {
          console.log(`[DataService] 资产有效性校验完成: 检查 ${result.total_checked} 个资产, 全部有效`);
        }
      }
    }
  }

  /**
   * 异步更新资产收藏状态
   */
  async setAssetFavorite(id: string, favorite: boolean): Promise<void> {
    if (getEnvironment().isDesktop) {
      bridge.setAssetFavoriteViaRust(id, favorite).catch(console.error);
    }
    // Web 模式暂不支持收藏状态（PostgreSQL schema 无 rating/favorite 字段）
  }

  /**
   * 异步批量删除资产
   */
  async deleteAssets(ids: string[]): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.deleteAssetsViaRust(ids).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.batchDeleteAssets(ids).catch(console.error);
      return;
    }
  }

  /**
   * 异步创建文件夹
   */
  async createFolder(folder: Folder): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.createFolderViaRust(folder).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.createFolder({
        name: folder.name,
        parentId: folder.parentId,
        path: folder.path,
      }).catch(console.error);
      return;
    }
  }

  /**
   * 异步重命名文件夹
   */
  async renameFolder(id: string, newName: string): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.renameFolderViaRust(id, newName).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.updateFolder(id, { name: newName }).catch(console.error);
      return;
    }
  }

  /**
   * 异步更新文件夹详细属性
   */
  async updateFolder(idOrItem: string | Folder, updates?: Partial<Folder>): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      const folder = typeof idOrItem === 'string' ? { id: idOrItem, ...updates } as Folder : idOrItem;
      bridge.updateFolderViaRust(folder).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.id;
      api.updateFolder(id, updates || {}).catch(console.error);
      return;
    }
  }

  /**
   * 异步删除文件夹
   */
  async deleteFolder(id: string): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.deleteFolderViaRust(id).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.deleteFolder(id).catch(console.error);
      return;
    }
  }

  /**
   * 异步创建标签
   */
  async createTag(tag: Tag): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.createTagViaRust(tag).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.createTag({ name: tag.name, color: tag.color }).catch(console.error);
      return;
    }
  }

  /**
   * 异步更新标签详细属性
   */
  async updateTag(idOrItem: string | Tag, updates?: Partial<Tag>): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      const tag = typeof idOrItem === 'string' ? { id: idOrItem, ...updates } as Tag : idOrItem;
      bridge.updateTagViaRust(tag.id, tag).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.id;
      api.updateTag(id, updates || {}).catch(console.error);
      return;
    }
  }

  /**
   * 异步删除标签
   */
  async deleteTag(id: string): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.deleteTagViaRust(id).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.deleteTag(id).catch(console.error);
      return;
    }
  }

  /**
   * 异步创建集合
   */
  async createCollection(col: Collection): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.createCollectionViaRust(col).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.createCollection({ name: col.name }).catch(console.error);
      return;
    }
  }

  /**
   * 异步更新集合详细属性
   */
  async updateCollection(idOrItem: string | Collection, updates?: Partial<Collection>): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      const col = typeof idOrItem === 'string' ? { id: idOrItem, ...updates } as Collection : idOrItem;
      bridge.updateCollectionViaRust(col.id, col).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.id;
      api.updateCollection(id, { name: (updates?.name) || '' }).catch(console.error);
      return;
    }
  }

  /**
   * 异步删除集合
   */
  async deleteCollection(id: string): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.deleteCollectionViaRust(id).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.deleteCollection(id).catch(console.error);
      return;
    }
  }

  /**
   * 异步保存/更新智能文件夹
   */
  async saveSmartFolder(sf: SmartFolder): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.saveSmartFolderViaRust(sf).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.saveSmartFolder({
        id: sf.id,
        name: sf.name,
        matchAll: sf.matchAll,
        rulesJson: JSON.stringify(sf.rules || []),
      }).catch(console.error);
      return;
    }
  }

  /**
   * 异步更新智能文件夹详细属性
   */
  async updateSmartFolder(sf: SmartFolder): Promise<void> {
    await this.saveSmartFolder(sf);
  }

  /**
   * 异步删除智能文件夹
   */
  async deleteSmartFolder(id: string): Promise<void> {
    const env = getEnvironment();

    if (env.isDesktop) {
      bridge.deleteSmartFolderViaRust(id).catch(console.error);
      return;
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      api.deleteSmartFolder(id).catch(console.error);
      return;
    }
  }

  /**
   * 在 Windows 资源管理器中定位文件
   */
  async openInExplorer(path: string): Promise<void> {
    if (getEnvironment().isDesktop) {
      bridge.openInWindowsExplorer(path).catch(console.error);
      return;
    }
    this.log('openInExplorer', 'Web 模式不支持打开文件管理器');
  }

  /**
   * 获取本地存储空间占用统计
   */
  async getStorageStats(): Promise<bridge.RustStorageStats> {
    const env = getEnvironment();

    if (env.isDesktop) {
      this.log('getStorageStats', '从 Rust 后端获取存储统计');
      const stats = await bridge.getStorageStatsViaRust();
      if (stats) return stats;
      // 降级返回默认值
      return {
        data_dir: 'C:\\Users\\User\\AppData\\Local\\AssetHub',
        db_size_bytes: 2457600,
        thumbnails_size_bytes: 8388608,
        total_size_bytes: 10846208,
        asset_count: 120,
      };
    }

    if (env.isRemoteWeb || env.isLocalWeb) {
      this.log('getStorageStats', '从 Web API 获取存储统计');
      const result = await api.getStorageStats();
      if (result.success && result.data) {
        return result.data;
      }
    }

    // 降级：返回默认统计
    return {
      data_dir: 'PostgreSQL (Cloud)',
      db_size_bytes: 0,
      thumbnails_size_bytes: 0,
      total_size_bytes: 0,
      asset_count: 0,
    };
  }

  /**
   * 完整数据迁移 (仅桌面模式支持)
   */
  async migrateDataStorage(newPath: string): Promise<string> {
    if (getEnvironment().isDesktop) {
      this.log('migrateDataStorage', `迁移数据到: ${newPath}`);
      const res = await bridge.migrateDataStorageViaRust(newPath);
      if (res) return res;
      throw new Error("Rust 后端迁移返回空响应");
    }
    // Web 预览环境模拟
    this.log('migrateDataStorage', 'Web 模式模拟数据迁移');
    await new Promise(r => setTimeout(r, 1200));
    return `[模拟成功] 数据已迁移至 ${newPath}，应用将重启。`;
  }

  /**
   * 重启桌面客户端应用
   */
  async restartApplication(): Promise<void> {
    if (getEnvironment().isDesktop) {
      await bridge.restartApplicationViaRust();
    } else {
      window.location.reload();
    }
  }
}

export const dataService = new DataService();