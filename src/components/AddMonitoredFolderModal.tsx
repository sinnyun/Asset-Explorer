import React, { useState, useMemo } from 'react';
import {
  X, FolderPlus, FolderCheck, FolderTree,
  Loader2, HardDrive, ArrowRight
} from 'lucide-react';
import { Folder } from '../types';
import { apiClient, runtime } from '../services/api';

interface AddMonitoredFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingFolders: Folder[];
  onConfirmAddAndScan: (folderPath: string, folderName: string, isMonitored: boolean) => Promise<void>;
}

export function AddMonitoredFolderModal({
  isOpen,
  onClose,
  existingFolders,
  onConfirmAddAndScan
}: AddMonitoredFolderModalProps) {
  const [folderPath, setFolderPath] = useState('D:\\DesignWorkspace');
  const [folderName, setFolderName] = useState('DesignWorkspace');
  const [isScanning, setIsScanning] = useState(false);

  // 现有已被标记为监视根目录的文件夹
  const monitoredFolders = useMemo(() => {
    return existingFolders.filter(f => f.isMonitored);
  }, [existingFolders]);

  // 自动探测输入的路径与现有监视文件夹的层级嵌套关系
  const relationship = useMemo(() => {
    const cleanInput = folderPath.trim().replace(/[/\\]+$/, '').toLowerCase();
    if (!cleanInput) return null;

    for (const mf of monitoredFolders) {
      const cleanMf = mf.path.trim().replace(/[/\\]+$/, '').toLowerCase();
      
      // 情况 1: 输入的是现有监视文件夹的子文件夹 (Parent -> Child)
      if (cleanInput.startsWith(cleanMf + '\\') || cleanInput.startsWith(cleanMf + '/')) {
        return {
          type: 'nested_child',
          parentFolder: mf,
          message: `检测到层级关联：该文件夹是现有监视工作区【${mf.name}】的子项目。`,
          detail: '系统将自动建立父子从属关系，并在界面中以双分列（父工作区列 + 子项目列）独立对照呈现！'
        };
      }

      // 情况 2: 输入的是现有监视文件夹的父级文件夹 (Child -> Parent)
      if (cleanMf.startsWith(cleanInput + '\\') || cleanMf.startsWith(cleanInput + '/')) {
        return {
          type: 'nested_parent',
          childFolder: mf,
          message: `检测到层级关联：该文件夹包含已监视的子项目【${mf.name}】。`,
          detail: '系统将自动将现有子项目关联至此父工作区，保留完整树形层级并在双分列中单独独立显示！'
        };
      }
    }

    return {
      type: 'independent',
      message: '独立监视文件夹',
      detail: '将作为全新的顶级工作区加入监视列表。'
    };
  }, [folderPath, monitoredFolders]);

  if (!isOpen) return null;

  const handleBrowseFolder = async () => {
    if (runtime.isDesktop) {
      try {
        const selected = await apiClient.pickDirectory();
        if (selected && typeof selected === 'string') {
          setFolderPath(selected);
          const parts = selected.split(/[/\\]/);
          const name = parts[parts.length - 1] || 'NewFolder';
          setFolderName(name);
        }
      } catch (err) {
        console.warn('Native dialog cancelled or failed:', err);
      }
    } else {
      // 浏览器环境快速预设切换
      const samplePaths = [
        'D:\\DesignWorkspace',
        'D:\\DesignWorkspace\\ProjectAlpha',
        'E:\\MediaLibrary\\Textures',
        'C:\\Users\\User\\3DProjects'
      ];
      const next = samplePaths[(samplePaths.indexOf(folderPath) + 1) % samplePaths.length];
      setFolderPath(next);
      const parts = next.split(/[/\\]/);
      setFolderName(parts[parts.length - 1] || 'Folder');
    }
  };

  const handleStartScan = async () => {
    if (!folderPath.trim()) return;
    try {
      setIsScanning(true);
      // 桌面模式：onConfirmAddAndScan 触发后台增量扫描后立即返回，
      // 此处随即关闭模态框，扫描进度转移到程序底部的全局进度条展示；
      // 界面上的资产会随扫描增量事件边扫边显示，不被全量扫描卡住。
      await onConfirmAddAndScan(folderPath.trim(), folderName.trim(), true);
    } catch (err) {
      alert('添加与扫描失败: ' + String(err));
    } finally {
      setIsScanning(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#181818] w-[560px] rounded-xl shadow-2xl border border-neutral-800 overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-[#141414]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <FolderPlus size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">添加并关联本地监视文件夹</h2>
              <p className="text-xs text-neutral-400">建立本地磁盘到 Rust 数据库的高性能索引与实时监听</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            disabled={isScanning}
            className="text-neutral-500 hover:text-neutral-300 p-1 rounded-md transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-5">
          
          {/* Path Input */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-300 flex items-center justify-between">
              <span>本地文件夹完整路径</span>
              <button 
                type="button" 
                onClick={handleBrowseFolder}
                className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-normal underline"
              >
                <HardDrive size={12} /> {runtime.isDesktop ? '浏览选择文件夹' : '切换测试路径'}
              </button>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={folderPath}
                onChange={(e) => {
                  setFolderPath(e.target.value);
                  const parts = e.target.value.split(/[/\\]/);
                  const name = parts[parts.length - 1] || parts[parts.length - 2] || 'Folder';
                  if (name) setFolderName(name);
                }}
                disabled={isScanning}
                placeholder="例如: D:\DesignWorkspace 或 D:\DesignWorkspace\ProjectAlpha"
                className="flex-1 bg-[#141414] border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-blue-500 transition-colors font-mono"
              />
            </div>
            <p className="text-[11px] text-neutral-500">
              支持添加顶级工作区根目录，也支持添加其下单独的子项目目录。
            </p>
          </div>

          {/* Folder Display Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-300">显示名称</label>
            <input
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              disabled={isScanning}
              placeholder="文件夹显示别名"
              className="w-full bg-[#141414] border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Intelligent Hierarchy Detection Notice */}
          {relationship && (
            <div className={`p-3.5 rounded-lg border text-xs space-y-1 ${
              relationship.type === 'nested_child' 
                ? 'bg-purple-500/10 border-purple-500/30 text-purple-300'
                : relationship.type === 'nested_parent'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                : 'bg-neutral-800/60 border-neutral-700/50 text-neutral-300'
            }`}>
              <div className="flex items-center gap-2 font-semibold">
                <FolderTree size={15} />
                <span>{relationship.message}</span>
              </div>
              <p className="text-neutral-400 pl-6 leading-relaxed">
                {relationship.detail}
              </p>
            </div>
          )}

          {/* Current Monitored List Preview */}
          {monitoredFolders.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs font-semibold text-neutral-400 flex items-center gap-1.5">
                <FolderCheck size={13} className="text-emerald-400" />
                <span>当前已关联的监视文件夹 ({monitoredFolders.length} 个):</span>
              </span>
              <div className="bg-[#141414] border border-neutral-800/80 rounded-lg p-2 max-h-28 overflow-y-auto space-y-1 custom-scrollbar text-xs font-mono">
                {monitoredFolders.map(f => (
                  <div key={f.id} className="flex items-center justify-between text-neutral-400 px-2 py-1 bg-white/[0.02] rounded">
                    <span className="truncate max-w-[280px]" title={f.path}>📁 {f.name} ({f.path})</span>
                    <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">监视中</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-neutral-800 flex items-center justify-between bg-[#141414]">
          <span className="text-[11px] text-neutral-500">
            优先使用 Windows 自带缩略图缓存并开启非阻塞后台写入
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isScanning}
              className="px-4 py-2 text-xs font-medium text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleStartScan}
              disabled={isScanning || !folderPath.trim()}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-lg shadow-blue-600/20 disabled:opacity-50"
            >
              {isScanning ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>处理中...</span>
                </>
              ) : (
                <>
                  <span>确认添加并扫描</span>
                  <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
