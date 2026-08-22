import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiInvocation, MANDATED_EXTENSION_NAMES, resolveMandatedExtensionPaths } from "../scripts/diagnostics.mjs";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HERMETIC_FLAGS = [
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
	"--no-env",
	"--offline",
];

describe("mandated extension resolution", () => {
	it("returns exactly the mandated evaluator extensions, ignoring dummy ambient extensions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hermetic-ext-"));
		roots.push(root);
		const modules = join(root, "npm", "node_modules");
		await mkdir(join(modules, "pi-clinepass-provider"), { recursive: true });
		await mkdir(join(modules, "pi-fabric"), { recursive: true });
		// Dummy ambient extension + skill that must never be selected.
		await mkdir(join(modules, "pi-dummy-extension"), { recursive: true });
		await mkdir(join(root, "skills"), { recursive: true });
		await writeFile(join(root, "skills", "dummy-skill.md"), "skill content");

		const paths = resolveMandatedExtensionPaths(root);

		expect(paths).toEqual([join(modules, "pi-clinepass-provider"), join(modules, "pi-fabric")]);
		expect(paths).toHaveLength(MANDATED_EXTENSION_NAMES.length);
		for (const name of MANDATED_EXTENSION_NAMES) {
			expect(paths.some((p) => p.endsWith(join("node_modules", name)))).toBe(true);
		}
	});

	it("throws when a mandated extension is missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hermetic-ext-"));
		roots.push(root);
		await mkdir(join(root, "npm", "node_modules", "pi-clinepass-provider"), { recursive: true });
		expect(() => resolveMandatedExtensionPaths(root)).toThrow(/pi-fabric/);
	});
});

describe("hermetic invocation", () => {
	const base = {
		repository: "/tmp/repo",
		workspace: "/tmp/task",
		requiredExtensions: ["/tmp/clinepass", "/tmp/fabric"],
		model: "clinepass/deepseek-v4-flash",
		thinking: "low",
		prompt: "Fix the bug.",
	};

	it("blocks ambient extensions, skills, and config artifacts on every run", () => {
		const invocation = buildPiInvocation(base);

		for (const flag of HERMETIC_FLAGS) {
			expect(invocation.args).toContain(flag);
		}
		// Ambient environment keys are stripped (launcher --no-env), never inherited.
		expect(invocation.args).toContain("--no-env");
	});

	it("pins exactly the mandated extensions and no tools restriction", () => {
		const invocation = buildPiInvocation(base);

		expect(invocation.args.filter((arg) => arg === "--extension")).toHaveLength(2);
		expect(invocation.args).toContain("/tmp/clinepass");
		expect(invocation.args).toContain("/tmp/fabric");
		// Tools are left at default-builtin: no pruning that would disable fabric_exec.
		expect(invocation.args).not.toContain("--no-builtin-tools");
		expect(invocation.args).not.toContain("--tools");
	});

	it("applies identical extension lists to every invocation", () => {
		const shared = [...base.requiredExtensions, "/tmp/support/isolated-bash.ts"];
		const stock = buildPiInvocation({ ...base, requiredExtensions: shared });
		const improved = buildPiInvocation({ ...base, requiredExtensions: shared });

		// The isolation support extension is measurement infrastructure: it loads
		// on BOTH arms exactly once each, so args differ only by repository.
		expect(stock.args.filter((arg) => arg === "/tmp/support/isolated-bash.ts")).toHaveLength(1);
		expect(improved.args.filter((arg) => arg === "/tmp/support/isolated-bash.ts")).toHaveLength(1);
		expect(improved.args.filter((arg) => arg === "--extension")).toHaveLength(3);
	});

	it("is fully determined by its inputs, so dummy ambient config cannot change it", () => {
		const a = buildPiInvocation(base);
		const b = buildPiInvocation(base);

		expect(b.args).toEqual(a.args);
		expect(b.cwd).toBe(a.cwd);
		expect(b.command).toBe(a.command);
	});
});
