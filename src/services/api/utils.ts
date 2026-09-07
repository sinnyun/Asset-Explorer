/**
 * ============================================================================
 * 统一 API 中间件 - 数据标准化工具
 *
 * 职责：
 * 1. Rust SQLite 后端返回的数据字段可能与 TypeScript 前端类型略有差异
 *    （如 parentId 为 null、tags/collections 缺失等），需要标准化。
 * 2. Express PostgreSQL 后端返回的日期字段可能是 Date 对象，需要转字符串。
 * 3. 提供各 Provider 共用的数据清洗函数，确保前端拿到一致结构。
 * ============================================================================
 */

import type { Asset, Folder, Tag, Collection, SmartFolder } from '../../types';

/**
 * 标准化文件夹数据
 * - parentId: null → undefined（保证前端 folder.parentId === undefined 过滤正确）
 * - tags/collections 缺失时补空数组
 */
export function normalizeFolder(f: any): Folder {
  return {
    ...f,
    parentId: f.parentId ?? undefined,
    tags: f.tags ?? [],
    collections: f.collections ?? [],
  };
}

/** 批量标准化文件夹列表 */
export function normalizeFolders(folders: any[]): Folder[] {
  return (folders || []).map(normalizeFolder);
}

/**
 * 标准化资产数据
 * - tags/collections 缺失时补空数组
 */
export function normalizeAsset(a: any): Asset {
  return {
    ...a,
    tags: a.tags ?? [],
    collections: a.collections ?? [],
  };
}

/** 批量标准化资产列表 */
export function normalizeAssets(assets: any[]): Asset[] {
  return (assets || []).map(normalizeAsset);
}

/**
 * 标准化智能文件夹数据
 * - 若后端存储为 rulesJson 字符串（PostgreSQL），安全解析为 rules: SmartFolderRule[]
 * - 确保 rules 始终为数组，matchAll 为布尔值
 */
export function normalizeSmartFolder(sf: any): SmartFolder {
  let rules = sf.rules;
  if (!rules && typeof sf.rulesJson === 'string') {
    try {
      rules = JSON.parse(sf.rulesJson);
    } catch {
      rules = [];
    }
  }
  return {
    ...sf,
    rules: Array.isArray(rules) ? rules : [],
    matchAll: sf.matchAll ?? true,
    isPinned: sf.isPinned ?? false,
  };
}

/** 批量标准化智能文件夹列表 */
export function normalizeSmartFolders(smartFolders: any[]): SmartFolder[] {
  return (smartFolders || []).map(normalizeSmartFolder);
}

/**
 * 标准化日期字段
 * PostgreSQL/Drizzle 返回 Date 对象，需转为 ISO 字符串
 */
export function serializeDates<T extends Record<string, any>>(obj: T): T {
  const result = { ...obj } as any;
  for (const key of ['dateModified', 'dateAdded', 'createdAt']) {
    if (result[key] instanceof Date) {
      result[key] = result[key].toISOString();
    }
  }
  return result;
}
