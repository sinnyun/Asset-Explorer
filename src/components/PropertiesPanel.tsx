import React from 'react';
import { 
  HardDrive, Calendar, Image as ImageIcon, Folder, ExternalLink, 
  Copy, Hash, Layers, Filter,
  File, Route, Ruler, Clock, Shield
} from 'lucide-react';
import { AssetState, Folder as FolderType, Asset, SmartFolder, Tag, Collection } from '../types';
import { formatBytes, formatDate, cn } from '../lib/utils';
import { apiClient } from '../services/api';
import { TagProperties } from './properties/TagProperties';
import { CollectionProperties } from './properties/CollectionProperties';
import { SmartFolderProperties } from './properties/SmartFolderProperties';
import { FolderProperties } from './properties/FolderProperties';
import { AssetPreviewToggle } from './preview/AssetPreviewToggle';

interface PropertiesPanelProps {
  state: AssetState;
  smartFolders: SmartFolder[];
  onUpdateSmartFolder: (id: string, updates: Partial<SmartFolder>) => void;
  onDeleteSmartFolder: (id: string) => void;
  onMoveSmartFolder: (id: string, direction: 'up' | 'down') => void;
  onTogglePinSmartFolder: (id: string) => void;

  onUpdateTag: (id: string, updates: Partial<Tag>) => void;
  onDeleteTag: (id: string) => void;
  onMoveTag: (id: string, direction: 'up' | 'down') => void;
  onTogglePinTag: (id: string) => void;

  onUpdateCollection: (id: string, updates: Partial<Collection>) => void;
  onDeleteCollection: (id: string) => void;
  onMoveCollection: (id: string, direction: 'up' | 'down') => void;
  onTogglePinCollection: (id: string) => void;

  onUpdateFolder: (id: string, updates: Partial<FolderType>) => void;
  onDeleteFolder: (id: string) => void;
  onMoveFolder: (id: string, direction: 'up' | 'down') => void;
  onTogglePinFolder: (id: string) => void;
}

/**
 * 从文件名中提取真实文件扩展名（如 "photo.png" → "png"）
 */
function extractExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx === -1 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

/**
 * 展示文件格式标签：
 * - 优先显示真实扩展名（如 png、jpg）
 * - 若无扩展名则显示大类 (image/video/model)
 */
function getFormatLabel(asset: Asset): { format: string; category: string } {
  const ext = extractExtension(asset.name);
  const categoryLabels: Record<string, string> = {
    image: '图片',
    video: '视频',
    audio: '音频',
    model: '模型',
    '3d': '3D 模型',
    document: '文档',
    archive: '压缩包',
    other: '其他',
  };
  const category = categoryLabels[asset.type] || asset.type;
  if (ext) return { format: ext, category };
  return { format: asset.type, category };
}

/**
 * 获取尺寸显示字符串（兼容 width/height 与 dimensions 字段）
 */
function getDimensionsLabel(asset: Asset): string | null {
  if (asset.width && asset.height) {
    return `${asset.width} × ${asset.height}`;
  }
  if (asset.dimensions) return asset.dimensions;
  return null;
}

export function PropertiesPanel({
  state,
  smartFolders,
  onUpdateSmartFolder,
  onDeleteSmartFolder,
  onMoveSmartFolder,
  onTogglePinSmartFolder,
  onUpdateTag,
  onDeleteTag,
  onMoveTag,
  onTogglePinTag,
  onUpdateCollection,
  onDeleteCollection,
  onMoveCollection,
  onTogglePinCollection,
  onUpdateFolder,
  onDeleteFolder,
  onMoveFolder,
  onTogglePinFolder,
}: PropertiesPanelProps) {
  // Combine all smart folders (built-in + custom)
  const allSmartFolders = [...smartFolders, ...state.customSmartFolders];

  // 1. Check selected items first
  const selectedAssets = state.assets.filter(a => state.selectedItems.some(i => i.type === 'asset' && i.id === a.id));
  const selectedFolders = state.folders.filter(f => state.selectedItems.some(i => i.type === 'folder' && i.id === f.id));

  // If a single folder is selected in the canvas
  if (state.selectedItems.length === 1 && selectedFolders.length === 1) {
    return (
      <FolderProperties 
        folder={selectedFolders[0]}
        allFolders={state.folders}
        assets={state.assets}
        tags={state.tags}
        collections={state.collections}
        onUpdate={onUpdateFolder}
        onDelete={onDeleteFolder}
        onMove={onMoveFolder}
        onTogglePin={onTogglePinFolder}
      />
    );
  }

  // If multiple items are selected in the canvas
  if (selectedAssets.length > 0 || selectedFolders.length > 0) {
    if (selectedAssets.length === 1 && selectedFolders.length === 0) {
      // ============================================================
      // Single Asset View — 显示详细文件信息
      // ============================================================
      const asset = selectedAssets[0];
      const folder = state.folders.find(f => f.id === asset.folderId);
      const { format, category } = getFormatLabel(asset);
      const dimensions = getDimensionsLabel(asset);
      
      // 格式化 SHA-256，展示为前 16 位 + 后 4 位便于查看
      const displayHash = asset.fileHash 
        ? asset.fileHash.length > 24 
          ? `${asset.fileHash.slice(0, 16)}...${asset.fileHash.slice(-4)}`
          : asset.fileHash
        : null;

      return (
        <div className="w-80 flex-shrink-0 bg-[#1e1e1e] border-l border-neutral-800 flex flex-col h-full overflow-y-auto custom-scrollbar select-none">
          <div className="p-4 border-b border-neutral-800 bg-[#191919]">
            <AssetPreviewToggle asset={asset} />
            <div className="text-[10px] uppercase font-semibold text-neutral-500 tracking-wider">资产属性</div>
            <h2 className="text-sm font-semibold text-white break-all leading-tight mt-0.5">{asset.name}</h2>
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              {/* 文件格式徽章 */}
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2a2a2a] border border-neutral-700 text-[10px] text-blue-300 uppercase font-mono font-semibold">
                <File size={9} /> {format}
              </span>
              {/* 分类徽章 */}
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2a2a2a] border border-neutral-700 text-[10px] text-neutral-400">
                {category}
              </span>
              {/* 尺寸徽章 (仅媒体有) */}
              {dimensions && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2a2a2a] border border-neutral-700 text-[10px] text-amber-300 font-mono">
                  <Ruler size={9} /> {dimensions}
                </span>
              )}
            </div>
          </div>

          <div className="p-4 space-y-5">
            {/* System Actions */}
            <div>
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">快捷操作</label>
              <div className="space-y-1.5">
                <button
                  onClick={() => apiClient.openInExplorer(asset.path)}
                  className="w-full flex items-center justify-center gap-2 text-xs py-2 px-3 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors shadow-lg shadow-blue-600/20"
                >
                  <ExternalLink size={14} /> 打开资源管理器定位
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(asset.path);
                  }}
                  className="w-full flex items-center justify-center gap-2 text-xs py-1.5 px-3 rounded-md bg-[#282828] hover:bg-[#333] border border-neutral-700 text-neutral-300 transition-colors"
                >
                  <Copy size={13} /> 复制文件完整路径
                </button>
              </div>
            </div>

            {/* 详细文件信息 */}
            <div>
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">文件信息</label>
              <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 space-y-2.5">
                {/* 完整文件路径 */}
                <div className="flex items-start gap-1.5 text-xs">
                  <Route size={13} className="text-neutral-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-neutral-500 uppercase mb-0.5">地址 / Path</div>
                    <div 
                      className="text-neutral-200 font-mono text-[11px] break-all leading-relaxed cursor-pointer hover:text-blue-300 transition-colors"
                      title="点击复制完整路径"
                      onClick={() => navigator.clipboard.writeText(asset.path)}
                    >
                      {asset.path}
                    </div>
                  </div>
                </div>

                <div className="h-px bg-neutral-800 my-1" />

                {/* 格式 / Format */}
                <div className="flex justify-between items-center text-xs">
                  <span className="text-neutral-500 flex items-center gap-1.5"><File size={13} /> 格式</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-neutral-200 uppercase font-mono font-semibold">{format}</span>
                    {format !== asset.type && (
                      <span className="text-neutral-500 text-[10px]">({category})</span>
                    )}
                  </div>
                </div>

                {/* 大小 / Size */}
                <div className="flex justify-between items-center text-xs">
                  <span className="text-neutral-500 flex items-center gap-1.5"><HardDrive size={13} /> 大小</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-neutral-200 font-mono">{formatBytes(asset.size)}</span>
                    <span className="text-neutral-600 text-[10px] font-mono">({asset.size.toLocaleString()} B)</span>
                  </div>
                </div>

                {/* 尺寸 / Dimensions (仅当宽高信息可用时) */}
                {dimensions && (
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-neutral-500 flex items-center gap-1.5"><Ruler size={13} /> 尺寸</span>
                    <span className="text-neutral-200 font-mono">{dimensions} px</span>
                  </div>
                )}

                {/* SHA-256 哈希 */}
                {displayHash && (
                  <div className="flex justify-between items-start text-xs">
                    <span className="text-neutral-500 flex items-center gap-1.5 mt-0.5"><Shield size={13} /> SHA-256</span>
                    <span className="text-neutral-400 font-mono text-[10px] text-right break-all cursor-pointer hover:text-emerald-300 transition-colors" title="点击复制完整哈希"
                      onClick={() => asset.fileHash && navigator.clipboard.writeText(asset.fileHash)}>
                      {displayHash}
                    </span>
                  </div>
                )}

                <div className="h-px bg-neutral-800 my-1" />

                {/* 所属目录 */}
                <div className="flex justify-between items-center text-xs">
                  <span className="text-neutral-500 flex items-center gap-1.5"><Folder size={13} /> 所属目录</span>
                  <span className="text-neutral-300 font-medium truncate max-w-[140px]" title={folder?.name || folder?.path}>
                    {folder?.name || '未知'}
                  </span>
                </div>

                {/* 修改日期 */}
                <div className="flex justify-between items-center text-xs">
                  <span className="text-neutral-500 flex items-center gap-1.5"><Calendar size={13} /> 修改日期</span>
                  <span className="text-neutral-300 font-mono text-[11px]">{formatDate(asset.dateModified)}</span>
                </div>

                {/* 添加日期 */}
                <div className="flex justify-between items-center text-xs">
                  <span className="text-neutral-500 flex items-center gap-1.5"><Clock size={13} /> 添加日期</span>
                  <span className="text-neutral-300 font-mono text-[11px]">{asset.dateAdded ? formatDate(asset.dateAdded) : '—'}</span>
                </div>
              </div>
            </div>

            {/* Assigned Tags & Collections */}
            <div>
              <label className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider block mb-2">已打标签与集合</label>
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {asset.tags.map(tagId => {
                    const tag = state.tags.find(t => t.id === tagId);
                    if (!tag) return null;
                    return (
                      <span key={tag.id} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-[#252525] border border-neutral-700 text-neutral-300">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                        {tag.name}
                      </span>
                    );
                  })}
                  {asset.tags.length === 0 && <span className="text-xs text-neutral-600 italic">暂无分配标签</span>}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {asset.collections.map(colId => {
                    const col = state.collections.find(c => c.id === colId);
                    if (!col) return null;
                    return (
                      <span key={col.id} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-[#252525] border border-neutral-700 text-amber-400">
                        <Layers size={11} />
                        {col.name}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Bulk selection
    const totalCount = selectedAssets.length + selectedFolders.length;
    const totalSize = selectedAssets.reduce((sum, a) => sum + a.size, 0);
    return (
      <div className="w-80 flex-shrink-0 bg-[#1e1e1e] border-l border-neutral-800 flex flex-col p-6 text-neutral-300 select-none">
        <div className="flex items-center justify-center w-14 h-14 bg-neutral-800 rounded-xl mb-4 mx-auto border border-neutral-700">
          <Copy size={28} className="text-blue-400" />
        </div>
        <h2 className="text-lg font-semibold text-white text-center mb-1">已多选 {totalCount} 项对象</h2>
        <div className="text-center text-xs text-neutral-500 mb-6">
          {selectedAssets.length > 0 ? `素材文件总体积 ${formatBytes(totalSize)}` : '仅选中文件夹'}
        </div>
        
        <div className="bg-[#161616] border border-neutral-800 rounded-lg p-3 space-y-2 text-xs">
          <div className="flex justify-between text-neutral-400">
            <span>素材文件</span>
            <span className="text-neutral-200 font-mono">{selectedAssets.length}</span>
          </div>
          <div className="flex justify-between text-neutral-400">
            <span>文件夹</span>
            <span className="text-neutral-200 font-mono">{selectedFolders.length}</span>
          </div>
          <div className="pt-2 border-t border-neutral-800 flex justify-between text-neutral-400">
            <span>合并体积</span>
            <span className="text-emerald-400 font-mono">{formatBytes(totalSize)}</span>
          </div>
        </div>
      </div>
    );
  }

  // 2. When no items are selected on canvas, check active sidebar entity!
  // Priority A: Active Tag
  if (state.activeTagId) {
    const activeTag = state.tags.find(t => t.id === state.activeTagId);
    if (activeTag) {
      return (
        <TagProperties 
          tag={activeTag}
          allTags={state.tags}
          assets={state.assets}
          folders={state.folders}
          onUpdate={onUpdateTag}
          onDelete={onDeleteTag}
          onMove={onMoveTag}
          onTogglePin={onTogglePinTag}
        />
      );
    }
  }

  // Priority B: Active Collection
  if (state.activeCollectionId) {
    const activeCol = state.collections.find(c => c.id === state.activeCollectionId);
    if (activeCol) {
      return (
        <CollectionProperties 
          collection={activeCol}
          allCollections={state.collections}
          assets={state.assets}
          folders={state.folders}
          onUpdate={onUpdateCollection}
          onDelete={onDeleteCollection}
          onMove={onMoveCollection}
          onTogglePin={onTogglePinCollection}
        />
      );
    }
  }

  // Priority C: Active Smart Folder
  if (state.activeSmartFolderId) {
    const activeSF = allSmartFolders.find(sf => sf.id === state.activeSmartFolderId);
    if (activeSF) {
      return (
        <SmartFolderProperties 
          smartFolder={activeSF}
          allSmartFolders={allSmartFolders}
          assets={state.assets}
          tags={state.tags}
          collections={state.collections}
          onUpdate={onUpdateSmartFolder}
          onDelete={onDeleteSmartFolder}
          onMove={onMoveSmartFolder}
          onTogglePin={onTogglePinSmartFolder}
        />
      );
    }
  }

  // Priority D: Active Folder (implicit view)
  if (state.activeFolderId) {
    const activeFolder = state.folders.find(f => f.id === state.activeFolderId);
    if (activeFolder) {
      return (
        <FolderProperties 
          folder={activeFolder}
          allFolders={state.folders}
          assets={state.assets}
          tags={state.tags}
          collections={state.collections}
          onUpdate={onUpdateFolder}
          onDelete={onDeleteFolder}
          onMove={onMoveFolder}
          onTogglePin={onTogglePinFolder}
        />
      );
    }
  }

  // Fallback: App Overview
  return (
    <div className="w-80 flex-shrink-0 bg-[#1e1e1e] border-l border-neutral-800 flex flex-col items-center justify-center text-neutral-500 p-6 text-center select-none">
      <div className="w-14 h-14 bg-blue-500/10 text-blue-400 rounded-2xl flex items-center justify-center font-bold text-lg mb-3 border border-blue-500/20 shadow-lg shadow-blue-500/10">
        AE
      </div>
      <h2 className="text-base font-semibold text-neutral-200 mb-1">Asset Explorer</h2>
      <p className="text-xs text-neutral-500 mb-6 max-w-[200px]">点击左侧智能文件夹、标签或集合，在此查看并管理详细信息</p>
      
      <div className="w-full bg-[#161616] rounded-lg p-3.5 text-left border border-neutral-800 space-y-2.5">
        <div className="flex justify-between items-center text-xs">
          <span className="flex items-center gap-2 text-neutral-400"><Folder size={13} className="text-amber-400" /> 文件夹</span>
          <span className="text-neutral-200 font-mono font-medium">{state.folders.length}</span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="flex items-center gap-2 text-neutral-400"><ImageIcon size={13} className="text-blue-400" /> 资产总数</span>
          <span className="text-neutral-200 font-mono font-medium">{state.assets.length}</span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="flex items-center gap-2 text-neutral-400"><Hash size={13} className="text-purple-400" /> 标签分类</span>
          <span className="text-neutral-200 font-mono font-medium">{state.tags.length}</span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="flex items-center gap-2 text-neutral-400"><Layers size={13} className="text-emerald-400" /> 专属集合</span>
          <span className="text-neutral-200 font-mono font-medium">{state.collections.length}</span>
        </div>
        <div className="flex justify-between items-center text-xs">
          <span className="flex items-center gap-2 text-neutral-400"><Filter size={13} className="text-cyan-400" /> 智能文件夹</span>
          <span className="text-neutral-200 font-mono font-medium">{allSmartFolders.length}</span>
        </div>
      </div>
    </div>
  );
}
