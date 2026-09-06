import React from 'react';
import { ChevronRight, ChevronDown, Pin } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface NavItemProps {
  key?: React.Key;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  indent?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  isPinned?: boolean;
  onToggleExpand?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function NavItem({ 
  active, 
  onClick, 
  icon, 
  label, 
  count,
  indent = 0, 
  hasChildren = false, 
  isExpanded = false, 
  isPinned = false,
  onToggleExpand,
  onContextMenu
}: NavItemProps) {
  return (
    <div className="relative group" onContextMenu={onContextMenu}>
      {indent > 0 && (
        <div 
          className="absolute border-l border-neutral-700/50" 
          style={{ left: `${(indent - 1) * 12 + 20}px`, top: 0, bottom: 0 }}
        />
      )}
      
      <div
        className={cn(
          "w-full flex items-center px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer group/item",
          active ? "bg-blue-500/15 text-blue-400 font-medium" : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
        )}
        style={{ paddingLeft: `${indent * 12 + 8}px` }}
      >
        {hasChildren ? (
          <button 
            onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
            className="w-4 h-4 flex items-center justify-center mr-1 text-neutral-500 hover:text-neutral-300 shrink-0 z-10"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <div className="w-4 mr-1 shrink-0" />
        )}
        
        <div 
          className="flex flex-1 items-center gap-2 overflow-hidden z-10 py-0.5"
          onClick={onClick}
        >
          <div className="shrink-0">{icon}</div>
          <span className="truncate flex-1 text-[13px]" title={label}>{label}</span>
          {isPinned && (
            <Pin size={11} className="text-amber-400 fill-amber-400/80 shrink-0" title="已置顶" />
          )}
          {count !== undefined && (
            <span className={cn(
              "text-[11px] px-1.5 py-0.2 rounded-full font-mono shrink-0 transition-colors",
              active ? "bg-blue-500/20 text-blue-300 font-medium" : "text-neutral-500 group-hover/item:text-neutral-400"
            )}>
              {count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
