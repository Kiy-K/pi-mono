import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

const editSchema = Type.Object({ path: Type.String() });
const bashSchema = Type.Object({ command: Type.String() });

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function createEditTool(): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "Edit",
		description: "Edit a file",
		parameters: editSchema,
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: `edited ${String(params.path)}` }],
			details: {},
		}),
	};
}

function createBashTool(): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: "Run a command",
		parameters: bashSchema,
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: `ran ${String(params.command)}` }],
			details: {},
		}),
	};
}

function completionChecks(harness: Harness): number {
	return harness.session.messages.filter(
		(message) => message.role === "user" && getMessageText(message).includes("Completion check"),
	).length;
}

describe("completion guard", () => {
	it("nudges verification when the agent stops right after editing", async () => {
		const harness = await createHarness({ tools: [createEditTool(), createBashTool()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done editing"),
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("verified"),
		]);

		await harness.session.prompt("fix the bug");

		expect(completionChecks(harness)).toBe(1);
		const roles = harness.session.messages.map((message) => message.role);
		expect(roles).toContain("toolResult");
		expect(getMessageText(harness.session.messages.at(-1)!)).toBe("verified");
	});

	it("does not nudge when nothing was edited", async () => {
		const harness = await createHarness({ tools: [createEditTool(), createBashTool()] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("all done")]);

		await harness.session.prompt("just say hi");

		expect(completionChecks(harness)).toBe(0);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("caps the nudge budget so the agent can still stop", async () => {
		const harness = await createHarness({ tools: [createEditTool(), createBashTool()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "a.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done 1"),
			fauxAssistantMessage("done 2"),
			fauxAssistantMessage("done 3"),
		]);

		await harness.session.prompt("fix the bug");

		expect(completionChecks(harness)).toBe(2);
	});
});
