/**
 * ============================================================================
 * 模块：环境检测引擎 (environment.ts)
 * 职责：统一检测当前运行环境（桌面/远程Web/本地Web），并提供相应的配置信息。
 * 检测机制：
 *   1. Tauri 桌面环境 → 检测 window.__TAURI__ 或 __TAURI_INTERNALS__
 *   2. 远程 Web 环境 → 检测 APP_ENV=remote 环境变量
 *   3. 本地 Web 环境 → 默认（本地开发服务器）
 * ============================================================================
 */

/** 运行环境枚举 */
export type AppEnvironment = 'desktop' | 'remote-web' | 'local-web';

/** 环境配置信息 */
export interface EnvironmentConfig {
  /** 当前运行环境 */
  env: AppEnvironment;
  /** 是否为 Tauri 桌面应用 */
  isDesktop: boolean;
  /** 是否为远程 Web 环境 */
  isRemoteWeb: boolean;
  /** 是否为本地 Web 环境 */
  isLocalWeb: boolean;
  /** API 基础 URL（仅 Web 模式使用） */
  apiBaseUrl: string;
  /** 调试标记 */
  debug: boolean;
}

/**
 * 检测是否为 Tauri 桌面环境
 * 通过检查 window 对象上是否存在 Tauri 注入的全局标记来判断
 */
export function isTauriDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    '__TAURI__' in window ||
    '__TAURI_INTERNALS__' in window ||
    (window as any).__TAURI_IPC__ !== undefined
  );
}

/**
 * 检测是否为远程 Web 环境（如 AI Studio / Cloud Run）
 * 通过检查 APP_URL 环境变量是否与本地地址不同来判断
 * 远程平台会自动注入 APP_URL 环境变量
 */
export function isRemoteWeb(): boolean {
  if (typeof window === 'undefined') return false;
  // 检测导入元数据中的环境变量（Vite 注入）
  const appUrl = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_APP_URL : undefined;
  const appEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_APP_ENV : undefined;

  if (appEnv === 'remote') return true;
  if (appUrl && !appUrl.includes('localhost') && !appUrl.includes('127.0.0.1')) return true;

  return false;
}

/**
 * 获取当前运行环境和配置
 * 优先级：桌面 > 远程 Web > 本地 Web
 */
export function getEnvironment(): EnvironmentConfig {
  // 1. 检测 Tauri 桌面环境
  if (isTauriDesktop()) {
    return {
      env: 'desktop',
      isDesktop: true,
      isRemoteWeb: false,
      isLocalWeb: false,
      apiBaseUrl: '',
      debug: false,
    };
  }

  // 2. 检测远程 Web 环境
  if (isRemoteWeb()) {
    return {
      env: 'remote-web',
      isDesktop: false,
      isRemoteWeb: true,
      isLocalWeb: false,
      // 远程环境下使用当前页面源作为 API 基础 URL
      apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      debug: false,
    };
  }

  // 3. 默认：本地 Web 开发环境
  return {
    env: 'local-web',
    isDesktop: false,
    isRemoteWeb: false,
    isLocalWeb: true,
    // 本地开发时 Express 服务器运行在 3000 端口
    apiBaseUrl: 'http://localhost:3000',
    debug: true,
  };
}

/**
 * 获取 API 基础 URL（外部导入时使用 Vite 环境变量或自动检测）
 * 优先使用 VITE_API_BASE_URL 环境变量，否则自动检测
 */
export function getApiBaseUrl(): string {
  // 优先使用 Vite 环境变量
  if (typeof import.meta !== 'undefined') {
    const envUrl = (import.meta as any).env?.VITE_API_BASE_URL;
    if (envUrl) return envUrl;
  }

  return getEnvironment().apiBaseUrl;
}

/**
 * 获取当前环境字符串表示（用于日志/调试）
 */
export function getEnvironmentLabel(): string {
  const env = getEnvironment();
  switch (env.env) {
    case 'desktop':
      return '[环境:桌面]';
    case 'remote-web':
      return '[环境:远程Web]';
    case 'local-web':
      return '[环境:本地Web]';
  }
}