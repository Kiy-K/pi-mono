export type EvaluationOutcome =
	| "cancelled_user"
	| "invalid_provider"
	| "invalid_infra"
	| "timeout_harness"
	| "solved"
	| "unsolved";

export interface TrialIdentity {
	sourceAnchor: string;
	evaluatorSha256: string;
	configSha256: string;
	provider: string;
	model: string;
	thinking: string;
	taskRevision: string;
	prompt: string;
	tools: string[];
	timeoutMs: number;
	artifactSha256: string;
}

export interface EvaluatorDescriptor {
	schemaVersion: 1;
	provider: string;
	model: string;
	thinking: string;
	extensionPath: string;
	extensionSha256: string;
	configSha256: string;
	headlessCommand: string;
	path: string;
	descriptorSha256: string;
	blocked: boolean;
	missing: string[];
}

export type PreflightResult =
	| { status: "blocked"; reason: string }
	| { status: "ready"; evaluator: EvaluatorDescriptor };

export interface RunManifest {
	schemaVersion: 2;
	runId: string;
	sourceAnchor: string;
	stock: { artifactSha256: string };
	candidate: { artifactSha256: string };
	evaluator: {
		provider: string;
		model: string;
		thinking: string;
		artifactSha256: string;
		configSha256: string;
	};
	task: {
		revision: string;
		prompt: string;
		tools: string[];
		timeoutMs: number;
	};
	runOrder: Array<"stock" | "candidate">;
	outcome: EvaluationOutcome;
}

export function classifyOutcome(input: {
	cancelled?: boolean;
	providerError?: string;
	infrastructureError?: string;
	processTimedOut?: boolean;
	processExitedCleanly?: boolean;
	verifierPassed?: boolean;
}): EvaluationOutcome;

export function assertComparableTrials(stock: TrialIdentity, candidate: TrialIdentity): void;

export function makeRunManifest(options: {
	runId: string;
	stock: TrialIdentity;
	candidate: TrialIdentity;
	runOrder: Array<"stock" | "candidate">;
	outcome: EvaluationOutcome;
}): RunManifest;

export function readEvaluatorContract(path: string | URL): Promise<EvaluatorDescriptor>;

export function preflightEvaluator(path: string | URL): Promise<PreflightResult>;
