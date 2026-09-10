/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import type { ScanProgress } from '../hooks/useScanMonitor';
import { cn } from '../lib/utils';

interface ScanProgressBarProps {
  progress: ScanProgress;
}

/**
 * 程序底部全局扫描进度条
 *
 * 仅展示「正在索引的监视文件夹」的扫描进度（总文件数 / 剩余文件数），
 * 与主界面资产渲染完全解耦——即使扫描仍在后台进行，已扫到的资产也会
 * 通过增量事件边扫边显示，不会阻塞 UI。
 */
export function ScanProgressBar({ progress }: ScanProgressBarProps) {
  if (!progress.active) return null;

  const { total, done } = progress;
  const remaining = Math.max(total - done, 0);
  const percent = total > 0 ? Math.min(Math.round((done / total) * 100), 100) : 0;
  const isDone = progress.status === 'finished';
  const isFailed = progress.status === 'failed';

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[560px] max-w-[90vw] animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div
        className={cn(
          "rounded-xl border shadow-2xl backdrop-blur-xl px-4 py-3",
          isFailed
            ? "bg-red-950/90 dark:bg-red-950/90 border-red-500/40"
            : isDone
            ? "bg-emerald-950/90 dark:bg-emerald-950/90 border-emerald-500/40"
            : "bg-neutral-900/90 dark:bg-neutral-900/90 border-neutral-700"
        )}
      >
        <div className="flex items-center gap-3">
          <div className="shrink-0">
            {isFailed ? (
              <AlertTriangle size={18} className="text-red-400" />
            ) : isDone ? (
              <CheckCircle2 size={18} className="text-emerald-400" />
            ) : (
              <Loader2 size={18} className="animate-spin text-blue-400" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-xs font-medium text-neutral-200 truncate">
                {isFailed
                  ? `索引失败：${progress.error || '未知错误'}`
                  : isDone
                  ? `「${progress.folderName}」索引完成`
                  : `正在建立索引：${progress.folderName || progress.path}`}
              </span>
              <span className="text-xs text-neutral-400 shrink-0 tabular-nums">
                {isDone
                  ? `${total} 个文件`
                  : isFailed
                  ? ''
                  : total > 0
                  ? `剩余 ${remaining} / 共 ${total} 个文件`
                  : '正在统计文件…'}
              </span>
            </div>

            {/* 进度条 */}
            <div className="w-full h-1.5 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-300",
                  isFailed ? "bg-red-500" : isDone ? "bg-emerald-500" : "bg-blue-500"
                )}
                style={{ width: `${isFailed ? 100 : percent}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
