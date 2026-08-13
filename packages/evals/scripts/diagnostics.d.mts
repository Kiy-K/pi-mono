export interface DiagnosticTask {
	id: string;
	split: "development" | "holdout";
	fixture: string;
	verifier: string;
	prompt: string;
}

export interface DiagnosticManifest {
	schemaVersion: 1;
	tasks: DiagnosticTask[];
}

export function validateManifest(manifest: unknown): DiagnosticManifest;

export function buildPiInvocation(options: {
	repository: string;
	workspace: string;
	extension: string;
	model: string;
	thinking: string;
	prompt: string;
}): { command: string; cwd: string; args: string[] };

export function parsePiEvents(stdout: string): {
	eventCount: number;
	malformedLines: number;
	toolCalls: number;
	failedToolCalls: number;
	repeatedToolCalls: number;
	retries: number;
	compactions: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	estimatedCostUsd: number;
	finalStopReason?: string;
	finalError?: string;
};

export function prepareWorkspace(fixture: string, workspace: string): Promise<void>;

export function prepareTreatmentSupport(repository: string, runId: string): Promise<string>;

export function runVerifier(
	verifier: string,
	workspace: string,
	timeoutMs: number,
): Promise<{
	passed: boolean;
	tests?: number;
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}>;
