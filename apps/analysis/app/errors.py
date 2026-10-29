"""分析服务的错误类型：和 Node 版 `HttpError` 对齐，路由层统一转 JSON。"""

from __future__ import annotations


class AnalysisError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
