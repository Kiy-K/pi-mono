/**
 * Completion-signature extraction for pi eval runs.
 *
 * Classifies an agent's tool-event stream into the signals that distinguish
 * genuine completion from premature stopping: mutation/test-command counts,
 * SPEC reads, and - critically - whether the final edit was followed only by
 * bundled-suite runs that actually PASSED. The false-green class (agent sees
 * a green bundled suite, external verifier disagrees) is only detectable
 * with the green conjunction; ordering alone is not evidence of success.
 *
 * Plain JS (.mjs) so CLI entry points can import it on any supported node
 * (>= 22.19); types live in completion-signature.d.mts.
 */

/** @typedef {{ mutations: number, commands: number, testCommands: number, bundledTestCommands: number, selfTestCommands: number, unattributedTestCommands: number, specReads: number, mutationsAfterLastCommand: 0 | 1, commandsAfterLastMutation: number, bundledOnlyAfterLastMutation: boolean, bundledGreenAfterLastMutation: boolean, unverifiedFinalMutation: boolean }} CompletionSignature */

export function completionSignature(phaseStdouts, bundledTestNames = []) {
	const MUTATORS = new Set(["write", "edit"]);
	const TEST_COMMAND = /(unittest|pytest|\btest_[a-z0-9_]+\.py\b)/;
	const bundled = new Set(bundledTestNames.map((name) => name.replace(/\.py$/, "")));
	let mutations = 0;
	let commands = 0;
	let testCommands = 0;
	let bundledTestCommands = 0;
	let selfTestCommands = 0;
	let unattributedTestCommands = 0;
	let nonBundledCommandAfterLastMutation = false;
	let specReads = 0;
	let lastMutationSeq = -1;
	let lastCommandSeq = -1;
	let lastBundledTestSeq = -1;
	let seq = 0;
	const bundledOnlyCalls = new Map();
	let lastBundledOnlyCallId;
	for (const stdout of phaseStdouts) {
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "tool_execution_end") {
				// Resolve the matching bundled-only start by toolCallId: calls
				// may interleave, so end order is not start order.
				if (event.toolCallId != null && bundledOnlyCalls.has(event.toolCallId)) {
					bundledOnlyCalls.get(event.toolCallId).ok = !event.isError;
				}
				continue;
			}
			if (event.type !== "tool_execution_start") continue;
			if (event.toolName === "bash") {
				commands += 1;
				lastCommandSeq = seq;
				const command = typeof event.args === "string" ? event.args : (event.args?.command ?? "");
				if (TEST_COMMAND.test(command)) {
					testCommands += 1;
					// Attribution uses ONLY explicit test references in the command,
					// in filename (test_promotions.py) OR module form (unittest
					// test_promotions): a bundled reference -> bundled run; any
					// other test reference -> self-authored; a bare
					// `unittest`/`pytest` (e.g. discover, which sweeps
					// self-authored files too) is unattributable.
					const named = command.match(/\btest_[a-z0-9_]+(?:\.py)?\b/g) ?? [];
					const stems = new Set(named.map((name) => name.replace(/\.py$/, "")));
					const hasBundled = [...stems].some((stem) => bundled.has(stem));
					const hasForeign = [...stems].some((stem) => !bundled.has(stem));
					if (hasBundled) {
						bundledTestCommands += 1;
						lastBundledTestSeq = seq;
					} else if (named.length > 0) {
						selfTestCommands += 1;
					} else {
						unattributedTestCommands += 1;
					}
					// Bundled-only requires the command to run NO foreign test
					// file: `pytest test_promotions.py test_mine.py` runs bundled
					// AND self-authored checks, so it breaks the claim. Any other
					// non-test command after the mutation breaks it too.
					const isBundledOnlyRun = hasBundled && !hasForeign;
					if (isBundledOnlyRun && event.toolCallId != null) {
						bundledOnlyCalls.set(event.toolCallId, { ok: null });
						lastBundledOnlyCallId = event.toolCallId;
					}
					if (mutations > 0 && seq > lastMutationSeq && !isBundledOnlyRun) {
						nonBundledCommandAfterLastMutation = true;
					}
				} else if (mutations > 0 && seq > lastMutationSeq) {
					nonBundledCommandAfterLastMutation = true;
				}
			} else if (MUTATORS.has(event.toolName)) {
				mutations += 1;
				lastMutationSeq = seq;
				// Per-mutation state: the false-green claim is about the FINAL
				// edit, so a later edit resets it (edit -> ls -> edit -> bundled
				// test IS bundled-only after the last edit).
				nonBundledCommandAfterLastMutation = false;
			} else if (event.toolName === "read") {
				const path = typeof event.args === "string" ? event.args : (event.args?.path ?? "");
				if (typeof path === "string" && path.includes("SPEC.md")) specReads += 1;
			}
			seq += 1;
		}
	}
	return {
		mutations,
		commands,
		testCommands,
		bundledTestCommands,
		selfTestCommands,
		unattributedTestCommands,
		specReads,
		mutationsAfterLastCommand: mutations > 0 && lastMutationSeq > lastCommandSeq ? 1 : 0,
		commandsAfterLastMutation: lastMutationSeq >= 0 && lastCommandSeq > lastMutationSeq ? lastCommandSeq - lastMutationSeq : 0,
		// Bundled-only ordering signal: EVERY command after the final mutation
		// was a bundled-suite run. This alone is NOT a "false green" - that
		// class requires the conjunction with the external verifier result
		// (valid verifier AND !passed), derived at analysis level; the field
		// is deliberately verifier-agnostic. On cart-promotions the bundled
		// suite misses 14/18 SPEC rules, so the signal marks reps whose only
		// post-edit verification was the weak suite.
		bundledOnlyAfterLastMutation:
			mutations > 0 && lastBundledTestSeq > lastMutationSeq && !nonBundledCommandAfterLastMutation,
		unverifiedFinalMutation: mutations > 0 && lastMutationSeq > lastCommandSeq,
		// Green-bundled signal: the FINAL bundled-only run after the last
		// mutation ENDED without error (paired by toolCallId, so a parallel
		// call's late end cannot shadow it). Ordering
		// (bundledOnlyAfterLastMutation) alone does not prove the suite
		// passed; the conjunction with a failing external verifier is the
		// false-green class.
		bundledGreenAfterLastMutation:
			mutations > 0 &&
			lastBundledTestSeq > lastMutationSeq &&
			lastBundledOnlyCallId != null &&
			bundledOnlyCalls.get(lastBundledOnlyCallId)?.ok === true,
	};
}
