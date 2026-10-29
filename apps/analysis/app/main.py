"""分析服务的 HTTP 入口（FastAPI）。

路由与 Node 版保持同一套路径和信封（`{success, data}` / `{success:false, errorMessage}`），
前端完全不用改：Node API 会用 ANALYSIS_API_BASE 把分析接口反向代理过来。

**Vercel 路径还原**：Vercel 的 rewrite 会把函数看到的 `path` 改成 `/api/index`，
原始路径丢失（实测 `/api`、`/api/index` 两种 destination 都一样）。所以
`vercel.json` 用 `destination: "/api/index?__path=/$1"` 把原路径塞进查询串，
`RewritePathMiddleware` 在这里把它还原成真正的 `scope["path"]` 并摘掉 `__path`。
查询串的其它参数 Vercel 会保留，不需要额外处理。
"""

from __future__ import annotations

import time
from urllib.parse import parse_qsl, unquote, urlencode

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import config
from .errors import AnalysisError
from .routes import ai as ai_route
from .routes import lottery as lottery_route
from .routes import recommend as recommend_route
from .routes import weather as weather_route

# 平台可能给的「原始路径」头（不同运行时版本不一样，作为 __path 的兜底）
ORIGINAL_PATH_HEADERS = (
    "x-forwarded-uri",
    "x-vercel-original-path",
    "x-invoke-path",
    "x-original-uri",
)


class RewritePathMiddleware:
    """把 Vercel rewrite 丢掉的原始路径补回去（纯 ASGI，流式 SSE 不受影响）。"""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            pairs = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
            original = next((value for key, value in pairs if key == "__path"), "")

            if not original:
                headers = {
                    key.decode("latin-1").lower(): value.decode("latin-1")
                    for key, value in scope.get("headers", [])
                }
                for name in ORIGINAL_PATH_HEADERS:
                    value = headers.get(name)
                    if value and value.startswith("/"):
                        original = value
                        break

            if original:
                path = unquote(original) if "%" in original else original
                scope = dict(scope)
                scope["path"] = path
                scope["raw_path"] = path.encode("latin-1")
                scope["query_string"] = urlencode(
                    [(key, value) for key, value in pairs if key != "__path"]
                ).encode("latin-1")

        await self.app(scope, receive, send)


app = FastAPI(title="ticai analysis", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(RewritePathMiddleware)

_STARTED_AT = time.monotonic()


@app.exception_handler(AnalysisError)
async def handle_analysis_error(_: Request, error: AnalysisError) -> JSONResponse:
    return JSONResponse(status_code=error.status, content={"success": False, "errorMessage": error.message})


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "service": "ticai-analysis",
        "uptimeSeconds": int(time.monotonic() - _STARTED_AT),
        "envLoaded": config.env_loaded(),
        "databaseConfigured": bool(config.database_url()),
    }


app.include_router(recommend_route.router)
app.include_router(lottery_route.router)
app.include_router(weather_route.router)
app.include_router(ai_route.router)
