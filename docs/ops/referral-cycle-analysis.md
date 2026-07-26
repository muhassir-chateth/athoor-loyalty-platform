# Referral cycles and collusion — analysis

Task 39, **investigation only**. No behaviour was changed, no schema was altered,
and no policy has been implemented. Staging data was read inside a
`BEGIN READ ONLY` transaction and rolled back.

Raised by the task 38 live verification, which found that customer A could submit
B's referral code and B could submit A's, with **both returning `rewarded`** and
each referrer credited +150.

Customers are referenced by Shopify id only.

---

## 1. What the model actually enforces today

Two different relations carry referral state, and this distinction drives
everything below.

| | `customers.referred_by` | `referrals` rows |
|---|---|---|
| Cardinality | **at most one per customer** (set once) | many per referrer, **and many per referred** |
| Set by | `recordReferralOnSignup` step 4, guarded `WHERE referred_by IS NULL AND id <> $2` | step 5 insert |
| Drives rewards? | **No** | **Yes** — the +150 and the +250 both hang off a `referrals` row |

Constraints confirmed live on `referrals`:

```
referrals_pkey             PRIMARY KEY (id)
referrals_check            CHECK ((referrer_id <> referred_id))
referrals_referrer_id_fkey FOREIGN KEY (referrer_id)  REFERENCES customers(id)
referrals_referred_id_fkey FOREIGN KEY (referred_id)  REFERENCES customers(id)
```

So the **only** structural guard is self-referral. There is no `UNIQUE
(referrer_id, referred_id)`.

Application guards, in full:

- `recordReferralOnSignup` rejects `referrerId === referredCustomerId` before any
  write (Req 11.8, Property 12).
- It returns `already_rewarded` when a row for **that exact pair** already exists
  and was signup-rewarded.
- `POST /v1/referral` refuses a claim once the claimant has any `earn_order`
  entry — the no-retro-attribution rule (spirit of Req 11.9).

Nothing else. In particular nothing looks at whether the claimant already has a
referrer, and nothing looks at the shape of the graph.

---

## 2. Every reachable scenario

Ordered by how cheap it is to exploit, which is not the order they were found in.

### S1 — Multi-claim: one account enriches unlimited referrers ⚠️ **cheapest attack**

**Not a cycle, and worse than every cycle below.** The dedupe key is the
*(referrer, referred)* pair, so a single new account can claim code after code:
each new referrer forms a new pair, inserts a new `referrals` row, and is credited
+150. `customers.referred_by` sticks at the first referrer — the guarded UPDATE
correctly does nothing on later claims — but **the reward is not gated on it.**

Cost to the attacker: one fresh account, zero purchases. Yield: 150 × N points
spread across N accomplices, plus the +250 stage to the *first* referrer once that
account makes one qualifying purchase.

*Status: established by reading `routes/referral.ts` and `referral.ts` — the
eligibility check is only `HAS_PAID_PURCHASE_SQL`, and the pair-existence check
cannot see a different referrer.* **Not live-verified**, unlike S2. It should be
confirmed with a throwaway trio before any fix is designed around it.

### S2 — Direct 2-cycle (A↔B) ✅ **live-verified**

A claims B's code, B claims A's. Both `rewarded`, both `referred_by` set to each
other, +150 each. Two accounts, no purchases, 300 points. Observed during the task
38 verification; the rows were cleaned up afterwards.

### S3 — Longer cycles (A→B→C→A)

Same mechanic, N accounts. Because `referred_by` holds at most one referrer, that
graph is **functional** — every node has out-degree ≤ 1 — so any cycle in it is a
simple disjoint cycle and detection is cheap and bounded. The `referrals` graph is
not functional, so a cycle there can coexist with S1 fan-out.

### S4 — Tree/chain collusion, no cycle at all

A refers B, B refers C, C refers D. No cycle exists, yet if all four are the same
person the payout is identical to S3. **No cycle policy addresses this**, which is
the strongest argument against treating "cycle" as the definition of the problem.

### S5 — Duplicate pair rows under concurrency

There is no `UNIQUE (referrer_id, referred_id)`. The pair-existence check and the
insert are a read-then-write inside one transaction, so under `READ COMMITTED` two
concurrent claims of the same code by the same claimant — using **two different
`Idempotency-Key` values**, so task 38's gate legitimately lets both through — can
both see no row and both insert, awarding +150 twice.

*Status: established from the schema and the code path; not reproduced.* Narrow
timing window, but it needs no accomplice at all.

### S6 — Self-referral

Blocked, twice: the application check and the DB `CHECK`. No action needed.

---

## 3. Staging data: clean

Queried live. Findings:

| Check | Result |
|---|---|
| `referrals` rows | **1** — referrer `9037455327431` → referred `9037455425735`, both stages rewarded, a legitimate task-25 test referral |
| Direct A↔B cycles in `referrals` | **0** |
| Direct cycles in `referred_by` | **0** |
| Cycles of any length in `referred_by` (recursive walk, depth ≤ 20) | **0** |
| Customers appearing as `referred_id` in more than one row (S1) | **0** |
| Duplicate `(referrer, referred)` pairs (S5) | **0** |
| `earn_referral` entries | 2, both to `9037455327431` (+150 signup, +250 first purchase) — consistent with the single row |

So **nothing needs remediating in staging**, and the S2 rows created during the
task 38 verification were fully removed. There is no production data yet — the
cutover has not run — so **no historical clean-up is implied by any option
below.** That materially lowers the cost of every option and is the single most
useful fact in this document: whatever policy is chosen can be enforced from day
one without a backfill.

---

## 4. Policy options

Complexity ratings are relative to each other, not absolute.

### Option A — Reject direct A↔B cycles

Refuse the claim when the referrer's own `referred_by` is the claimant.

- **Implementation: low.** One extra read in `recordReferralOnSignup`, inside the
  existing transaction; one new outcome status; one route mapping to a 409. The
  theme already handles unmapped errors with the neutral message, so the
  storefront needs no change to be safe, only to be *specific*.
- **Customer impact: low but asymmetric.** Only the *second* claimant is refused,
  which may be the entirely legitimate one — two genuine friends who each invited
  the other. They lose nothing (the claimant is never the one credited) but the
  friend they were trying to credit is.
- **Existing data: none affected.** Zero cycles exist.
- **Idempotency:** the 409 is a 4xx and therefore *cached* for the 24-hour window
  under that customer+route+key. Deterministic, so replaying it is correct — but
  if the policy is later relaxed, cached refusals linger up to 24h.
- **Clawbacks:** none needed; nothing was ever awarded.
- **Fraud review:** unchanged; refusals are invisible to it unless separately
  recorded.
- **Migration: none.**
- **Leaves open:** S1, S3, S4, S5 — i.e. most of the value.

### Option B — Reject cycles of any length

Walk `referred_by` from the prospective referrer; refuse if the claimant is
reachable.

- **Implementation: medium.** A bounded recursive CTE inside the claim
  transaction. Cheap on a functional graph and easy to bound (depth limit),
  but it is a read-then-write, so it carries the same TOCTOU shape as S5: two
  concurrent claims could each see no cycle and jointly create one. Closing that
  properly means locking the participants or accepting eventual detection.
- **Customer impact: low, with a genuine false-positive tail.** Extended families
  and friendship groups do form long chains; refusing the one claim that happens
  to close a loop will occasionally be wrong, and will be hard to explain.
- **Existing data: none affected.**
- **Idempotency / clawbacks / fraud review:** as Option A.
- **Migration:** none required. A depth cap is a policy constant, not schema.
- **Leaves open:** S1, S4, S5. **Note that S4 pays exactly as well as S3 and is
  untouched**, so B buys less than its cost suggests.

### Option C — Allow the relationship, suppress the reward

Record the `referrals` row, award nothing, tell the member the relationship was
recorded.

- **Implementation: medium, and it needs schema.** `signup_rewarded = false`
  cannot express "deliberately withheld", because the existing code treats a row
  with `signup_rewarded = false` as *pending* and will reward it on a later claim
  (`if (existingRow && !existingRow.signup_rewarded)` → marks it rewarded). So
  without a distinct suppression column, C silently converts into "rewarded
  later" — a trap worth naming.
- **Customer impact: poor.** The member is told their referral was accepted while
  their friend is never credited, with no explanation. Worse than an honest
  refusal.
- **Existing data: none affected.**
- **Idempotency:** the response is a 200, so it caches and replays normally.
- **Clawbacks:** none — nothing is paid. This is C's one real advantage: it
  cannot create a reward that later needs reversing.
- **Fraud review:** strong. Every suspicious relationship is preserved with its
  reason, which is exactly the input Req 10.6 wants.
- **Migration:** a new column (e.g. `reward_withheld_reason TEXT`), plus care that
  the existing "reward a pending row" path cannot pick these up.
- **Leaves open:** nothing structurally, but only for the shapes it is taught to
  suppress — the shape question is unchanged.

### Option D — Detect only, send to fraud review

Pay as today; surface cycles and fan-out on the admin fraud-review surface.

- **Implementation: low for detection, high for consequences.** The detection
  queries are written and validated (§3). But paying first means reversing later,
  and **there is no clawback path for `earn_referral`**: refunds claw back order
  earnings only. Reversal is a manual admin adjustment under Req 10.2, one
  customer at a time, each needing a 1–500 character reason.
- **Customer impact: none up front**, then the worst kind — points appear, get
  spent, and are later removed by hand. A member who has already redeemed a
  discount code cannot be cleanly unwound.
- **Existing data: none affected.**
- **Idempotency:** unchanged.
- **Clawbacks:** this is the option that *depends* on a mechanism the platform
  does not have.
- **Fraud review:** its whole point. `GET /v1/admin/fraud-review` already lists
  referrals, so the surface exists.
- **Migration:** none for detection; optionally a triage-state column.
- **Leaves open:** everything, by design — it is visibility, not prevention.

---

## 5. Recommendation

**Reframe the task, then adopt Option A plus a one-referrer-per-customer rule,
with Option D's detection layered on for the shapes that remain.**

Concretely, in priority order:

1. **Close S1 first — one accepted referral per customer, ever.** It is cheaper to
   exploit than any cycle (one account, no accomplice needed to *start*), it is
   unbounded in yield, and the fix is smaller than any cycle check: refuse the
   claim when the claimant already has a `referrals` row as `referred_id`, or
   already has `referred_by` set. This also happens to make S2 and S3 far harder,
   because every participant in a cycle must be someone's referred party.
   **This, not the cycle, is the finding that matters.**
2. **Add `UNIQUE (referrer_id, referred_id)` on `referrals`** to close S5 at the
   database rather than in application logic. Staging currently has zero duplicate
   pairs, so the migration is safe today — and it will not be safe forever, so it
   is worth doing before real data exists.
3. **Then Option A** for the direct A↔B case, which after step 1 is largely
   redundant but is cheap and makes the intent explicit.
4. **Option D for the rest** — longer cycles (S3) and collusive chains (S4) go to
   fraud review rather than being blocked.

Reasoning:

- **Cycles are the wrong abstraction.** S4 pays exactly as well as S3 and contains
  no cycle at all, so any policy defined in terms of cycles is defeated by
  re-drawing the same accounts as a chain. A rule about *how many referrals one
  account may benefit from* is the one that actually bounds the payout.
- **Option B's cost lands on legitimate members** while leaving the equally
  profitable S4 open. Poor trade.
- **Option C is user-hostile** for a marginal auditing gain over D, and carries a
  schema trap that would silently pay the reward anyway if implemented carelessly.
- **Option D alone is unsafe as a primary control** precisely because
  `earn_referral` has no clawback path. Paying first and reversing by hand is
  acceptable for the residual long-tail shapes; it is not acceptable as the only
  defence against an unbounded, zero-cost attack.
- **The timing is unusually favourable.** There is no production referral data, so
  enforcement can start clean with no backfill and no member ever losing points
  they already saw.

### If this is adopted, the implementation task should also

- Confirm S1 and S5 live on throwaway customers first — S1 is currently a
  code-reading conclusion, and a fix designed around an unverified mechanism is a
  guess.
- Add a property test beside Property 12 stating the invariant chosen (a natural
  candidate: *no customer is ever the `referred_id` of more than one rewarded
  referral*).
- Decide the storefront copy for the new refusal, and add it to the locale file
  and the claim flow's state map — the theme currently falls through to the
  neutral message, which is safe but unhelpful.
- Re-run the §3 queries before enforcing, in case data has been created since.

---

## 6. What this analysis did not do

- **No behaviour, schema, requirement or theme change.** Read-only throughout.
- **S1 and S5 were not reproduced live.** Both are conclusions from the schema and
  the code path; S2 is the only scenario with live evidence.
- **No judgement on whether the reward amounts themselves should change**, or on
  household/payment-instrument limits, which are a different class of control
  (they need identity signals the platform does not currently collect).
- **No fraud-review UI work assessed** beyond noting the surface exists.
