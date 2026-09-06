import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // 【Tauri 官方模板做法】监视器必须忽略 src-tauri 目录：
      // Rust 编译时 cargo 会锁定 target 下的 .o 产物文件，
      // chokidar/fs.watch 监视被锁定文件会抛出 EBUSY 错误导致开发服务器崩溃。
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : { ignored: ['**/src-tauri/**'] },
    },
  };
});
