import { KeepAliveRoutes } from './KeepAliveRoutes'
import { appRoutes } from './routes'

export function AppRouter() {
  return <KeepAliveRoutes routes={appRoutes} fallbackPath="/" />
}
