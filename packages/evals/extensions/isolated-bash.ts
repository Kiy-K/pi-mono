import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { createIsolatedBashOperations } from "../src/tool-isolation.ts";

export default function isolatedBash(pi: ExtensionAPI): void {
	pi.registerTool({
		...createBashTool(process.cwd(), {
			operations: createIsolatedBashOperations(),
			exposeSessionEnvironment: false,
		}),
		label: "bash (eval sandbox)",
	});
}
