"""PostgreSQL 访问层（psycopg 连接池）。

和 Node 版 `db.mjs` 对齐：延迟建池、单实例复用、连不上抛 503。
远端库（Prisma Postgres）建连实测 5–7s，所以池必须常驻，不能在每次请求里 connect。
"""

from __future__ import annotations

import threading
from typing import Any

from . import config
from .errors import AnalysisError

_pool = None
_lock = threading.Lock()


def get_pool():
    global _pool
    if _pool is not None:
        return _pool

    with _lock:
        if _pool is not None:
            return _pool

        url = config.conninfo()
        if not url:
            raise AnalysisError(503, "服务端未配置 DATABASE_URL")

        try:
            from psycopg_pool import ConnectionPool
        except ImportError as error:  # pragma: no cover - 只在依赖缺失时触发
            raise AnalysisError(503, "缺少 psycopg 依赖") from error

        try:
            pool = ConnectionPool(
                conninfo=url,
                min_size=1,
                max_size=3,
                timeout=15,
                # 远端库往返慢，连接空闲别关太快（Serverless 冷启动会重连）
                max_idle=600,
                open=False,
            )
            pool.open(wait=True, timeout=20)
        except Exception as error:  # noqa: BLE001 - 统一转成 503
            raise AnalysisError(503, f"数据库连接失败：{error}") from error

        _pool = pool
        return _pool


def query(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    pool = get_pool()
    try:
        with pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                if cur.description is None:
                    return []
                columns = [item.name for item in cur.description]
                return [dict(zip(columns, row, strict=False)) for row in cur.fetchall()]
    except Exception as error:  # noqa: BLE001
        raise AnalysisError(503, f"数据库查询失败：{error}") from error


def close_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            try:
                _pool.close()
            finally:
                _pool = None
