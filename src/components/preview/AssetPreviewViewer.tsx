/**
 * ============================================================================
 * 组件：Asset 文件预览器 (AssetPreviewViewer)
 *
 * 封装开源库 open-file-viewer (@open-file-viewer/react) 的 FileViewer，
 * 针对单个 Asset 自动解析其可加载的预览源并渲染。
 *
 * 特点：
 *   - 依据 asset.type 动态加载对应插件（图片/视频/音频/文档/Office/PDF 等）
 *   - 通过 style.css 提供与主题一致的工具栏、缩放/旋转/全屏等交互
 * ============================================================================
 */
import { useMemo } from 'react';
import { FileViewer } from '@open-file-viewer/react';
import {
  imagePlugin,
  textPlugin,
  videoPlugin,
  audioPlugin,
  officePlugin,
  pdfPlugin,
  archivePlugin,
  model3dPlugin,
  fallbackPlugin,
  type PreviewPlugin,
} from '@open-file-viewer/core';
import '@open-file-viewer/core/style.css';
import type { Asset } from '../../types';

interface AssetPreviewViewerProps {
  /** 预览源 URL（由 resolveAssetPreviewSource 解析得到） */
  src: string;
  asset: Asset;
  /** 是否显示工具栏（默认 true） */
  toolbar?: boolean;
  /** 高度 CSS 值 */
  height?: number | string;
  width?: number | string;
  className?: string;
  /** 全屏展示模式（隐藏自带 fullscreen 按钮，交由外层悬浮面板控制） */
  fullscreen?: boolean;
}

/**
 * 依据文件名扩展名/类型挑选预览插件
 */
function pickPlugins(asset: Asset): PreviewPlugin[] {
  const name = asset.name || '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

  // 代码 / 文本 / 标记类文件
  const textExts = [
    'txt', 'md', 'log', 'json', 'js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'css',
    'scss', 'less', 'xml', 'yml', 'yaml', 'toml', 'ini', 'csv', 'py', 'java',
    'c', 'cpp', 'h', 'go', 'rs', 'sh', 'bat', 'sql', 'php', 'rb', 'kt', 'swift',
  ];
  if (ext === 'pdf') return [pdfPlugin(), fallbackPlugin()];
  if (textExts.includes(ext)) return [textPlugin(), fallbackPlugin()];

  switch (asset.type) {
    case 'image':
      return [imagePlugin(), fallbackPlugin()];
    case 'video':
      return [videoPlugin(), fallbackPlugin()];
    case 'audio':
      return [audioPlugin(), fallbackPlugin()];
    case 'model':
    case '3d':
      return [model3dPlugin(), fallbackPlugin()];
    case 'archive':
      return [archivePlugin(), fallbackPlugin()];
    case 'document':
      // Office 文档 / PDF 文本类
      return [officePlugin(), pdfPlugin(), textPlugin(), fallbackPlugin()];
    default:
      return [imagePlugin(), videoPlugin(), audioPlugin(), officePlugin(), pdfPlugin(), textPlugin(), fallbackPlugin()];
  }
}

export function AssetPreviewViewer({
  src,
  asset,
  toolbar = true,
  height = '100%',
  width = '100%',
  className,
  fullscreen = false,
}: AssetPreviewViewerProps) {
  const plugins = useMemo(() => pickPlugins(asset), [asset]);

  return (
    <FileViewer
      file={src}
      fileName={asset.name}
      width={width}
      height={height}
      fit="contain"
      className={className}
      theme="dark"
      locale="zh-CN"
      toolbar={fullscreen ? { fullscreen: false } : toolbar}
      plugins={plugins}
      onError={(err) => console.warn('[AssetPreview] 预览出错:', err?.message || err)}
    />
  );
}
