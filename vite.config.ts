import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // API 端口与 apps/api 共用同一份 .env，避免两边不一致
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.API_PORT || '3001'
  const apiTarget = `http://127.0.0.1:${apiPort}`

  return {
    plugins: [react()],
    server: {
      proxy: {
        // 开发期同源转发到本地 API（apps/api），生产由 VITE_API_BASE 指向独立服务
        '/api': {
          target: apiTarget,
          changeOrigin: false,
        },
      },
    },
    // vite preview 同样转发，方便用生产构建做本地验收
    preview: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: false,
        },
      },
    },
  }
})
