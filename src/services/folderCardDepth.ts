import type { Folder } from '../types';

export type FolderCardDepth = number | typeof Infinity;

/**
 * Keep only the folder cards within a fixed relative depth.
 * The caller can use a different context when entering a project so its
 * internal folders start again at depth 1.
 */
export function filterFoldersByDepth(
  folders: Folder[],
  contextFolderId: string | undefined,
  maxDepth: FolderCardDepth,
): Folder[] {
  const limit = maxDepth === Infinity ? Infinity : Math.max(1, Math.min(8, Math.floor(maxDepth)));
  const byId = new Map(folders.map(folder => [folder.id, folder]));

  return folders.filter(folder => {
    if (contextFolderId && folder.id === contextFolderId) return false;
    let current = folder;
    let depth = 0;
    const visited = new Set<string>();

    while (current) {
      if (visited.has(current.id)) return contextFolderId === undefined && depth < limit;
      visited.add(current.id);
      const parentId = current.parentId;
      if (!parentId) {
        if (contextFolderId) return false;
        depth += 1;
        return depth <= limit;
      }
      if (parentId === contextFolderId) {
        depth += 1;
        return depth <= limit;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        // A partially loaded cache cannot prove deeper ancestry. Keep it as a
        // safe direct card rather than hiding a folder or throwing.
        depth += 1;
        return !contextFolderId && depth <= limit;
      }
      current = parent;
      depth += 1;
    }
    return false;
  });
}
