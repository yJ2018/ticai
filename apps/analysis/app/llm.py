"""DeepSeek 客户端（OpenAI 兼容协议，标准库 urllib 实现）。

对齐 apps/api/src/llm.mjs 的非流式部分：
- 默认关闭思考模式（DEEPSEEK_THINKING=1 可开），交互式请求更便宜更快；
- json 模式走 response_format；max_tokens 上限 8192；
- 上游状态码映射成和 Node 一样的错误文案。
流式（SSE）留给 AI 分析迁移那一轮再加。
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

from .config import env_float, env_int, env_str, strip_trailing_slash
from .errors import AnalysisError

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-flash"
MAX_OUTPUT_TOKENS = 8192


def llm_config() -> dict[str, Any]:
    return {
        "apiKey": env_str("DEEPSEEK_API_KEY"),
        "baseUrl": strip_trailing_slash(env_str("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL)),
        "model": env_str("DEEPSEEK_MODEL", DEFAULT_MODEL),
        "timeoutMs": env_int("DEEPSEEK_TIMEOUT_MS", 60_000),
        "maxTokens": min(env_int("DEEPSEEK_MAX_TOKENS", 1024), MAX_OUTPUT_TOKENS),
        "thinking": env_str("DEEPSEEK_THINKING", "0") == "1",
    }


def _upstream_message(payload: Any, fallback: str) -> str:
    message = None
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
        message = message or payload.get("message")
    return message.strip() if isinstance(message, str) and message.strip() else fallback


def _map_upstream_error(status: int, payload: Any) -> AnalysisError:
    if status == 401:
        return AnalysisError(502, "DeepSeek 鉴权失败，请检查服务端 DEEPSEEK_API_KEY 是否正确")
    if status == 402:
        return AnalysisError(502, "DeepSeek 账户余额不足，请先充值")
    if status == 429:
        return AnalysisError(429, "DeepSeek 触发限流，请稍后重试")
    if status in (400, 422):
        return AnalysisError(502, f"DeepSeek 拒绝了请求：{_upstream_message(payload, f'HTTP {status}')}")
    return AnalysisError(502, f"DeepSeek 返回 HTTP {status}")


def _read_usage(usage: Any) -> dict[str, int]:
    usage = usage if isinstance(usage, dict) else {}
    details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
    return {
        "promptTokens": int(usage.get("prompt_tokens") or 0),
        "completionTokens": int(usage.get("completion_tokens") or 0),
        "totalTokens": int(usage.get("total_tokens") or 0),
        "cachedTokens": int(details.get("cached_tokens") or usage.get("prompt_cache_hit_tokens") or 0),
    }


def build_request_body(cfg: dict, options: dict, stream: bool = False) -> dict:
    use_thinking = options.get("thinking")
    use_thinking = cfg["thinking"] if use_thinking is None else bool(use_thinking)
    max_tokens = options.get("maxTokens")
    default_max = max(cfg["maxTokens"], 4096) if use_thinking else cfg["maxTokens"]

    body: dict[str, Any] = {
        "model": cfg["model"],
        "messages": options["messages"],
        "stream": stream,
        "thinking": {"type": "enabled" if use_thinking else "disabled"},
        "max_tokens": min(max(int(max_tokens), 1), MAX_OUTPUT_TOKENS) if isinstance(max_tokens, int) else default_max,
    }
    if isinstance(options.get("temperature"), (int, float)):
        body["temperature"] = options["temperature"]
    if options.get("json"):
        body["response_format"] = {"type": "json_object"}
    if stream:
        body["stream_options"] = {"include_usage": True}
    return body


def chat_completion(cfg: dict, options: dict) -> dict[str, Any]:
    """非流式对话补全；成功返回 {content, reasoning, model, finishReason, truncated, usage}。"""
    if not cfg.get("apiKey"):
        raise AnalysisError(503, "服务端未配置 DEEPSEEK_API_KEY")
    messages = options.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AnalysisError(400, "messages 不能为空")

    body = build_request_body(cfg, options, stream=False)
    timeout_ms = options.get("timeoutMs") or cfg["timeoutMs"]
    request = urllib.request.Request(
        f"{cfg['baseUrl']}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "authorization": f"Bearer {cfg['apiKey']}",
            "content-type": "application/json",
            "accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=max(timeout_ms / 1000, 1)) as response:
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = None
        raise _map_upstream_error(error.code, payload) from error
    except (urllib.error.URLError, socket.timeout, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
            raise AnalysisError(504, f"DeepSeek 请求超时（{timeout_ms}ms）") from error
        raise AnalysisError(502, f"DeepSeek 连接失败：{reason}") from error

    try:
        payload = json.loads(text) if text else None
    except ValueError as error:
        raise AnalysisError(502, "DeepSeek 返回了非 JSON 内容") from error

    choice = (payload or {}).get("choices", [{}])[0] if isinstance(payload, dict) else {}
    message = choice.get("message") or {}
    content = message.get("content") if isinstance(message.get("content"), str) else ""
    reasoning = message.get("reasoning_content") if isinstance(message.get("reasoning_content"), str) else ""

    if not content and not reasoning:
        raise AnalysisError(502, "DeepSeek 返回了空内容")

    return {
        "content": content,
        "reasoning": reasoning,
        "model": payload.get("model") if isinstance(payload.get("model"), str) else cfg["model"],
        "finishReason": choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else "",
        "truncated": choice.get("finish_reason") == "length",
        "usage": _read_usage((payload or {}).get("usage")),
    }


__all__ = ["llm_config", "chat_completion", "build_request_body", "env_float", "ChatStream", "open_chat_stream"]


def _parse_sse_payload(raw: str, state: dict) -> list[tuple[str, str]]:
    """解析一行 SSE；返回 [('reasoning'|'content', delta), ...]。"""
    trimmed = raw.strip()
    if not trimmed.startswith("data:"):
        return []
    data = trimmed[5:].strip()
    if not data or data == "[DONE]":
        return []

    try:
        payload = json.loads(data)
    except ValueError:
        return []

    if isinstance(payload.get("model"), str):
        state["model"] = payload["model"]
    if payload.get("usage"):
        state["usage"] = _read_usage(payload["usage"])

    choice = (payload.get("choices") or [{}])[0] if isinstance(payload.get("choices"), list) else {}
    if isinstance(choice.get("finish_reason"), str) and choice["finish_reason"]:
        state["finishReason"] = choice["finish_reason"]

    events: list[tuple[str, str]] = []
    delta = choice.get("delta") or {}
    if isinstance(delta.get("reasoning_content"), str) and delta["reasoning_content"]:
        state["received"] = True
        events.append(("reasoning", delta["reasoning_content"]))
    if isinstance(delta.get("content"), str) and delta["content"]:
        state["received"] = True
        events.append(("content", delta["content"]))
    return events


class ChatStream:
    """DeepSeek 流式补全：边读边产出 (kind, delta)，结束后给 result。"""

    def __init__(self, cfg: dict, response, timeout_ms: int) -> None:
        self.cfg = cfg
        self.response = response
        self.timeout_ms = timeout_ms
        self.state = {"model": cfg["model"], "finishReason": "", "usage": _read_usage(None), "received": False}

    def events(self):
        try:
            for raw in self.response:
                line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
                yield from _parse_sse_payload(line, self.state)
        except (socket.timeout, TimeoutError, OSError) as error:
            raise AnalysisError(502, f"DeepSeek 数据流中断：{error}") from error

    def result(self) -> dict:
        if not self.state["received"]:
            raise AnalysisError(502, "DeepSeek 返回了空内容")
        return {
            "model": self.state["model"],
            "finishReason": self.state["finishReason"],
            "truncated": self.state["finishReason"] == "length",
            "usage": self.state["usage"],
        }

    def close(self) -> None:
        try:
            self.response.close()
        except Exception:  # noqa: BLE001 - 关闭失败不影响结果
            pass


def open_chat_stream(cfg: dict, options: dict) -> ChatStream:
    """建立流式连接；连接/鉴权/参数错误在返回前抛出（对应 Node 的「首个增量前不写响应头」）。"""
    if not cfg.get("apiKey"):
        raise AnalysisError(503, "服务端未配置 DEEPSEEK_API_KEY")
    messages = options.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AnalysisError(400, "messages 不能为空")

    body = build_request_body(cfg, options, stream=True)
    timeout_ms = options.get("timeoutMs") or cfg["timeoutMs"]
    request = urllib.request.Request(
        f"{cfg['baseUrl']}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "authorization": f"Bearer {cfg['apiKey']}",
            "content-type": "application/json",
            "accept": "text/event-stream",
        },
        method="POST",
    )

    try:
        response = urllib.request.urlopen(request, timeout=max(timeout_ms / 1000, 1))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = None
        raise _map_upstream_error(error.code, payload) from error
    except (urllib.error.URLError, socket.timeout, TimeoutError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
            raise AnalysisError(504, f"DeepSeek 请求超时（{timeout_ms}ms）") from error
        raise AnalysisError(502, f"DeepSeek 连接失败：{reason}") from error

    return ChatStream(cfg, response, timeout_ms)
