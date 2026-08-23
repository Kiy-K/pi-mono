import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/matching-engine.py.
 *
 * Audit history: the verifier originally had no same-price FIFO scenario at
 * all — a matching-order time-priority inversion survived every check and the
 * public suite when only equal-price resting SELLS were involved (the lone
 * public FIFO test rested two buys). The named check 'same-price orders fill
 * in arrival order on both sides' was added; this suite pins the reference
 * implementation and the side-specific inversion mutants so the hole cannot
 * reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "matching-engine");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "matching-engine.py");

const REFERENCE = `"""Matching engine per SPEC.md."""
import itertools


class Order:
    def __init__(self, order_id, side, price, qty):
        self.order_id = order_id
        self.side = side
        self.price = price
        self.qty = qty

    def __eq__(self, other):
        return isinstance(other, Order) and (self.order_id, self.side, self.price, self.qty) == (
            other.order_id, other.side, other.price, other.qty)

    def __repr__(self):
        return f"Order({self.order_id},{self.side!r},{self.price},{self.qty})"


class Trade:
    def __init__(self, buy_id, sell_id, price, qty):
        self.buy_id = buy_id
        self.sell_id = sell_id
        self.price = price
        self.qty = qty

    def __eq__(self, other):
        return isinstance(other, Trade) and (self.buy_id, self.sell_id, self.price, self.qty) == (
            other.buy_id, other.sell_id, other.price, other.qty)

    def __repr__(self):
        return f"Trade({self.buy_id},{self.sell_id},{self.price},{self.qty})"


class MatchingEngine:
    def __init__(self):
        self._orders = {}
        self._bids = {}
        self._asks = {}
        self._seq = itertools.count()

    def submit(self, order):
        if order.price < 1 or order.qty < 1:
            raise ValueError("price and qty must be >= 1")
        if order.order_id in self._orders:
            raise ValueError("duplicate order id")
        trades = []
        book = self._bids if order.side == "buy" else self._asks
        opposing = self._asks if order.side == "buy" else self._bids
        remaining = order.qty
        opp_side = "sell" if order.side == "buy" else "buy"
        while remaining > 0:
            best = None
            for oid, o in opposing.items():
                if o["qty"] <= 0:
                    continue
                if order.side == "buy" and o["price"] > order.price:
                    continue
                if order.side == "sell" and o["price"] < order.price:
                    continue
                if best is None or (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"]):
                    best = (oid, o)
            if best is None:
                break
            oid, o = best
            fill = min(remaining, o["qty"])
            trades.append(Trade(order.order_id if order.side == "buy" else oid,
                                oid if order.side == "buy" else order.order_id,
                                o["price"], fill))
            o["qty"] -= fill
            remaining -= fill
            if o["qty"] == 0:
                del opposing[oid]
        if remaining > 0:
            self._orders[order.order_id] = {"side": order.side, "price": order.price,
                                            "qty": remaining, "seq": next(self._seq)}
            book[order.order_id] = self._orders[order.order_id]
        return trades

    def cancel(self, order_id):
        o = self._orders.get(order_id)
        if o is None or o["qty"] <= 0:
            return False
        o["qty"] = 0
        del self._orders[order_id]
        self._bids.pop(order_id, None)
        self._asks.pop(order_id, None)
        return True

    def book(self):
        bids = [Order(oid, "buy", o["price"], o["qty"])
                for oid, o in sorted(self._bids.items(), key=lambda kv: (-kv[1]["price"], kv[1]["seq"]))
                if o["qty"] > 0]
        asks = [Order(oid, "sell", o["price"], o["qty"])
                for oid, o in sorted(self._asks.items(), key=lambda kv: (kv[1]["price"], kv[1]["seq"]))
                if o["qty"] > 0]
        return bids, asks

    def state(self):
        return sum(1 for o in self._orders.values() if o["qty"] > 0)
`;

/** Invert time priority for one aggressor side only. */
function sideInversion(aggressor: "buy" | "sell"): string {
	const find = 'if best is None or (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"]):';
	const replace =
		aggressor === "buy"
			? `if best is None or (order.side == "${aggressor}" and [o["price"], -o["seq"]] < [best[1]["price"], -best[1]["seq"]]) or (order.side != "${aggressor}" and (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"])):\n                    best = (oid, o)`
			: `if best is None or (order.side == "${aggressor}" and [o["price"], -o["seq"]] < [best[1]["price"], -best[1]["seq"]]) or (order.side != "${aggressor}" and (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"])):\n                    best = (oid, o)`;
	if (!REFERENCE.includes(find)) throw new Error("comparator anchor missing");
	return REFERENCE.replace(find, `${replace}`);
}

/** name -> mutated engine source. */
const MUTANTS: Record<string, () => string> = {
	sell_side_fifo_inverted: () => sideInversion("buy"),
	buy_side_fifo_inverted: () => sideInversion("sell"),
	trade_at_aggressor_price: () =>
		applyFindReplace(
			REFERENCE,
			'                                o["price"], fill))',
			"                                order.price, fill))",
		),
	no_crossing_check: () =>
		applyFindReplace(
			REFERENCE,
			'                if order.side == "buy" and o["price"] > order.price:\n                    continue',
			"                pass",
		),
	buy_book_sorted_ascending: () =>
		applyFindReplace(
			REFERENCE,
			'key=lambda kv: (-kv[1]["price"], kv[1]["seq"])',
			'key=lambda kv: (kv[1]["price"], kv[1]["seq"])',
		),
	wrong_bound_message: () =>
		applyFindReplace(
			REFERENCE,
			'raise ValueError("price and qty must be >= 1")',
			'raise ValueError("invalid order")',
		),
	cancel_not_reusable: () =>
		applyFindReplace(
			REFERENCE,
			'        o["qty"] = 0\n        del self._orders[order_id]\n',
			'        o["qty"] = 0\n',
		),
	duplicate_check_removed: () =>
		applyFindReplace(
			REFERENCE,
			'        if order.order_id in self._orders:\n            raise ValueError("duplicate order id")\n',
			"",
		),
};

function applyFindReplace(source: string, find: string, replace: string): string {
	if (!source.includes(find)) throw new Error(`anchor not found: ${find.slice(0, 50)}...`);
	return source.replace(find, replace);
}

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(engineSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-matchingengine-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_engine.py"), join(root, "test_engine.py")),
			writeFile(join(root, "engine.py"), engineSource),
		]);
		// Purge __pycache__: importlib caches .pyc by mtime+size and same-size
		// mutants written quickly could otherwise validate stale bytecode.
		await rm(join(root, "__pycache__"), { recursive: true, force: true });
		// The verifier exits non-zero when checks fail; a caught mutant is an
		// expected rejection, so parse stdout instead of treating exit 1 as error.
		const { stdout } = await execFileAsync(
			process.platform === "win32" ? "python" : "python3",
			[verifierPath, root],
			{
				timeout: 30_000,
			},
		).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
		const payload = JSON.parse(stdout.trim()) as VerifierResult;
		return Array.isArray(payload?.failures) ? payload : { passed: false, tests: 0, failures: [stdout] };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function namedChecks(result: VerifierResult): string[] {
	return [
		...new Set(
			result.failures
				.filter((failure) => !failure.startsWith("test_engine."))
				.map((failure) => failure.split(":")[0]),
		),
	];
}

describe("matching-engine verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it.each([["sell_side_fifo_inverted"], ["buy_side_fifo_inverted"]])(
		`catches %s via the both-sides FIFO check`,
		async (name) => {
			const result = await runVerifier(MUTANTS[name]());
			expect(result.passed).toBe(false);
			expect(namedChecks(result), `${name} must be caught by the FIFO check`).toContain(
				"same-price orders fill in arrival order on both sides",
			);
		},
	);

	for (const [name, build] of Object.entries(MUTANTS)) {
		if (name.endsWith("fifo_inverted")) continue;
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier(build());
			expect(result.passed).toBe(false);
			expect(
				namedChecks(result).length + result.failures.filter((f) => f.startsWith("test_engine.")).length,
			).toBeGreaterThan(0);
		});
	}
});
