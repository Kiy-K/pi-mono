export interface CompletionSignature {
	mutations: number;
	commands: number;
	testCommands: number;
	bundledTestCommands: number;
	selfTestCommands: number;
	unattributedTestCommands: number;
	specReads: number;
	mutationsAfterLastCommand: 0 | 1;
	commandsAfterLastMutation: number;
	/** Every command after the final mutation was a bundled-suite run (ordering only - not evidence the suite passed). */
	bundledOnlyAfterLastMutation: boolean;
	/** Final post-mutation bundled-only run ended without error (toolCallId-paired). */
	bundledGreenAfterLastMutation: boolean;
	unverifiedFinalMutation: boolean;
}

export function completionSignature(phaseStdouts: string[], bundledTestNames?: string[]): CompletionSignature;
