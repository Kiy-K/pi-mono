import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createIsolatedBashOperations, probeToolIsolation } from "../src/tool-isolation.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("exposes only the writable workspace with no ambient environment or network route", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-eval-isolation-test-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const hostMarker = join(root, "host-only");
	await mkdir(workspace);
	await writeFile(hostMarker, "secret\n");

	const chunks: Buffer[] = [];
	const result = await createIsolatedBashOperations().exec(
		[
			'test "$PWD" = /tmp/workspace',
			'test ! -e "$HOST_MARKER"',
			"! env | grep -q '^PI_EVAL_SECRET_MARKER='",
			'test "$(tail -n +2 /proc/net/route | wc -l)" -eq 0',
			"printf isolated > result.txt",
			'printf "%s" "$PWD"',
		].join(" && "),
		workspace,
		{
			onData: (chunk) => chunks.push(chunk),
			env: { ...process.env, HOST_MARKER: hostMarker, PI_EVAL_SECRET_MARKER: "secret" },
		},
	);

	const output = Buffer.concat(chunks).toString();
	expect(result.exitCode, output).toBe(0);
	expect(output).toBe("/tmp/workspace");
	expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("isolated");
	await expect(readFile(hostMarker, "utf8")).resolves.toBe("secret\n");
	await expect(probeToolIsolation(workspace)).resolves.toBeUndefined();
});
