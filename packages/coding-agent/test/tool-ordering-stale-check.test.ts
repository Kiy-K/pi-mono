import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	runAgentLoop,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function getToolResultText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result)) return "";
	const content = (result as { content: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null || !("text" in part)) return "";
			const text = part.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const { promise, resolve } = createDeferred<boolean>();
	const started = Date.now();
	const tick = (): void => {
		if (predicate() || Date.now() - started >= timeoutMs) {
			resolve(predicate());
			return;
		}
		setTimeout(tick, 5);
	};
	tick();
	return promise;
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-stale-check-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Mechanism proof: with the default "parallel" tool execution, a write and a
// dependent bash verification in the SAME assistant message are dispatched
// concurrently. bash does not await the write's per-file mutation queue, so
// when the write is slower (deterministically simulated via a gated write) it
// observes the PRE-mutation file state.
describe("tool-ordering stale-verification: batched write + dependent bash", () => {
	it("bash verification observes pre-write content while the write in the same batch is in flight", async () => {
		const dir = await createTempDir();
		const target = join(dir, "notes.txt");
		await writeFile(target, "OLD-CONTENT", "utf-8");

		const { promise: writeGate, resolve: releaseWrite } = createDeferred<void>();
		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async (d) => {
					await mkdir(d, { recursive: true });
				},
				writeFile: async (path, content) => {
					await writeGate;
					await writeFile(path, content, "utf-8");
				},
			},
		});
		const bashTool = createBashTool(dir);

		const events: AgentEvent[] = [];
		let calls = 0;
		const streamFn: Parameters<typeof runAgentLoop>[5] = () => {
			calls += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (calls === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "write-1",
									name: "write",
									arguments: { path: target, content: "NEW-CONTENT" },
								},
								{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: `cat "${target}"` } },
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return stream;
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [writeTool as AgentTool, bashTool as AgentTool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		const run = runAgentLoop(
			[createUserMessage("write notes then verify")],
			context,
			config,
			(event) => {
				events.push(event);
			},
			undefined,
			streamFn,
		);

		// bash runs concurrently while the write is gated; wait for its result.
		const captured = await waitUntil(() =>
			events.some(
				(event) =>
					event.type === "tool_execution_end" &&
					event.toolName === "bash" &&
					getToolResultText(event.result) !== "",
			),
		);
		expect(captured).toBe(true);

		const bashEnd = [...events]
			.reverse()
			.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end" && event.toolName === "bash",
			);
		if (!bashEnd) throw new Error("expected a bash tool_execution_end event");
		const bashOutput = getToolResultText(bashEnd.result);

		// The write is still gated here, so the file on disk is unchanged.
		expect(bashOutput).toContain("OLD-CONTENT");
		expect(bashOutput).not.toContain("NEW-CONTENT");

		releaseWrite();
		await run;

		expect(await readFile(target, "utf-8")).toBe("NEW-CONTENT");
	});
});
