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
import { dataService, isTauriDesktop } from '../services/dataService';
import { Loader2 } from 'lucide-react';

/**
 * 内存缩略图缓存（跨组件与滚动生命周期持久）：
 * - 避免列表滚动时重复触发 Rust IPC 跨进程数据传输
 * - 避免重新反序列化数十 KB 的 base64 字符串造成主线程卡顿
 */
const thumbnailCache = new Map<string, string>();
const inFlightThumbnails = new Map<string, Promise<string | null>>();

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
 * 缩略图组件：自动处理桌面环境下的 base64 转换与缓存
 *
 * 优化策略：
 * 1. 内存二级缓存：已加载的缩略图直接从 Map 读取，初次渲染 0ms 显示，无 IPC 开销。
 * 2. 请求合并去重：同一资产被多次引用时，复用同一个 in-flight Promise。
 * 3. 错误恢复：图片加载失败时平滑降级为 fallbackIcon，防止白屏或破损图片标识。
 */
export function ThumbnailImage({ asset, className, alt, fallbackIcon, loading = 'lazy' }: ThumbnailImageProps) {
  const cacheKey = asset.id;
  const cachedUrl = thumbnailCache.get(cacheKey) || (!isTauriDesktop() && asset.thumbnailUrl ? asset.thumbnailUrl : null);

  const [thumbUrl, setThumbUrl] = useState<string | null>(cachedUrl);
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'done' | 'failed'>(
    cachedUrl ? 'done' : 'idle'
  );
  const isDesktop = useRef(isTauriDesktop()).current;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // 如果内存缓存中已有，直接使用
    const hit = thumbnailCache.get(cacheKey);
    if (hit) {
      setThumbUrl(hit);
      setLoadingState('done');
      return;
    }

    // Web 环境：直接使用 asset.thumbnailUrl
    if (!isDesktop) {
      if (asset.thumbnailUrl) {
        thumbnailCache.set(cacheKey, asset.thumbnailUrl);
        setThumbUrl(asset.thumbnailUrl);
        setLoadingState('done');
      } else {
        setLoadingState('failed');
      }
      return;
    }

    // 桌面环境：通过 Rust IPC 读取并缓存
    setLoadingState('loading');

    let requestPromise = inFlightThumbnails.get(cacheKey);
    if (!requestPromise) {
      requestPromise = dataService.getAssetThumbnail(asset.id, asset.path, asset.thumbnailUrl)
        .finally(() => {
          inFlightThumbnails.delete(cacheKey);
        });
      inFlightThumbnails.set(cacheKey, requestPromise);
    }

    requestPromise
      .then((url) => {
        if (!mountedRef.current) return;
        if (url) {
          thumbnailCache.set(cacheKey, url);
          setThumbUrl(url);
          setLoadingState('done');
        } else {
          setLoadingState('failed');
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setLoadingState('failed');
        }
      });

    return () => {
      mountedRef.current = false;
    };
  }, [cacheKey, asset.id, asset.path, asset.thumbnailUrl, isDesktop]);

  // 缩略图加载完成 → 显示图片
  if (thumbUrl && loadingState !== 'failed') {
    return (
      <img
        src={thumbUrl}
        alt={alt || asset.name}
        className={className}
        loading={loading}
        onError={() => setLoadingState('failed')}
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