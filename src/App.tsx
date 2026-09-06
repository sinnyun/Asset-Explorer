/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useMemo, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainArea } from './components/MainArea';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ContextMenu, ContextMenuItem } from './components/ContextMenu';
import { BulkActionBar } from './components/BulkActionBar';
import { SettingsModal } from './components/SettingsModal';
import { AddMonitoredFolderModal } from './components/AddMonitoredFolderModal';
import { CreateEntityModal } from './components/CreateEntityModal';
import { RenameModal } from './components/RenameModal';
import { AssetState, SidebarTab, SmartFolder, SortOption, ThemeMode, Tag, Collection, Folder as FolderType } from './types';
import { mockAssets, mockFolders, mockTags, mockCollections, smartFolders } from './data';
import { 
  Edit2, Trash2, ExternalLink, FolderOpen, Pin, ArrowUp, ArrowDown, Info,
  LayoutGrid, List, CheckSquare, Plus, RefreshCw, FolderPlus, Layers, Tag as TagIcon 
} from 'lucide-react';
import { isTauriDesktop, openInWindowsExplorer } from './services/desktopBridge';
import { dataService } from './services/dataService';

export default function App() {
  const [addMonitoredModalOpen, setAddMonitoredModalOpen] = useState(false);
  const [state, setState] = useState<AssetState>({
    assets: mockAssets,
    folders: mockFolders,
    tags: mockTags,
    collections: mockCollections,
    selectedItems: [],
    activeFolderId: null,
    activeSmartFolderId: 'sf_all',
    activeTagId: null,
    activeCollectionId: null,
    activeSidebarTab: 'smart',
    expandedFolderIds: ['workspace', 'proj1', 'assets', 'textures'],
    collapsedGroupIds: [],
    searchQuery: '',
    viewMode: 'grid',
    groupByFolder: true,
    includeSubfolders: true,
    customSmartFolders: [],
    sortOption: 'name_asc',
    theme: 'dark'
  });

  // 1. 初始化从后端 SQLite 异步加载全量数据 (非阻塞)
  useEffect(() => {
    dataService.loadWorkspace().then(loaded => {
      if (loaded) {
        setState(prev => ({ ...prev, ...loaded }));
      }
      // 加载完成后，校验资产有效性：删除数据库中文件已不存在的资产记录
      // 这包括清理之前开发/测试阶段写入的 C:/Workspace 等模拟数据路径
      // 校验结果会打印到控制台：检查了多少个资产，清理了多少个无效路径
      dataService.validateAssets().then(() => {
        // 校验完成后，重新加载工作区数据（清理后状态已更新）
        dataService.loadWorkspace().then(reloaded => {
          if (reloaded) {
            console.log(`[App] 资产校验后重新加载: ${reloaded.assets.length} 个资产`);
            setState(prev => ({ ...prev, ...reloaded }));
          }
        });
      });
    });
  }, []);

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

  // Apply Theme
  useEffect(() => {
    if (state.theme === 'dark' || (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [state.theme]);

  // 桌面模式：监听文件监控器实时事件（资产新增/删除/修改）
  useEffect(() => {
    if (!isTauriDesktop()) return;

    let unlisteners: Array<() => void> = [];

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        // 资产新增
        const unlistenAdd = await listen<{ asset_id?: string; path: string }>('asset:added', () => {
          // 提示用户刷新视图（或自动重新加载工作区）
          dataService.loadWorkspace().then((payload) => {
            if (payload) {
              setState(prev => ({ ...prev, assets: payload.assets, folders: payload.folders }));
            }
          });
        });

        // 资产删除
        const unlistenRemove = await listen<{ path: string }>('asset:removed', () => {
          dataService.loadWorkspace().then((payload) => {
            if (payload) {
              setState(prev => ({ ...prev, assets: payload.assets, folders: payload.folders }));
            }
          });
        });

        // 资产修改
        const unlistenModify = await listen<{ asset_id?: string; path: string }>('asset:modified', () => {
          dataService.loadWorkspace().then((payload) => {
            if (payload) {
              setState(prev => ({ ...prev, assets: payload.assets, folders: payload.folders }));
            }
          });
        });

        unlisteners = [unlistenAdd, unlistenRemove, unlistenModify];
      } catch (e) {
        console.warn('[App] 文件监控事件监听器初始化失败（非桌面环境可忽略）:', e);
      }
    };

    setupListeners();

    return () => {
      unlisteners.forEach(fn => fn());
    };
  }, []);

  const handleChangeTab = (tab: SidebarTab) => {
    setState(prev => ({ ...prev, activeSidebarTab: tab }));
  };

  const handleSelectSmartFolder = (id: string) => {
    setState(prev => ({ ...prev, activeSmartFolderId: id, activeFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [] }));
  };

  const handleSelectFolder = (id: string) => {
    setState(prev => ({ ...prev, activeFolderId: id, activeSmartFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [] }));
  };

  const handleSelectTag = (id: string) => {
    setState(prev => ({ ...prev, activeTagId: id, activeFolderId: null, activeSmartFolderId: null, activeCollectionId: null, selectedItems: [] }));
  };

  const handleSelectCollection = (id: string) => {
    setState(prev => ({ ...prev, activeCollectionId: id, activeFolderId: null, activeSmartFolderId: null, activeTagId: null, selectedItems: [] }));
  };

  const handleToggleFolderExpand = (id: string) => {
    setState(prev => ({
      ...prev,
      expandedFolderIds: prev.expandedFolderIds.includes(id)
        ? prev.expandedFolderIds.filter(fid => fid !== id)
        : [...prev.expandedFolderIds, id]
    }));
  };

  const handleToggleSelection = (id: string, type: 'asset' | 'folder', multi: boolean) => {
    setState(prev => {
      const isSelected = prev.selectedItems.some(item => item.id === id && item.type === type);
      if (multi) {
        return {
          ...prev,
          selectedItems: isSelected 
            ? prev.selectedItems.filter(item => !(item.id === id && item.type === type))
            : [...prev.selectedItems, { id, type }]
        };
      } else {
        return {
          ...prev,
          selectedItems: [{ id, type }]
        };
      }
    });
  };

  const handleClearSelection = () => {
    setState(prev => ({ ...prev, selectedItems: [] }));
  };

  const handleChangeView = (mode: 'grid' | 'list') => {
    setState(prev => ({ ...prev, viewMode: mode }));
  };

  const handleToggleGroupByFolder = () => {
    setState(prev => ({ ...prev, groupByFolder: !prev.groupByFolder }));
  };

  const handleToggleIncludeSubfolders = () => {
    setState(prev => ({ ...prev, includeSubfolders: !prev.includeSubfolders }));
  };

  const handleToggleGroupCollapse = (id: string) => {
    setState(prev => ({
      ...prev,
      collapsedGroupIds: prev.collapsedGroupIds.includes(id)
        ? prev.collapsedGroupIds.filter(gid => gid !== id)
        : [...prev.collapsedGroupIds, id]
    }));
  };

  const handleSortChange = (option: SortOption) => {
    setState(prev => ({ ...prev, sortOption: option }));
  };

  const handleCreateSmartFolder = () => {
    const newId = `sf_custom_${Date.now()}`;
    const newSF: SmartFolder = {
      id: newId,
      name: 'New Smart Folder',
      icon: 'Filter',
      rules: [],
      matchAll: true,
      isSearchHistory: false
    };
    dataService.saveSmartFolder(newSF);
    setState(prev => ({
      ...prev,
      customSmartFolders: [newSF, ...prev.customSmartFolders],
      activeSmartFolderId: newId,
      activeFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [], activeSidebarTab: 'smart'
    }));
  };

  const handleUpdateSmartFolder = (id: string, updates: Partial<SmartFolder>) => {
    setState(prev => {
      const updated = prev.customSmartFolders.map(sf => sf.id === id ? { ...sf, ...updates } : sf);
      const target = updated.find(sf => sf.id === id);
      if (target) {
        dataService.saveSmartFolder(target);
      }
      return { ...prev, customSmartFolders: updated };
    });
  };

  const handleDeleteSmartFolder = (id: string) => {
    dataService.deleteSmartFolder(id);
    setState(prev => ({
      ...prev,
      customSmartFolders: prev.customSmartFolders.filter(sf => sf.id !== id),
      activeSmartFolderId: prev.activeSmartFolderId === id ? 'sf_all' : prev.activeSmartFolderId
    }));
  };

  const handleMoveSmartFolder = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const list = [...prev.customSmartFolders];
      const idx = list.findIndex(sf => sf.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return prev;
      const [item] = list.splice(idx, 1);
      list.splice(targetIdx, 0, item);
      return { ...prev, customSmartFolders: list };
    });
  };

  const handleTogglePinSmartFolder = (id: string) => {
    setState(prev => {
      const updated = prev.customSmartFolders.map(sf => 
        sf.id === id ? { ...sf, isPinned: !sf.isPinned } : sf
      );
      const target = updated.find(sf => sf.id === id);
      if (target) dataService.saveSmartFolder(target);
      return { ...prev, customSmartFolders: updated };
    });
  };

  // --- Tag Operations ---
  const handleUpdateTag = (id: string, updates: Partial<Tag>) => {
    setState(prev => {
      const updated = prev.tags.map(t => t.id === id ? { ...t, ...updates } : t);
      const target = updated.find(t => t.id === id);
      if (target) dataService.updateTag(target);
      return { ...prev, tags: updated };
    });
  };

  const handleDeleteTag = (id: string) => {
    dataService.deleteTag(id);
    setState(prev => ({
      ...prev,
      tags: prev.tags.filter(t => t.id !== id),
      assets: prev.assets.map(a => ({ ...a, tags: a.tags.filter(tid => tid !== id) })),
      folders: prev.folders.map(f => ({ ...f, tags: f.tags?.filter(tid => tid !== id) })),
      activeTagId: prev.activeTagId === id ? null : prev.activeTagId
    }));
  };

  const handleMoveTag = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const list = [...prev.tags];
      const idx = list.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return prev;
      const [item] = list.splice(idx, 1);
      list.splice(targetIdx, 0, item);
      return { ...prev, tags: list };
    });
  };

  const handleTogglePinTag = (id: string) => {
    setState(prev => {
      const updated = prev.tags.map(t => 
        t.id === id ? { ...t, isPinned: !t.isPinned } : t
      );
      const target = updated.find(t => t.id === id);
      if (target) dataService.updateTag(target);
      return { ...prev, tags: updated };
    });
  };

  // --- Collection Operations ---
  const handleUpdateCollection = (id: string, updates: Partial<Collection>) => {
    setState(prev => {
      const updated = prev.collections.map(c => c.id === id ? { ...c, ...updates } : c);
      const target = updated.find(c => c.id === id);
      if (target) dataService.updateCollection(target);
      return { ...prev, collections: updated };
    });
  };

  const handleDeleteCollection = (id: string) => {
    dataService.deleteCollection(id);
    setState(prev => ({
      ...prev,
      collections: prev.collections.filter(c => c.id !== id),
      assets: prev.assets.map(a => ({ ...a, collections: a.collections.filter(cid => cid !== id) })),
      activeCollectionId: prev.activeCollectionId === id ? null : prev.activeCollectionId
    }));
  };

  const handleMoveCollection = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const list = [...prev.collections];
      const idx = list.findIndex(c => c.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= list.length) return prev;
      const [item] = list.splice(idx, 1);
      list.splice(targetIdx, 0, item);
      return { ...prev, collections: list };
    });
  };

  const handleTogglePinCollection = (id: string) => {
    setState(prev => {
      const updated = prev.collections.map(c => 
        c.id === id ? { ...c, isPinned: !c.isPinned } : c
      );
      const target = updated.find(c => c.id === id);
      if (target) dataService.updateCollection(target);
      return { ...prev, collections: updated };
    });
  };

  // --- Folder Operations ---
  const handleUpdateFolder = (id: string, updates: Partial<FolderType>) => {
    setState(prev => {
      const updated = prev.folders.map(f => f.id === id ? { ...f, ...updates } : f);
      const target = updated.find(f => f.id === id);
      if (target) dataService.updateFolder(target);
      return { ...prev, folders: updated };
    });
  };

  const handleDeleteFolder = (id: string) => {
    dataService.deleteFolder(id);
    setState(prev => ({
      ...prev,
      folders: prev.folders.filter(f => f.id !== id),
      selectedItems: prev.selectedItems.filter(i => !(i.type === 'folder' && i.id === id)),
      activeFolderId: prev.activeFolderId === id ? null : prev.activeFolderId
    }));
  };

  const handleMoveFolder = (id: string, direction: 'up' | 'down') => {
    setState(prev => {
      const targetFolder = prev.folders.find(f => f.id === id);
      if (!targetFolder) return prev;
      const siblings = prev.folders.filter(f => f.parentId === targetFolder.parentId);
      const idx = siblings.findIndex(f => f.id === id);
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= siblings.length) return prev;
      
      const otherFolder = siblings[targetIdx];
      const list = [...prev.folders];
      const f1Index = list.findIndex(f => f.id === id);
      const f2Index = list.findIndex(f => f.id === otherFolder.id);
      list[f1Index] = otherFolder;
      list[f2Index] = targetFolder;
      return { ...prev, folders: list };
    });
  };

  const handleTogglePinFolder = (id: string) => {
    setState(prev => {
      const updated = prev.folders.map(f => 
        f.id === id ? { ...f, isPinned: !f.isPinned } : f
      );
      const target = updated.find(f => f.id === id);
      if (target) dataService.updateFolder(target);
      return { ...prev, folders: updated };
    });
  };

  const handleSearchSubmit = (query: string) => {
    if (!query.trim()) return;
    const newSF: SmartFolder = {
      id: `sf_search_${Date.now()}`,
      name: `Search: ${query}`,
      icon: 'Search',
      rules: [{ id: Date.now().toString(), type: 'name', operator: 'contains', value: query }],
      matchAll: true,
      isSearchHistory: true
    };
    setState(prev => ({
      ...prev,
      customSmartFolders: [newSF, ...prev.customSmartFolders],
      activeSmartFolderId: newSF.id,
      activeFolderId: null, activeTagId: null, activeCollectionId: null, selectedItems: [], activeSidebarTab: 'smart'
    }));
  };

  // --- Context Menu Handlers ---
  const handleContextMenuAsset = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const asset = state.assets.find(a => a.id === id);
    if (!asset) return;
    
    // Auto select if not selected
    if (!state.selectedItems.some(i => i.type === 'asset' && i.id === id)) {
      setState(prev => ({ ...prev, selectedItems: [{ type: 'asset', id }] }));
    }

    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '重命名', icon: <Edit2 size={14}/>, onClick: () => {
          setRenameModal({
            isOpen: true,
            title: '重命名素材',
            initialValue: asset.name,
            onConfirm: (newName) => setState(p => ({ ...p, assets: p.assets.map(a => a.id === id ? { ...a, name: newName } : a) }))
          });
        }},
        { label: '打开素材源文件', icon: <ExternalLink size={14}/>, onClick: () => window.open(asset.thumbnailUrl || asset.path, '_blank') },
        { 
          label: '在资源管理器中定位', 
          icon: <FolderOpen size={14}/>, 
          onClick: () => {
            openInWindowsExplorer(asset.path).catch(console.error);
          } 
        },
        { divider: true, label: '' },
        { label: '删除素材', danger: true, icon: <Trash2 size={14}/>, onClick: () => {
          dataService.deleteAssets([id]);
          setState(p => ({
            ...p, 
            assets: p.assets.filter(a => a.id !== id),
            selectedItems: p.selectedItems.filter(i => !(i.type === 'asset' && i.id === id))
          }));
        }}
      ]
    });
  };

  const handleContextMenuFolder = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const folder = state.folders.find(f => f.id === id);
    if (!folder) return;

    if (!state.selectedItems.some(i => i.type === 'folder' && i.id === id)) {
      setState(prev => ({ ...prev, selectedItems: [{ type: 'folder', id }] }));
    }

    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '查看/编辑目录属性', icon: <Info size={14}/>, onClick: () => handleSelectFolder(id) },
        { label: folder.isPinned ? '取消置顶' : '置顶文件夹', icon: <Pin size={14}/>, onClick: () => handleTogglePinFolder(id) },
        { label: '在同级目录中上移', icon: <ArrowUp size={14}/>, onClick: () => handleMoveFolder(id, 'up') },
        { label: '在同级目录中下移', icon: <ArrowDown size={14}/>, onClick: () => handleMoveFolder(id, 'down') },
        { label: '打开资源管理器定位', icon: <FolderOpen size={14}/>, onClick: () => openInWindowsExplorer(folder.path) },
        { divider: true, label: '' },
        { label: '重命名目录', icon: <Edit2 size={14}/>, onClick: () => {
          setRenameModal({
            isOpen: true,
            title: '重命名文件夹',
            initialValue: folder.name,
            onConfirm: (newName) => handleUpdateFolder(id, { name: newName })
          });
        }},
        { divider: true, label: '' },
        { label: '移除文件夹', danger: true, icon: <Trash2 size={14}/>, onClick: () => {
          handleDeleteFolder(id);
        }}
      ]
    });
  };

  const handleContextMenuTag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const tag = state.tags.find(t => t.id === id);
    if (!tag) return;
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '查看/编辑标签属性', icon: <Info size={14}/>, onClick: () => handleSelectTag(id) },
        { label: tag.isPinned ? '取消置顶' : '置顶标签', icon: <Pin size={14}/>, onClick: () => handleTogglePinTag(id) },
        { label: '上移一位', icon: <ArrowUp size={14}/>, onClick: () => handleMoveTag(id, 'up') },
        { label: '下移一位', icon: <ArrowDown size={14}/>, onClick: () => handleMoveTag(id, 'down') },
        { divider: true, label: '' },
        { label: '重命名标签', icon: <Edit2 size={14}/>, onClick: () => {
          setRenameModal({
            isOpen: true,
            title: '重命名标签',
            initialValue: tag.name,
            onConfirm: (newName) => handleUpdateTag(id, { name: newName })
          });
        }},
        { divider: true, label: '' },
        { label: '删除标签', danger: true, icon: <Trash2 size={14}/>, onClick: () => {
          handleDeleteTag(id);
        }}
      ]
    });
  };

  const handleContextMenuCollection = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const col = state.collections.find(c => c.id === id);
    if (!col) return;
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '查看/编辑集合属性', icon: <Info size={14}/>, onClick: () => handleSelectCollection(id) },
        { label: col.isPinned ? '取消置顶' : '置顶集合', icon: <Pin size={14}/>, onClick: () => handleTogglePinCollection(id) },
        { label: '上移一位', icon: <ArrowUp size={14}/>, onClick: () => handleMoveCollection(id, 'up') },
        { label: '下移一位', icon: <ArrowDown size={14}/>, onClick: () => handleMoveCollection(id, 'down') },
        { divider: true, label: '' },
        { label: '重命名集合', icon: <Edit2 size={14}/>, onClick: () => {
          setRenameModal({
            isOpen: true,
            title: '重命名集合',
            initialValue: col.name,
            onConfirm: (newName) => handleUpdateCollection(id, { name: newName })
          });
        }},
        { divider: true, label: '' },
        { label: '删除集合', danger: true, icon: <Trash2 size={14}/>, onClick: () => {
          handleDeleteCollection(id);
        }}
      ]
    });
  };

  const handleContextMenuSmartFolder = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const customSf = state.customSmartFolders.find(sf => sf.id === id);
    const builtInSf = smartFolders.find(sf => sf.id === id);
    const targetSf = customSf || builtInSf;
    
    if (customSf) {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: '查看/编辑属性与规则',
            icon: <Info size={14} />,
            onClick: () => handleSelectSmartFolder(id)
          },
          {
            label: targetSf?.isPinned ? '取消置顶' : '置顶智能文件夹',
            icon: <Pin size={14} />,
            onClick: () => handleTogglePinSmartFolder(id)
          },
          {
            label: '上移一位',
            icon: <ArrowUp size={14} />,
            onClick: () => handleMoveSmartFolder(id, 'up')
          },
          {
            label: '下移一位',
            icon: <ArrowDown size={14} />,
            onClick: () => handleMoveSmartFolder(id, 'down')
          },
          { divider: true, label: '' },
          {
            label: '重命名智能文件夹',
            icon: <Edit2 size={14} />,
            onClick: () => {
              setRenameModal({
                isOpen: true,
                title: '重命名智能文件夹',
                initialValue: customSf.name,
                onConfirm: (newName) => handleUpdateSmartFolder(id, { name: newName })
              });
            }
          },
          { divider: true, label: '' },
          {
            label: '删除智能文件夹',
            danger: true,
            icon: <Trash2 size={14} />,
            onClick: () => {
              handleDeleteSmartFolder(id);
            }
          }
        ]
      });
    } else if (builtInSf) {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: '查看/编辑属性与统计',
            icon: <Info size={14} />,
            onClick: () => handleSelectSmartFolder(id)
          },
          {
            label: builtInSf.isPinned ? '取消置顶' : '置顶智能文件夹',
            icon: <Pin size={14} />,
            onClick: () => handleTogglePinSmartFolder(id)
          }
        ]
      });
    }
  };

  // Canvas background context menu
  const handleContextMenuCanvas = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: state.viewMode === 'grid' ? '切换为列表视图' : '切换为网格视图',
          icon: state.viewMode === 'grid' ? <List size={14} /> : <LayoutGrid size={14} />,
          onClick: () => handleChangeView(state.viewMode === 'grid' ? 'list' : 'grid')
        },
        {
          label: state.groupByFolder ? '取消按文件夹分组' : '开启按文件夹分组',
          icon: <FolderOpen size={14} />,
          onClick: handleToggleGroupByFolder
        },
        {
          label: state.includeSubfolders ? '仅显示当前层级素材' : '包含所有子目录素材',
          icon: <Layers size={14} />,
          onClick: handleToggleIncludeSubfolders
        },
        { divider: true, label: '' },
        {
          label: state.selectedItems.length > 0 ? '取消全选素材' : '全选所有素材',
          icon: <CheckSquare size={14} />,
          onClick: () => {
            if (state.selectedItems.length > 0) {
              handleClearSelection();
            } else {
              setState(p => ({
                ...p,
                selectedItems: filteredAssets.map(a => ({ id: a.id, type: 'asset' }))
              }));
            }
          }
        },
        { divider: true, label: '' },
        {
          label: '添加本地监视文件夹',
          icon: <FolderPlus size={14} />,
          onClick: handleScanLocalFolder
        },
        {
          label: '新建标签',
          icon: <TagIcon size={14} />,
          onClick: handleCreateTag
        },
        {
          label: '新建集合',
          icon: <Layers size={14} />,
          onClick: handleCreateCollection
        },
        {
          label: '刷新数据',
          icon: <RefreshCw size={14} />,
          onClick: () => {
            dataService.loadWorkspace().then(d => {
              if (d) {
                setState(prev => ({
                  ...prev,
                  folders: d.folders || [],
                  assets: d.assets || [],
                  tags: d.tags || [],
                  collections: d.collections || [],
                  customSmartFolders: d.customSmartFolders || []
                }));
              }
            });
          }
        }
      ]
    });
  };

  // Sidebar background context menu
  const handleContextMenuSidebar = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '新建智能文件夹',
          icon: <Plus size={14} />,
          onClick: handleCreateSmartFolder
        },
        {
          label: '添加本地监视文件夹',
          icon: <FolderPlus size={14} />,
          onClick: handleScanLocalFolder
        },
        {
          label: '新建标签',
          icon: <TagIcon size={14} />,
          onClick: handleCreateTag
        },
        {
          label: '新建集合',
          icon: <Layers size={14} />,
          onClick: handleCreateCollection
        },
        { divider: true, label: '' },
        {
          label: '偏好设置',
          icon: <Info size={14} />,
          onClick: () => setSettingsOpen(true)
        }
      ]
    });
  };

  const handleCreateTag = () => {
    setCreateEntityModal({ isOpen: true, type: 'tag' });
  };

  const handleCreateCollection = () => {
    setCreateEntityModal({ isOpen: true, type: 'collection' });
  };

  const handleConfirmCreateEntity = (data: { name: string; color: string; description?: string; isPinned: boolean }) => {
    if (createEntityModal.type === 'tag') {
      const newTag: Tag = {
        id: `t_${Date.now()}`,
        name: data.name,
        color: data.color,
        description: data.description,
        isPinned: data.isPinned
      };
      dataService.createTag(newTag);
      setState(prev => ({
        ...prev,
        tags: [newTag, ...prev.tags],
        activeTagId: newTag.id,
        activeFolderId: null,
        activeSmartFolderId: null,
        activeCollectionId: null,
        selectedItems: [],
        activeSidebarTab: 'tags'
      }));
    } else {
      const newCol: Collection = {
        id: `c_${Date.now()}`,
        name: data.name,
        color: data.color,
        description: data.description,
        isPinned: data.isPinned
      };
      dataService.createCollection(newCol);
      setState(prev => ({
        ...prev,
        collections: [newCol, ...prev.collections],
        activeCollectionId: newCol.id,
        activeFolderId: null,
        activeSmartFolderId: null,
        activeTagId: null,
        selectedItems: [],
        activeSidebarTab: 'collections'
      }));
    }
  };

  // --- Scan Folder Logic ---
  const handleScanLocalFolder = () => {
    setAddMonitoredModalOpen(true);
  };

  const handleConfirmAddAndScan = async (folderPath: string, folderName: string, isMonitored: boolean) => {
    const cleanInput = folderPath.trim().replace(/[/\\]+$/, '').toLowerCase();
    
    // 自动判定层级关系 (检测现有文件夹中是否存在该目录的父文件夹或子文件夹)
    let detectedParentId: string | undefined = undefined;
    const existingParent = state.folders.find(f => {
      const p = f.path.toLowerCase().replace(/[/\\]+$/, '');
      return cleanInput.startsWith(p + '\\') || cleanInput.startsWith(p + '/');
    });

    if (existingParent) {
      detectedParentId = existingParent.id;
    }

    if (isTauriDesktop()) {
      const result = await dataService.scanDirectory(folderPath.trim());
      if (result) {
        const root = {
          ...result.root_folder,
          name: folderName || result.root_folder.name,
          isMonitored: true,
          parentId: detectedParentId || result.root_folder.parentId,
        };

        // 如果该新文件夹是某个现有文件夹的父文件夹，调整现有文件夹的 parentId
        const updatedExisting = state.folders.map(f => {
          const p = f.path.toLowerCase().replace(/[/\\]+$/, '');
          if (p.startsWith(cleanInput + '\\') || p.startsWith(cleanInput + '/')) {
            return { ...f, parentId: root.id };
          }
          return f;
        });

        setState(p => ({
          ...p,
          folders: [...updatedExisting, root, ...result.sub_folders],
          assets: [...p.assets, ...result.assets],
          activeFolderId: root.id,
          activeSidebarTab: 'folders',
          expandedFolderIds: Array.from(new Set([...p.expandedFolderIds, root.id, ...(detectedParentId ? [detectedParentId] : [])]))
        }));
        return;
      }
    }

    // Web 预览环境模拟真实嵌套添加与扫描流程
    const newRootId = `monitored_${Date.now()}`;
    const newRootFolder = {
      id: newRootId,
      name: folderName || 'MonitoredWorkspace',
      path: folderPath,
      parentId: detectedParentId,
      isMonitored: true,
      tags: ['workspace'],
      collections: []
    };

    // 模拟生成两个子文件夹 (展示父子文件夹完整结构)
    const subFolder1 = {
      id: `${newRootId}_sub1`,
      name: 'HighRes_Textures',
      path: `${folderPath}\\HighRes_Textures`,
      parentId: newRootId,
      isMonitored: false,
      tags: ['texture'],
      collections: []
    };
    const subFolder2 = {
      id: `${newRootId}_sub2`,
      name: 'Render_Outputs',
      path: `${folderPath}\\Render_Outputs`,
      parentId: newRootId,
      isMonitored: false,
      tags: ['render'],
      collections: []
    };

    // 模拟写入扫描素材
    const mockNewAssets = [
      {
        id: `asset_${Date.now()}_1`,
        name: `${folderName}_hero_render.png`,
        path: `${folderPath}\\${folderName}_hero_render.png`,
        size: 4892010,
        type: 'image' as const,
        folderId: newRootId,
        tags: ['render', 'hero'],
        collections: [],
        rating: 5,
        isFavorite: true,
        thumbnailUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500&auto=format&fit=crop&q=60',
        dateModified: new Date().toISOString(),
        metadata: { width: 3840, height: 2160, format: 'PNG', colorSpace: 'sRGB' }
      },
      {
        id: `asset_${Date.now()}_2`,
        name: `albedo_wood_4k.jpg`,
        path: `${folderPath}\\HighRes_Textures\\albedo_wood_4k.jpg`,
        size: 3120400,
        type: 'image' as const,
        folderId: subFolder1.id,
        tags: ['texture'],
        collections: [],
        rating: 4,
        isFavorite: false,
        thumbnailUrl: 'https://images.unsplash.com/photo-1546484396-fb3fc6f95f98?w=500&auto=format&fit=crop&q=60',
        dateModified: new Date().toISOString(),
        metadata: { width: 4096, height: 4096, format: 'JPEG' }
      }
    ];

    // 更新现有文件夹并建立层级继承
    const updatedExisting = state.folders.map(f => {
      const p = f.path.toLowerCase().replace(/[/\\]+$/, '');
      if (p.startsWith(cleanInput + '\\') || p.startsWith(cleanInput + '/')) {
        return { ...f, parentId: newRootId };
      }
      return f;
    });

    dataService.createFolder(newRootFolder);
    dataService.createFolder(subFolder1);
    dataService.createFolder(subFolder2);

    setState(p => ({
      ...p,
      folders: [...updatedExisting, newRootFolder, subFolder1, subFolder2],
      assets: [...p.assets, ...mockNewAssets],
      activeFolderId: newRootId,
      activeSidebarTab: 'folders',
      expandedFolderIds: Array.from(new Set([...p.expandedFolderIds, newRootId, subFolder1.id, ...(detectedParentId ? [detectedParentId] : [])]))
    }));
  };

  // --- Bulk Actions ---
  const handleBulkAddTags = (tagIds: string[]) => {
    setState(p => ({
      ...p,
      assets: p.assets.map(a => {
        if (p.selectedItems.some(i => i.type === 'asset' && i.id === a.id)) {
          return { ...a, tags: Array.from(new Set([...a.tags, ...tagIds])) };
        }
        return a;
      })
    }));
  };

  const handleBulkAddCollections = (colIds: string[]) => {
    setState(p => ({
      ...p,
      assets: p.assets.map(a => {
        if (p.selectedItems.some(i => i.type === 'asset' && i.id === a.id)) {
          return { ...a, collections: Array.from(new Set([...a.collections, ...colIds])) };
        }
        return a;
      })
    }));
  };

  const handleBulkDelete = () => {
    if (window.confirm(`Delete ${state.selectedItems.length} selected items?`)) {
      const selectedAssetIds = state.selectedItems.filter(i => i.type === 'asset').map(i => i.id);
      const selectedFolderIds = state.selectedItems.filter(i => i.type === 'folder').map(i => i.id);
      
      if (selectedAssetIds.length > 0) {
        dataService.deleteAssets(selectedAssetIds);
      }
      for (const fId of selectedFolderIds) {
        dataService.deleteFolder(fId);
      }

      setState(p => ({
        ...p,
        assets: p.assets.filter(a => !selectedAssetIds.includes(a.id)),
        folders: p.folders.filter(f => !selectedFolderIds.includes(f.id)),
        selectedItems: []
      }));
    }
  };

  // --- Settings ---
  const handleUpdateTheme = (theme: ThemeMode) => {
    setState(p => ({ ...p, theme }));
  };

  const handleRelocatePaths = (oldBasePath: string, newBasePath: string) => {
    setState(p => ({
      ...p,
      folders: p.folders.map(f => ({
        ...f,
        path: f.path.startsWith(oldBasePath) ? f.path.replace(oldBasePath, newBasePath) : f.path
      })),
      assets: p.assets.map(a => ({
        ...a,
        path: a.path.startsWith(oldBasePath) ? a.path.replace(oldBasePath, newBasePath) : a.path
      }))
    }));
    alert(`Successfully mapped database base paths from ${oldBasePath} to ${newBasePath}. Internal File index preserved.`);
  };

  const filteredAssets = useMemo(() => {
    let result = state.assets;
    if (state.activeFolderId) {
      if (state.includeSubfolders) {
        const getChildFolderIds = (parentId: string): string[] => {
          const children = state.folders.filter(f => f.parentId === parentId).map(f => f.id);
          return [parentId, ...children.flatMap(getChildFolderIds)];
        };
        const allowedFolderIds = getChildFolderIds(state.activeFolderId);
        result = result.filter(a => allowedFolderIds.includes(a.folderId));
      } else {
        result = result.filter(a => a.folderId === state.activeFolderId);
      }
    } else if (state.activeSmartFolderId) {
      const sf = smartFolders.find(s => s.id === state.activeSmartFolderId);
      const customSf = state.customSmartFolders.find(s => s.id === state.activeSmartFolderId);
      
      if (sf && sf.filter) {
        result = result.filter(sf.filter);
      } else if (customSf && customSf.rules) {
        result = result.filter(asset => {
          if (customSf.rules!.length === 0) return true;
          const matches = customSf.rules!.map(rule => {
            if (rule.type === 'name') return asset.name.toLowerCase().includes(rule.value.toLowerCase());
            if (rule.type === 'tag') {
              const tag = state.tags.find(t => t.name.toLowerCase().includes(rule.value.toLowerCase()));
              return tag ? asset.tags.includes(tag.id) : false;
            }
            if (rule.type === 'collection') {
              const col = state.collections.find(c => c.name.toLowerCase().includes(rule.value.toLowerCase()));
              return col ? asset.collections.includes(col.id) : false;
            }
            if (rule.type === 'type') return asset.type.toLowerCase() === rule.value.toLowerCase();
            return false;
          });
          return customSf.matchAll ? matches.every(Boolean) : matches.some(Boolean);
        });
      }
    } else if (state.activeTagId) {
      result = result.filter(a => a.tags.includes(state.activeTagId!));
    } else if (state.activeCollectionId) {
      result = result.filter(a => a.collections.includes(state.activeCollectionId!));
    }

    if (state.searchQuery) {
      result = result.filter(a => a.name.toLowerCase().includes(state.searchQuery.toLowerCase()));
    }
    return result;
  }, [state.assets, state.activeFolderId, state.activeSmartFolderId, state.activeTagId, state.activeCollectionId, state.searchQuery, state.folders, state.includeSubfolders, state.customSmartFolders]);

  const filteredFolders = useMemo(() => {
    if (state.activeTagId) {
      return state.folders.filter(f => f.tags.includes(state.activeTagId!));
    } else if (state.activeCollectionId) {
      return state.folders.filter(f => f.collections.includes(state.activeCollectionId!));
    }
    return [];
  }, [state.folders, state.activeTagId, state.activeCollectionId]);

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
        onDelete={handleBulkDelete}
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
