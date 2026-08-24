import { describe, expect, it } from "vitest";
import { completionSignature } from "../scripts/diagnostics.mjs";

/** Build a minimal pi JSON event stream from tool names, in start order. */
function stream(tools: Array<{ name: string; error?: boolean; args?: unknown }>): string {
	const lines: string[] = ['{"type":"session","version":3,"id":"t","timestamp":"t","cwd":"/w"}'];
	for (const tool of tools) {
		lines.push(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: `c-${tool.name}-${Math.random()}`,
				toolName: tool.name,
				args: tool.args ?? {},
			}),
		);
		lines.push(
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "x",
				toolName: tool.name,
				result: {},
				isError: tool.error ?? false,
			}),
		);
	}
	lines.push('{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{}}}');
	return `${lines.join("\n")}\n`;
}

describe("completionSignature", () => {
	it("flags a final edit with no command executed after it (preregistered premature-completion signature)", () => {
		const sig = completionSignature([stream([{ name: "read" }, { name: "bash" }, { name: "edit" }])]);
		expect(sig.unverifiedFinalMutation).toBe(true);
		expect(sig.mutationsAfterLastCommand).toBe(1);
		expect(sig.commandsAfterLastMutation).toBe(0);
	});

	it("does not flag a rep whose final state was exercised by a later command", () => {
		const sig = completionSignature([stream([{ name: "edit" }, { name: "bash" }])]);
		expect(sig.unverifiedFinalMutation).toBe(false);
		expect(sig.commandsAfterLastMutation).toBe(1);
		expect(sig.mutationsAfterLastCommand).toBe(0);
	});

	it("does not flag reads or searches as mutations", () => {
		const sig = completionSignature([
			stream([{ name: "edit" }, { name: "bash" }, { name: "read" }, { name: "grep" }, { name: "find" }]),
		]);
		expect(sig.unverifiedFinalMutation).toBe(false);
		expect(sig.mutations).toBe(1);
	});

	it("does not flag a rep that never mutated the workspace", () => {
		const sig = completionSignature([stream([{ name: "bash" }, { name: "read" }])]);
		expect(sig.unverifiedFinalMutation).toBe(false);
		expect(sig.mutations).toBe(0);
		expect(sig.commands).toBe(1);
	});

	it("merges gate continuation and repair phases into one timeline", () => {
		// Phase 1 ends verified; gate continuation (phase 1b) mutates afterwards.
		const sig = completionSignature([stream([{ name: "edit" }, { name: "bash" }]), stream([{ name: "write" }])]);
		expect(sig.unverifiedFinalMutation).toBe(true);
		expect(sig.mutations).toBe(2);
	});

	it("tolerates malformed lines", () => {
		const sig = completionSignature(["not json\n", stream([{ name: "bash" }, { name: "edit" }]), "\n\n"]);
		expect(sig.unverifiedFinalMutation).toBe(true);
	});

	it("counts errored commands as commands (a failed verification still exercises the state)", () => {
		const sig = completionSignature([stream([{ name: "edit" }, { name: "bash", error: true }])]);
		expect(sig.unverifiedFinalMutation).toBe(false);
		expect(sig.commands).toBe(1);
	});

	it("attributes test runs: bundled by exact fixture name, self-authored by other test file, discover unattributed", () => {
		const sig = completionSignature(
			[
				stream([
					{ name: "bash", args: { command: "python3 -m unittest test_promotions.py -v" } },
					{ name: "bash", args: { command: "python3 -m unittest test_mine.py -v" } },
					{ name: "bash", args: { command: "python3 -m unittest discover" } },
					{ name: "bash", args: { command: "ls -la" } },
				]),
			],
			["test_promotions.py", "test_cart.py"],
		);
		expect(sig.testCommands).toBe(3);
		expect(sig.bundledTestCommands).toBe(1);
		expect(sig.selfTestCommands).toBe(1);
		expect(sig.unattributedTestCommands).toBe(1);
	});

	it("does not flag bundled-only when an unrelated command ran between mutation and bundled suite", () => {
		const sig = completionSignature(
			[
				stream([
					{ name: "edit" },
					{ name: "bash", args: { command: "ls -la" } },
					{ name: "bash", args: { command: "python3 -m unittest test_promotions.py" } },
				]),
			],
			["test_promotions.py"],
		);
		expect(sig.bundledOnlyAfterLastMutation).toBe(false);
	});

	it("evaluates bundled-only against the FINAL edit: an intervening edit resets the trace", () => {
		const sig = completionSignature(
			[
				stream([
					{ name: "edit" },
					{ name: "bash", args: { command: "ls -la" } },
					{ name: "edit" },
					{ name: "bash", args: { command: "python3 -m unittest test_promotions.py" } },
				]),
			],
			["test_promotions.py"],
		);
		expect(sig.bundledOnlyAfterLastMutation).toBe(true);
	});

	it("flags bundled-only verification: bundled suite is the only post-mutation command", () => {
		const sig = completionSignature(
			[stream([{ name: "edit" }, { name: "bash", args: { command: "python3 -m unittest test_promotions.py" } }])],
			["test_promotions.py"],
		);
		expect(sig.bundledOnlyAfterLastMutation).toBe(true);
		expect(sig.unverifiedFinalMutation).toBe(false);
	});

	it("does not flag bundled-only when a self-authored test ran after the mutation", () => {
		const sig = completionSignature(
			[stream([{ name: "edit" }, { name: "bash", args: { command: "python3 -m unittest test_mine.py" } }])],
			["test_promotions.py"],
		);
		expect(sig.bundledOnlyAfterLastMutation).toBe(false);
		expect(sig.selfTestCommands).toBe(1);
	});

	it("does not flag bundled-only when one command mixes bundled and self-authored test files", () => {
		const sig = completionSignature(
			[
				stream([
					{ name: "edit" },
					{ name: "bash", args: { command: "python3 -m pytest test_promotions.py test_mine.py" } },
				]),
			],
			["test_promotions.py"],
		);
		expect(sig.bundledTestCommands).toBe(1);
		expect(sig.bundledOnlyAfterLastMutation).toBe(false);
	});

	it("counts SPEC.md reads as use of the in-workspace oracle", () => {
		const sig = completionSignature([
			stream([
				{ name: "read", args: { path: "/ws/SPEC.md" } },
				{ name: "read", args: { path: "/ws/cart.py" } },
			]),
		]);
		expect(sig.specReads).toBe(1);
	});

	it("rejects a mutant that attributes self-authored tests as bundled by regex alone", () => {
		const fixture = [stream([{ name: "bash", args: { command: "python3 -m unittest test_mine.py" } }])];
		expect(completionSignature(fixture, ["test_promotions.py"]).bundledTestCommands).toBe(0);
		const mutant = completionSignature(
			[fixture[0].replaceAll("test_mine.py", "test_promotions.py")],
			["test_promotions.py"],
		);
		expect(mutant.bundledTestCommands).toBe(1);
	});

	// Mutant controls: buggy extractors must misclassify at least one fixture.
	it("rejects a mutant that counts reads as mutations", () => {
		const fixture = [stream([{ name: "edit" }, { name: "bash" }, { name: "read" }])];
		expect(completionSignature(fixture).unverifiedFinalMutation).toBe(false);
		const mutant = completionSignature([
			stream([{ name: "edit" }, { name: "bash" }, { name: "read" }]).replaceAll('"read"', '"edit"'),
		]);
		expect(mutant.unverifiedFinalMutation).toBe(true);
	});

	it("rejects a mutant that scans execution-end order instead of start order", () => {
		// Parallel mode: edit starts first, bash starts second; bash (fast) ends
		// before the long-running edit. Start order: edit, bash -> verified.
		// End order: bash, edit -> an end-order scanner sees the mutation last.
		const lines = [
			'{"type":"session","version":3,"id":"t","timestamp":"t","cwd":"/w"}',
			'{"type":"tool_execution_start","toolCallId":"1","toolName":"edit","args":{}}',
			'{"type":"tool_execution_start","toolCallId":"2","toolName":"bash","args":{}}',
			'{"type":"tool_execution_end","toolCallId":"2","toolName":"bash","result":{},"isError":false}',
			'{"type":"tool_execution_end","toolCallId":"1","toolName":"edit","result":{},"isError":false}',
		];
		const stdout = `${lines.join("\n")}\n`;
		expect(completionSignature([stdout]).unverifiedFinalMutation).toBe(false);
		// End-order mutant: last end event is the edit -> would flag.
		const endOrderLastTool = JSON.parse(lines.at(-1)!).toolName;
		expect(endOrderLastTool).toBe("edit");
	});
});
