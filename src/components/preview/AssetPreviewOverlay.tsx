/**
 * ============================================================================
 * 组件：全屏文件预览悬浮面板 (AssetPreviewOverlay)
 *
 * 双击项目文件时弹出，覆盖整个应用视口，居中显示悬浮面板，
 * 并在面板内使用 open-file-viewer 全屏渲染该文件，支持查看/关闭。
 * ============================================================================
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { X, Loader2, ExternalLink } from 'lucide-react';
import type { Asset } from '../../types';
import { resolveAssetPreviewSource } from './assetPreviewSource';
import { apiClient } from '../../services/api';
// 懒加载重量级预览库，仅在全屏预览打开时才加载 open-file-viewer
const AssetPreviewViewer = lazy(() =>
  import('./AssetPreviewViewer').then((m) => ({ default: m.AssetPreviewViewer }))
);

interface AssetPreviewOverlayProps {
  asset: Asset | null;
  /** 关闭悬浮面板 */
  onClose: () => void;
}

export function AssetPreviewOverlay({ asset, onClose }: AssetPreviewOverlayProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // 当 asset 变化时重新解析预览源
  useEffect(() => {
    setSrc(null);
    setFailed(false);
    if (!asset) return;

    let cancelled = false;
    resolveAssetPreviewSource(asset)
      .then((url) => {
        if (cancelled) return;
        if (url) setSrc(url);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!asset) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(e) => {
        // 点击遮罩空白区域关闭
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 悬浮面板 */}
      <div className="relative w-[92vw] h-[92vh] max-w-[1400px] bg-[#1a1a1a] border border-neutral-700 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* 面板标题栏 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-800 bg-[#191919] select-none">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase font-semibold text-blue-400 tracking-wider shrink-0">全屏预览</span>
            <span className="text-sm text-neutral-200 font-medium truncate" title={asset.path}>
              {asset.name}
            </span>
            <span className="text-xs text-neutral-500 font-mono uppercase truncate hidden sm:inline">
              {asset.type}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => apiClient.openInExplorer(asset.path)}
              className="p-1.5 rounded text-neutral-400 hover:text-blue-300 hover:bg-white/10 transition-colors"
              title="在资源管理器中定位"
            >
              <ExternalLink size={16} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-red-500/80 transition-colors"
              title="关闭 (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 预览主体 */}
        <div className="flex-1 min-h-0 relative bg-black">
          {failed ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-500">
              <ExternalLink size={40} className="mb-3 opacity-40" />
              <p className="text-sm">当前文件暂不支持在此预览</p>
              <button
                onClick={() => apiClient.openInExplorer(asset.path)}
                className="mt-4 text-xs px-3 py-1.5 rounded bg-[#282828] border border-neutral-700 text-neutral-300 hover:bg-[#333] transition-colors"
              >
                在资源管理器中打开
              </button>
            </div>
          ) : src ? (
            <Suspense
              fallback={
                <div className="w-full h-full flex items-center justify-center text-neutral-400">
                  <Loader2 size={28} className="animate-spin" />
                </div>
              }
            >
              <AssetPreviewViewer
                src={src}
                asset={asset}
                fullscreen
                className="w-full h-full"
              />
            </Suspense>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-neutral-400">
              <Loader2 size={28} className="animate-spin" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
