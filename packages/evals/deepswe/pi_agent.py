import json
import os
import shlex
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist
from pier.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from pier.utils.trajectory_utils import format_trajectory_json

# Protocol default (protocol.json); the adapter accepts any provider/model
# so the DeepSWE path runs against whatever credential is available.
MODEL = "openai-codex/gpt-5.6-luna"

# Egress domains per provider: the sandbox network allowlist is derived from
# the model's provider, not hardcoded to one vendor's auth stack.
PROVIDER_DOMAINS = {
    "openai-codex": ["auth.openai.com", "chatgpt.com"],
    "opencode": ["opencode.ai", "api.opencode.ai"],
}


def _text(content: object) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        value = block.get("text")
        if isinstance(value, str):
            parts.append(value)
    return "\n".join(parts)


def _usage(raw: object) -> tuple[int, int, int, float]:
    if not isinstance(raw, dict):
        return 0, 0, 0, 0.0
    direct = raw.get("input")
    cached = raw.get("cacheRead")
    output = raw.get("output")
    cost = raw.get("cost")
    input_tokens = direct if isinstance(direct, int) else 0
    cached_tokens = cached if isinstance(cached, int) else 0
    output_tokens = output if isinstance(output, int) else 0
    total_cost = cost.get("total") if isinstance(cost, dict) else 0
    return (
        input_tokens + cached_tokens,
        cached_tokens,
        output_tokens,
        float(total_cost) if isinstance(total_cost, int | float) else 0.0,
    )


def _timestamp(raw: object) -> str | None:
    if not isinstance(raw, int | float):
        return None
    return (
        datetime.fromtimestamp(raw / 1000, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def trajectory_from_jsonl(
    instruction: str,
    stdout: str,
    *,
    model_name: str,
    version: str,
    reasoning_effort: str,
) -> Trajectory:
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if isinstance(event, dict):
            events.append(event)

    session_id = next(
        (
            event.get("id")
            for event in events
            if event.get("type") == "session" and isinstance(event.get("id"), str)
        ),
        None,
    )
    tool_results = {
        event.get("toolCallId"): event
        for event in events
        if event.get("type") == "tool_execution_end"
        and isinstance(event.get("toolCallId"), str)
    }
    steps = [Step(step_id=1, source="user", message=instruction)]
    totals = [0, 0, 0]
    total_cost = 0.0
    failed_tool_calls = 0
    tool_call_count = 0
    assistant_errors = 0

    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        blocks = content if isinstance(content, list) else []
        texts: list[str] = []
        reasoning: list[str] = []
        calls: list[ToolCall] = []
        results: list[ObservationResult] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                texts.append(block["text"])
            elif block.get("type") == "thinking" and isinstance(
                block.get("thinking"), str
            ):
                reasoning.append(block["thinking"])
            elif block.get("type") == "toolCall":
                call_id = block.get("id")
                name = block.get("name")
                arguments = block.get("arguments")
                if not isinstance(call_id, str) or not isinstance(name, str):
                    continue
                calls.append(
                    ToolCall(
                        tool_call_id=call_id,
                        function_name=name,
                        arguments=arguments if isinstance(arguments, dict) else {},
                    )
                )
                tool_call_count += 1
                result = tool_results.get(call_id)
                if result is not None:
                    is_error = result.get("isError") is True
                    failed_tool_calls += int(is_error)
                    payload = result.get("result")
                    result_content = (
                        payload.get("content") if isinstance(payload, dict) else None
                    )
                    results.append(
                        ObservationResult(
                            source_call_id=call_id,
                            content=_text(result_content),
                            extra={"is_error": is_error},
                        )
                    )

        prompt_tokens, cached_tokens, output_tokens, cost = _usage(message.get("usage"))
        totals[0] += prompt_tokens
        totals[1] += cached_tokens
        totals[2] += output_tokens
        total_cost += cost
        stop_reason = message.get("stopReason")
        if stop_reason in {"error", "aborted"}:
            assistant_errors += 1
        steps.append(
            Step(
                step_id=len(steps) + 1,
                timestamp=_timestamp(message.get("timestamp")),
                source="agent",
                model_name=model_name,
                reasoning_effort=reasoning_effort,
                message="\n".join(texts),
                reasoning_content="\n".join(reasoning) or None,
                tool_calls=calls or None,
                observation=Observation(results=results) if results else None,
                metrics=Metrics(
                    prompt_tokens=prompt_tokens,
                    cached_tokens=cached_tokens,
                    completion_tokens=output_tokens,
                    cost_usd=cost,
                ),
                llm_call_count=1,
                extra={"stop_reason": stop_reason},
            )
        )

    compactions = 0
    compaction_calls = 0
    for event in events:
        if event.get("type") != "compaction_end" or event.get("aborted") is True:
            continue
        compactions += 1
        result = event.get("result")
        usage = result.get("usage") if isinstance(result, dict) else None
        prompt_tokens, cached_tokens, output_tokens, cost = _usage(usage)
        if any((prompt_tokens, output_tokens, cost)):
            compaction_calls += 1
        totals[0] += prompt_tokens
        totals[1] += cached_tokens
        totals[2] += output_tokens
        total_cost += cost

    retries = sum(event.get("type") == "auto_retry_start" for event in events)
    extra = {
        "assistant_errors": assistant_errors,
        "compactions": compactions,
        "failed_tool_calls": failed_tool_calls,
        "model_calls": len(steps) - 1 + compaction_calls,
        "retries": retries,
        "tool_calls": tool_call_count,
    }
    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=session_id,
        agent=Agent(
            name="pi",
            version=version,
            model_name=model_name,
            extra={"reasoning_effort": reasoning_effort},
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=totals[0],
            total_cached_tokens=totals[1],
            total_completion_tokens=totals[2],
            total_cost_usd=total_cost,
            total_steps=len(steps),
            extra=extra,
        ),
    )


class PiAgent(BaseAgent):
    SUPPORTS_ATIF = True

    def __init__(
        self,
        *args: Any,
        artifact_path: str | Path,
        auth_path: str | Path | None = None,
        pi_commit: str,
        reasoning_effort: str = "medium",
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        provider, _, model_id = self.model_name.partition("/")
        if provider not in PROVIDER_DOMAINS or not model_id:
            raise ValueError(
                f"Unsupported model {self.model_name!r}; expected provider/model "
                f"with provider in {sorted(PROVIDER_DOMAINS)}"
            )
        self.provider = provider
        self.model_id = model_id
        self.artifact_path = Path(artifact_path).resolve(strict=True)
        self.auth_path = self._resolve_auth(auth_path)
        self.theme_path = self.artifact_path.parent.joinpath("theme").resolve(
            strict=True
        )
        for name in ("dark.json", "light.json"):
            if not self.theme_path.joinpath(name).is_file():
                raise ValueError(f"Pi artifact is missing theme/{name}")
        self.pi_commit = pi_commit
        self.reasoning_effort = reasoning_effort

    def _resolve_auth(self, auth_path: str | Path | None) -> Path:
        """Credential resolution without any pre-installed stack: explicit
        auth_path, then PI_CODING_AGENT_DIR/auth.json, then - API-key
        providers only - a synthesized auth file from the key's env var."""
        if auth_path is not None:
            return Path(auth_path).resolve(strict=True)
        agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
        if agent_dir:
            candidate = Path(agent_dir) / "auth.json"
            if candidate.is_file():
                return candidate.resolve()
        key_env = f"{self.provider.upper().replace('-', '_')}_API_KEY"
        key = os.environ.get(key_env)
        if self.provider == "opencode" and key:
            auth = Path(tempfile.gettempdir()) / f"pi-deepswe-auth-{os.getpid()}.json"
            auth.write_text(json.dumps({"opencode": {"type": "api_key", "key": key}}))
            auth.chmod(0o600)
            return auth
        raise ValueError(
            "No credential: pass auth_path, set PI_CODING_AGENT_DIR to a dir "
            f"containing auth.json, or set {key_env} (supported for opencode)"
        )

    @staticmethod
    def name() -> str:
        return "pi"

    def version(self) -> str:
        return self.pi_commit

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=PROVIDER_DOMAINS[self.provider])

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.exec(
            "mkdir -p /installed-agent/config", user="root", timeout_sec=30
        )
        await environment.upload_file(self.artifact_path, "/installed-agent/pi")
        await environment.upload_file(
            self.auth_path, "/installed-agent/config/auth.json"
        )
        await environment.upload_dir(self.theme_path, "/installed-agent/theme")
        owner = shlex.quote(str(environment.default_user or "root"))
        result = await environment.exec(
            "chmod 755 /installed-agent/pi && "
            "chmod 600 /installed-agent/config/auth.json && "
            f"chown -R {owner} /installed-agent",
            user="root",
            timeout_sec=30,
        )
        if result.return_code != 0:
            raise RuntimeError(result.stderr or "Failed to install Pi artifact")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        command = " ".join(
            [
                "/installed-agent/pi",
                "--mode json --print --no-session --offline --approve",
                "--no-extensions --no-skills --no-prompt-templates --no-themes",
                f"--provider {self.provider} --model {self.model_id}"
                f" --thinking {self.reasoning_effort}",
                shlex.quote(instruction),
            ]
        )
        result = await environment.exec(
            command,
            cwd="/app",
            env=environment.agent_process_env(
                {
                    "PI_CODING_AGENT_DIR": "/installed-agent/config",
                    "PI_OFFLINE": "1",
                    "PI_TELEMETRY": "0",
                    "GIT_AUTHOR_NAME": "Pi Benchmark",
                    "GIT_AUTHOR_EMAIL": "pi-benchmark@localhost",
                    "GIT_COMMITTER_NAME": "Pi Benchmark",
                    "GIT_COMMITTER_EMAIL": "pi-benchmark@localhost",
                }
            ),
        )
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        stdout = result.stdout or ""
        (self.logs_dir / "pi.jsonl").write_text(stdout)
        (self.logs_dir / "pi.stderr.log").write_text(result.stderr or "")
        if result.return_code != 0:
            raise RuntimeError(f"Pi exited with code {result.return_code}")
        trajectory = trajectory_from_jsonl(
            instruction,
            stdout,
            model_name=self.model_name,
            version=self.pi_commit,
            reasoning_effort=self.reasoning_effort,
        )
        (self.logs_dir / "trajectory.json").write_text(
            format_trajectory_json(trajectory.to_json_dict())
        )
        self.populate_context(context, trajectory)
        if context.n_agent_steps == 0:
            raise RuntimeError("Pi produced no assistant messages")
        if trajectory.final_metrics.extra["assistant_errors"]:
            raise RuntimeError("Pi ended with an assistant error")

    @staticmethod
    def populate_context(context: AgentContext, trajectory: Trajectory) -> None:
        metrics = trajectory.final_metrics
        if metrics is None:
            return
        context.n_input_tokens = metrics.total_prompt_tokens
        context.n_cache_tokens = metrics.total_cached_tokens
        context.n_output_tokens = metrics.total_completion_tokens
        context.cost_usd = metrics.total_cost_usd
        context.peak_context_tokens = max(
            (
                step.metrics.prompt_tokens
                for step in trajectory.steps
                if step.metrics is not None and step.metrics.prompt_tokens is not None
            ),
            default=0,
        )
        context.summarization_count = metrics.extra["compactions"]
        context.n_agent_steps = len(trajectory.steps) - 1
        context.metadata = metrics.extra
