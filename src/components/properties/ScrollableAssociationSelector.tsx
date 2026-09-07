import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, Check, Plus, Layers, Hash, CornerDownLeft, Sparkles, LayoutList, LayoutGrid } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface AssociationItem {
  id: string;
  name: string;
  color?: string;
  description?: string;
}

interface ScrollableAssociationSelectorProps {
  type: 'tag' | 'collection';
  items: AssociationItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  title?: string;
  placeholder?: string;
}

export function ScrollableAssociationSelector({
  type,
  items,
  onSelect,
  onClose,
  title,
  placeholder,
}: ScrollableAssociationSelectorProps) {
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 默认标题与占位符
  const defaultTitle = type === 'tag' ? '添加标签' : '添加集合';
  const defaultPlaceholder = type === 'tag' ? '搜索待添加标签...' : '搜索待添加集合...';

  // 根据搜索词即时过滤
  const filteredItems = useMemo(() => {
    if (!search.trim()) return items;
    const query = search.trim().toLowerCase();
    return items.filter(item => item.name.toLowerCase().includes(query));
  }, [items, search]);

  // 当过滤列表变化时，重置高亮索引，防止越界
  useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredItems.length, search]);

  // 自动聚焦搜索框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 滚动高亮项到视野内
  useEffect(() => {
    if (highlightedIndex >= 0 && itemRefs.current[highlightedIndex]) {
      itemRefs.current[highlightedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [highlightedIndex]);

  // 处理选中项（点击或回车），给予微动效并支持连续添加
  const handleSelect = (item: AssociationItem) => {
    setRecentlyAddedId(item.id);
    onSelect(item.id);
    setTimeout(() => {
      setRecentlyAddedId(null);
    }, 600);
  };

  /**
   * 循环列表键盘事件处理 (Cyclic Navigation)
   * - ArrowDown: 移到下一项，末项时循环回到第 0 项
   * - ArrowUp: 移到上一项，首项时循环跳到最后一项
   * - Enter: 选中当前高亮项
   * - Escape: 关闭面板
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredItems.length === 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      return;
    }

    const total = filteredItems.length;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev + 1) % total);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev - 1 + total) % total);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < total) {
        handleSelect(filteredItems[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const isTag = type === 'tag';

  return (
    <div 
      className="mt-2.5 bg-[#171717] border border-neutral-700/80 rounded-lg p-2.5 shadow-xl shadow-black/50 text-neutral-200 transition-all select-none animate-in fade-in zoom-in-95 duration-150"
      onKeyDown={handleKeyDown}
    >
      {/* 头部标题与统计信息 */}
      <div className="flex items-center justify-between pb-2 border-b border-neutral-800/90 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-neutral-300">
          {isTag ? <Hash size={13} className="text-blue-400" /> : <Layers size={13} className="text-amber-400" />}
          <span>{title || defaultTitle}</span>
          <span className="text-[10px] text-neutral-500 font-mono ml-1 px-1.5 py-0.2 rounded bg-neutral-800 border border-neutral-700/50">
            {filteredItems.length}{filteredItems.length !== items.length ? ` / ${items.length}` : ''}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* 模式切换：列表 vs 紧凑徽章 */}
          <button
            type="button"
            onClick={() => setViewMode(viewMode === 'list' ? 'grid' : 'list')}
            className="p-1 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
            title={viewMode === 'list' ? '切换为紧凑徽章网格' : '切换为详细单列列表'}
          >
            {viewMode === 'list' ? <LayoutGrid size={12} /> : <LayoutList size={12} />}
          </button>

          {/* 关闭按钮 */}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
            title="关闭 (Esc)"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 搜索过滤输入框 */}
      <div className="mt-2 relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={placeholder || defaultPlaceholder}
          className="w-full bg-[#111111] border border-neutral-800 focus:border-neutral-600 rounded-md pl-7 pr-7 py-1 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none transition-colors"
        />
        {search && (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 p-0.5"
            title="清空搜索"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {/* 核心：受控最大高度的滚动/循环列表 */}
      <div 
        ref={listRef}
        className={cn(
          "mt-2 overflow-y-auto custom-scrollbar pr-0.5",
          // 控制最大高度，杜绝长页面撑爆的问题
          viewMode === 'list' ? "max-h-48 space-y-1" : "max-h-48 flex flex-wrap gap-1.5 p-0.5"
        )}
      >
        {filteredItems.length > 0 ? (
          filteredItems.map((item, idx) => {
            const isHighlighted = idx === highlightedIndex;
            const isJustAdded = recentlyAddedId === item.id;

            if (viewMode === 'grid') {
              // 紧凑徽章模式
              return (
                <button
                  key={item.id}
                  ref={el => { itemRefs.current[idx] = el; }}
                  type="button"
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-all text-left group",
                    isJustAdded
                      ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300"
                      : isHighlighted
                        ? "bg-neutral-800 border-neutral-600 text-white shadow-sm"
                        : "bg-[#1f1f1f] border-neutral-800 text-neutral-300 hover:bg-[#282828] hover:border-neutral-700"
                  )}
                  title={item.name}
                >
                  {isTag ? (
                    <span 
                      className="w-2 h-2 rounded-full shrink-0" 
                      style={{ backgroundColor: item.color || '#3B82F6' }} 
                    />
                  ) : (
                    <Layers size={11} className="text-amber-400 shrink-0" />
                  )}
                  <span className="truncate max-w-[120px]">{item.name}</span>
                  <Plus size={10} className="text-neutral-500 group-hover:text-neutral-300 shrink-0 ml-0.5" />
                </button>
              );
            }

            // 垂直列表模式
            return (
              <button
                key={item.id}
                ref={el => { itemRefs.current[idx] = el; }}
                type="button"
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setHighlightedIndex(idx)}
                className={cn(
                  "w-full flex items-center justify-between text-xs px-2.5 py-1.5 rounded-md border transition-all text-left group",
                  isJustAdded 
                    ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                    : isHighlighted 
                      ? "bg-neutral-800 border-neutral-600/80 text-white shadow-sm" 
                      : "bg-[#1b1b1b] border-transparent hover:bg-neutral-800/60 text-neutral-300 hover:text-white"
                )}
              >
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  {isTag ? (
                    <span 
                      className="w-2 h-2 rounded-full shrink-0 ring-1 ring-black/40" 
                      style={{ backgroundColor: item.color || '#3B82F6' }} 
                    />
                  ) : (
                    <Layers size={12} className="text-amber-400 shrink-0" />
                  )}
                  <span className="truncate font-medium">{item.name}</span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {isJustAdded ? (
                    <span className="flex items-center gap-0.5 text-[10px] text-emerald-400 font-medium">
                      <Check size={11} /> 已添加
                    </span>
                  ) : (
                    <span className={cn(
                      "flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded transition-all",
                      isHighlighted 
                        ? "bg-blue-600/30 text-blue-300 border border-blue-500/40" 
                        : "text-neutral-500 group-hover:text-neutral-300 bg-neutral-800/80"
                    )}>
                      <Plus size={10} /> 添加
                    </span>
                  )}
                </div>
              </button>
            );
          })
        ) : (
          <div className="py-6 px-3 text-center text-xs text-neutral-500 flex flex-col items-center justify-center gap-1.5">
            <span className="text-neutral-600">
              {search ? '未找到匹配项' : `暂无待添加的${isTag ? '标签' : '集合'}`}
            </span>
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-[11px] text-blue-400 hover:underline"
              >
                清空搜索关键词
              </button>
            )}
          </div>
        )}
      </div>

      {/* 底部循环导航提示与状态提示栏 */}
      <div className="mt-2 pt-1.5 border-t border-neutral-800/80 flex items-center justify-between text-[10px] text-neutral-500 px-0.5">
        <span className="flex items-center gap-1">
          <span className="font-mono bg-neutral-800 px-1 py-0.2 rounded text-neutral-400 border border-neutral-700/50">↑↓</span>
          <span>循环滚动</span>
          <span className="font-mono bg-neutral-800 px-1 py-0.2 rounded text-neutral-400 border border-neutral-700/50 ml-1">↵</span>
          <span>添加</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          完成
        </button>
      </div>
    </div>
  );
}
