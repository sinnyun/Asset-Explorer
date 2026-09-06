/**
 * ============================================================================
 * 组件：缩略图图片 (ThumbnailImage)
 * 职责：
 * 1. 统一处理桌面模式下缩略图的 base64 转换（绕过浏览器 file:// 安全限制）
 * 2. Web 模式下直接使用 asset.thumbnailUrl（Web 模式下无 file:// 限制）
 * 3. 提供加载中状态和失败后的占位图标
 * 4. 一处定义，多处复用（PropertiesPanel、MonitoredSplitView、列表视图等）
 * ============================================================================
 */
import React, { useState, useEffect, useRef } from 'react';
import { Asset } from '../types';
import { dataService } from '../services/dataService';
import { Loader2 } from 'lucide-react';

interface ThumbnailImageProps {
  asset: Asset;
  /** 额外的 CSS 类名 */
  className?: string;
  /** alt 文本，默认使用 asset.name */
  alt?: string;
  /** 缩略图加载失败或无缩略图时显示的占位图标 */
  fallbackIcon?: React.ReactNode;
  /** 图片加载策略，默认 lazy */
  loading?: 'lazy' | 'eager';
}

/**
 * 缩略图组件：自动处理桌面环境下的 base64 转换
 *
 * 在桌面 Tauri 环境下：
 * - 若 asset.thumbnailUrl 已存在（数据库缓存），调用 Rust IPC readThumbnailBase64
 *   读取缓存的缩略图文件并返回 base64 data URL
 * - 若无缓存，调用 Rust 后端从源文件生成缩略图并保存到数据库
 *
 * 在 Web 环境下：
 * - 直接使用 asset.thumbnailUrl（无 file:// 安全限制）
 */
export function ThumbnailImage({ asset, className, alt, fallbackIcon, loading = 'lazy' }: ThumbnailImageProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'done' | 'failed'>('idle');
  const isDesktop = useRef(
    typeof window !== 'undefined' && typeof (window as any).__TAURI__ !== 'undefined'
  ).current;
  const mountedRef = useRef(true);

  useEffect(() => {
    // 清理标记：防止组件卸载后继续更新状态
    mountedRef.current = true;

    const loadThumbnail = async () => {
      // Web 环境：直接使用 asset.thumbnailUrl（无 file:// 安全限制）
      if (!isDesktop) {
        if (asset.thumbnailUrl) {
          setThumbUrl(asset.thumbnailUrl);
          setLoadingState('done');
        } else {
          setLoadingState('failed');
        }
        return;
      }

      // 桌面环境：通过 Rust IPC 读取缩略图，返回 base64 data URL
      setLoadingState('loading');
      try {
        const url = await dataService.getAssetThumbnail(asset.id, asset.path, asset.thumbnailUrl);
        if (mountedRef.current) {
          if (url) {
            setThumbUrl(url);
            setLoadingState('done');
          } else {
            setLoadingState('failed');
          }
        }
      } catch {
        if (mountedRef.current) {
          setLoadingState('failed');
        }
      }
    };

    loadThumbnail();

    return () => {
      mountedRef.current = false;
    };
  }, [asset.id, asset.path, asset.thumbnailUrl, isDesktop]);

  // 缩略图加载完成 → 显示图片
  if (thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt={alt || asset.name}
        className={className}
        loading={loading}
      />
    );
  }

  // 缩略图加载中 → 显示加载动画
  if (loadingState === 'loading') {
    return <Loader2 size={24} className="animate-spin text-neutral-500" />;
  }

  // 加载失败或无缩略图 → 显示占位图标（如果有）
  if (fallbackIcon) {
    return <>{fallbackIcon}</>;
  }

  return null;
}