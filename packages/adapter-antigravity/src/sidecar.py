"""One-run JSONL bridge from Bremio to the official Antigravity Python SDK."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import sys
import time
from typing import Any


def emit(payload: dict[str, Any]) -> None:
  print(json.dumps(payload, ensure_ascii=False, default=str), flush=True)


def credentials_configured() -> bool:
  if os.environ.get("GEMINI_API_KEY"):
    return True
  vertex = os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("true", "1")
  enterprise = os.environ.get("GOOGLE_GENAI_USE_ENTERPRISE", "").lower() in ("true", "1")
  return (vertex or enterprise) and bool(
      os.environ.get("GOOGLE_CLOUD_PROJECT")
      and os.environ.get("GOOGLE_CLOUD_LOCATION")
  )


def health() -> int:
  try:
    import google.antigravity  # pylint: disable=unused-import,import-outside-toplevel
    version = importlib.metadata.version("google-antigravity")
  except Exception as error:  # pylint: disable=broad-exception-caught
    emit({
        "status": "unavailable",
        "detail": f"google-antigravity is not importable: {error}",
    })
    return 1

  if credentials_configured():
    emit({
        "status": "ok",
        "detail": f"google-antigravity {version}; credentials detected",
    })
    return 0
  emit({
      "status": "degraded",
      "detail": (
          f"google-antigravity {version}; set GEMINI_API_KEY or Vertex "
          "environment variables before running"
      ),
  })
  return 0


def model_for(request: dict[str, Any]) -> Any:
  model = request.get("model")
  reasoning = request.get("reasoningLevel")
  if not reasoning:
    return model

  from google.antigravity import (  # pylint: disable=import-outside-toplevel
      GeminiAPIEndpoint,
      GeminiModelOptions,
      ModelTarget,
      ModelType,
      ThinkingLevel,
      VertexEndpoint,
  )

  thinking = ThinkingLevel({"xhigh": "extra_high"}.get(reasoning, reasoning))
  options = GeminiModelOptions(thinking_level=thinking)
  use_vertex = (
      os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("true", "1")
      or os.environ.get("GOOGLE_GENAI_USE_ENTERPRISE", "").lower() in ("true", "1")
  )
  endpoint = (
      VertexEndpoint(options=options)
      if use_vertex
      else GeminiAPIEndpoint(options=options)
  )
  return ModelTarget(
      name=model or "gemini-3.5-flash",
      types=[ModelType.TEXT],
      endpoint=endpoint,
  )


def tool_name(value: Any) -> str:
  return str(getattr(value, "value", value))


def jsonable(value: Any) -> Any:
  if hasattr(value, "model_dump"):
    return value.model_dump(mode="json")
  if isinstance(value, (str, int, float, bool)) or value is None:
    return value
  if isinstance(value, dict):
    return {str(key): jsonable(item) for key, item in value.items()}
  if isinstance(value, (list, tuple)):
    return [jsonable(item) for item in value]
  return str(value)


async def run(request: dict[str, Any]) -> int:
  from google.antigravity import (  # pylint: disable=import-outside-toplevel
      Agent,
      BuiltinTools,
      CapabilitiesConfig,
      LocalAgentConfig,
  )
  from google.antigravity.hooks import policy  # pylint: disable=import-outside-toplevel
  from google.antigravity.types import (  # pylint: disable=import-outside-toplevel
      Text,
      Thought,
      ToolCall,
      ToolResult,
  )

  run_id = str(request["runId"])
  cwd = os.path.abspath(str(request["cwd"]))
  os.chdir(cwd)
  writable = request.get("permission") == "workspace-write"
  enabled_tools = (
      [
          BuiltinTools.LIST_DIR,
          BuiltinTools.SEARCH_DIR,
          BuiltinTools.FIND_FILE,
          BuiltinTools.VIEW_FILE,
          BuiltinTools.CREATE_FILE,
          BuiltinTools.EDIT_FILE,
          BuiltinTools.RUN_COMMAND,
          BuiltinTools.FINISH,
      ]
      if writable
      else BuiltinTools.read_only()
  )
  config = LocalAgentConfig(
      system_instructions=request.get("systemPrompt"),
      capabilities=CapabilitiesConfig(
          enable_subagents=False,
          enabled_tools=enabled_tools,
      ),
      policies=[policy.allow_all()] if writable else [],
      workspaces=[cwd],
      response_schema=request.get("outputSchema"),
      model=model_for(request),
  )

  text_parts: list[str] = []
  structured: Any = None
  session_id: str | None = None
  async with Agent(config) as agent:
    response = await agent.chat(str(request["prompt"]))
    async for chunk in response.chunks:
      if isinstance(chunk, Text):
        text_parts.append(chunk.text)
        emit({
            "type": "message",
            "runId": run_id,
            "ts": int(time.time() * 1000),
            "role": "assistant",
            "text": chunk.text,
        })
      elif isinstance(chunk, Thought):
        emit({
            "type": "thinking",
            "runId": run_id,
            "ts": int(time.time() * 1000),
            "text": chunk.text,
        })
      elif isinstance(chunk, ToolCall):
        emit({
            "type": "tool_use",
            "runId": run_id,
            "ts": int(time.time() * 1000),
            "name": tool_name(chunk.name),
            "input": jsonable(chunk.args),
        })
      elif isinstance(chunk, ToolResult):
        detail = chunk.error or jsonable(chunk.result)
        emit({
            "type": "tool_result",
            "runId": run_id,
            "ts": int(time.time() * 1000),
            "name": tool_name(chunk.name),
            "ok": chunk.error is None,
            "detail": str(detail),
        })

    structured = await response.structured_output()
    usage = response.usage_metadata
    if usage is not None:
      usage_event: dict[str, Any] = {
          "type": "usage",
          "runId": run_id,
          "ts": int(time.time() * 1000),
      }
      if usage.prompt_token_count is not None:
        usage_event["inputTokens"] = usage.prompt_token_count
      output_tokens = 0
      has_output = False
      if usage.candidates_token_count is not None:
        output_tokens += usage.candidates_token_count
        has_output = True
      if usage.thoughts_token_count is not None:
        output_tokens += usage.thoughts_token_count
        has_output = True
      if has_output:
        usage_event["outputTokens"] = output_tokens
      emit(usage_event)
    session_id = agent.conversation_id

  outcome: dict[str, Any] = {
      "status": "completed",
      "finalText": "".join(text_parts),
  }
  if structured is not None:
    outcome["structured"] = jsonable(structured)
  if session_id:
    outcome["sessionId"] = session_id
  emit({
      "type": "completed",
      "runId": run_id,
      "ts": int(time.time() * 1000),
      "outcome": outcome,
  })
  return 0


async def main() -> int:
  if "--health" in sys.argv:
    return health()
  raw = sys.stdin.readline()
  if not raw:
    print("sidecar expected one JSON request on stdin", file=sys.stderr)
    return 2
  request: dict[str, Any] = {}
  try:
    request = json.loads(raw)
    return await run(request)
  except asyncio.CancelledError:
    raise
  except Exception as error:  # pylint: disable=broad-exception-caught
    run_id = str(request.get("runId", "antigravity"))
    message = f"{type(error).__name__}: {error}"
    print(message, file=sys.stderr, flush=True)
    emit({
        "type": "error",
        "runId": run_id,
        "ts": int(time.time() * 1000),
        "message": message,
        "fatal": True,
    })
    emit({
        "type": "completed",
        "runId": run_id,
        "ts": int(time.time() * 1000),
        "outcome": {"status": "failed", "error": message},
    })
    return 1


if __name__ == "__main__":
  raise SystemExit(asyncio.run(main()))
