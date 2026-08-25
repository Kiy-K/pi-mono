import { stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, type TruncationResult, truncateHead, truncateLine } from "./truncate.ts";

const astGrepSchema = Type.Object({
	pattern: Type.Optional(
		Type.String({
			description:
				"AST pattern to search for. Must parse as a COMPLETE syntax node (e.g. 'function $NAME($$$ARGS) { $$$BODY }'). $VAR captures one node, $$$CAPS zero or more. The same metavariable used twice must match identical code.",
		}),
	),
	kind: Type.Optional(
		Type.String({
			description:
				"Syntax-tree node kind to list instead of a pattern, e.g. 'function_declaration', 'class_declaration', 'method_definition' (TS/JS), 'function_definition'/'class_definition' (Python), 'function_item' (Rust). Comma-separated kinds are allowed for an outline. Use a pattern (not kind) to find code by structure.",
		}),
	),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
	lang: Type.Optional(
		Type.String({
			description:
				"Tree-sitter language name, e.g. TypeScript, TSX, JavaScript, Python, Rust, Go (inferred from file extensions when omitted)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const astGrepToolSystemPromptContribution = {
	snippet: "Structural code search with ast-grep: match AST patterns or list syntax-tree kinds (outline)",
	guidelines: [],
} as const;

export type AstGrepToolInput = Static<typeof astGrepSchema>;
const DEFAULT_LIMIT = 100;

export interface AstGrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
}

interface AstGrepMatch {
	file?: string;
	text?: string;
	range?: { start?: { line?: number } };
}

function runAstGrep(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	// Executor form: Promise.withResolvers needs lib es2024, above this package's target.
	return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
		const child = spawn("ast-grep", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => reject(new Error(`Failed to run ast-grep: ${error.message}`)));
		child.on("close", (code) => resolve({ stdout, stderr, code }));
	});
}

/**
 * ast-grep --json=compact emits one JSON array of match objects; append its
 * items to matches. Non-array output (empty string) yields nothing.
 */
function collectMatches(stdout: string, matches: AstGrepMatch[]): void {
	if (!stdout.trim()) return;
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (!Array.isArray(parsed)) return;
		for (const item of parsed) {
			if (item && typeof item === "object") matches.push(item as AstGrepMatch);
		}
	} catch {
		// Malformed output: leave matches untouched rather than failing the call.
	}
}

function formatMatches(matches: AstGrepMatch[], limit: number): { text: string; limitReached: boolean } {
	const lines: string[] = [];
	let limitReached = false;
	for (const match of matches) {
		if (lines.length >= limit) {
			limitReached = true;
			break;
		}
		const file = match.file ?? "?";
		const line = (match.range?.start?.line ?? 0) + 1;
		const firstLine = (match.text ?? "").split("\n")[0] ?? "";
		lines.push(`${file}:${line}: ${truncateLine(firstLine).text}`);
	}
	return { text: lines.join("\n"), limitReached };
}

export function createAstGrepToolDefinition(
	cwd: string,
): ToolDefinition<typeof astGrepSchema, AstGrepToolDetails | undefined> {
	return {
		name: "ast_grep",
		label: "ast-grep",
		description: `Structural code search using ast-grep (tree-sitter based). Two modes: (1) pattern search - match code by AST structure with metavariables, robust to formatting and renaming; (2) kind listing - outline all declarations of a syntax kind (functions, classes, methods) with line numbers. Patterns must be complete syntax nodes; partial constructs like 'function $NAME($$$A)' without a body do not parse. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: astGrepToolSystemPromptContribution.snippet,
		parameters: astGrepSchema,
		async execute(
			_toolCallId,
			{ pattern, kind, path: searchPath, lang, limit }: AstGrepToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: AstGrepToolDetails }> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			if (!pattern && !kind) {
				throw new Error("Provide either 'pattern' (AST pattern) or 'kind' (syntax-tree kind)");
			}
			if (pattern && kind) {
				throw new Error("Provide only one of 'pattern' or 'kind'");
			}

			const targetPath = searchPath ? resolveToCwd(searchPath, cwd) : cwd;
			try {
				await fsStat(targetPath);
			} catch {
				throw new Error(`Path does not exist: ${searchPath}`);
			}

			const kinds = (kind ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
			const maxMatches = limit ?? DEFAULT_LIMIT;
			const matches: AstGrepMatch[] = [];

			if (pattern) {
				const args = ["run", "--json=compact", "-p", pattern];
				if (lang) args.push("-l", lang);
				args.push(targetPath);
				const { stdout, stderr, code } = await runAstGrep(args);
				if (code !== 0 && !stdout.trim()) {
					throw new Error(`ast-grep failed: ${stderr.trim() || `exit code ${code}`}`);
				}
				collectMatches(stdout, matches);
			} else {
				for (const nodeKind of kinds) {
					const args = ["run", "--json=compact", "-k", nodeKind];
					if (lang) args.push("-l", lang);
					args.push(targetPath);
					const { stdout, stderr, code } = await runAstGrep(args);
					if (code !== 0 && !stdout.trim()) {
						throw new Error(`ast-grep failed for kind '${nodeKind}': ${stderr.trim() || `exit code ${code}`}`);
					}
					collectMatches(stdout, matches);
				}
				matches.sort(
					(a, b) =>
						(a.file ?? "").localeCompare(b.file ?? "") ||
						(a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0),
				);
			}

			const { text, limitReached } = formatMatches(matches, maxMatches);
			const truncated = truncateHead(text || "No matches");
			return {
				content: [{ type: "text", text: truncated.content }],
				details: { truncation: truncated, matchLimitReached: limitReached ? maxMatches : undefined },
			};
		},
	};
}

export function createAstGrepTool(cwd: string): AgentTool<typeof astGrepSchema> {
	return wrapToolDefinition(createAstGrepToolDefinition(cwd));
}
