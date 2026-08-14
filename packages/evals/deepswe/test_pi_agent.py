import json
import tempfile
import unittest
from pathlib import Path

from pier.environments.base import ExecResult
from pier.models.agent.context import AgentContext

from deepswe.pi_agent import PiAgent, trajectory_from_jsonl


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

    def test_rejects_unpinned_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "pi"
            auth = root / "auth.json"
            artifact.touch()
            auth.touch()
            with self.assertRaisesRegex(ValueError, "GPT-5.6 Luna"):
                PiAgent(
                    logs_dir=root / "logs",
                    model_name="openai/gpt-5.6-luna",
                    artifact_path=artifact,
                    auth_path=auth,
                    pi_commit="abc123",
                )


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
