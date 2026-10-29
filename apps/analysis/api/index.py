"""Vercel Python 入口：把 FastAPI 的 ASGI app 暴露成函数。

原始路径的还原在 `app.main` 里注册（`RewritePathMiddleware`），
这里只负责导出 ASGI 实例，方便 Vercel 识别。
"""

from app.main import app  # noqa: F401  (Vercel 通过 app 变量识别 ASGI 应用)
