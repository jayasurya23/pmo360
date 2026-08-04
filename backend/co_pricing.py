"""Change Order pricing: the PMO / admin cost adders, and how they stay hidden.

A change order carries two internal cost adders expressed as percentages of the
line-item subtotal. They are ADDITIVE on the base, never compounding — $100 with
a 5% PMO adder and a 5% admin adder is $110, not $110.25.

The client never learns they exist. There is no extra row on the deliverable, no
"project management" line, no percentage printed anywhere: the markup is folded
INTO the individual line costs. Which means the only thing standing between the
client and the secret is arithmetic — if the printed lines do not sum to the
printed total, the gap IS the disclosure. That is why `distribute_markup` uses
largest-remainder (Hamilton) apportionment instead of scaling each line and
rounding it independently: independent rounding drifts a cent or two across a
long CO, and the residual has nowhere to hide on a one-page table.

This module is the ONLY implementation of that apportionment. The React editor
shows base line items plus a breakdown and deliberately does not re-derive the
distribution in TypeScript — two implementations of a rounding rule will drift,
and the one that drifts is the one printed on a signed document.

Decimal, not float, for the arithmetic: this is client-facing money on a
contract. Every amount is converted through `str()` so 0.1 is 0.1 rather than
0.1000000000000000055, quantized to whole cents, and only widened back to float
at the boundary — the ORM columns, the Pydantic schemas and the JSON wire are
all float, and handing Decimal across that line would serialize as a string.
Cent counts stay exact integers throughout, so "the lines sum to the total" is a
statement about integers, not about floating point luck.
"""
from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal


def _dec(value) -> Decimal:
    """Widen to Decimal through str(), which is what keeps binary float noise
    out of the cents. None is 0 — a blank adder and a 0% adder mean the same."""
    if value is None:
        return Decimal(0)
    return Decimal(str(value))


def _factor(pmo_pct, admin_pct) -> Decimal:
    """1 + (pmo + admin)/100. Summing the percentages before applying them is
    what makes the adders additive rather than compounding."""
    return Decimal(1) + (_dec(pmo_pct) + _dec(admin_pct)) / Decimal(100)


def _cents(amount: Decimal) -> int:
    """Whole cents, ties away from zero — the invoicing convention, and
    symmetric for credits so a -$1.005 line rounds like a +$1.005 one."""
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _money(cents: int) -> float:
    return float(Decimal(cents) / 100)


def _apportion(ideals: Sequence[Decimal], target_cents: int) -> list[int]:
    """Largest-remainder (Hamilton): floor every ideal share, then hand the
    leftover cents out one at a time to the largest fractional parts.

    FLOOR, not truncation. On a credit line (-$100.005) truncation rounds toward
    zero and leaves a negative remainder, which breaks the ordering the method
    depends on. Flooring pins every remainder into [0, 1) whatever the sign, so
    one routine covers charges and credits and the leftover count is provably
    between 0 and len(ideals) whenever the caller derived `target_cents` from
    these same ideals — which both call sites below do.
    """
    floors = [i.to_integral_value(rounding=ROUND_FLOOR) for i in ideals]
    out = [int(f) for f in floors]
    leftover = target_cents - sum(out)
    if leftover:
        # Ties break on index, so the same CO prints the same cents every time
        # someone re-downloads it.
        order = sorted(
            range(len(ideals)), key=lambda k: (-(ideals[k] - floors[k]), k)
        )
        if leftover < 0:   # only reachable on a caller-supplied target
            order.reverse()
        step = 1 if leftover > 0 else -1
        for k in order[:abs(leftover)]:
            out[k] += step
    return out


def marked_up_total(base, pmo_pct, admin_pct) -> float:
    """What the client pays: the line-item subtotal plus both adders.

    This is the meaning of `change_orders.total_amount`, which the Proposals
    revised-contract-value rollup and the Dashboard CO card already read.
    """
    b = _dec(base)
    f = _factor(pmo_pct, admin_pct)
    if f == 1:
        # No adder set -> exact identity, deliberately without a re-quantize.
        # Every CO in the database has 0/0 the moment this ships, and rounding
        # here would let the feature nudge totals on change orders that were
        # already approved, signed and emailed.
        return float(b)
    # Quantize to whole cents BEFORE applying the factor, because callers hand
    # us a float sum of the line items and that sum arrives pre-drifted:
    # 4387.88 + 36521.92 is 40909.799999999996, not 40909.80. distribute_markup
    # sums the same lines as exact Decimals, so without this the two disagree
    # by a cent whenever the markup lands on an exact half-cent tie -- roughly
    # 1 CO in 590. The printed page was never at risk (its lines and its total
    # both come from distribute_markup), but the internal breakdown would sit a
    # cent under the total on the signed document, which reads as a bug in the
    # app and invites someone to go looking for why.
    return _money(_cents(Decimal(_cents(b)) / 100 * f))


def distribute_markup(line_amounts: Sequence, pmo_pct, admin_pct) -> list[float]:
    """Fold the adders into the line items: the marked-up per-line amounts,
    which sum EXACTLY to `marked_up_total(sum(line_amounts), ...)`.

    Empty input gives an empty list, which ties out against a $0 total. A base
    of zero needs no special case either: each line is scaled on its own rather
    than taken as a share of the subtotal, so there is no division to guard.
    """
    f = _factor(pmo_pct, admin_pct)
    if f == 1:
        # Byte-for-byte passthrough (str() round-trips a float exactly), NOT
        # round(x, 2) — see marked_up_total. This is the path every existing CO
        # takes, and it has to be incapable of changing a printed page.
        return [float(_dec(a)) for a in line_amounts]
    amounts = [_dec(a) for a in line_amounts]
    target = _cents(sum(amounts, Decimal(0)) * f)
    return [_money(c) for c in _apportion([a * f * 100 for a in amounts], target)]


def markup_breakdown(base, pmo_pct, admin_pct) -> dict[str, float]:
    """The INTERNAL view the app shows its own staff: base / PMO $ / admin $ /
    total, with the four guaranteed to add up on screen.

    The two dollar figures are apportioned against the total's residual rather
    than each rounded on its own, because a panel where 33.33 + 1.67 + 1.67 sits
    next to a total of 36.66 reads as a bug in the app rather than as rounding.

    `base` is a line-item subtotal, i.e. money, so quantizing it here is a no-op
    and `total_amount` below is the same value `marked_up_total` returns.
    """
    base_c = _cents(_dec(base))
    base_money = _money(base_c)
    total = marked_up_total(base_money, pmo_pct, admin_pct)
    pmo_c, admin_c = _apportion(
        [Decimal(base_c) * _dec(pmo_pct) / 100,
         Decimal(base_c) * _dec(admin_pct) / 100],
        _cents(_dec(total)) - base_c,
    )
    return {
        "base_amount": base_money,
        "pmo_amount": _money(pmo_c),
        "admin_amount": _money(admin_c),
        "total_amount": total,
    }
