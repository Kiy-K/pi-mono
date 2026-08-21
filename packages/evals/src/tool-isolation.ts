import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function killProcessGroup(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

export function createIsolatedBashOperations(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			const workspace = await realpath(cwd);
			if (!(await stat(workspace)).isDirectory()) {
				throw new Error("Working directory is not a directory: " + cwd);
			}

			// The workspace is bind-mounted at its own real path so the sandbox
			// reports the same absolute paths the read/edit/write tools use.
			// Remapping it to a fixed path (e.g. /tmp/workspace) makes bash output
			// disagree with the file tools' path namespace: agents then hand the
			// write tool sandbox-internal paths and the edits land outside the
			// workspace on the host, invisible to both bash and verifiers.
			const args = ["--ro-bind", "/", "/"];
			for (const hiddenPath of ["/home", "/root", "/run/user", "/tmp"]) {
				if (existsSync(hiddenPath)) args.push("--tmpfs", hiddenPath);
			}
			args.push(
				"--bind",
				workspace,
				workspace,
				"--chdir",
				workspace,
				"--unshare-net",
				"--unshare-pid",
				"--unshare-uts",
				"--unshare-ipc",
				"--unshare-cgroup-try",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--clearenv",
				"--setenv",
				"HOME",
				"/tmp/home",
				"--setenv",
				"TMPDIR",
				"/tmp",
				"--setenv",
				"PATH",
				SANDBOX_PATH,
				"--dir",
				"/tmp/home",
				"--new-session",
				"--die-with-parent",
				"--",
				"/bin/bash",
				"-c",
				command,
			);

			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const child = spawn("bwrap", args, {
					cwd: "/",
					detached: true,
					env: { PATH: SANDBOX_PATH },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				const abort = () => killProcessGroup(child.pid);

				if (timeout !== undefined) {
					if (!Number.isFinite(timeout) || timeout <= 0) {
						killProcessGroup(child.pid);
						reject(new Error("Invalid timeout: must be a finite number of seconds"));
						return;
					}
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						abort();
					}, timeout * 1000);
				}

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.once("error", reject);
				signal?.addEventListener("abort", abort, { once: true });
				child.once("close", (exitCode) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", abort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode });
				});
			});
		},
	};
}

export async function probeToolIsolation(cwd: string): Promise<void> {
	const output: Buffer[] = [];
	const { exitCode } = await createIsolatedBashOperations().exec(
		[
			'test -w "$PWD"',
			'test -z "$(find /home /root -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)"',
			'! env | grep -Eq "(_TOKEN|_KEY|_SECRET|AUTH|CREDENTIAL)"',
			'test "$(tail -n +2 /proc/net/route | wc -l)" -eq 0',
			"printf probe > .pi-isolation-probe",
			"rm .pi-isolation-probe",
		].join(" && "),
		cwd,
		{ onData: (chunk) => output.push(chunk), timeout: 10 },
	);
	if (exitCode !== 0) {
		throw new Error(`Eval isolation probe failed with exit code ${exitCode}: ${Buffer.concat(output).toString()}`);
	}

	// The sandbox must report the workspace at the same absolute path the
	// read/edit/write tools use, so file paths printed by bash resolve
	// identically outside the sandbox. Verified from the outside instead of
	// interpolating the path into the probe command.
	const pwdOutput: Buffer[] = [];
	const pwd = await createIsolatedBashOperations().exec("pwd", cwd, {
		onData: (chunk) => pwdOutput.push(chunk),
		timeout: 10,
	});
	const sandboxCwd = Buffer.concat(pwdOutput).toString().trim();
	const expectedCwd = await realpath(cwd);
	if (pwd.exitCode !== 0 || sandboxCwd !== expectedCwd) {
		throw new Error(
			"Eval isolation probe: sandbox cwd " + sandboxCwd + " does not match the real workspace path " + expectedCwd,
		);
	}
}
