import React, { useState, useEffect } from 'react';
import { X, Hash, Layers, Pin, Check } from 'lucide-react';

interface CreateEntityModalProps {
  isOpen: boolean;
  type: 'tag' | 'collection';
  existingNames: string[];
  onClose: () => void;
  onConfirm: (data: { name: string; color: string; description?: string; isPinned: boolean }) => void;
}

const PRESET_COLORS = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#06b6d4', // Cyan
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#64748b', // Slate
];

export function CreateEntityModal({
  isOpen,
  type,
  existingNames,
  onClose,
  onConfirm
}: CreateEntityModalProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(type === 'tag' ? '#3b82f6' : '#f59e0b');
  const [description, setDescription] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setColor(type === 'tag' ? PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)] : '#f59e0b');
      setDescription('');
      setIsPinned(false);
      setError(null);
    }
  }, [isOpen, type]);

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(`请输入${type === 'tag' ? '标签' : '集合'}名称`);
      return;
    }

    if (existingNames.some(n => n.toLowerCase() === trimmedName.toLowerCase())) {
      setError(`已存在同名的${type === 'tag' ? '标签' : '集合'}`);
      return;
    }

    onConfirm({
      name: trimmedName,
      color,
      description: description.trim() || undefined,
      isPinned
    });
    onClose();
  };

  const isTag = type === 'tag';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div 
        className="w-full max-w-md bg-[#1c1c1c] border border-neutral-800 rounded-xl shadow-2xl overflow-hidden text-neutral-200 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 bg-[#171717]">
          <div className="flex items-center gap-2.5">
            <div 
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${color}20`, color: color }}
            >
              {isTag ? <Hash size={18} /> : <Layers size={18} />}
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">
                {isTag ? '新建标签' : '新建集合'}
              </h2>
              <p className="text-xs text-neutral-400">
                {isTag ? '创建新标签以便于跨文件夹分类和检索素材' : '创建新集合以便按项目或主题整理素材资产'}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1 rounded-md text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Name Field */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">
              {isTag ? '标签名称' : '集合名称'} <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={isTag ? '例如: 角色原画、UI组件、未完成...' : '例如: 2026核心素材、概念原案...'}
              className="w-full bg-[#121212] border border-neutral-700/70 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
            {error && (
              <p className="mt-1 text-xs text-red-400">{error}</p>
            )}
          </div>

          {/* Color Palette */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">
              色彩标识
            </label>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {PRESET_COLORS.map(c => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setColor(c)}
                  className="w-6 h-6 rounded-full border border-neutral-700/50 flex items-center justify-center transition-transform hover:scale-110 relative"
                  style={{ backgroundColor: c }}
                  title={c}
                >
                  {color.toLowerCase() === c.toLowerCase() && (
                    <Check size={12} className="text-white drop-shadow-xs" />
                  )}
                </button>
              ))}
              <div className="flex items-center gap-1 ml-1 bg-[#121212] border border-neutral-700/60 rounded-md px-1.5 py-0.5">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-5 h-5 rounded cursor-pointer bg-transparent border-0"
                  title="自定义颜色"
                />
                <span className="text-[11px] font-mono text-neutral-400 uppercase">{color}</span>
              </div>
            </div>
          </div>

          {/* Description Field */}
          <div>
            <label className="block text-xs font-medium text-neutral-300 mb-1.5">
              描述说明 <span className="text-neutral-500">(可选)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="添加简要说明或备注..."
              rows={2}
              className="w-full bg-[#121212] border border-neutral-700/70 rounded-lg px-3 py-2 text-xs text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-blue-500 transition-colors resize-none"
            />
          </div>

          {/* Pin Option */}
          <div className="flex items-center justify-between p-3 bg-[#141414] border border-neutral-800 rounded-lg">
            <div className="flex items-center gap-2">
              <Pin size={15} className={isPinned ? "text-amber-400 fill-amber-400" : "text-neutral-500"} />
              <div>
                <div className="text-xs font-medium text-neutral-200">在侧边栏置顶显示</div>
                <div className="text-[11px] text-neutral-500">置顶后将固定显示在导航列表最上方</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsPinned(!isPinned)}
              className={`w-9 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                isPinned ? 'bg-amber-500' : 'bg-neutral-700'
              }`}
            >
              <div
                className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  isPinned ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-800/80">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors"
            >
              {isTag ? '创建标签' : '创建集合'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
