import React, { useState, useEffect } from 'react';
import { 
  X, Database, Monitor, FolderSync, RefreshCw, HardDrive, 
  ArrowRight, CheckCircle2, AlertTriangle, Loader2, Sparkles 
} from 'lucide-react';
import { formatBytes } from '../lib/utils';
import { dataService } from '../services/dataService';
import { isTauriDesktop } from '../services/desktopBridge';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdateTheme: (mode: 'dark' | 'light' | 'system') => void;
  onRelocatePaths: (oldBasePath: string, newBasePath: string) => void;
}

export function SettingsModal({ isOpen, onClose, onUpdateTheme, onRelocatePaths }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'appearance' | 'database'>('database');
  const [oldPath, setOldPath] = useState('');
  const [newPath, setNewPath] = useState('');

  // 存储统计与迁移状态
  const [migrationTargetPath, setMigrationTargetPath] = useState('D:\\AssetHub_Storage');
  const [storageStats, setStorageStats] = useState<{
    data_dir: string;
    db_size_bytes: number;
    thumbnails_size_bytes: number;
    total_size_bytes: number;
    asset_count: number;
  } | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState('');
  const [migrationSuccess, setMigrationSuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      dataService.getStorageStats().then(stats => {
        setStorageStats(stats);
      }).catch(console.error);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleStartMigration = async () => {
    if (!migrationTargetPath.trim()) return;
    const confirm = window.confirm(
      `确定将软件的所有数据（包括 SQLite 数据库、WAL 日志、缩略图缓存等）完整迁移至:\n${migrationTargetPath}\n\n迁移成功后程序将自动更新配置并重启生效。`
    );
    if (!confirm) return;

    setIsMigrating(true);
    setMigrationStatus('正在执行 WAL 检查点并挂起写入事务...');

    try {
      setMigrationStatus('正在原子复制 SQLite 数据库与全部缩略图缓存...');
      const message = await dataService.migrateDataStorage(migrationTargetPath.trim());
      setMigrationStatus(message || '迁移成功完成！正在重启应用...');
      setMigrationSuccess(true);

      setTimeout(async () => {
        setIsMigrating(false);
        await dataService.restartApplication();
      }, 1500);
    } catch (err) {
      alert('迁移失败: ' + String(err));
      setIsMigrating(false);
      setMigrationStatus('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#181818] w-[680px] rounded-xl shadow-2xl border border-neutral-800 overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-[#141414]">
          <h2 className="text-base font-semibold text-white">系统首选项与存储管理</h2>
          <button 
            onClick={onClose} 
            disabled={isMigrating}
            className="text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex h-[480px]">
          {/* Sidebar Tabs */}
          <div className="w-52 border-r border-neutral-800 p-2 space-y-1 bg-[#141414]">
            <button
              onClick={() => setActiveTab('database')}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-xs font-medium flex items-center gap-2 transition-colors ${
                activeTab === 'database' 
                  ? 'bg-blue-500/10 text-blue-400 font-semibold' 
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
            >
              <Database size={15} /> 数据存储与完整迁移
            </button>
            <button
              onClick={() => setActiveTab('appearance')}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-xs font-medium flex items-center gap-2 transition-colors ${
                activeTab === 'appearance' 
                  ? 'bg-blue-500/10 text-blue-400 font-semibold' 
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
            >
              <Monitor size={15} /> 主题与外观
            </button>
          </div>

          {/* Content Area */}
          <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
            
            {activeTab === 'database' && (
              <div className="space-y-6">
                
                {/* 1. Storage Stats Cards */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
                      <HardDrive size={14} className="text-blue-400" />
                      <span>当前数据存储目录与磁盘空间占用</span>
                    </span>
                    <span className="text-[10px] font-mono bg-neutral-800 px-2 py-0.5 rounded text-neutral-400">
                      SQLite 嵌入式存储
                    </span>
                  </div>

                  <div className="p-3 rounded-lg bg-[#141414] border border-neutral-800 text-xs font-mono space-y-2">
                    <div className="text-neutral-400 truncate" title={storageStats?.data_dir}>
                      目录: <span className="text-neutral-200">{storageStats?.data_dir || '加载中...'}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <div className="bg-[#1a1a1a] p-2 rounded border border-neutral-800/80">
                        <div className="text-[10px] text-neutral-500">SQLite 数据库</div>
                        <div className="font-semibold text-neutral-200 text-sm mt-0.5">
                          {storageStats ? formatBytes(storageStats.db_size_bytes) : '--'}
                        </div>
                      </div>
                      <div className="bg-[#1a1a1a] p-2 rounded border border-neutral-800/80">
                        <div className="text-[10px] text-neutral-500">Windows 缩略图缓存</div>
                        <div className="font-semibold text-neutral-200 text-sm mt-0.5">
                          {storageStats ? formatBytes(storageStats.thumbnails_size_bytes) : '--'}
                        </div>
                      </div>
                      <div className="bg-[#1a1a1a] p-2 rounded border border-neutral-800/80">
                        <div className="text-[10px] text-neutral-500">总计占用空间</div>
                        <div className="font-semibold text-emerald-400 text-sm mt-0.5">
                          {storageStats ? formatBytes(storageStats.total_size_bytes) : '--'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 2. Full Data Migration Card */}
                <div className="p-4 rounded-xl border border-blue-500/20 bg-blue-500/5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Sparkles size={16} className="text-blue-400" />
                    <span className="text-xs font-semibold text-white">本地数据完整迁移 (一键迁移并自动重启)</span>
                  </div>
                  <p className="text-[11px] text-neutral-400 leading-relaxed">
                    迁移时将安全停止事务写入，完整拷贝软件的所有数据（包括 SQLite 数据库、WAL 事务日志、全部缩略图缓存等）。迁移成功后程序将自动更新配置并重启，自动读取并使用新的文件地址和数据库地址显示界面。
                  </p>

                  <div className="space-y-1.5 pt-1">
                    <label className="text-xs font-semibold text-neutral-300">目标新存储目录路径</label>
                    <input
                      type="text"
                      value={migrationTargetPath}
                      onChange={(e) => setMigrationTargetPath(e.target.value)}
                      disabled={isMigrating}
                      placeholder="例如: D:\AssetHub_Data 或 E:\AppData\AssetHub"
                      className="w-full bg-[#141414] border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-200 font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  {isMigrating && (
                    <div className="p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 flex items-center gap-2">
                      <Loader2 size={15} className="animate-spin text-blue-400 shrink-0" />
                      <span>{migrationStatus}</span>
                    </div>
                  )}

                  {migrationSuccess && (
                    <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
                      <span>迁移成功！软件即将自动重启并加载新路径。</span>
                    </div>
                  )}

                  <button
                    onClick={handleStartMigration}
                    disabled={isMigrating || !migrationTargetPath.trim()}
                    className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2.5 text-xs font-medium transition-colors flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20 disabled:opacity-50"
                  >
                    {isMigrating ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />}
                    <span>一键完整迁移所有数据并重启软件</span>
                  </button>
                </div>

                {/* 3. Relocate File Base Path */}
                <div className="p-4 rounded-xl border border-neutral-800 bg-[#141414] space-y-3">
                  <h3 className="text-xs font-semibold text-neutral-300 flex items-center gap-2">
                    <FolderSync size={15} className="text-amber-400" />
                    <span>资产源文件路径重定向 (Relocate Asset Path)</span>
                  </h3>
                  <p className="text-[11px] text-neutral-400 leading-relaxed">
                    若您在物理磁盘上移动了素材文件夹（例如从 C 盘移至 D 盘），可在此批量更新内部索引，防止文件死链。
                  </p>
                  
                  <div className="space-y-2">
                    <div>
                      <label className="text-[11px] text-neutral-400">原路径前缀</label>
                      <input 
                        type="text" 
                        placeholder="例如: C:\Workspace"
                        value={oldPath}
                        onChange={(e) => setOldPath(e.target.value)}
                        className="w-full mt-1 bg-[#1a1a1a] border border-neutral-800 rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-neutral-700"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-neutral-400">新路径前缀</label>
                      <input 
                        type="text" 
                        placeholder="例如: D:\NewAssets\Workspace"
                        value={newPath}
                        onChange={(e) => setNewPath(e.target.value)}
                        className="w-full mt-1 bg-[#1a1a1a] border border-neutral-800 rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-neutral-700"
                      />
                    </div>
                    <button 
                      onClick={() => {
                        if (oldPath && newPath) {
                          onRelocatePaths(oldPath, newPath);
                          setOldPath(''); 
                          setNewPath('');
                          alert('路径前缀已更新！');
                        }
                      }}
                      className="w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded py-2 text-xs font-medium transition-colors flex items-center justify-center gap-2 mt-1"
                    >
                      <RefreshCw size={13} /> 更新数据库中资产路径
                    </button>
                  </div>
                </div>

              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xs font-semibold text-white mb-3">主题模式</h3>
                  <div className="grid grid-cols-3 gap-3">
                    <button onClick={() => onUpdateTheme('light')} className="border border-neutral-800 rounded-lg p-3 text-center hover:border-blue-500 transition-colors bg-[#141414]">
                      <div className="w-full h-12 bg-white rounded border border-neutral-300 mb-2 shadow-sm" />
                      <span className="text-xs font-medium text-neutral-400">浅色模式</span>
                    </button>
                    <button onClick={() => onUpdateTheme('dark')} className="border border-blue-500 rounded-lg p-3 text-center bg-blue-500/10 transition-colors">
                      <div className="w-full h-12 bg-[#141414] rounded border border-neutral-800 mb-2 shadow-sm" />
                      <span className="text-xs font-medium text-blue-400">深色模式</span>
                    </button>
                    <button onClick={() => onUpdateTheme('system')} className="border border-neutral-800 rounded-lg p-3 text-center hover:border-blue-500 transition-colors bg-[#141414]">
                      <div className="w-full h-12 bg-gradient-to-r from-white to-[#141414] rounded border border-neutral-700 mb-2 shadow-sm" />
                      <span className="text-xs font-medium text-neutral-400">跟随系统</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

