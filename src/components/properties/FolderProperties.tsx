import React, { useState, useMemo } from 'react';
import { 
  Folder as FolderIcon, Pin, PinOff, ArrowUp, ArrowDown, Trash2, 
  Map, ExternalLink, Copy, HardDrive, Layers, Hash, Check, FolderCheck, 
  Eye, Radio
} from 'lucide-react';
import { Folder, Asset, Tag, Collection } from '../../types';
import { formatBytes, cn } from '../../lib/utils';
import { apiClient } from '../../services/api';

interface FolderPropertiesProps {
  folder: Folder;
  allFolders: Folder[];
  assets: Asset[];
  tags: Tag[];
  collections: Collection[];
  onUpdate: (id: string, updates: Partial<Folder>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onTogglePin: (id: string) => void;
}

export function FolderProperties({
  folder,
  allFolders,
  assets,
  tags,
  collections,
  onUpdate,
  onDelete,
  onMove,
  onTogglePin
}: FolderPropertiesProps) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  // useMemo 优化：仅当依赖变化时重新计算
  const siblings = useMemo(
    () => allFolders.filter(f => f.parentId === folder.parentId),
    [allFolders, folder.parentId]
  );
  const siblingIndex = useMemo(() => siblings.findIndex(f => f.id === folder.id), [siblings, folder.id]);
  const canMoveUp = siblingIndex > 0;
  const canMoveDown = siblingIndex >= 0 && siblingIndex < siblings.length - 1;

  // Folder content stats
  const folderAssets = useMemo(
    () => assets.filter(a => a.folderId === folder.id),
    [assets, folder.id]
  );
  const childFolders = useMemo(
    () => allFolders.filter(f => f.parentId === folder.id),
    [allFolders, folder.id]
  );
  const totalSizeBytes = useMemo(() => {
    let sum = 0;
    for (const a of folderAssets) sum += a.size;
    return sum;
  }, [folderAssets]);

  const handleCopyPath = () => {
    navigator.clipboard.writeText(folder.path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const handleRevealExplorer = () => {
    apiClient.openInExplorer(folder.path);
  };

  const handleDelete = () => {
    if (isConfirmingDelete) {
      onDelete(folder.id);
      setIsConfirmingDelete(false);
    } else {
      setIsConfirmingDelete(true);
    }
  };

  return (
    <div className="w-80 flex-shrink-0 bg-[#1e1e1e] border-l border-neutral-800 flex flex-col h-full overflow-y-auto custom-scrollbar select-none">
      {/* Header Banner */}
      <div className="p-4 border-b border-neutral-800 bg-[#191919]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <FolderIcon size={16} />
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-neutral-500 tracking-wider">文件夹属性</div>
              <div className="text-sm font-semibold text-white truncate max-w-[140px]">{folder.name}</div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {folder.isMonitored && (
              <span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded">
                监视中
              </span>
            )}
            {folder.isPinned && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium text-amber-400 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded">
                <Pin size={10} className="fill-amber-400" /> 置顶
              </span>
            )}
          </div>
        </div>

        {/* Quick Action Toolbar */}
        <div className="grid grid-cols-4 gap-1.5 pt-1">
          <button
            onClick={() => onTogglePin(folder.id)}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              folder.isPinned 
                ? "bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30" 
                : "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white"
            )}
            title={folder.isPinned ? "取消置顶" : "置顶到顶部"}
          >
            {folder.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            <span>{folder.isPinned ? "已置顶" : "置顶"}</span>
          </button>

          <button
            onClick={() => onMove(folder.id, 'up')}
            disabled={!canMoveUp}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              canMoveUp 
                ? "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white" 
                : "bg-[#1a1a1a] border-neutral-800 text-neutral-600 cursor-not-allowed"
            )}
            title="在同级文件夹中上移"
          >
            <ArrowUp size={13} />
            <span>上移</span>
          </button>

          <button
            onClick={() => onMove(folder.id, 'down')}
            disabled={!canMoveDown}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              canMoveDown 
                ? "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white" 
                : "bg-[#1a1a1a] border-neutral-800 text-neutral-600 cursor-not-allowed"
            )}
            title="在同级文件夹中下移"
          >
            <ArrowDown size={13} />
            <span>下移</span>
          </button>

          <button
            onClick={handleDelete}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              isConfirmingDelete 
                ? "bg-red-600 border-red-500 text-white animate-pulse" 
                : "bg-[#252525] border-neutral-700/60 text-neutral-400 hover:text-red-400 hover:border-red-500/50"
            )}
            title={isConfirmingDelete ? "确认删除文件夹" : "删除文件夹"}
          >
            <Trash2 size={13} />
            <span>{isConfirmingDelete ? "确认" : "删除"}</span>
          </button>
        </div>

        {isConfirmingDelete && (
          <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 p-2 rounded flex items-center justify-between">
            <span>确认从资源管理器解绑移除该目录？</span>
            <button 
              onClick={() => setIsConfirmingDelete(false)}
              className="text-neutral-400 hover:text-white underline ml-2"
            >
              取消
            </button>
          </div>
        )}
      </div>

      {/* Main Form Fields */}
      <div className="p-4 space-y-5">
        {/* Name Field */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
            文件夹名称 (重命名)
          </label>
          <input
            type="text"
            value={folder.name}
            onChange={(e) => onUpdate(folder.id, { name: e.target.value })}
            className="w-full bg-[#141414] border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-500"
            placeholder="输入文件夹名称..."
          />
        </div>

        {/* Path Information */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
            系统物理路径
          </label>
          <div className="bg-[#141414] border border-neutral-700 rounded-md p-2.5 text-xs text-neutral-300 font-mono break-all leading-relaxed select-text">
            {folder.path}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <button
              onClick={handleCopyPath}
              className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-[#252525] hover:bg-[#303030] border border-neutral-700 rounded text-xs text-neutral-300 transition-colors"
            >
              {copiedPath ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              <span>{copiedPath ? "已复制" : "复制完整路径"}</span>
            </button>

            <button
              onClick={handleRevealExplorer}
              className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/40 rounded text-xs text-blue-300 transition-colors"
            >
              <ExternalLink size={13} />
              <span>打开资源管理器</span>
            </button>
          </div>
        </div>

        {/* Monitored Setting */}
        <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
                <Radio size={14} className={folder.isMonitored ? "text-blue-400 animate-pulse" : "text-neutral-500"} />
                本地监视工作区
              </div>
              <div className="text-[11px] text-neutral-500 mt-0.5">自动探测子目录变动与双列对比视图</div>
            </div>
            <button
              onClick={() => onUpdate(folder.id, { isMonitored: !folder.isMonitored })}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
                folder.isMonitored ? "bg-blue-600" : "bg-neutral-700"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                  folder.isMonitored ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </div>
        </div>

        {/* Stats Card */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            目录结构统计
          </label>
          <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 space-y-2.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <FolderIcon size={13} className="text-amber-400" /> 直接包含资产
              </span>
              <span className="font-semibold text-neutral-200">{folderAssets.length} 项</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <Layers size={13} className="text-purple-400" /> 子文件夹数量
              </span>
              <span className="font-semibold text-neutral-200">{childFolders.length} 个</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <HardDrive size={13} className="text-emerald-400" /> 目录资产总容量
              </span>
              <span className="font-semibold text-neutral-200">{formatBytes(totalSizeBytes)}</span>
            </div>

            <div className="pt-2 border-t border-neutral-800/80 flex justify-between items-center text-xs">
              <span className="text-neutral-500">同级目录排位</span>
              <span className="text-neutral-400 font-mono">
                第 {siblingIndex + 1} / {siblings.length} 位
              </span>
            </div>
          </div>
        </div>

        {/* Tags Assigned */}
        {folder.tags && folder.tags.length > 0 && (
          <div>
            <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
              关联标签
            </label>
            <div className="flex flex-wrap gap-1.5">
              {folder.tags.map(tagId => {
                const t = tags.find(item => item.id === tagId);
                if (!t) return null;
                return (
                  <span 
                    key={t.id} 
                    className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-[#252525] border border-neutral-700 text-neutral-300"
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />
                    {t.name}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
