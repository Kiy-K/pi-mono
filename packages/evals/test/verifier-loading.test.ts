import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Verifier module loading must tolerate submissions that use
 * `from __future__ import annotations` with @dataclass: dataclasses resolves
 * cls.__module__ through sys.modules, so a verifier that execs modules
 * without registering them crashes with AttributeError before printing its
 * JSON verdict (observed live: cart-promotions A/B rep 1, both arms). Every
 * verifier's load() must register sys.modules[name] before exec_module.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");

const FUTURE_ANNOTATIONS_STUB = `"""Promotion engine per SPEC.md."""
from __future__ import annotations
from dataclasses import dataclass
from cart import Cart


class PromotionError(ValueError):
    pass


@dataclass(frozen=True)
class PromotionLine:
    description: str
    discount_cents: int


@dataclass(frozen=True)
class PromotionResult:
    lines: list[PromotionLine]
    total_discount_cents: int


def percentage_discount(cart, percent):
    raise NotImplementedError


def buy_x_get_y_free(cart, sku, x, y):
    raise NotImplementedError


def apply_promotions(cart, promotions):
    raise NotImplementedError
`;

describe("verifier module loading", () => {
	it("cart-promotions verifier reports a JSON verdict for a future-annotations dataclass submission", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-verifier-loading-"));
		try {
			for (const name of ["cart.py", "receipt.py", "test_cart.py", "test_promotions.py"]) {
				await copyFile(join(packageRoot, "diagnostics", "tasks", "cart-promotions", name), join(root, name));
			}
			await writeFile(join(root, "promotions.py"), FUTURE_ANNOTATIONS_STUB);
			// The stub fails its checks, so the verifier exits 1; a caught
			// rejection is expected - the verdict is in stdout either way.
			const { stdout } = await execFileAsync(
				process.platform === "win32" ? "python" : "python3",
				[join(packageRoot, "diagnostics", "verifiers", "cart-promotions.py"), root],
				{ timeout: 30_000 },
			).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
			const payload = JSON.parse(stdout.trim()) as { passed: boolean; tests: number; failures: string[] };
			// The stub must be evaluated (checks run and fail), not crash the verifier.
			expect(payload.passed).toBe(false);
			expect(payload.tests).toBeGreaterThan(0);
			expect(payload.failures.length).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
