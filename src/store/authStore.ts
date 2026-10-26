import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { fetchMe, logoutRequest, type AuthUser } from '../api/authApi'

/**
 * 登录态。
 *
 * token 存 localStorage（persist），请求时放 Authorization 头。
 * 不做「静默续期」：token 是 30 天的不透明串，过期就重新登录。
 *
 * 登录是可选能力——未登录时 token/user 都是 null，站点其余功能照常。
 */

type AuthState = {
  token: string | null
  user: AuthUser | null
  /** 是否已经从持久化恢复并校验过 token（首屏判断用） */
  ready: boolean
  setSession: (token: string, user: AuthUser) => void
  signOut: () => Promise<void>
  /** 启动时校验本地 token 是否还有效；失效就清掉 */
  validate: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      ready: false,

      setSession: (token, user) => set({ token, user, ready: true }),

      signOut: async () => {
        const token = get().token
        set({ token: null, user: null, ready: true })
        if (token) {
          await logoutRequest(token)
        }
      },

      validate: async () => {
        const token = get().token
        if (!token) {
          set({ ready: true })
          return
        }
        try {
          const user = await fetchMe(token)
          set({ user, ready: true })
        } catch {
          set({ token: null, user: null, ready: true })
        }
      },
    }),
    {
      name: 'ticai.auth',
      // ready 不持久化：刷新后必须先校验一次 token
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
)
