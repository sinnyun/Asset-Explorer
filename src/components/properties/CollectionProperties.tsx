import React, { useState, useMemo } from 'react';
import { 
  Layers, Pin, PinOff, ArrowUp, ArrowDown, Trash2, 
  HardDrive, Calendar, Check, Image as ImageIcon, Folder, Sparkles 
} from 'lucide-react';
import { Collection, Asset, Folder as FolderType } from '../../types';
import { formatBytes, cn } from '../../lib/utils';
import { ThumbnailImage } from '../ThumbnailImage';

interface CollectionPropertiesProps {
  collection: Collection;
  allCollections: Collection[];
  assets: Asset[];
  folders: FolderType[];
  onUpdate: (id: string, updates: Partial<Collection>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onTogglePin: (id: string) => void;
}

const COLLECTION_COLORS = [
  { name: 'Amber Gold', hex: '#f59e0b' },
  { name: 'Sky Blue', hex: '#0284c7' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Purple Neon', hex: '#a855f7' },
  { name: 'Rose Red', hex: '#f43f5e' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Orange', hex: '#ea580c' }
];

export function CollectionProperties({
  collection,
  allCollections,
  assets,
  folders,
  onUpdate,
  onDelete,
  onMove,
  onTogglePin
}: CollectionPropertiesProps) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  // Filter assets and folders in this collection
  // useMemo 优化计算
  const collectedAssets = useMemo(
    () => assets.filter(a => a.collections.includes(collection.id)),
    [assets, collection.id]
  );
  const collectedFolders = useMemo(
    () => folders.filter(f => f.collections.includes(collection.id)),
    [folders, collection.id]
  );
  const totalSizeBytes = useMemo(() => {
    let sum = 0;
    for (const a of collectedAssets) sum += a.size;
    return sum;
  }, [collectedAssets]);

  const currentIndex = allCollections.findIndex(c => c.id === collection.id);
  const canMoveUp = currentIndex > 0;
  const canMoveDown = currentIndex >= 0 && currentIndex < allCollections.length - 1;
  const activeColor = collection.color || '#f59e0b';

  const handleDelete = () => {
    if (isConfirmingDelete) {
      onDelete(collection.id);
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
            <div 
              className="w-7 h-7 rounded-lg flex items-center justify-center shadow-inner"
              style={{ backgroundColor: `${activeColor}20`, border: `1px solid ${activeColor}50` }}
            >
              <Layers size={16} style={{ color: activeColor }} />
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-neutral-500 tracking-wider">集合属性</div>
              <div className="text-sm font-semibold text-white truncate max-w-[140px]">{collection.name}</div>
            </div>
          </div>

          {collection.isPinned && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-amber-400 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-full">
              <Pin size={11} className="fill-amber-400" /> 已置顶
            </span>
          )}
        </div>

        {/* Quick Action Toolbar */}
        <div className="grid grid-cols-4 gap-1.5 pt-1">
          <button
            onClick={() => onTogglePin(collection.id)}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              collection.isPinned 
                ? "bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30" 
                : "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white"
            )}
            title={collection.isPinned ? "取消置顶" : "置顶到顶部"}
          >
            {collection.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            <span>{collection.isPinned ? "已置顶" : "置顶"}</span>
          </button>

          <button
            onClick={() => onMove(collection.id, 'up')}
            disabled={!canMoveUp}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              canMoveUp 
                ? "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white" 
                : "bg-[#1a1a1a] border-neutral-800 text-neutral-600 cursor-not-allowed"
            )}
            title="上移一位"
          >
            <ArrowUp size={13} />
            <span>上移</span>
          </button>

          <button
            onClick={() => onMove(collection.id, 'down')}
            disabled={!canMoveDown}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              canMoveDown 
                ? "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white" 
                : "bg-[#1a1a1a] border-neutral-800 text-neutral-600 cursor-not-allowed"
            )}
            title="下移一位"
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
            title={isConfirmingDelete ? "点击确认删除" : "删除集合"}
          >
            <Trash2 size={13} />
            <span>{isConfirmingDelete ? "确认" : "删除"}</span>
          </button>
        </div>

        {isConfirmingDelete && (
          <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 p-2 rounded flex items-center justify-between">
            <span>确认删除该集合并从所有资产解除？</span>
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
            集合名称 (重命名)
          </label>
          <input
            type="text"
            value={collection.name}
            onChange={(e) => onUpdate(collection.id, { name: e.target.value })}
            className="w-full bg-[#141414] border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-500"
            placeholder="输入集合名称..."
          />
        </div>

        {/* Theme Accent Color */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            集合主题色标
          </label>
          <div className="grid grid-cols-4 gap-2 mb-2">
            {COLLECTION_COLORS.map(c => (
              <button
                key={c.hex}
                onClick={() => onUpdate(collection.id, { color: c.hex })}
                className={cn(
                  "py-1.5 px-2 rounded-md flex items-center gap-1.5 border text-xs transition-all",
                  activeColor.toLowerCase() === c.hex.toLowerCase()
                    ? "bg-[#282828] border-white text-white font-medium shadow"
                    : "bg-[#161616] border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
                )}
              >
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.hex }} />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Description Field */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
            集合备注与项目背景
          </label>
          <textarea
            value={collection.description || ''}
            onChange={(e) => onUpdate(collection.id, { description: e.target.value })}
            placeholder="记录此集合的项目背景、策划用途或归档说明..."
            rows={3}
            className="w-full bg-[#141414] border border-neutral-700 rounded-md p-2.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500 resize-none"
          />
        </div>

        {/* Info & Stats Card */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            集合统计与排位
          </label>
          <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 space-y-2.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <Layers size={13} className="text-amber-400" /> 集合收录素材
              </span>
              <span className="font-semibold text-neutral-200">{collectedAssets.length} 项</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <HardDrive size={13} className="text-emerald-400" /> 总文件容量
              </span>
              <span className="font-semibold text-neutral-200">{formatBytes(totalSizeBytes)}</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <Folder size={13} className="text-blue-400" /> 关联文件夹
              </span>
              <span className="font-semibold text-neutral-200">{collectedFolders.length} 个</span>
            </div>

            <div className="pt-2 border-t border-neutral-800/80 flex justify-between items-center text-xs">
              <span className="text-neutral-500">集合排列位置</span>
              <span className="text-neutral-400 font-mono">
                第 {currentIndex + 1} / {allCollections.length} 位
              </span>
            </div>
          </div>
        </div>

        {/* Thumbnail Preview */}
        {collectedAssets.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
                收录资产缩略预览
              </label>
              <span className="text-[10px] text-neutral-500">{collectedAssets.length} items</span>
            </div>
            
            <div className="grid grid-cols-3 gap-1.5">
              {collectedAssets.slice(0, 6).map(asset => (
                <div 
                  key={asset.id} 
                  className="aspect-square bg-[#121212] border border-neutral-800 rounded overflow-hidden relative group"
                  title={asset.name}
                >
                  <ThumbnailImage
                    asset={asset}
                    className="w-full h-full object-cover"
                    fallbackIcon={<ImageIcon size={18} className="text-neutral-600" />}
                    loading="lazy"
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-black/70 p-0.5 text-[9px] text-neutral-300 truncate text-center opacity-0 group-hover:opacity-100 transition-opacity">
                    {asset.name}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
