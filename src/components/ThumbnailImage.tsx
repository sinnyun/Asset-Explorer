/**
 * ============================================================================
 * 组件：缩略图图片 (ThumbnailImage)
 * 职责：
 * 1. 统一处理桌面模式下缩略图的加载（桌面模式通过 Rust IPC 获取/生成缩略图）
 * 2. Web 模式下直接使用 asset.thumbnailUrl（Web 模式下无 file:// 限制）
 * 3. 提供加载中状态和失败后的占位图标
 * 4. 一处定义，多处复用（PropertiesPanel、MonitoredSplitView、列表视图等）
 *
 * 【修复】自动恢复失效缩略图：
 *   当桌面模式下 asset:// URL 因缓存文件被清理/数据迁移导致 404 时，
 *   <img> 触发 onError → 自动通过 Rust IPC 重新生成缩略图并更新缓存，
 *   避免缩略图空白占位。
 * ============================================================================
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Asset } from '../types';
import { dataService, isTauriDesktop } from '../services/dataService';
import { Loader2 } from 'lucide-react';

/**
 * 内存缩略图缓存（跨组件与滚动生命周期持久）：
 * - 避免列表滚动时重复触发 Rust IPC 跨进程数据传输
 * - 避免重新反序列化数十 KB 的 base64 字符串造成主线程卡顿
 */
const thumbnailCache = new Map<string, string>();

/** 已触发过重新生成的资产 ID 集合（防止 onError 死循环重试） */
const regenerationAttempted = new Set<string>();

/** 进行中的缩略图请求合并（同一资产去重） */
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
 * 缩略图组件：自动处理桌面环境下的缩略图加载与缓存
 *
 * 优化策略：
 * 1. 内存二级缓存：已加载的缩略图直接从 Map 读取，初次渲染 0ms 显示，无 IPC 开销。
 * 2. 请求合并去重：同一资产被多次引用时，复用同一个 in-flight Promise。
 * 3. 自动恢复：图片加载失败时自动触发 Rust 后端重新生成缩略图。
 */
export function ThumbnailImage({ asset, className, alt, fallbackIcon, loading = 'lazy' }: ThumbnailImageProps) {
  const cacheKey = asset.id;
  const isDesktop = useRef(isTauriDesktop()).current;
  const mountedRef = useRef(true);

  // 初始 URL：优先从内存缓存读取；
  // Web 环境下若无缓存但 asset.thumbnailUrl 存在，直接使用（无需 IPC）。
  const cachedUrl = thumbnailCache.get(cacheKey)
    || (!isDesktop && asset.thumbnailUrl ? asset.thumbnailUrl : null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(cachedUrl);
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'done' | 'failed'>(
    cachedUrl ? 'done' : 'idle'
  );
  /**
   * 加载缩略图。
   * @param forceRegenerate - 为 true 时跳过已有的 thumbnailUrl 缓存路径，
   *   直接调用 Rust get_thumbnail 强制验证/重新生成。
   */
  const loadThumbnail = useCallback((forceRegenerate = false) => {
    if (!isDesktop) {
      // Web 环境：直接使用 asset.thumbnailUrl
      if (asset.thumbnailUrl) {
        regenerationAttempted.delete(cacheKey);
        thumbnailCache.set(cacheKey, asset.thumbnailUrl);
        setThumbUrl(asset.thumbnailUrl);
        setLoadingState('done');
      } else {
        setLoadingState('failed');
      }
      return;
    }

    // 合并并发请求：同一资产的重复调用共享同一个 Promise
    const reqKey = `${cacheKey}:${forceRegenerate ? 'regen' : 'normal'}`;
    let requestPromise = inFlightThumbnails.get(reqKey);
    if (!requestPromise) {
      requestPromise = dataService.getAssetThumbnail(
        asset.id,
        asset.path,
        forceRegenerate ? undefined : asset.thumbnailUrl
      ).finally(() => {
        inFlightThumbnails.delete(reqKey);
      });
      inFlightThumbnails.set(reqKey, requestPromise);
    }

    setLoadingState('loading');
    requestPromise
      .then((url) => {
        if (!mountedRef.current) return;
        if (url) {
          // 缩略图加载成功 → 清除重试标记，允许后续失败再次自动恢复。
          // 但若返回的是 asset 协议 URL（asset:// / asset.localhost），
          // 协议可能本身不可用——保留 regenerationAttempted 标记，
          // 使后续 onError 能直接走 base64 降级而不是陷入无效重试循环。
          const isAssetProtoUrl = url.startsWith('asset://') || url.includes('asset.localhost');
          if (!isAssetProtoUrl) {
            regenerationAttempted.delete(cacheKey);
          }
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
  }, [cacheKey, asset.id, asset.path, asset.thumbnailUrl, isDesktop]);

  useEffect(() => {
    mountedRef.current = true;

    // 如果内存缓存中已有，直接使用
    const hit = thumbnailCache.get(cacheKey);
    if (hit) {
      regenerationAttempted.delete(cacheKey);
      setThumbUrl(hit);
      setLoadingState('done');
      return;
    }

    // Web 环境：直接使用 asset.thumbnailUrl
    if (!isDesktop) {
      if (asset.thumbnailUrl) {
        regenerationAttempted.delete(cacheKey);
        thumbnailCache.set(cacheKey, asset.thumbnailUrl);
        setThumbUrl(asset.thumbnailUrl);
        setLoadingState('done');
      } else {
        setLoadingState('failed');
      }
      return;
    }

    // 桌面环境：通过 Rust IPC 获取/生成缩略图
    loadThumbnail(false);

    return () => {
      mountedRef.current = false;
    };
  }, [cacheKey, asset.id, asset.path, asset.thumbnailUrl, isDesktop, loadThumbnail]);

  /**
   * 处理 <img> 加载失败事件：
   * - 桌面模式下，若 asset:// URL 因缓存文件失效/路径格式问题导致 404，
   *   自动通过 Rust IPC 重新生成缩略图（只重试一次）。
   * - 若重新生成后的 URL 仍然 404，则降级尝试 read_thumbnail_base64
   *   直接读取文件为 data URL（绕过 asset:// 协议兼容性问题）。
   * - Web 模式下 URL 由服务端管理，直接显示占位图标。
   *
   * 【增强】asset:// / asset.localhost 协议出现 ERR_CONNECTION_REFUSED
   *   （Tauri asset 协议整体未就绪）时，重新生成只会再产生同类型的 asset 协议 URL，
   *   无法解决问题。此时优先尝试直接 base64 读取，绕过 asset 协议。
   */
  const handleImageError = useCallback(() => {
    if (!isDesktop) {
      setLoadingState('failed');
      return;
    }
    // 判断当前失败 URL 是否为 asset 协议（Tauri v1: asset://, v2: http://asset.localhost/）
    const isAssetProtocolUrl = (thumbUrl?.startsWith('asset://')
      || (thumbUrl ?? '').includes('asset.localhost'));

    // asset:// 协议连接被拒绝（非 404 文件缺失而是协议本身不可用）→ 直接跳级到 base64 降级
    if (isAssetProtocolUrl) {
      // 若已经重试过重新生成且仍失败 → 不再重试，直接 base64
      if (regenerationAttempted.has(cacheKey)) {
        // 清理缓存并尝试 base64 读取
        thumbnailCache.delete(cacheKey);
        const base64CacheKey = `${cacheKey}:base64`;
        let requestPromise = inFlightThumbnails.get(base64CacheKey);
        if (!requestPromise) {
          if (asset.thumbnailUrl) {
            requestPromise = dataService.loadThumbnailBase64(asset.thumbnailUrl).finally(() => {
              inFlightThumbnails.delete(base64CacheKey);
            });
          } else {
            // thumbnailUrl 缺失 → 尝试通过 IPC 获取新缩略图路径再读 base64
            setLoadingState('failed');
            return;
          }
          inFlightThumbnails.set(base64CacheKey, requestPromise);
        }

        setLoadingState('loading');
        requestPromise
          .then((dataUrl) => {
            if (!mountedRef.current) return;
            if (dataUrl) {
              thumbnailCache.set(cacheKey, dataUrl);
              setThumbUrl(dataUrl);
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
        return;
      }

      // 首次失败 → 标记已重试，先尝试 IPC 重新生成（可能返回 base64 data URL）
      regenerationAttempted.add(cacheKey);
      thumbnailCache.delete(cacheKey);
      setThumbUrl(null);
      loadThumbnail(true);
      return;
    }

    // 非 asset 协议 URL 的普通加载失败（如 http 404）→ 每个资产只自动重新生成一次
    if (!regenerationAttempted.has(cacheKey)) {
      regenerationAttempted.add(cacheKey);
      thumbnailCache.delete(cacheKey);
      setThumbUrl(null);
      loadThumbnail(true);
    } else {
      // 已重试过一次仍 404 → 尝试用 base64 data URL 展示已有缩略图
      // （绕过 asset:// 协议对某些路径/盘的兼容性问题）
      const base64CacheKey = `${cacheKey}:base64`;
      let requestPromise = inFlightThumbnails.get(base64CacheKey);
      if (!requestPromise) {
        if (asset.thumbnailUrl) {
          requestPromise = dataService.loadThumbnailBase64(asset.thumbnailUrl).finally(() => {
            inFlightThumbnails.delete(base64CacheKey);
          });
        } else {
          setLoadingState('failed');
          return;
        }
        inFlightThumbnails.set(base64CacheKey, requestPromise);
      }

      setLoadingState('loading');
      requestPromise
        .then((dataUrl) => {
          if (!mountedRef.current) return;
          if (dataUrl) {
            thumbnailCache.set(cacheKey, dataUrl);
            setThumbUrl(dataUrl);
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
    }
  }, [cacheKey, asset.id, asset.path, asset.thumbnailUrl, isDesktop, loadThumbnail, thumbUrl]);

  // 缩略图加载完成 → 显示图片
  if (thumbUrl && loadingState !== 'failed') {
    return (
      <img
        src={thumbUrl}
        alt={alt || asset.name}
        className={className}
        loading={loading}
        onError={handleImageError}
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
