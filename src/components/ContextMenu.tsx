import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  // Escape key closes menu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Adjust coordinates to prevent clipping
  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const pad = 10;
      let adjX = x;
      let adjY = y;
      
      if (adjX + rect.width > window.innerWidth - pad) {
        adjX = Math.max(pad, window.innerWidth - rect.width - pad);
      }
      if (adjY + rect.height > window.innerHeight - pad) {
        adjY = Math.max(pad, window.innerHeight - rect.height - pad);
      }
      setPosition({ x: adjX, y: adjY });
    }
  }, [x, y, items]);

  return (
    <>
      {/* 1. Invisible backdrop to trap clicks/right-clicks anywhere outside */}
      <div 
        className="fixed inset-0 z-[9998] bg-transparent cursor-default"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />

      {/* 2. Context Menu Dropdown */}
      <div 
        ref={menuRef}
        className="fixed z-[9999] min-w-[200px] max-w-[280px] bg-white dark:bg-[#1e1e1e] border border-neutral-200 dark:border-neutral-700/80 rounded-lg shadow-2xl overflow-hidden py-1 text-xs font-medium select-none"
        style={{ top: position.y, left: position.x }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, idx) => {
          if (item.divider) {
            return <div key={idx} className="h-px bg-neutral-200 dark:bg-neutral-800 my-1" />;
          }
          return (
            <button
              key={idx}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                item.onClick();
                onClose();
              }}
              className={cn(
                "w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors",
                item.danger 
                  ? "text-red-600 dark:text-red-400 hover:bg-red-500/10" 
                  : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-white"
              )}
            >
              {item.icon && <span className="opacity-80 shrink-0">{item.icon}</span>}
              <span className="truncate flex-1">{item.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
