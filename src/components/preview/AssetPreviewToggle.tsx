/**
 * ============================================================================
 * 组件：右侧详情面板"文件预览区"的 缩略图 / 查看器 切换
 *
 * 在该区域顶部提供两个切换按钮：
 *   - "缩略图"：保持原有的缩略图显示
 *   - "查看器"：使用 open-file-viewer 直接渲染该文件（图片/视频/文档等）
 * ============================================================================
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Image as ImageIcon, ScanEye, Loader2, ExternalLink } from 'lucide-react';
import type { Asset } from '../../types';
import { cn } from '../../lib/utils';
import { ThumbnailImage } from '../ThumbnailImage';
import { resolveAssetPreviewSource } from './assetPreviewSource';
// 懒加载重量级预览库：进入查看器模式时才加载 open-file-viewer
const AssetPreviewViewer = lazy(() =>
  import('./AssetPreviewViewer').then((m) => ({ default: m.AssetPreviewViewer }))
);

interface AssetPreviewToggleProps {
  asset: Asset;
}

type PreviewMode = 'thumbnail' | 'viewer';

export function AssetPreviewToggle({ asset }: AssetPreviewToggleProps) {
  const [mode, setMode] = useState<PreviewMode>('thumbnail');
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // 进入查看器模式时解析预览源
  useEffect(() => {
    if (mode !== 'viewer') return;
    setSrc(null);
    setFailed(false);
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
  }, [asset, mode]);

  const switchMode = (next: PreviewMode) => {
    // 切换回来不破坏源，直接切换渲染
    setMode(next);
  };

  return (
    <div className="w-full bg-[#111] rounded-lg overflow-hidden border border-neutral-800 mb-3 shadow-inner relative">
      {/* 顶部切换按钮 */}
      <div className="absolute top-1.5 right-1.5 z-20 flex items-center gap-0.5 bg-black/60 backdrop-blur-md rounded-md p-0.5 border border-white/10">
        <button
          onClick={() => switchMode('thumbnail')}
          title="缩略图"
          className={cn(
            "p-1 rounded transition-colors",
            mode === 'thumbnail' ? "bg-neutral-600 text-white" : "text-neutral-400 hover:text-white hover:bg-white/10"
          )}
        >
          <ImageIcon size={12} />
        </button>
        <button
          onClick={() => switchMode('viewer')}
          title="文件查看器"
          className={cn(
            "p-1 rounded transition-colors",
            mode === 'viewer' ? "bg-neutral-600 text-white" : "text-neutral-400 hover:text-white hover:bg-white/10"
          )}
        >
          <ScanEye size={12} />
        </button>
      </div>

      {/* 内容区 */}
      {mode === 'thumbnail' ? (
        <div className="w-full aspect-video bg-black flex items-center justify-center overflow-hidden">
          <ThumbnailImage
            asset={asset}
            className="w-full h-full object-contain"
            fallbackIcon={<ImageIcon size={48} className="text-neutral-700" />}
            loading="eager"
          />
        </div>
      ) : (
        <div className="w-full h-64 bg-black flex items-center justify-center">
          {failed ? (
            <div className="flex flex-col items-center justify-center text-neutral-500 px-3 text-center">
              <ExternalLink size={20} className="mb-2 opacity-50" />
              <p className="text-[11px]">暂不支持在此预览</p>
            </div>
          ) : src ? (
            <Suspense
              fallback={
                <Loader2 size={22} className="animate-spin text-neutral-500" />
              }
            >
              <AssetPreviewViewer
                src={src}
                asset={asset}
                height="100%"
                className="w-full h-full"
              />
            </Suspense>
          ) : (
            <Loader2 size={22} className="animate-spin text-neutral-500" />
          )}
        </div>
      )}

    </div>
  );
}
