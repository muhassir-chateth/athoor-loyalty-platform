# FUTURE REQUIREMENT — refund-driven points clawback (NOT in the current release)

**Status: recorded only. Deliberately NOT implemented.** Recorded on the owner's explicit
instruction during the portal completion run, with the equally explicit instruction that it
must not be mixed into the current release unless separately approved.

## The requirement, as stated

When a customer earns points from a purchase and subsequently redeems those points, a
later return or refund of that purchase must not let the customer retain the benefit
improperly. Design a **30-day refund-eligibility window** so that qualifying returned
purchases automatically trigger the appropriate points reversal / clawback against the
customer's overall points balance and against the original points transaction.

## Why it is not a small change

Recorded so the eventual estimate is not made from the one-line summary. None of this is
a design decision — these are the questions a design has to answer.

1. **The points may already be spent.** Clawback can drive a balance negative. The
   existing ledger has `refund_clawback` and `cancellation_clawback` reasons already, so
   the reversal vocabulary exists, but "what happens when the balance cannot absorb it"
   is a policy question, not a technical one: allow a negative balance, clamp at zero and
   absorb the loss, or block the refund.
2. **A redemption may already have been issued as a discount code.** If points became a
   reward that was issued, reversing the points does not reverse the code. Whether the
   code is voided is a separate decision with its own customer-facing consequence.
3. **Partial refunds.** A refund of two items out of five is not a full reversal, so the
   clawback has to be proportional to the refunded value, which requires knowing which
   line items earned which points.
4. **The 30-day window needs a defined start.** Order creation, fulfilment, or delivery
   are all defensible and give materially different outcomes.
5. **Idempotency.** Shopify can deliver a refund webhook more than once; the clawback must
   be keyed so a repeat delivery cannot double-debit.
6. **Tier side effects.** If a clawback drops a customer below a tier threshold, whether
   tier is recomputed and whether entitlements already used are revoked is undecided.
7. **Audit.** `admin_audit_log` has a CHECK constraint on `operation_type`; a new
   operation type means a migration that swaps that constraint, as migration 22 already
   did once.

## Explicitly out of scope for the current release

No schema, service, webhook, portal or theme change for this requirement is part of the
current release. The portal ships without it.
