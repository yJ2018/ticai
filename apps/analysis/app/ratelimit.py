"""按 key 的滑动窗口限流（对齐 Node 版 createRateLimiter）。"""

from __future__ import annotations

import time
from typing import Callable

from .errors import AnalysisError


class RateLimiter:
    def __init__(self, limit: int, window_ms: float = 60_000, max_keys: int = 5_000) -> None:
        self.limit = limit
        self.window = window_ms / 1000
        self.max_keys = max_keys
        self._hits: dict[str, list[float]] = {}

    def hit(self, key: str) -> None:
        if not self.limit:
            return
        now = time.time()
        recent = [stamp for stamp in self._hits.get(key, []) if now - stamp < self.window]
        if len(recent) >= self.limit:
            retry_after = max(1, int(self.window - (now - recent[0])))
            raise AnalysisError(429, f"调用过于频繁，请 {retry_after} 秒后重试")
        recent.append(now)
        self._hits[key] = recent

        if len(self._hits) > self.max_keys:
            for stored_key, stamps in list(self._hits.items()):
                if not any(now - stamp < self.window for stamp in stamps):
                    self._hits.pop(stored_key, None)
            if len(self._hits) > self.max_keys:
                self._hits.pop(next(iter(self._hits)), None)


def make_limiter(limit: int) -> RateLimiter:
    return RateLimiter(limit)


__all__: list[Callable] = []
