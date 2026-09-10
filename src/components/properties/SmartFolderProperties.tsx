import React, { useState, useMemo } from 'react';
import { 
  Filter, Pin, PinOff, ArrowUp, ArrowDown, Trash2, Plus, Trash, 
  LayoutGrid, Clock, Tag as TagIcon, Image as ImageIcon, Box, 
  Search, Star, Heart, Flame, Bookmark, Sparkles, HardDrive, Check 
} from 'lucide-react';
import { SmartFolder, SmartFolderRule, Asset, Tag, Collection } from '../../types';
import { formatBytes, cn } from '../../lib/utils';
import { ThumbnailImage } from '../ThumbnailImage';

interface SmartFolderPropertiesProps {
  smartFolder: SmartFolder;
  allSmartFolders: SmartFolder[];
  assets: Asset[];
  tags: Tag[];
  collections: Collection[];
  onUpdate: (id: string, updates: Partial<SmartFolder>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onTogglePin: (id: string) => void;
}

const AVAILABLE_ICONS = [
  { id: 'Filter', icon: Filter, label: 'Filter' },
  { id: 'LayoutGrid', icon: LayoutGrid, label: 'Grid' },
  { id: 'Clock', icon: Clock, label: 'Recent' },
  { id: 'Tag', icon: TagIcon, label: 'Tag' },
  { id: 'Image', icon: ImageIcon, label: 'Image' },
  { id: 'Box', icon: Box, label: '3D Box' },
  { id: 'Search', icon: Search, label: 'Search' },
  { id: 'Star', icon: Star, label: 'Star' },
  { id: 'Heart', icon: Heart, label: 'Favorite' },
  { id: 'Flame', icon: Flame, label: 'Hot' },
  { id: 'Bookmark', icon: Bookmark, label: 'Bookmark' },
  { id: 'Sparkles', icon: Sparkles, label: 'AI/Magic' }
];

export function SmartFolderProperties({
  smartFolder,
  allSmartFolders,
  assets,
  tags,
  collections,
  onUpdate,
  onDelete,
  onMove,
  onTogglePin
}: SmartFolderPropertiesProps) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  // Compute matched assets with useMemo（避免每次渲染都全量 filter + reduce）
  // 保留原始子串匹配语义：tag.name.includes(rule.value)
  const matchedAssets = useMemo(() => {
    const rules = smartFolder.rules;
    if (!rules || rules.length === 0) {
      if (smartFolder.filter) {
        return assets.filter(smartFolder.filter);
      }
      return assets; // 无规则 → 全部匹配
    }

    // 预计算每条规则的 tag/collection 子串匹配 ID 集
    const precomputed = rules.map(rule => {
      if (rule.type === 'tag') {
        const valLower = rule.value.toLowerCase();
        const ids = new Set<string>();
        for (const t of tags) {
          if (t.name.toLowerCase().includes(valLower)) ids.add(t.id);
        }
        return { rule, tagIds: ids, colIds: new Set<string>() };
      }
      if (rule.type === 'collection') {
        const valLower = rule.value.toLowerCase();
        const ids = new Set<string>();
        for (const c of collections) {
          if (c.name.toLowerCase().includes(valLower)) ids.add(c.id);
        }
        return { rule, tagIds: new Set<string>(), colIds: ids };
      }
      return { rule, tagIds: new Set<string>(), colIds: new Set<string>() };
    });

    const result: Asset[] = [];
    for (const asset of assets) {
      const matches = precomputed.map(p => {
        const { rule } = p;
        if (rule.type === 'name') return asset.name.toLowerCase().includes(rule.value.toLowerCase());
        if (rule.type === 'tag') return asset.tags.some(tid => p.tagIds.has(tid));
        if (rule.type === 'collection') return asset.collections.some(cid => p.colIds.has(cid));
        if (rule.type === 'type') return asset.type.toLowerCase() === rule.value.toLowerCase();
        return false;
      });
      if (smartFolder.matchAll ? matches.every(Boolean) : matches.some(Boolean)) {
        result.push(asset);
      }
    }
    return result;
  }, [assets, tags, collections, smartFolder]);

  const totalSizeBytes = useMemo(() => {
    let sum = 0;
    for (const a of matchedAssets) sum += a.size;
    return sum;
  }, [matchedAssets]);
  const currentIndex = allSmartFolders.findIndex(sf => sf.id === smartFolder.id);
  const canMoveUp = currentIndex > 0;
  const canMoveDown = currentIndex >= 0 && currentIndex < allSmartFolders.length - 1;

  const handleDelete = () => {
    if (isConfirmingDelete) {
      onDelete(smartFolder.id);
      setIsConfirmingDelete(false);
    } else {
      setIsConfirmingDelete(true);
    }
  };

  const handleAddRule = () => {
    const newRule: SmartFolderRule = {
      id: Date.now().toString(),
      type: 'name',
      operator: 'contains',
      value: ''
    };
    onUpdate(smartFolder.id, {
      rules: [...(smartFolder.rules || []), newRule]
    });
  };

  const CurrentIconComponent = AVAILABLE_ICONS.find(i => i.id === smartFolder.icon)?.icon || Filter;

  return (
    <div className="w-full flex-shrink-0 bg-[#1e1e1e] border-l border-neutral-800 flex flex-col h-full overflow-y-auto custom-scrollbar select-none">
      {/* Header Banner */}
      <div className="p-4 border-b border-neutral-800 bg-[#191919]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <CurrentIconComponent size={16} />
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-neutral-500 tracking-wider">智能文件夹属性</div>
              <div className="text-sm font-semibold text-white truncate max-w-[140px]">{smartFolder.name}</div>
            </div>
          </div>

          {smartFolder.isPinned && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-amber-400 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-full">
              <Pin size={11} className="fill-amber-400" /> 已置顶
            </span>
          )}
        </div>

        {/* Quick Action Toolbar */}
        <div className="grid grid-cols-4 gap-1.5 pt-1">
          <button
            onClick={() => onTogglePin(smartFolder.id)}
            className={cn(
              "flex items-center justify-center gap-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors",
              smartFolder.isPinned 
                ? "bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30" 
                : "bg-[#252525] border-neutral-700/60 text-neutral-300 hover:bg-neutral-700 hover:text-white"
            )}
            title={smartFolder.isPinned ? "取消置顶" : "置顶到顶部"}
          >
            {smartFolder.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            <span>{smartFolder.isPinned ? "已置顶" : "置顶"}</span>
          </button>

          <button
            onClick={() => onMove(smartFolder.id, 'up')}
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
            onClick={() => onMove(smartFolder.id, 'down')}
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
            title={isConfirmingDelete ? "确认删除智能文件夹" : "删除智能文件夹"}
          >
            <Trash2 size={13} />
            <span>{isConfirmingDelete ? "确认" : "删除"}</span>
          </button>
        </div>

        {isConfirmingDelete && (
          <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 p-2 rounded flex items-center justify-between">
            <span>确认删除该智能文件夹？</span>
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
            智能文件夹名称 (重命名)
          </label>
          <input
            type="text"
            value={smartFolder.name}
            onChange={(e) => onUpdate(smartFolder.id, { name: e.target.value })}
            className="w-full bg-[#141414] border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-blue-500"
            placeholder="输入智能文件夹名称..."
          />
        </div>

        {/* Icon Selector */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            图标标识
          </label>
          <div className="grid grid-cols-6 gap-1.5">
            {AVAILABLE_ICONS.map(({ id, icon: IconComponent }) => (
              <button
                key={id}
                onClick={() => onUpdate(smartFolder.id, { icon: id })}
                className={cn(
                  "p-2 rounded-md flex items-center justify-center border transition-colors",
                  smartFolder.icon === id 
                    ? "bg-blue-600 border-blue-400 text-white shadow-md shadow-blue-500/30" 
                    : "bg-[#161616] border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-white"
                )}
                title={id}
              >
                <IconComponent size={15} />
              </button>
            ))}
          </div>
        </div>

        {/* Description Field */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-1.5">
            描述与过滤用途
          </label>
          <textarea
            value={smartFolder.description || ''}
            onChange={(e) => onUpdate(smartFolder.id, { description: e.target.value })}
            placeholder="说明此智能文件夹的过滤逻辑和场景用途..."
            rows={2}
            className="w-full bg-[#141414] border border-neutral-700 rounded-md p-2.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Matching Criteria & Rule Builder (for customizable smart folders) */}
        {smartFolder.rules !== undefined ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
                匹配规则配置
              </label>
              <select
                value={smartFolder.matchAll ? 'all' : 'any'}
                onChange={(e) => onUpdate(smartFolder.id, { matchAll: e.target.value === 'all' })}
                className="bg-[#141414] border border-neutral-700 text-neutral-300 text-xs rounded px-2 py-0.5 focus:outline-none"
              >
                <option value="all">满足全部条件 (AND)</option>
                <option value="any">满足任意条件 (OR)</option>
              </select>
            </div>

            <div className="space-y-2 mb-3">
              {smartFolder.rules.map((rule, idx) => (
                <div key={rule.id} className="bg-[#161616] border border-neutral-800 rounded-lg p-2.5 relative group">
                  <button 
                    onClick={() => {
                      const newRules = smartFolder.rules!.filter(r => r.id !== rule.id);
                      onUpdate(smartFolder.id, { rules: newRules });
                    }}
                    className="absolute top-2 right-2 text-neutral-500 hover:text-red-400 opacity-60 group-hover:opacity-100 transition-opacity"
                    title="移除该规则"
                  >
                    <Trash size={13} />
                  </button>

                  <div className="grid grid-cols-2 gap-1.5 mb-1.5 pr-6">
                    <select
                      value={rule.type}
                      onChange={(e) => {
                        const newRules = [...smartFolder.rules!];
                        newRules[idx] = { ...rule, type: e.target.value as any };
                        onUpdate(smartFolder.id, { rules: newRules });
                      }}
                      className="bg-[#202020] border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none"
                    >
                      <option value="name">文件名包含</option>
                      <option value="tag">包含标签</option>
                      <option value="collection">所属集合</option>
                      <option value="type">资产类型 (扩展名)</option>
                    </select>

                    <select
                      value={rule.operator}
                      onChange={(e) => {
                        const newRules = [...smartFolder.rules!];
                        newRules[idx] = { ...rule, operator: e.target.value as any };
                        onUpdate(smartFolder.id, { rules: newRules });
                      }}
                      className="bg-[#202020] border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none"
                    >
                      <option value="contains">包含 (Contains)</option>
                      <option value="equals">等于 (Equals)</option>
                    </select>
                  </div>

                  <input
                    type="text"
                    placeholder="输入匹配值 (如: png, render, UI)..."
                    value={rule.value}
                    onChange={(e) => {
                      const newRules = [...smartFolder.rules!];
                      newRules[idx] = { ...rule, value: e.target.value };
                      onUpdate(smartFolder.id, { rules: newRules });
                    }}
                    className="w-full bg-[#1e1e1e] border border-neutral-700 rounded px-2.5 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500"
                  />
                </div>
              ))}

              <button
                onClick={handleAddRule}
                className="w-full py-1.5 border border-dashed border-neutral-700 hover:border-blue-500/60 rounded-md text-xs font-medium text-neutral-400 hover:text-blue-400 hover:bg-blue-500/5 transition-all flex items-center justify-center gap-1"
              >
                <Plus size={13} /> 添加过滤条件规则
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 text-xs text-neutral-400 leading-relaxed">
            <div className="text-blue-400 font-medium mb-1">系统内置预设过滤器</div>
            此文件夹由系统智能引擎按特定业务规则动态聚合，支持重命名、调整排位与置顶。
          </div>
        )}

        {/* Stats Card */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">
            实时匹配统计
          </label>
          <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 space-y-2.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <Filter size={13} className="text-blue-400" /> 匹配资产总数
              </span>
              <span className="font-semibold text-neutral-200">{matchedAssets.length} 项</span>
            </div>

            <div className="flex justify-between items-center text-xs">
              <span className="text-neutral-400 flex items-center gap-1.5">
                <HardDrive size={13} className="text-emerald-400" /> 匹配文件总大小
              </span>
              <span className="font-semibold text-neutral-200">{formatBytes(totalSizeBytes)}</span>
            </div>

            <div className="pt-2 border-t border-neutral-800/80 flex justify-between items-center text-xs">
              <span className="text-neutral-500">列表顺序排位</span>
              <span className="text-neutral-400 font-mono">
                第 {currentIndex + 1} / {allSmartFolders.length} 位
              </span>
            </div>
          </div>
        </div>

        {/* Thumbnail Preview */}
        {matchedAssets.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block">
                匹配资产缩略预览
              </label>
              <span className="text-[10px] text-neutral-500">{matchedAssets.length} items</span>
            </div>
            
            <div className="grid grid-cols-3 gap-1.5">
              {matchedAssets.slice(0, 6).map(asset => (
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
