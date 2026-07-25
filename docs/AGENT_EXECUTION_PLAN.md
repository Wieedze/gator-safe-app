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
Host is **0G Tapp** (decided 2026-07-25). Phase 0 is the check that it holds, not a
comparison: deploy a hello-world and verify (a) `GetSecretResource` yields a usable key,
(b) the derived address is **identical after a redeploy**, (c) `GetEvidence` returns
attestation. (b) is the one that can kill it — the mandate is signed to that address.
If it fails, fall back to self-hosted; phases 1–2 are unaffected either way.

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
