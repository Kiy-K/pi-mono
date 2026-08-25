import asyncio
import json
import sys
import tempfile
import types
import unittest
import unittest.mock
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _fake_exec_with_stdout(environment, stdout):
	async def exec(command, cwd=None, env=None, **_kwargs):
		environment.commands.append((command, cwd, env))
		if command.startswith("/installed-agent/pi"):
			return ExecResult(stdout=stdout, stderr="", return_code=0)
		return ExecResult(stdout="", stderr="", return_code=0)

	return exec


def _install_pier_stubs() -> None:
	"""Minimal stand-ins for the proprietary pier framework (not on PyPI),
	mirroring only the surface deepswe.pi_agent uses. Lets the adapter's
	logic be verified without the DeepSWE cluster; real runs still require
	pier 0.3.1 (protocol.json)."""
	try:
		import pier  # noqa: F401

		return
	except ModuleNotFoundError:
		pass

	pier = types.ModuleType("pier")
	agents = types.ModuleType("pier.agents")
	agents_base = types.ModuleType("pier.agents.base")
	environments = types.ModuleType("pier.environments")
	environments_base = types.ModuleType("pier.environments.base")
	models = types.ModuleType("pier.models")
	agent_models = types.ModuleType("pier.models.agent")
	context_mod = types.ModuleType("pier.models.agent.context")
	network_mod = types.ModuleType("pier.models.agent.network")
	trajectories = types.ModuleType("pier.models.trajectories")
	utils = types.ModuleType("pier.utils")
	trajectory_utils = types.ModuleType("pier.utils.trajectory_utils")

	class BaseAgent:
		def __init__(self, *args: Any, model_name: str | None = None, logs_dir: Path | None = None, **kwargs: Any) -> None:
			self.model_name = model_name
			self.logs_dir = Path(logs_dir) if logs_dir is not None else None

	@dataclass
	class ExecResult:
		stdout: str
		stderr: str
		return_code: int

	@dataclass
	class AgentContext:
		n_input_tokens: int = 0
		n_cache_tokens: int = 0
		n_output_tokens: int = 0
		cost_usd: float = 0.0
		peak_context_tokens: int = 0
		summarization_count: int = 0
		n_agent_steps: int = 0
		metadata: dict = field(default_factory=dict)

	@dataclass
	class NetworkAllowlist:
		domains: list[str]

	@dataclass
	class ToolCall:
		tool_call_id: str
		function_name: str
		arguments: dict

	@dataclass
	class ObservationResult:
		source_call_id: str
		content: str
		extra: dict = field(default_factory=dict)

	@dataclass
	class Observation:
		results: list

	@dataclass
	class Metrics:
		prompt_tokens: int | None = None
		cached_tokens: int | None = None
		completion_tokens: int | None = None
		cost_usd: float | None = None

	@dataclass
	class Step:
		step_id: int
		source: str
		message: str
		timestamp: str | None = None
		model_name: str | None = None
		reasoning_effort: str | None = None
		reasoning_content: str | None = None
		tool_calls: list | None = None
		observation: Observation | None = None
		metrics: Metrics | None = None
		llm_call_count: int | None = None
		extra: dict | None = None

	@dataclass
	class Agent:
		name: str
		version: str
		model_name: str
		extra: dict = field(default_factory=dict)

	@dataclass
	class FinalMetrics:
		total_prompt_tokens: int
		total_cached_tokens: int
		total_completion_tokens: int
		total_cost_usd: float
		total_steps: int
		extra: dict = field(default_factory=dict)

	@dataclass
	class Trajectory:
		schema_version: str
		session_id: str | None
		agent: Agent
		steps: list
		final_metrics: FinalMetrics | None

		def to_json_dict(self) -> dict:
			from dataclasses import asdict

			return asdict(self)

	def format_trajectory_json(payload: dict) -> str:
		return json.dumps(payload)

	agents_base.BaseAgent = BaseAgent
	environments_base.BaseEnvironment = object
	environments_base.ExecResult = ExecResult
	context_mod.AgentContext = AgentContext
	network_mod.NetworkAllowlist = NetworkAllowlist
	trajectories.Agent = Agent
	trajectories.FinalMetrics = FinalMetrics
	trajectories.Metrics = Metrics
	trajectories.Observation = Observation
	trajectories.ObservationResult = ObservationResult
	trajectories.Step = Step
	trajectories.ToolCall = ToolCall
	trajectories.Trajectory = Trajectory
	trajectory_utils.format_trajectory_json = format_trajectory_json

	for name, module in {
		"pier": pier,
		"pier.agents": agents,
		"pier.agents.base": agents_base,
		"pier.environments": environments,
		"pier.environments.base": environments_base,
		"pier.models": models,
		"pier.models.agent": agent_models,
		"pier.models.agent.context": context_mod,
		"pier.models.agent.network": network_mod,
		"pier.models.trajectories": trajectories,
		"pier.utils": utils,
		"pier.utils.trajectory_utils": trajectory_utils,
	}.items():
		sys.modules[name] = module


_install_pier_stubs()

from pier.environments.base import ExecResult  # noqa: E402
from pier.models.agent.context import AgentContext  # noqa: E402

from deepswe.pi_agent import PiAgent, trajectory_from_jsonl  # noqa: E402


class PiAgentTest(unittest.TestCase):
    def test_converts_pi_events_and_metrics_to_atif(self) -> None:
        events = [
            {
                "type": "session",
                "id": "session-1",
                "timestamp": "2026-08-13T00:00:00Z",
            },
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "timestamp": 1_786_602_736_128,
                    "content": [
                        {"type": "thinking", "thinking": "inspect"},
                        {
                            "type": "toolCall",
                            "id": "call-1",
                            "name": "bash",
                            "arguments": {"command": "false"},
                        },
                    ],
                    "usage": {
                        "input": 20,
                        "cacheRead": 30,
                        "output": 5,
                        "cost": {"total": 0.25},
                    },
                    "stopReason": "toolUse",
                },
            },
            {
                "type": "tool_execution_end",
                "toolCallId": "call-1",
                "toolName": "bash",
                "result": {"content": [{"type": "text", "text": "exit 1"}]},
                "isError": True,
            },
            {"type": "auto_retry_start"},
            {
                "type": "compaction_end",
                "aborted": False,
                "result": {
                    "usage": {
                        "input": 7,
                        "cacheRead": 11,
                        "output": 3,
                        "cost": {"total": 0.05},
                    }
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "timestamp": 1_786_602_737_128,
                    "content": [{"type": "text", "text": "done"}],
                    "usage": {
                        "input": 40,
                        "cacheRead": 10,
                        "output": 6,
                        "cost": {"total": 0.4},
                    },
                    "stopReason": "stop",
                },
            },
        ]
        trajectory = trajectory_from_jsonl(
            "Fix it",
            "\n".join(json.dumps(event) for event in events),
            model_name="openai-codex/gpt-5.6-luna",
            version="abc123",
            reasoning_effort="medium",
        )

        self.assertEqual(trajectory.session_id, "session-1")
        self.assertEqual(len(trajectory.steps), 3)
        self.assertEqual(trajectory.steps[1].reasoning_content, "inspect")
        self.assertEqual(trajectory.steps[1].metrics.prompt_tokens, 50)
        self.assertTrue(trajectory.steps[1].observation.results[0].extra["is_error"])
        self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 118)
        self.assertEqual(trajectory.final_metrics.total_completion_tokens, 14)
        self.assertEqual(trajectory.final_metrics.total_cached_tokens, 51)
        self.assertAlmostEqual(trajectory.final_metrics.total_cost_usd, 0.7)
        self.assertEqual(trajectory.final_metrics.extra["failed_tool_calls"], 1)
        self.assertEqual(trajectory.final_metrics.extra["retries"], 1)
        self.assertEqual(trajectory.final_metrics.extra["compactions"], 1)
        self.assertEqual(trajectory.final_metrics.extra["model_calls"], 3)

    def test_adapter_is_pinned_and_populates_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            auth = root / "auth.json"
            (root / "theme").mkdir()
            (root / "theme" / "dark.json").write_text("{}")
            (root / "theme" / "light.json").write_text("{}")
            artifact.write_text("binary")
            auth.write_text("{}")
            agent = PiAgent(
                logs_dir=root / "logs",
                model_name="openai-codex/gpt-5.6-luna",
                artifact_path=artifact,
                auth_path=auth,
                pi_commit="abc123",
                reasoning_effort="medium",
            )

            self.assertEqual(
                agent.network_allowlist().domains,
                ["auth.openai.com", "chatgpt.com"],
            )
            context = AgentContext()
            trajectory = trajectory_from_jsonl(
                "Fix it",
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "done"}],
                            "usage": {
                                "input": 2,
                                "cacheRead": 3,
                                "output": 4,
                                "cost": {"total": 0.1},
                            },
                            "stopReason": "stop",
                        },
                    }
                ),
                model_name=agent.model_name,
                version=agent.version(),
                reasoning_effort="medium",
            )
            agent.populate_context(context, trajectory)

            self.assertEqual(context.n_input_tokens, 5)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.n_output_tokens, 4)
            self.assertEqual(context.n_agent_steps, 1)

    def test_resolves_auth_from_env_without_installed_stack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            (root / "theme").mkdir()
            (root / "theme" / "dark.json").write_text("{}")
            (root / "theme" / "light.json").write_text("{}")
            artifact.touch()

            # OPENCODE_API_KEY synthesizes a 0600 auth file; no auth_path needed.
            with unittest.mock.patch.dict(
                "os.environ",
                {"OPENCODE_API_KEY": "zk-test-key", "PI_CODING_AGENT_DIR": ""},
            ):
                agent = PiAgent(
                    logs_dir=root / "logs",
                    model_name="opencode/x-preview-f-free",
                    artifact_path=artifact,
                    pi_commit="abc123",
                )
            self.assertEqual(json.loads(agent.auth_path.read_text())["opencode"]["key"], "zk-test-key")
            self.assertEqual(agent.auth_path.stat().st_mode & 0o777, 0o600)

            # PI_CODING_AGENT_DIR/auth.json wins when present; explicit auth_path
            # wins over both; nothing available raises a clear error.
            agent_dir = root / "agent-dir"
            agent_dir.mkdir()
            (agent_dir / "auth.json").write_text('{"from": "agent-dir"}')
            with unittest.mock.patch.dict(
                "os.environ",
                {"OPENCODE_API_KEY": "zk-test-key", "PI_CODING_AGENT_DIR": str(agent_dir)},
            ):
                agent = PiAgent(
                    logs_dir=root / "logs",
                    model_name="opencode/x-preview-f-free",
                    artifact_path=artifact,
                    pi_commit="abc123",
                )
            self.assertEqual(json.loads(agent.auth_path.read_text())["from"], "agent-dir")
            explicit = root / "explicit.json"
            explicit.write_text('{"from": "explicit"}')
            with unittest.mock.patch.dict("os.environ", {"PI_CODING_AGENT_DIR": str(agent_dir)}):
                agent = PiAgent(
                    logs_dir=root / "logs",
                    model_name="opencode/x-preview-f-free",
                    artifact_path=artifact,
                    auth_path=explicit,
                    pi_commit="abc123",
                )
            self.assertEqual(json.loads(agent.auth_path.read_text())["from"], "explicit")
            with unittest.mock.patch.dict("os.environ", {}, clear=True):
                with self.assertRaisesRegex(ValueError, "No credential"):
                    PiAgent(
                        logs_dir=root / "logs",
                        model_name="opencode/x-preview-f-free",
                        artifact_path=artifact,
                        pi_commit="abc123",
                    )

    def test_smoke_runs_opencode_model_without_installed_stack(self) -> None:
        """End-to-end adapter smoke on the OpenCode credential path."""

        class FakeEnvironment:
            default_user = "agent"

            def __init__(self) -> None:
                self.commands: list[tuple[str, str | None, dict[str, str] | None]] = []

            async def exec(self, command, cwd=None, env=None, **_kwargs):
                self.commands.append((command, cwd, env))
                if command.startswith("/installed-agent/pi"):
                    return ExecResult(stdout=STDOUT, stderr="", return_code=0)
                return ExecResult(stdout="", stderr="", return_code=0)

            async def upload_file(self, _source, target):
                pass

            async def upload_dir(self, _source, target):
                pass

            @staticmethod
            def agent_process_env(env):
                return env

        STDOUT = json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "done"}],
                    "usage": {},
                    "stopReason": "stop",
                },
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            (root / "theme").mkdir()
            (root / "theme" / "dark.json").write_text("{}")
            (root / "theme" / "light.json").write_text("{}")
            artifact.touch()
            environment = FakeEnvironment()
            with unittest.mock.patch.dict("os.environ", {"OPENCODE_API_KEY": "zk-test-key", "PI_CODING_AGENT_DIR": ""}):
                agent = PiAgent(
                    logs_dir=root / "logs",
                    model_name="opencode/x-preview-f-free",
                    artifact_path=artifact,
                    pi_commit="abc123",
                )
                context = AgentContext()
                asyncio.run(agent.run("Fix the bug", environment, context))  # type: ignore[arg-type]

        command, cwd, _ = environment.commands[-1]
        self.assertIn("--provider opencode --model x-preview-f-free", command)
        self.assertIn("--thinking medium", command)
        self.assertEqual(cwd, "/app")
        self.assertEqual(context.n_agent_steps, 1)

    def test_rejects_unknown_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            auth = root / "auth.json"
            artifact.touch()
            auth.touch()
            with self.assertRaisesRegex(ValueError, "Unsupported model"):
                PiAgent(
                    logs_dir=root / "logs",
                    model_name="openai/gpt-5.6-luna",
                    artifact_path=artifact,
                    auth_path=auth,
                    pi_commit="abc123",
                )

    def test_accepts_opencode_model_and_derives_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            auth = root / "auth.json"
            (root / "theme").mkdir()
            (root / "theme" / "dark.json").write_text("{}")
            (root / "theme" / "light.json").write_text("{}")
            artifact.touch()
            auth.touch()
            agent = PiAgent(
                logs_dir=root / "logs",
                model_name="opencode/x-preview-f-free",
                artifact_path=artifact,
                auth_path=auth,
                pi_commit="abc123",
            )

            self.assertEqual(agent.network_allowlist().domains, ["opencode.ai", "api.opencode.ai"])
            self.assertEqual(agent.model_id, "x-preview-f-free")


class PiAgentIsolationTest(unittest.IsolatedAsyncioTestCase):
    async def test_uploads_only_pi_runtime_and_auth_and_runs_from_app(self) -> None:
        class FakeEnvironment:
            default_user = "agent"

            def __init__(self, stdout: str) -> None:
                self.stdout = stdout
                self.commands: list[tuple[str, str | None, dict[str, str] | None]] = []
                self.uploads: list[str] = []

            async def exec(
                self,
                command: str,
                cwd: str | None = None,
                env: dict[str, str] | None = None,
                **_kwargs: object,
            ) -> ExecResult:
                self.commands.append((command, cwd, env))
                if command.startswith("/installed-agent/pi"):
                    return ExecResult(stdout=self.stdout, stderr="", return_code=0)
                return ExecResult(stdout="", stderr="", return_code=0)

            async def upload_file(self, _source: Path, target: str) -> None:
                self.uploads.append(target)

            async def upload_dir(self, _source: Path, target: str) -> None:
                self.uploads.append(target)

            @staticmethod
            def agent_process_env(env: dict[str, str]) -> dict[str, str]:
                return env

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            auth = root / "auth.json"
            (root / "theme").mkdir()
            (root / "theme" / "dark.json").write_text("{}")
            (root / "theme" / "light.json").write_text("{}")
            artifact.touch()
            auth.touch()
            stdout = json.dumps(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "done"}],
                        "usage": {},
                        "stopReason": "stop",
                    },
                }
            )
            environment = FakeEnvironment(stdout)
            agent = PiAgent(
                logs_dir=root / "logs",
                model_name="openai-codex/gpt-5.6-luna",
                artifact_path=artifact,
                auth_path=auth,
                pi_commit="abc123",
            )

            await agent.setup(environment)  # type: ignore[arg-type]
            context = AgentContext()
            instruction = "Fix 'quoted input' exactly"
            await agent.run(instruction, environment, context)  # type: ignore[arg-type]

            self.assertEqual(
                environment.uploads,
                [
                    "/installed-agent/pi",
                    "/installed-agent/config/auth.json",
                    "/installed-agent/theme",
                ],
            )
            command, cwd, env = environment.commands[-1]
            self.assertEqual(cwd, "/app")
            self.assertIn("'Fix '\"'\"'quoted input'\"'\"' exactly'", command)
            self.assertNotIn("/tests", command)
            self.assertNotIn("/solution", command)
            self.assertEqual(env["PI_CODING_AGENT_DIR"], "/installed-agent/config")
            self.assertEqual(env["GIT_AUTHOR_NAME"], "Pi Benchmark")
            self.assertEqual(env["GIT_AUTHOR_EMAIL"], "pi-benchmark@localhost")
            self.assertEqual(env["GIT_COMMITTER_NAME"], "Pi Benchmark")
            self.assertEqual(env["GIT_COMMITTER_EMAIL"], "pi-benchmark@localhost")
            self.assertEqual(context.n_agent_steps, 1)


if __name__ == "__main__":
    unittest.main()
