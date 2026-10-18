import { type ReactNode } from 'react'

export type KeepAliveRouteItem = {
  path: string
  element: ReactNode
  cache?: boolean
}

export type NavItem = {
  to: string
  label: string
}
