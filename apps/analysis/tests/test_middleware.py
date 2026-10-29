"""Vercel rewrite 的路径还原（纯 ASGI 中间件）。

线上踩过的坑：Vercel 把 `/(.*)` rewrite 到 `/api/index` 后，函数里看到的 `path` 就是
`/api/index`，原始路径完全丢失（`/api`、`/api/index` 两种 destination 都一样）。
所以 `vercel.json` 用 `destination: "/api/index?__path=/$1"` 带上原路径，
中间件在 ASGI 层还原并摘掉 `__path`。这里固定住这段行为的三个分支。
"""

from __future__ import annotations

import asyncio
import unittest

from app.main import RewritePathMiddleware


async def _noop_send(_message) -> None:
    return None


class RewritePathTests(unittest.TestCase):
    def run_middleware(self, scope: dict) -> dict:
        seen: dict = {}

        async def inner(inner_scope, _receive, _send) -> None:
            seen.update(inner_scope)

        middleware = RewritePathMiddleware(inner)
        asyncio.run(middleware(scope, None, _noop_send))
        return seen

    def test_restores_path_from_query_param(self) -> None:
        seen = self.run_middleware(
            {
                "type": "http",
                "path": "/api/index",
                "query_string": b"game=pl5&kind=prediction&order=2&__path=%2Fapi%2Fanalysis%2Flottery",
                "headers": [],
            }
        )
        self.assertEqual(seen["path"], "/api/analysis/lottery")
        self.assertEqual(seen["raw_path"], b"/api/analysis/lottery")
        self.assertEqual(seen["query_string"], b"game=pl5&kind=prediction&order=2")

    def test_header_fallback(self) -> None:
        seen = self.run_middleware(
            {
                "type": "http",
                "path": "/api/index",
                "query_string": b"",
                "headers": [(b"x-invoke-path", b"/api/venue-weather")],
            }
        )
        self.assertEqual(seen["path"], "/api/venue-weather")

    def test_untouched_when_no_original_path(self) -> None:
        seen = self.run_middleware(
            {"type": "http", "path": "/api/index", "query_string": b"a=1", "headers": []}
        )
        self.assertEqual(seen["path"], "/api/index")
        self.assertEqual(seen["query_string"], b"a=1")

    def test_non_http_scope_passes_through(self) -> None:
        seen = self.run_middleware({"type": "lifespan"})
        self.assertEqual(seen["type"], "lifespan")


if __name__ == "__main__":
    unittest.main()
