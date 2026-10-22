import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // BFF 端口与 server/index.mjs 共用同一份 .env，避免两边端口不一致
  const env = loadEnv(mode, process.cwd(), '')
  const bffPort = env.PORT || '3000'
  const bffTarget = `http://127.0.0.1:${bffPort}`
  // 新 API（apps/api）默认 3001；本地先让对战详情走它，其余接口仍旧 BFF
  const newApiTarget = `http://127.0.0.1:${env.API_PORT || '3001'}`

  return {
    plugins: [react()],
    server: {
      proxy: {
        // 更具体的路径必须排在 '/api' 前面
        '/api/match-detail': {
          target: newApiTarget,
          changeOrigin: false,
        },
        // 统一走同源 /api，密钥只存在于服务端
        '/api': {
          target: bffTarget,
          changeOrigin: false,
        },
      },
    },
  }
})
