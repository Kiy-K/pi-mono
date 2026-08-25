import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { type TruncationResult, truncateHead, truncateLine } from "./truncate.ts";

const lspSchema = Type.Object({
	action: Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("diagnostics")], {
		description: "LSP query to run",
	}),
	file: Type.String({ description: "Source file to query (relative to working directory)" }),
	symbol: Type.Optional(
		Type.String({
			description:
				"Substring of the symbol text to place the cursor on; first match on 'line' if given, else first occurrence in the file",
		}),
	),
	line: Type.Optional(Type.Number({ description: "1-indexed line to query (default: line containing 'symbol')" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 20)" })),
});

export const lspToolSystemPromptContribution = {
	snippet: "On-demand LSP: go to definition, find references, diagnostics",
	guidelines: [],
} as const;

export type LspToolInput = Static<typeof lspSchema>;
const DEFAULT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const DIAGNOSTICS_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_GRACE_MS = 300;

export interface LspToolDetails {
	truncation?: TruncationResult;
}

interface ServerConfig {
	command: string;
	args: string[];
	fileType: string;
}

function getServerConfig(extension: string): ServerConfig {
	switch (extension) {
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return { command: "typescript-language-server", args: ["--stdio"], fileType: "TypeScript/JavaScript" };
		case ".py":
			return { command: "pyright-langserver", args: ["--stdio"], fileType: "Python" };
		case ".rs":
			return { command: "rust-analyzer", args: [], fileType: "Rust" };
		default:
			throw new Error(`No language server configured for file type '${extension}'`);
	}
}

function getLanguageId(extension: string): string {
	switch (extension) {
		case ".tsx":
			return "typescriptreact";
		case ".jsx":
			return "javascriptreact";
		case ".py":
			return "python";
		case ".rs":
			return "rust";
		default:
			return extension === ".mjs" || extension === ".cjs" ? "javascript" : "typescript";
	}
}

/**
 * Resolve the cursor position for a definition/references query.
 * `line` is 1-indexed; when omitted the first occurrence of `symbol` in the file wins.
 */
export function resolveSymbolPosition(
	content: string,
	symbol?: string,
	line?: number,
): { line: number; character: number } {
	const lines = content.split("\n");
	if (line !== undefined) {
		const index = line - 1;
		const text = lines[index];
		if (text === undefined) {
			throw new Error(`Line ${line} is beyond end of file (${lines.length} lines)`);
		}
		const char = symbol ? text.indexOf(symbol) : -1;
		return { line: index, character: char >= 0 ? char : 0 };
	}
	if (!symbol) {
		throw new Error("Provide 'symbol' or 'line' to locate the query position");
	}
	for (let i = 0; i < lines.length; i++) {
		const char = lines[i].indexOf(symbol);
		if (char >= 0) return { line: i, character: char };
	}
	throw new Error(`Symbol '${symbol}' not found in file`);
}

/** Incremental reader for Content-Length framed JSON-RPC messages on stdout. */
class MessageBuffer {
	private chunks: Buffer[] = [];
	private size = 0;

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
	}

	tryRead(): unknown | undefined {
		if (this.size === 0) return undefined;
		const data = Buffer.concat(this.chunks, this.size);
		const headerEnd = data.indexOf("\r\n\r\n");
		if (headerEnd < 0) return undefined;
		const header = data.subarray(0, headerEnd).toString();
		const match = /Content-Length: (\d+)/i.exec(header);
		if (!match) throw new Error(`Malformed LSP response header: ${header.split("\r\n")[0]}`);
		const length = Number(match[1]);
		const start = headerEnd + 4;
		if (data.length < start + length) return undefined;
		this.chunks = [data.subarray(start + length)];
		this.size = this.chunks[0].length;
		return JSON.parse(data.subarray(start, start + length).toString()) as unknown;
	}
}

interface LocationLike {
	uri: string;
	line: number;
	character: number;
}

interface DiagnosticLike {
	range?: { start?: { line?: number; character?: number } };
	severity?: number;
	message?: string;
}

interface ServerHandle {
	request(method: string, params: unknown): Promise<Record<string, unknown>>;
	notify(method: string, params: unknown): void;
	waitForNotification(method: string): Promise<Record<string, unknown>>;
}

/**
 * Spawn a stdio language server, complete the initialize handshake, hand a
 * request handle to `use`, then shut the server down. Rejects on spawn errors,
 * early exit, or after `timeoutMs`.
 */
async function withLanguageServer(
	config: ServerConfig,
	cwd: string,
	timeoutMs: number,
	use: (handle: ServerHandle) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolveOuter, rejectOuter) => {
		const child = spawn(config.command, config.args, { cwd });
		let settled = false;
		let nextId = 1;
		let stderr = "";
		const pending = new Map<
			number,
			{ resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
		>();
		const waiters: Array<{
			method: string;
			resolve: (value: Record<string, unknown>) => void;
			reject: (err: Error) => void;
		}> = [];
		const buffer = new MessageBuffer();

		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeAllListeners();
			try {
				handle.notify("shutdown", {});
			} catch {
				// server may already be gone
			}
			child.kill();
			for (const entry of pending.values()) {
				entry.reject(error ?? new Error("Language server closed"));
			}
			pending.clear();
			for (const waiter of waiters.splice(0)) {
				waiter.reject(error ?? new Error("Language server closed"));
			}
			if (error) rejectOuter(error);
			else resolveOuter();
		}

		function write(message: object): void {
			const body = JSON.stringify(message);
			child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		}

		function dispatch(message: Record<string, unknown>): void {
			if (typeof message.id === "number") {
				const entry = pending.get(message.id);
				if (!entry) return;
				pending.delete(message.id);
				if (message.error) {
					entry.reject(new Error(`LSP error from ${config.command}: ${JSON.stringify(message.error)}`));
				} else {
					entry.resolve((message.result ?? {}) as Record<string, unknown>);
				}
				return;
			}
			if (typeof message.method === "string") {
				for (let i = waiters.length - 1; i >= 0; i--) {
					if (waiters[i].method === message.method) {
						waiters[i].resolve((message.params ?? {}) as Record<string, unknown>);
						waiters.splice(i, 1);
					}
				}
			}
		}

		const timer = setTimeout(() => {
			finish(new Error(`lsp request timed out after ${timeoutMs}ms (${config.command})`));
		}, timeoutMs);

		if (signal) {
			const abort = (): void => finish(new Error("Operation aborted"));
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}

		const handle: ServerHandle = {
			request(method, params) {
				return new Promise<Record<string, unknown>>((resolve, reject) => {
					if (settled) {
						reject(new Error("Language server already closed"));
						return;
					}
					const id = nextId++;
					pending.set(id, { resolve, reject });
					write({ jsonrpc: "2.0", id, method, params });
				});
			},
			notify(method, params) {
				if (!settled) write({ jsonrpc: "2.0", method, params });
			},
			waitForNotification(method) {
				return new Promise<Record<string, unknown>>((resolve, reject) => {
					waiters.push({ method, resolve, reject });
				});
			},
		};

		child.stdout.on("data", (chunk: Buffer) => {
			buffer.push(chunk);
			try {
				for (let message = buffer.tryRead(); message !== undefined; message = buffer.tryRead()) {
					dispatch(message as Record<string, unknown>);
				}
			} catch (error) {
				finish(new Error(`Failed to parse ${config.command} output: ${(error as Error).message}`));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});
		child.on("error", (error) => {
			finish(new Error(`Failed to spawn ${config.command} for ${config.fileType} files: ${error.message}`));
		});
		child.on("exit", (code) => {
			finish(
				new Error(
					`${config.command} exited prematurely (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
				),
			);
		});

		void (async () => {
			await handle.request("initialize", {
				processId: process.pid,
				rootUri: pathToFileURL(cwd).href,
				capabilities: {},
			});
			handle.notify("initialized", {});
			await use(handle);
			finish();
		})().catch((error: unknown) => {
			finish(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function normalizeLocations(result: unknown): LocationLike[] {
	const asLocation = (item: unknown): LocationLike | undefined => {
		if (!item || typeof item !== "object") return undefined;
		const loc = item as { uri?: unknown; targetUri?: unknown; range?: { start?: LocationLike } };
		const uri = typeof loc.uri === "string" ? loc.uri : typeof loc.targetUri === "string" ? loc.targetUri : undefined;
		if (!uri || !loc.range?.start) return undefined;
		return { uri, line: loc.range.start.line ?? 0, character: loc.range.start.character ?? 0 };
	};
	if (Array.isArray(result)) {
		return result.map(asLocation).filter((loc): loc is LocationLike => loc !== undefined);
	}
	const single = asLocation(result);
	return single ? [single] : [];
}

async function formatLocations(locations: LocationLike[], limit: number): Promise<string> {
	const lines: string[] = [];
	for (const location of locations.slice(0, limit)) {
		let filePath = location.uri;
		if (filePath.startsWith("file://")) filePath = fileURLToPath(filePath);
		let text = "";
		try {
			const content = await readFile(filePath, "utf8");
			text = content.split("\n")[location.line] ?? "";
		} catch {
			// unreadable target: still report the position
		}
		lines.push(`${filePath}:${location.line + 1}: ${truncateLine(text.trim(), 120).text}`);
	}
	return lines.join("\n");
}

const SEVERITY_NAMES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function formatDiagnosticLine(filePath: string, diagnostic: DiagnosticLike): string {
	const line = (diagnostic.range?.start?.line ?? 0) + 1;
	const column = (diagnostic.range?.start?.character ?? 0) + 1;
	const severity = SEVERITY_NAMES[diagnostic.severity ?? 0] ?? "info";
	return `${filePath}:${line}:${column} ${severity} ${diagnostic.message ?? ""}`;
}

async function collectDiagnostics(
	handle: ServerHandle,
	uri: string,
	filePath: string,
	timeoutMs: number,
): Promise<string[]> {
	const waitMatching = (): Promise<DiagnosticLike[]> =>
		new Promise<DiagnosticLike[]>((resolve, reject) => {
			void (async () => {
				for (;;) {
					const params = await handle.waitForNotification("textDocument/publishDiagnostics");
					if ((params.uri as string) === uri) {
						resolve((params.diagnostics as DiagnosticLike[]) ?? []);
						return;
					}
				}
			})().catch(reject);
		});

	const first = await Promise.race([
		waitMatching(),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`No diagnostics received within ${timeoutMs / 1000}s`)), timeoutMs),
		),
	]);
	// Servers often send an empty batch first and the real one moments later;
	// keep collecting briefly so we surface the freshest batch.
	let diagnostics = first;
	for (;;) {
		const next = await Promise.race([
			waitMatching(),
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DIAGNOSTICS_GRACE_MS)),
		]);
		if (!next) break;
		diagnostics = next;
	}
	return diagnostics.map((diagnostic) => formatDiagnosticLine(filePath, diagnostic));
}

export function createLspToolDefinition(cwd: string): ToolDefinition<typeof lspSchema, LspToolDetails | undefined> {
	return {
		name: "lsp",
		label: "LSP",
		description: "On-demand language-server queries: go to definition, find references, or get file diagnostics.",
		promptSnippet: lspToolSystemPromptContribution.snippet,
		parameters: lspSchema,
		async execute(
			_toolCallId,
			{ action, file, symbol, line, limit }: LspToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: LspToolDetails }> {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			if (action !== "diagnostics" && !symbol && line === undefined) {
				throw new Error("Provide 'symbol' or 'line' to locate the query position");
			}

			const filePath = resolveToCwd(file, cwd);
			const extension = extname(filePath).toLowerCase();
			const config = getServerConfig(extension);
			const maxResults = limit ?? DEFAULT_LIMIT;

			let output: string;
			if (action === "diagnostics") {
				output = await runDiagnostics(config, cwd, filePath, extension, signal);
			} else {
				output = await runLocationQuery(action, config, cwd, filePath, extension, symbol, line, maxResults, signal);
			}

			const truncated = truncateHead(output || "No results");
			return {
				content: [{ type: "text", text: truncated.content }],
				details: { truncation: truncated },
			};
		},
	};
}

async function runDiagnostics(
	config: ServerConfig,
	cwd: string,
	filePath: string,
	extension: string,
	signal?: AbortSignal,
): Promise<string> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		throw new Error(`Cannot read file ${filePath}: ${(error as Error).message}`);
	}
	const uri = pathToFileURL(filePath).href;
	let result: string[] = [];
	await withLanguageServer(
		config,
		cwd,
		DIAGNOSTICS_TIMEOUT_MS + DIAGNOSTICS_GRACE_MS * 2,
		async (handle) => {
			handle.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: getLanguageId(extension), version: 1, text },
			});
			result = await collectDiagnostics(handle, uri, filePath, DIAGNOSTICS_TIMEOUT_MS);
		},
		signal,
	);
	return result.join("\n");
}

async function runLocationQuery(
	action: "definition" | "references",
	config: ServerConfig,
	cwd: string,
	filePath: string,
	extension: string,
	symbol: string | undefined,
	line: number | undefined,
	maxResults: number,
	signal?: AbortSignal,
): Promise<string> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		throw new Error(`Cannot read file ${filePath}: ${(error as Error).message}`);
	}
	const position = resolveSymbolPosition(content, symbol, line);
	const uri = pathToFileURL(filePath).href;
	let output = "";
	await withLanguageServer(
		config,
		cwd,
		REQUEST_TIMEOUT_MS,
		async (handle) => {
			handle.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: getLanguageId(extension), version: 1, text: content },
			});
			// Cold servers (e.g. rust-analyzer) answer with empty results while
			// still indexing; retry a few times before giving up.
			const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
			let locations: LocationLike[] = [];
			for (let attempt = 0; attempt < 4; attempt++) {
				if (attempt > 0) await delay(1500);
				const result =
					action === "definition"
						? await handle.request("textDocument/definition", { textDocument: { uri }, position })
						: await handle.request("textDocument/references", {
								textDocument: { uri },
								position,
								context: { includeDeclaration: true },
							});
				locations = normalizeLocations(result);
				if (locations.length) break;
			}
			output = locations.length ? await formatLocations(locations, maxResults) : "No results";
		},
		signal,
	);
	return output;
}

export function createLspTool(cwd: string): AgentTool<typeof lspSchema> {
	return wrapToolDefinition(createLspToolDefinition(cwd));
}
