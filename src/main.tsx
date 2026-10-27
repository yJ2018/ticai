// 全局样式必须先于组件样式导入，否则组件里的 .scss 会先注入、被全局规则覆盖
import './styles/global.scss'

import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ConfirmDialogProvider } from './components/ConfirmDialog'

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <BrowserRouter>
    <ConfirmDialogProvider>
      <App />
    </ConfirmDialogProvider>
  </BrowserRouter>,
)
