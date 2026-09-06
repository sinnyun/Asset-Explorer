import React, { useState } from 'react';
import { Tag as TagIcon, Layers, Trash2, X, Plus } from 'lucide-react';
import { AssetState, Tag, Collection } from '../types';

interface BulkActionBarProps {
  state: AssetState;
  onClear: () => void;
  onAddTags: (tagIds: string[]) => void;
  onAddCollections: (collectionIds: string[]) => void;
  onDelete: () => void;
}

export function BulkActionBar({ state, onClear, onAddTags, onAddCollections, onDelete }: BulkActionBarProps) {
  const [showTags, setShowTags] = useState(false);
  const [showCols, setShowCols] = useState(false);
  
  if (state.selectedItems.length === 0) return null;

  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div className="bg-white/90 dark:bg-neutral-900/90 backdrop-blur-xl border border-neutral-200 dark:border-neutral-800 shadow-2xl rounded-full px-4 py-2 flex items-center gap-4 text-sm font-medium">
        
        <div className="flex items-center gap-2 text-neutral-800 dark:text-white px-2">
          <div className="w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs">
            {state.selectedItems.length}
          </div>
          <span>Selected</span>
        </div>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-700" />

        <div className="relative">
          <button 
            onClick={() => { setShowTags(!showTags); setShowCols(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <TagIcon size={16} /> Add Tags
          </button>
          {showTags && (
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-xl p-2 max-h-48 overflow-y-auto">
              <div className="text-xs text-neutral-500 font-semibold mb-2 px-1">APPLY TAGS</div>
              {state.tags.map(tag => (
                <button 
                  key={tag.id}
                  onClick={() => { onAddTags([tag.id]); setShowTags(false); }}
                  className="w-full text-left px-2 py-1.5 rounded text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-2"
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <button 
            onClick={() => { setShowCols(!showCols); setShowTags(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <Layers size={16} /> Add Collections
          </button>
          {showCols && (
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-xl p-2 max-h-48 overflow-y-auto">
              <div className="text-xs text-neutral-500 font-semibold mb-2 px-1">APPLY COLLECTIONS</div>
              {state.collections.map(col => (
                <button 
                  key={col.id}
                  onClick={() => { onAddCollections([col.id]); setShowCols(false); }}
                  className="w-full text-left px-2 py-1.5 rounded text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {col.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-700" />

        <button 
          onClick={onDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={16} /> Delete
        </button>

        <button 
          onClick={onClear}
          className="p-1.5 rounded-full text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ml-2"
          title="Clear Selection"
        >
          <X size={16} />
        </button>

      </div>
    </div>
  );
}
