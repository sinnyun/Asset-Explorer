import type { Folder, FolderSummary } from '../types';

/** Convert the compact database row into the UI model without loading tags/assets. */
export function folderSummaryToFolder(summary: FolderSummary): Folder {
  return {
    id: summary.id,
    name: summary.name,
    path: summary.path,
    parentId: summary.parentId,
    isMonitored: summary.isMonitored,
    tags: [],
    collections: [],
    assetCount: summary.assetCount,
    hasChildren: summary.hasChildren,
  };
}

/** Merge paged folder rows while preserving UI-only metadata already held in memory. */
export function mergeFolderSummaries(existing: Folder[], summaries: FolderSummary[]): Folder[] {
  const byId = new Map(existing.map(folder => [folder.id, folder]));
  for (const summary of summaries) {
    const previous = byId.get(summary.id);
    const next = folderSummaryToFolder(summary);
    byId.set(summary.id, previous ? { ...previous, ...next } : next);
  }
  return Array.from(byId.values());
}

/** Return the selected folder and every loaded descendant in the sidebar cache. */
export function collectFolderSubtreeIds(folders: Folder[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}
