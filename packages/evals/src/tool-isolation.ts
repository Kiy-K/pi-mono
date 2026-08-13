import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SANDBOX_CWD = "/tmp/workspace";

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
			if (!(await stat(workspace)).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);

			const args = ["--ro-bind", "/", "/"];
			for (const hiddenPath of ["/home", "/root", "/run/user", "/tmp"]) {
				if (existsSync(hiddenPath)) args.push("--tmpfs", hiddenPath);
			}
			args.push(
				"--dir",
				SANDBOX_CWD,
				"--bind",
				workspace,
				SANDBOX_CWD,
				"--chdir",
				SANDBOX_CWD,
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
			`test "$PWD" = ${SANDBOX_CWD}`,
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
}
