import React, { useState, useEffect } from 'react';
import { LogIn, LogOut, Cloud, Sparkles, User as UserIcon, RefreshCw, HardDrive, CheckCircle2 } from 'lucide-react';
import { runtime, apiClient } from '../services/api';
import type { User } from 'firebase/auth';

interface UserAccountBarProps {
  onReloadWorkspace?: () => void;
}

export function UserAccountBar({ onReloadWorkspace }: UserAccountBarProps) {
  const isDesktop = runtime.isDesktop;
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedSuccess, setSeedSuccess] = useState(false);

  useEffect(() => {
    if (isDesktop) return;

    let unsubscribe: (() => void) | undefined;
    import('../lib/firebase').then(({ auth }) => {
      import('firebase/auth').then(({ onAuthStateChanged }) => {
        unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
          setUser(currentUser);
          if (currentUser) {
            try {
              // 自动同步用户到 PostgreSQL
              const token = await currentUser.getIdToken();
              await fetch('/api/auth/sync', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                },
              });
            } catch (e) {
              console.warn('同步用户信息失败:', e);
            }
          }
        });
      });
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [isDesktop]);

  const handleLogin = async () => {
    if (isDesktop) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const { auth, googleAuthProvider } = await import('../lib/firebase');
      const { signInWithPopup } = await import('firebase/auth');
      const credential = await signInWithPopup(auth, googleAuthProvider);
      
      // 同步用户信息到数据库
      if (credential.user) {
        const token = await credential.user.getIdToken();
        await fetch('/api/auth/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
        });
        onReloadWorkspace?.();
      }
    } catch (err: any) {
      console.error('Google 登录失败:', err);
      if (err.code === 'auth/popup-blocked') {
        setErrorMsg('弹出窗口被浏览器拦截，请允许弹窗或新标签打开');
      } else {
        setErrorMsg('登录失败，请重试');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    if (isDesktop) return;
    setLoading(true);
    try {
      const { auth } = await import('../lib/firebase');
      const { signOut } = await import('firebase/auth');
      await signOut(auth);
      setMenuOpen(false);
      onReloadWorkspace?.();
    } catch (err) {
      console.error('退出登录失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSeedWorkspace = async () => {
    setSeeding(true);
    try {
      const seeded = await apiClient.seedWorkspace();
      if (seeded) {
        setSeedSuccess(true);
        setTimeout(() => setSeedSuccess(false), 3000);
        onReloadWorkspace?.();
      }
    } catch (err) {
      console.error('初始化示例库失败:', err);
    } finally {
      setSeeding(false);
    }
  };

  if (isDesktop) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-neutral-900/60 border border-neutral-800 text-[11px] text-neutral-400">
        <HardDrive size={13} className="text-emerald-400 shrink-0" />
        <span className="truncate">桌面本地模式 (SQLite)</span>
      </div>
    );
  }

  return (
    <div className="relative">
      {user ? (
        <div className="p-2 rounded-lg bg-neutral-900/80 border border-neutral-800 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName || 'User'}
                  className="w-6 h-6 rounded-full object-cover border border-neutral-700 shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                  {(user.displayName || user.email || 'U')[0].toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-xs font-medium text-neutral-200 truncate leading-tight">
                  {user.displayName || user.email?.split('@')[0]}
                </div>
                <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  云端数据库已就绪
                </div>
              </div>
            </div>

            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="text-[11px] text-neutral-400 hover:text-neutral-200 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
              title="账户选项"
            >
              {menuOpen ? '收起' : '管理'}
            </button>
          </div>

          {menuOpen && (
            <div className="pt-2 border-t border-neutral-800/80 space-y-1">
              <button
                onClick={handleSeedWorkspace}
                disabled={seeding}
                className="w-full flex items-center justify-between text-[11px] text-neutral-300 hover:text-white bg-white/5 hover:bg-white/10 px-2 py-1.5 rounded transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  {seedSuccess ? <CheckCircle2 size={13} className="text-emerald-400" /> : <Sparkles size={13} className="text-amber-400" />}
                  {seedSuccess ? '已导入示例库' : '一键导入云端样例'}
                </span>
                {seeding && <RefreshCw size={11} className="animate-spin text-neutral-400" />}
              </button>

              <button
                onClick={handleLogout}
                disabled={loading}
                className="w-full flex items-center gap-1.5 text-[11px] text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-2 py-1.5 rounded transition-colors"
              >
                <LogOut size={13} />
                退出登录
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 text-xs font-medium text-white bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 hover:border-neutral-600 rounded-lg py-2 transition-all shadow-sm group"
          >
            {loading ? (
              <RefreshCw size={14} className="animate-spin text-neutral-400" />
            ) : (
              <>
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>登录 Google 账号同步</span>
              </>
            )}
          </button>

          <div className="flex items-center justify-between px-1 text-[10px] text-neutral-500">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500/80" />
              本地演示体验模式
            </span>
            <span className="text-neutral-600">云端已连接</span>
          </div>

          {errorMsg && (
            <div className="text-[10px] text-rose-400 bg-rose-950/40 border border-rose-800/40 rounded px-2 py-1 leading-tight">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
