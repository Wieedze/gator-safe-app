# Agent execution rail — implementation plan

**Scope: limit order only.** DCA is disconnected (`FUTURE.md`). Gas model is settled by
ADR 0007. This plan covers making a limit order run without the operator holding a key
or keeping a terminal open.

## What changes

Today the operator pastes an address they generated locally, then runs
`skills/hourglass-agent/scripts/run-limit-order.ts` and keeps the process alive.

After: the app provisions the agent, the operator signs and funds, the runtime polls
and fills. The manual path stays — it becomes one of two options, not the only one.

## Flow and states

```
draft ──▶ provisioned ──▶ signed ──▶ funded ──▶ watching ──▶ filled
          (agent addr)    (mandate    (agent     (runtime     (once,
                           on graph)   has gas)   polling)     limitedCalls(1))
```

| Transition | Trigger | Who acts |
|---|---|---|
| draft → provisioned | "Execute by an agent" | app → runtime |
| provisioned → signed | mandate signed to the agent address | operator (Safe, threshold) |
| signed → funded | ETH top-up to the agent wallet | operator (Safe, separate tx) |
| funded → watching | runtime starts | runtime |
| watching → filled | quote ≥ `minReceived` | runtime |

Two hard ordering constraints:

- **Provision before signing.** The mandate's delegate is the agent address; it must
  exist first.
- **Fund after signing, before watching.** ADR 0007. Its own Safe transaction — never
  bundled with the Permit2 "Enable trading" step.

## Needs

### App (`src/`)

- Mode selector in the Limit order tab: *run it myself* (current) / *delegate to an
  agent* (new). Manual mode unchanged.
- Provisioning call returning `{ agentAddress, runtimeRef }` — blocks until an address
  exists, surfaces failure.
- Agent address feeds the existing mandate build unchanged. It is already just the
  delegate; no change to terms, salt, caveats or the signing path.
- **Fund step** after signature: a Safe ETH transfer to `agentAddress`, its own
  transaction and its own consent. Suggested amount = one redeem + margin (ADR 0007 —
  the top-up size *is* the loss ceiling).
- **Balance gate**: `watching` is unreachable while the agent balance is zero. Replaces
  the local check the skill does today.
- Status surface per mandate, driven by the states above.

### Runtime

- Long-lived process executing the logic already in `run-limit-order.ts`: discover on
  Intuition by `delegationHash`, poll the Uniswap quote, redeem once when
  `quote.output ≥ minReceived`.
- Holds `AGENT_PRIVATE_KEY` and `UNISWAP_API_KEY`. **The Uniswap key is Hourglass's own,
  supplied to the runtime** — decided 2026-07-25. One shared key across mandates; its
  cost and rate limits are a later problem, explicitly not designed for here.
- Stable agent address across restarts and redeploys — the mandate is signed to it.
- **Dies on revocation.** Each poll iteration checks the mandate's disabled state on the
  `DelegationManager` before quoting. Disabled means the instance exits — it has nothing
  left it is allowed to do, and a redeem would revert with `CannotUseADisabledDelegation`
  anyway. No new surface: the runtime already talks to that contract.
- **No status endpoint.** The runtime is *triggered*, not polled: the app starts it and
  reads progress from what already exists — the mandate on Intuition, the fill on-chain.
  Decided 2026-07-25.

### Service boundary

Per `code.md`, the runtime host sits behind one service interface so the app never
depends on which host is chosen:

```ts
provision(chainId): Promise<{ agentAddress: Address; runtimeRef: string }>
start(runtimeRef, instruction): Promise<void>
status(runtimeRef): Promise<AgentState>
```

`0G Tapp` and `self-hosted` are two implementations. Phases 1–2 build against the
interface; phase 3 picks the host.

## Phases

**Phase 0 — validate the host (blocking, ~1 day).**
Host is **0G Tapp**, one app instance per mandate (see below). Deploy a hello-world and
verify:

- (a) `GetSecretResource` yields a usable signing key, and `GetEvidence` returns
  attestation binding it to the deployment.
- (b) **`stop_app` then `start_app` with the same `app_id` yields the same address.**
  This is the one that can kill it — see below.
- (c) What a host reboot does to a running app and its derived key. The README notes
  *"a VM reboot clears both the state and the RTMRs"* without saying what that means for
  the key.
- (d) The per-minute billing rate. **Informational only for the demo** — Hourglass pays
  the compute from its own 0G deposit, and a demo order fills in minutes. Priced here
  just so the multi-week idle case is a known number, not a surprise later.

Nothing here is verified yet; the address-stability reasoning is read off the README
(HKDF from the `app_id` namespace, "hardware-independent app secrets"), not measured.
If (b) fails, fall back to self-hosted; phases 1–2 are unaffected either way.

**Phase 1 — app surface, mocked runtime.**
Mode selector, provisioning call, fund step, balance gate, status display. Runtime
interface backed by a stub returning a local throwaway address. Ships and demos without
any host decision.

**Phase 2 — runtime process.**
Package `run-limit-order.ts` as a long-lived service against the interface. Status
reporting. Runs locally first.

**Phase 3 — 0G Tapp.**
Implement the interface against Tapp (`start-app`, `GetSecretResource`, `GetEvidence`).
Deploy. End-to-end on Base with a real mandate.

## One Tapp instance per mandate

`app_id` is deployer-assigned (`start_app.sh --app-id APP_ID`), not derived from the
compose hash — so we choose it. **One instance per mandate, keyed on the
`delegationHash`**, living exactly as long as its authorization: provisioned at
"execute with agent", it polls, fills once (`limitedCalls(1)`), and dies.

Why this shape:

- The runtime lifetime mirrors the mandate's on-chain authorization. Nothing outlives
  what it is allowed to do: it exits on fill, and on revocation.
- Each mandate has its own key and its own gas. No cross-mandate blast radius, and
  revocation is just letting the instance die.
- There is no redeploy in the flow — the address is read once at provisioning, signed
  into the mandate, used once.

**The cost this shape carries:** a limit order waits for its trigger price, possibly for
weeks, and the instance must survive that wait. So the risk is not redeploy stability,
it is **restart** stability plus **idle billing**. If the wait needs bounding, a
`TimestampEnforcer` on the mandate gives it a deadline (same primitive the abandonment
sweep needs, `FUTURE.md [COST]`).

Neither bites at demo scale: a demo order fills in minutes and Hourglass pays the
compute. Restart stability still gets measured in phase 0 because it is cheap to check
and expensive to discover later; idle billing is only priced, not solved.

## Trigger, not polling

The runtime starts on an explicit trigger, and the natural one is **the end of the
"execute with agent" signing step**. A manual re-trigger must also exist, and must work
**without a page reload** — a mandate signed in an earlier session has to be startable.

The Intuition indexing race the skill warns about (*"not found on Intuition yet"*) is
absorbed by the flow itself: the fund step sits between signing and starting, and takes
longer than indexing. No retry loop needed at the trigger.

## Open decisions

**Blocking phase 3:**

- **Tapp address stability** — phase 0 verifies it. If the derived address changes on
  redeploy, the host falls back to self-hosted, and Hourglass then holds the agent key
  — contradicting *"Hourglass never holds your keys"* in
  `skills/hourglass-agent/SKILL.md`. That contradiction needs its own ADR before
  shipping. It does not arise under Tapp.

**Non-blocking:**

- Gas residue has no return path — accepted for v1, deferred (`FUTURE.md [COST]`).

## Out of scope

- Relayers and gas abstraction (ADR 0007).
- DCA (`FUTURE.md [DCA]`).
- Agentic ID / ERC-8004 identity for the agent (`docs/0G-INTEGRATION-MAP.md`).
- Moving IPFS pinning to 0G Storage — breaks CID-based discovery
  (`docs/0G-INTEGRATION-MAP.md §2.4`).

## References

- ADR: `.claude/choices/0007-agent-gas-is-self-funded-post-signature.md`
- `docs/0G-INTEGRATION-MAP.md` — host options, what 0G does and does not cover
- `skills/hourglass-agent/SKILL.md`, `scripts/run-limit-order.ts` — the logic being hosted
- `FUTURE.md` — `[COST]` gas residue, `[DCA]` deferred rail
