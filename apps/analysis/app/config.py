"""运行期配置。

本地从仓库根 `.env` 或 `apps/analysis/.env` 读；Vercel 上直接读环境变量。
只放读库与缓存相关的键，分析参数仍写死在引擎里（和 Node 版本保持同一套门槛）。
"""

from __future__ import annotations

import os
from pathlib import Path


def _load_env_file(path: Path) -> bool:
    """把 KEY=VALUE 灌进 os.environ（已存在的变量优先，和 Node 版 loadEnv 一致）。"""
    if not path.is_file():
        return False
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value
    return True


ROOT = Path(__file__).resolve().parents[3]

_loaded = _load_env_file(ROOT / "apps" / "analysis" / ".env") or _load_env_file(ROOT / ".env")


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "").strip()


def ssl_enabled() -> bool:
    return os.environ.get("DATABASE_SSL", "").strip().lower() in {"1", "true"}


def conninfo() -> str:
    """DATABASE_URL + 可选的 sslmode。

    Node 版用 `ssl: { rejectUnauthorized: false }`；libpq 对应的写法是 sslmode=require
    （只加密、不校验证书，和远端 Prisma 池化的要求一致）。
    URL 里已经带了 sslmode 就不覆盖。
    """
    url = database_url()
    if not url:
        return ""
    if ssl_enabled() and "sslmode=" not in url:
        joiner = "&" if "?" in url else "?"
        return f"{url}{joiner}sslmode=require"
    return url


def env_loaded() -> bool:
    return bool(_loaded)


def cache_ttl_seconds() -> int:
    try:
        return max(0, int(os.environ.get("ANALYSIS_CACHE_TTL", "60")))
    except ValueError:
        return 60


# ── 通用环境变量读取（对齐 Node 的 lib.mjs env / envInt）────────────────────

def env_str(name: str, fallback: str = "") -> str:
    value = os.environ.get(name)
    return fallback if value is None or value == "" else value


def env_int(name: str, fallback: int) -> int:
    raw = env_str(name, "")
    if not raw:
        return fallback
    try:
        parsed = int(raw)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def env_float(name: str, fallback: float) -> float:
    raw = env_str(name, "")
    if not raw:
        return fallback
    try:
        parsed = float(raw)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def strip_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value


def open_meteo_settings() -> dict[str, str]:
    return {
        "geocodingBase": strip_trailing_slash(
            env_str("OPEN_METEO_GEOCODING_BASE", "https://geocoding-api.open-meteo.com")
        ),
        "forecastBase": strip_trailing_slash(env_str("OPEN_METEO_FORECAST_BASE", "https://api.open-meteo.com")),
    }


def venue_rate_per_minute() -> int:
    return env_int("VENUE_RATE_LIMIT_PER_MIN", 20)


def ai_rate_per_minute() -> int:
    return env_int("AI_RATE_LIMIT_PER_MIN", 10)
