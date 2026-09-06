/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainArea } from './components/MainArea';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ContextMenu, ContextMenuItem } from './components/ContextMenu';
import { BulkActionBar } from './components/BulkActionBar';
import { SettingsModal } from './components/SettingsModal';
import { AddMonitoredFolderModal } from './components/AddMonitoredFolderModal';
import { CreateEntityModal } from './components/CreateEntityModal';
import { RenameModal } from './components/RenameModal';
import { smartFolders } from './data';
import { useAppState } from './hooks/useAppState';
import { useFileMonitoring } from './hooks/useFileMonitoring';
import { useAssetFiltering } from './hooks/useAssetFiltering';
import { useNavigationActions } from './hooks/useNavigationActions';
import { useEntityActions } from './hooks/useEntityActions';
import { useContextMenuHandlers } from './hooks/useContextMenuHandlers';
import { useMiscActions } from './hooks/useMiscActions';
import { handleConfirmAddAndScan as scanAndAddFolder } from './hooks/useFolderScan';

export default function App() {
  const { state, setState } = useAppState();
  const [addMonitoredModalOpen, setAddMonitoredModalOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{x: number, y: number, items: ContextMenuItem[]} | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createEntityModal, setCreateEntityModal] = useState<{
    isOpen: boolean;
    type: 'tag' | 'collection';
  }>({ isOpen: false, type: 'tag' });
  const [renameModal, setRenameModal] = useState<{
    isOpen: boolean;
    title: string;
    initialValue: string;
    onConfirm: (newName: string) => void;
  }>({ isOpen: false, title: '', initialValue: '', onConfirm: () => {} });

  useFileMonitoring(setState);

  // 导航与选中操作
  const {
    handleChangeTab, handleSelectSmartFolder, handleSelectFolder, handleSelectTag,
    handleSelectCollection, handleToggleFolderExpand, handleToggleSelection,
    handleClearSelection, handleChangeView, handleToggleGroupByFolder,
    handleToggleIncludeSubfolders, handleToggleGroupCollapse, handleSortChange,
  } = useNavigationActions(setState);

  // 实体 CRUD 操作
  const {
    handleCreateSmartFolder, handleUpdateSmartFolder, handleDeleteSmartFolder,
    handleMoveSmartFolder, handleTogglePinSmartFolder,
    handleUpdateTag, handleDeleteTag, handleMoveTag, handleTogglePinTag,
    handleUpdateCollection, handleDeleteCollection, handleMoveCollection, handleTogglePinCollection,
    handleUpdateFolder, handleDeleteFolder, handleMoveFolder, handleTogglePinFolder,
    handleSearchSubmit,
  } = useEntityActions(setState);

  // 过滤
  const { filteredAssets, filteredFolders } = useAssetFiltering(state, smartFolders);

  // 创建/批量/设置操作
  const {
    handleConfirmCreateEntity, handleBulkAddTags, handleBulkAddCollections,
    handleBulkDelete, handleUpdateTheme, handleRelocatePaths,
  } = useMiscActions(createEntityModal, setState);

  // 右键菜单操作
  const {
    handleContextMenuAsset, handleContextMenuFolder, handleContextMenuTag,
    handleContextMenuCollection, handleContextMenuSmartFolder,
    handleContextMenuCanvas, handleContextMenuSidebar,
  } = useContextMenuHandlers({
    state, filteredAssets, smartFolders, setState, setContextMenu, setRenameModal, setSettingsOpen,
    onSelectFolder: handleSelectFolder,
    onSelectTag: handleSelectTag,
    onSelectCollection: handleSelectCollection,
    onSelectSmartFolder: handleSelectSmartFolder,
    onChangeView: handleChangeView,
    onToggleGroupByFolder: handleToggleGroupByFolder,
    onToggleIncludeSubfolders: handleToggleIncludeSubfolders,
    onClearSelection: handleClearSelection,
    onScanLocalFolder: () => setAddMonitoredModalOpen(true),
    onCreateTag: () => setCreateEntityModal({ isOpen: true, type: 'tag' }),
    onCreateCollection: () => setCreateEntityModal({ isOpen: true, type: 'collection' }),
    onTogglePinFolder: handleTogglePinFolder, onMoveFolder: handleMoveFolder,
    onDeleteFolder: handleDeleteFolder, onUpdateFolder: handleUpdateFolder,
    onTogglePinTag: handleTogglePinTag, onMoveTag: handleMoveTag,
    onDeleteTag: handleDeleteTag, onUpdateTag: handleUpdateTag,
    onTogglePinCollection: handleTogglePinCollection, onMoveCollection: handleMoveCollection,
    onDeleteCollection: handleDeleteCollection, onUpdateCollection: handleUpdateCollection,
    onTogglePinSmartFolder: handleTogglePinSmartFolder, onMoveSmartFolder: handleMoveSmartFolder,
    onDeleteSmartFolder: handleDeleteSmartFolder, onUpdateSmartFolder: handleUpdateSmartFolder,
    onCreateSmartFolder: handleCreateSmartFolder,
  });

  // 创建标签 / 集合
  const handleCreateTag = () => setCreateEntityModal({ isOpen: true, type: 'tag' });
  const handleCreateCollection = () => setCreateEntityModal({ isOpen: true, type: 'collection' });

  // 扫描本地文件夹
  const handleScanLocalFolder = () => setAddMonitoredModalOpen(true);

  const handleConfirmAddAndScan = async (folderPath: string, folderName: string, isMonitored: boolean) => {
    await scanAndAddFolder(folderPath, folderName, isMonitored, state, setState);
  };


  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#141414] text-neutral-200 font-sans">
      <Sidebar 
        state={state} 
        onChangeTab={handleChangeTab}
        onSelectSmartFolder={handleSelectSmartFolder} 
        onSelectFolder={handleSelectFolder}
        onSelectTag={handleSelectTag}
        onSelectCollection={handleSelectCollection}
        onToggleFolderExpand={handleToggleFolderExpand}
        onCreateSmartFolder={handleCreateSmartFolder}
        onCreateTag={handleCreateTag}
        onCreateCollection={handleCreateCollection}
        onContextMenuFolder={handleContextMenuFolder}
        onContextMenuSmartFolder={handleContextMenuSmartFolder}
        onContextMenuTag={handleContextMenuTag}
        onContextMenuCollection={handleContextMenuCollection}
        onContextMenuSidebar={handleContextMenuSidebar}
        onOpenSettings={() => setSettingsOpen(true)}
        onScanLocalFolder={handleScanLocalFolder}
        smartFolders={smartFolders}
      />
      <MainArea 
        state={state} 
        filteredAssets={filteredAssets} 
        filteredFolders={filteredFolders}
        onToggleSelection={handleToggleSelection}
        onClearSelection={handleClearSelection}
        onChangeView={handleChangeView}
        onToggleGroupByFolder={handleToggleGroupByFolder}
        onToggleIncludeSubfolders={handleToggleIncludeSubfolders}
        onToggleGroupCollapse={handleToggleGroupCollapse}
        onSortChange={handleSortChange}
        onSearchSubmit={handleSearchSubmit}
        onContextMenuAsset={handleContextMenuAsset}
        onContextMenuFolder={handleContextMenuFolder}
        onContextMenuCanvas={handleContextMenuCanvas}
        onSelectFolder={handleSelectFolder}
        onAddMonitoredFolder={handleScanLocalFolder}
      />
      <PropertiesPanel 
        state={state} 
        smartFolders={smartFolders}
        onUpdateSmartFolder={handleUpdateSmartFolder}
        onDeleteSmartFolder={handleDeleteSmartFolder}
        onMoveSmartFolder={handleMoveSmartFolder}
        onTogglePinSmartFolder={handleTogglePinSmartFolder}
        onUpdateTag={handleUpdateTag}
        onDeleteTag={handleDeleteTag}
        onMoveTag={handleMoveTag}
        onTogglePinTag={handleTogglePinTag}
        onUpdateCollection={handleUpdateCollection}
        onDeleteCollection={handleDeleteCollection}
        onMoveCollection={handleMoveCollection}
        onTogglePinCollection={handleTogglePinCollection}
        onUpdateFolder={handleUpdateFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveFolder={handleMoveFolder}
        onTogglePinFolder={handleTogglePinFolder}
      />
      
      {contextMenu && (
        <ContextMenu 
          x={contextMenu.x} 
          y={contextMenu.y} 
          items={contextMenu.items} 
          onClose={() => setContextMenu(null)} 
        />
      )}

      <BulkActionBar 
        state={state}
        onClear={handleClearSelection}
        onAddTags={handleBulkAddTags}
        onAddCollections={handleBulkAddCollections}
        onDelete={() => handleBulkDelete(state)}
      />

      <SettingsModal 
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onUpdateTheme={handleUpdateTheme}
        onRelocatePaths={handleRelocatePaths}
      />

      <AddMonitoredFolderModal 
        isOpen={addMonitoredModalOpen}
        onClose={() => setAddMonitoredModalOpen(false)}
        existingFolders={state.folders}
        onConfirmAddAndScan={handleConfirmAddAndScan}
      />

      <CreateEntityModal 
        isOpen={createEntityModal.isOpen}
        type={createEntityModal.type}
        existingNames={createEntityModal.type === 'tag' ? state.tags.map(t => t.name) : state.collections.map(c => c.name)}
        onClose={() => setCreateEntityModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={handleConfirmCreateEntity}
      />

      <RenameModal 
        isOpen={renameModal.isOpen}
        title={renameModal.title}
        initialValue={renameModal.initialValue}
        onClose={() => setRenameModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={renameModal.onConfirm}
      />
    </div>
  );
}
