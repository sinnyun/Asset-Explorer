/**
 * ============================================================================
 * 模块：前端与 Rust Tauri IPC 通信适配层 (desktopBridge.ts)
 * 职责：连接前端 React 界面与底层 Rust 后端。
 * 特性：全部为非阻塞异步调用 (Non-blocking Async Promise)，绝不卡死前端主线程！
 * ============================================================================
 */

import { Asset, Folder, SmartFolder, Tag, Collection } from '../types';
import { isTauriDesktop } from './environment';

// 重新导出 isTauriDesktop 以保持向后兼容（其他模块从 desktopBridge 导入）
export { isTauriDesktop };

/**
 * 弹出 Windows 原生文件夹选取窗口 (非阻塞异步)
 */
export async function pickDirectoryViaDialog(): Promise<string | null> {
  if (!isTauriDesktop()) return null;
  try {
    const tauri = (window as any).__TAURI__;
    if (tauri?.dialog?.open) {
      const selected = await tauri.dialog.open({ directory: true, multiple: false });
      return typeof selected === 'string' ? selected : null;
    }
  } catch (e) {
    console.warn("pickDirectoryViaDialog failed:", e);
  }
  return null;
}

/**
 * 封装安全的 Tauri invoke 调用 (异步非阻塞)
 * 日志分级：区分动态导入失败 vs IPC 调用失败
 */
async function callTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriDesktop()) {
    console.warn(`[DesktopBridge] 非桌面环境，跳过 Rust 命令: ${cmd}`);
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (err: any) {
    // 区分动态导入错误和 IPC 调用错误
    if (err instanceof Error && (err.message?.includes('import') || err.message?.includes('module'))) {
      console.warn(`[DesktopBridge] 动态导入 @tauri-apps/api/core 失败（可能 Vite HMR 未就绪）:`, err.message);
    } else {
      console.warn(`[DesktopBridge] 调用 Rust 命令 ${cmd} 失败:`, err);
    }
    return null;
  }
}

export interface RustWorkspacePayload {
  folders: Folder[];
  tags: Tag[];
  collections: Collection[];
  smart_folders: SmartFolder[];
  assets: Asset[];
}

export interface RustScanResult {
  root_folder: Folder;
  sub_folders: Folder[];
  assets: Asset[];
  total_files_scanned: number;
  total_duration_ms: number;
}

export interface RustAggregationReport {
  total_assets: number;
  total_bytes: number;
  type_counts: Record<string, number>;
  tag_counts: Record<string, number>;
  collection_counts: Record<string, number>;
  folder_counts: Record<string, number>;
  rating_distribution: Record<number, number>;
  size_buckets: Record<string, number>;
  format_extensions: Record<string, number>;
}

// --- 数据库持久化异步命令 ---

export async function loadWorkspaceFromRustDb(): Promise<RustWorkspacePayload | null> {
  return await callTauri<RustWorkspacePayload>('load_workspace');
}

export async function scanLocalDirectoryViaRust(dirPath: string): Promise<RustScanResult | null> {
  return await callTauri<RustScanResult>('scan_directory', { path: dirPath });
}

export async function setAssetRatingViaRust(id: string, rating: number): Promise<boolean> {
  const res = await callTauri<void>('set_asset_rating', { id, rating });
  return res !== null;
}

export async function setAssetFavoriteViaRust(id: string, favorite: boolean): Promise<boolean> {
  const res = await callTauri<void>('set_asset_favorite', { id, favorite });
  return res !== null;
}

export async function deleteAssetsViaRust(ids: string[]): Promise<boolean> {
  const res = await callTauri<void>('delete_assets', { ids });
  return res !== null;
}

export async function createFolderViaRust(folder: Folder): Promise<boolean> {
  const res = await callTauri<void>('create_folder', { folder });
  return res !== null;
}

export async function updateFolderViaRust(folder: Folder): Promise<boolean> {
  const res = await callTauri<void>('update_folder', { folder });
  return res !== null;
}

export async function renameFolderViaRust(id: string, newName: string): Promise<boolean> {
  const res = await callTauri<void>('rename_folder', { id, newName });
  return res !== null;
}

export async function deleteFolderViaRust(id: string): Promise<boolean> {
  const res = await callTauri<void>('delete_folder', { id });
  return res !== null;
}

export async function createTagViaRust(tag: Tag): Promise<boolean> {
  const res = await callTauri<void>('create_tag', { tag });
  return res !== null;
}

export async function updateTagViaRust(tag: Tag): Promise<boolean> {
  const res = await callTauri<void>('update_tag', { tag });
  return res !== null;
}

export async function deleteTagViaRust(id: string): Promise<boolean> {
  const res = await callTauri<void>('delete_tag', { id });
  return res !== null;
}

export async function createCollectionViaRust(collection: Collection): Promise<boolean> {
  const res = await callTauri<void>('create_collection', { collection });
  return res !== null;
}

export async function updateCollectionViaRust(collection: Collection): Promise<boolean> {
  const res = await callTauri<void>('update_collection', { collection });
  return res !== null;
}

export async function deleteCollectionViaRust(id: string): Promise<boolean> {
  const res = await callTauri<void>('delete_collection', { id });
  return res !== null;
}

export async function saveSmartFolderViaRust(smartFolder: SmartFolder): Promise<boolean> {
  const res = await callTauri<void>('save_smart_folder', { smartFolder });
  return res !== null;
}

export async function deleteSmartFolderViaRust(id: string): Promise<boolean> {
  const res = await callTauri<void>('delete_smart_folder', { id });
  return res !== null;
}

export async function aggregateDataViaRust(assets: Asset[]): Promise<RustAggregationReport | null> {
  return await callTauri<RustAggregationReport>('aggregate_data', { assets });
}

export async function filterSmartFolderViaRust(assets: Asset[], smartFolder: SmartFolder): Promise<string[] | null> {
  return await callTauri<string[]>('filter_by_smart_folder', { assets, smartFolder });
}

export async function openInWindowsExplorer(filePath: string): Promise<boolean> {
  const res = await callTauri<void>('open_in_file_manager', { path: filePath });
  return res !== null;
}

export async function getSystemInfoViaRust(): Promise<Record<string, unknown> | null> {
  return await callTauri<Record<string, unknown>>('get_system_info');
}

export interface RustStorageStats {
  data_dir: string;
  db_size_bytes: number;
  thumbnails_size_bytes: number;
  total_size_bytes: number;
  asset_count: number;
}

export async function getStorageStatsViaRust(): Promise<RustStorageStats | null> {
  return await callTauri<RustStorageStats>('get_storage_stats');
}

export async function migrateDataStorageViaRust(newPath: string): Promise<string | null> {
  return await callTauri<string>('migrate_data_storage', { newPath });
}

export async function restartApplicationViaRust(): Promise<void> {
  await callTauri<void>('restart_application');
}

