/**
 * SPEC-faithful cart-promotions reference sources and the violating-mutant
 * catalog, shared by the verifier-attribution suite and the verification-
 * signal characterization. Each mutant is one plausible wrong rule applied to
 * PROMO_REF; every mutant must be rejected by the external verifier.
 */

export const NL = String.fromCharCode(92) + "n";
const Q3 = String.fromCharCode(34).repeat(3);

export const PROMO_REF = `${Q3}Promotions per SPEC.md.${Q3}
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP


class PromotionError(ValueError):
    pass


@dataclass(frozen=True)
class PromotionLine:
    description: str
    discount_cents: int


@dataclass(frozen=True)
class PromotionResult:
    lines: list
    total_discount_cents: int


def _round_half_up(value):
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def percentage_discount(cart, percent):
    if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not (0 < percent <= 100):
        raise PromotionError("percent must be in (0, 100]")
    total = 0
    for item in cart.items():
        line_total = item.unit_price_cents * item.quantity
        total += _round_half_up(line_total * percent / 100)
    return total


def buy_x_get_y_free(cart, sku, x, y):
    if not isinstance(x, int) or not isinstance(y, int) or x < 1 or y < 1:
        raise PromotionError("x and y must be >= 1")
    for item in cart.items():
        if item.sku == sku:
            groups = item.quantity // (x + y)
            return groups * y * item.unit_price_cents
    return 0


def apply_promotions(cart, promotions):
    percent_count = sum(1 for kind, *_ in promotions if kind == "percent")
    if percent_count > 1:
        raise PromotionError("percentage promotions are exclusive")
    lines = []
    total = 0
    for promo in promotions:
        kind = promo[0]
        if kind == "percent":
            d = percentage_discount(cart, promo[1])
            desc = f"{promo[1]}% OFF"
        else:
            _, sku, x, y = promo
            d = buy_x_get_y_free(cart, sku, x, y)
            desc = f"BOGO {sku} ({x}+{y})"
        lines.append((desc, d))
        total += d
    total = min(total, cart.subtotal_cents())
    return PromotionResult([PromotionLine(desc, d) for desc, d in lines], total)
`;

export const RECEIPT_REF = `${Q3}Receipts per SPEC.md.${Q3}
from cart import Cart
import promotions as promotions_mod


def format_receipt(cart):
    lines = ["RECEIPT"]
    for item in cart.items():
        line_total = item.unit_price_cents * item.quantity
        lines.append(f"{item.name} x{item.quantity} @{item.unit_price_cents}c = {line_total}c")
    lines.append(f"SUBTOTAL: {cart.subtotal_cents()}c")
    return "${NL}".join(lines)


def format_receipt_with_promotions(cart, promotions):
    result = promotions_mod.apply_promotions(cart, promotions)
    lines = ["RECEIPT"]
    for item in cart.items():
        line_total = item.unit_price_cents * item.quantity
        lines.append(f"{item.name} x{item.quantity} @{item.unit_price_cents}c = {line_total}c")
    lines.append(f"SUBTOTAL: {cart.subtotal_cents()}c")
    if promotions:
        lines.append("PROMOTIONS")
        for line in result.lines:
            lines.append(f"{line.description}: -{line.discount_cents}c")
    lines.append(f"TOTAL: {cart.subtotal_cents() - result.total_discount_cents}c")
    return "${NL}".join(lines)
`;

/** name -> one plausible wrong rule. */
export const MUTANTS: Record<string, readonly [find: string, replace: string]> = {
	rounds_half_down: ["ROUND_HALF_UP", "ROUND_HALF_DOWN"],
	rounds_once_per_cart: [
		`    total = 0
    for item in cart.items():
        line_total = item.unit_price_cents * item.quantity
        total += _round_half_up(line_total * percent / 100)
    return total`,
		`    line_total = sum(i.unit_price_cents * i.quantity for i in cart.items())
    return _round_half_up(line_total * percent / 100)`,
	],
	percent_100_rejected: ["not (0 < percent <= 100)", "not (0 < percent < 100)"],
	bogo_remainder_discounted: ["groups = item.quantity // (x + y)", "groups = -(-item.quantity // (x + y))"],
	bogo_y_unvalidated: ["or not isinstance(y, int) or x < 1 or y < 1", "or not isinstance(x, int) or x < 1"],
	bogo_y_lt1_unvalidated: ["or x < 1 or y < 1", "or x < 1"],
	discount_cap_missing: ["total = min(total, cart.subtotal_cents())", "pass"],
	str_percent_coerced: [
		'if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not (0 < percent <= 100):\n        raise PromotionError("percent must be in (0, 100]")',
		'if isinstance(percent, str):\n        percent = 10\n    if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not (0 < percent <= 100):\n        raise PromotionError("percent must be in (0, 100]")',
	],
	none_percent_skips_discount: [
		'if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not (0 < percent <= 100):\n        raise PromotionError("percent must be in (0, 100]")',
		"if percent is None:\n        return 0\n    if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not (0 < percent <= 100):\n        raise PromotionError",
	],
	percent_zero_accepted: ["not (0 < percent <= 100)", "not (percent < 0)"],
	percent_over_100_accepted: ["not (0 < percent <= 100)", "not (0 < percent)"],
	float_percent_rejected: ["(int, float)", "int"],
	empty_cart_crashes: [
		"    total = 0\n    for item in cart.items():",
		"    total = sum(cart.items()[0].unit_price_cents for _ in [0])\n    for item in cart.items():",
	],
	unknown_sku_discounts_first_line: ["        if item.sku == sku:", "        if True:"],
	bogo_x_unvalidated: ["or x < 1 or y < 1", "or y < 1"],
	exclusivity_dropped: [
		'if percent_count > 1:\n        raise PromotionError("percentage promotions are exclusive")',
		"pass",
	],
	error_not_value_error: ["class PromotionError(ValueError):", "class PromotionError(Exception):"],
	empty_promotions_nonzero_total: [
		"return PromotionResult([PromotionLine(desc, d) for desc, d in lines], total)",
		"return PromotionResult([PromotionLine(desc, d) for desc, d in lines], total or -1)",
	],
};

export function applyMutation([find, replace]: readonly [string, string]): string {
	if (!PROMO_REF.includes(find)) throw new Error(`anchor not found: ${find.slice(0, 50)}...`);
	return PROMO_REF.replace(find, replace);
}
