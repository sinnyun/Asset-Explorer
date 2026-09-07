import React, { useState, useMemo } from 'react';
import { Hash, Pin, PinOff, ArrowUp, ArrowDown, Trash2, Tag as TagIcon, 
  Layers, HardDrive, Calendar, Check, ExternalLink, Image as ImageIcon 
} from 'lucide-react';
import { Tag, Asset, Folder } from '../../types';
import { formatBytes, cn } from '../../lib/utils';
import { ThumbnailImage } from '../ThumbnailImage';

interface TagPropertiesProps {
  tag: Tag;
  allTags: Tag[];
  assets: Asset[];
  folders: Folder[];
  onUpdate: (id: string, updates: Partial<Tag>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onTogglePin: (id: string) => void;
}

const COLOR_PRESETS = [
  { name: 'Red', hex: '#ef4444' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Purple', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Lime', hex: '#84cc16' },
  { name: 'Slate', hex: '#64748b' }
];

export function TagProperties({
  tag,
  allTags,
  assets,
  folders,
  onUpdate,
  onDelete,
  onMove,
  onTogglePin
}: TagPropertiesProps) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  // Filter assets and folders containing this tag
  // useMemo 优化计算
  const taggedAssets = useMemo(
    () => assets.filter(a => a.tags.includes(tag.id)),
    [assets, tag.id]
  );
  const taggedFolders = useMemo(
    () => folders.filter(f => f.tags.includes(tag.id)),
    [folders, tag.id]
  );
  const totalSizeBytes = useMemo(() => {
    let sum = 0;
    for (const a of taggedAssets) sum += a.size;
    return sum;
  }, [taggedAssets]);

  // Order index and moving capability
  const currentIndex = allTags.findIndex(t => t.id === tag.id);
  const canMoveUp = currentIndex > 0;
  const canMoveDown = currentIndex >= 0 && currentIndex < allTags.length - 1;

  const handleDelete = () => {
    if (isConfirmingDelete) {
      onDelete(tag.id);
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
              style={{ backgroundColor: `${tag.color}25`, border: `1px solid ${tag.color}60` }}
            >
              <Hash size={16} style={{ color: tag.color }} />
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-neutral-500 tracking-wider">标签属性</div>
              <div className="text-sm font-semibold text-white truncate max-w-[140px]">{tag.name}</div>
            </div>
          </div>

          {tag.isPinned && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-amber-400 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-full">
              <Pin size={11} className="fill-amber-400" /> 已置顶
            </span>
          )}
        </div>

        {/* Quick Action Toolbar */}
        <div className="grid grid-cols-4 gap-1.5 pt-1">
          <button
            onClick={() => onTogglePin(tag.id)}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              tag.isPinned 
                ? "bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30" 
                : "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white"
            )}
            title={tag.isPinned ? "取消置顶" : "置顶到顶部"}
          >
            {tag.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            <span>{tag.isPinned ? "已置顶" : "置顶"}</span>
          </button>

          <button
            onClick={() => onMove(tag.id, 'up')}
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
            onClick={() => onMove(tag.id, 'down')}
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
            title={isConfirmingDelete ? "点击确认删除" : "删除标签"}
          >
            <Trash2 size={13} />
            <span>{isConfirmingDelete ? "确认" : "删除"}</span>
          </button>
        </div>

        {isConfirmingDelete && (
          <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 p-2 rounded flex items-center justify-between">
            <span>确认删除该标签并解除关联？</span>
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
            标签名称 (重命名)
          </label>
          <div className="relative">
            <input
              type="text"
              value={tag.name}
              onChange={(e) => onUpdate(tag.id, { name: e.target.value })}
              className="w-full bg-[#141414] border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-blue-500"
              placeholder="输入标签名称..."
            />
          </div>
        </div>

        {/* Color Palette */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            标签专属色彩
          </label>
          <div className="grid grid-cols-6 gap-2 mb-3">
            {COLOR_PRESETS.map(preset => (
              <button
                key={preset.hex}
                onClick={() => onUpdate(tag.id, { color: preset.hex })}
                className={cn(
                  "w-full aspect-square rounded-md flex items-center justify-center transition-transform hover:scale-110 relative",
                  tag.color.toLowerCase() === preset.hex.toLowerCase() && "ring-2 ring-white ring-offset-2 ring-offset-[#1e1e1e]"
                )}
                style={{ backgroundColor: preset.hex }}
                title={preset.name}
              >
                {tag.color.toLowerCase() === preset.hex.toLowerCase() && (
                  <Check size={12} className="text-white drop-shadow" />
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 bg-[#141414] border border-neutral-700/80 rounded-md px-2.5 py-1.5">
            <div 
              className="w-4 h-4 rounded-full shrink-0 border border-neutral-600"
              style={{ backgroundColor: tag.color }} 
            />
            <span className="text-xs text-neutral-500 font-mono">HEX</span>
            <input
              type="text"
              value={tag.color}
              onChange={(e) => onUpdate(tag.id, { color: e.target.value })}
              className="bg-transparent text-xs text-neutral-200 font-mono focus:outline-none flex-1 uppercase"
              placeholder="#3B82F6"
            />
          </div>
        </div>

        {/* Description Field */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
            标签备注说明
          </label>
          <textarea
            value={tag.description || ''}
            onChange={(e) => onUpdate(tag.id, { description: e.target.value })}
            placeholder="添加此标签的业务用途或使用规范说明..."
            rows={3}
            className="w-full bg-[#141414] border border-neutral-700 rounded-md p-2.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Info & Stats Card */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            关联与位置统计
          </label>
          <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 space-y-2.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <TagIcon size={13} className="text-blue-400" /> 关联资产数量
              </span>
              <span className="font-semibold text-neutral-200">{taggedAssets.length} 项</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <HardDrive size={13} className="text-emerald-400" /> 资产占用容量
              </span>
              <span className="font-semibold text-neutral-200">{formatBytes(totalSizeBytes)}</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <Layers size={13} className="text-purple-400" /> 关联目录数量
              </span>
              <span className="font-semibold text-neutral-200">{taggedFolders.length} 个</span>
            </div>

            <div className="pt-2 border-t border-neutral-800/80 flex justify-between items-center text-xs">
              <span className="text-neutral-500">列表顺序排位</span>
              <span className="text-neutral-400 font-mono">
                第 {currentIndex + 1} / {allTags.length} 位
              </span>
            </div>
          </div>
        </div>

        {/* Associated Assets Thumbnail Preview */}
        {taggedAssets.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
                关联资产缩略预览
              </label>
              <span className="text-[10px] text-neutral-500">{taggedAssets.length} items</span>
            </div>
            
            <div className="grid grid-cols-3 gap-1.5">
              {taggedAssets.slice(0, 6).map(asset => (
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
