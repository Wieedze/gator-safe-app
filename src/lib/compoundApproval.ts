import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex, type PublicClient } from 'viem'

// Anything above this is "standing" for our purposes — the compound agent pulls
// only harvested fees per cycle (a tiny fraction of maxUint256), so a real
// standing approval never needs topping up. Half of maxUint256 comfortably
// separates "approved once, unlimited-ish" from a bounded, spendable-down approval.
const STANDING_THRESHOLD = maxUint256 / 2n

/**
 * `increaseLiquidity` (the second half of a compound) pulls the harvested fees
 * from the Safe, which requires the Safe to have approved the PositionManager for
 * both pool tokens ahead of time — a plain ERC20 approval, not a delegation (the
 * Safe grants it directly; the agent never touches it). Without this, the compound
 * agent is not under-permissioned in a way the mandate can express — it simply
 * can't pull the fees, and `run-compound.ts` blocks and asks for this exact fix.
 *
 * Returns the pool tokens (of the ones passed) whose current Safe -> PositionManager
 * allowance is not yet standing.
 */
export async function checkCompoundApprovals(
  client: PublicClient,
  safeAddress: Address,
  positionManager: Address,
  tokens: Address[],
): Promise<Address[]> {
  const missing: Address[] = []
  for (const token of tokens) {
    const allowance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [safeAddress, positionManager],
    })
    if (allowance < STANDING_THRESHOLD) missing.push(token)
  }
  return missing
}

export interface ApprovalTx {
  to: Address
  value: '0'
  data: Hex
}

/**
 * One `approve(positionManager, maxUint256)` per token — sent directly by the Safe
 * (via `sdk.txs.send`, its normal multisig transaction flow), not signed as a
 * delegation. Unlimited rather than fee-sized because fee amounts are unknown at
 * setup time and vary every cycle; re-approving before each compound would just
 * add gas and a race with the agent's own timing.
 */
export function buildCompoundApprovalTxs(positionManager: Address, tokens: Address[]): ApprovalTx[] {
  return tokens.map((token) => ({
    to: token,
    value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [positionManager, maxUint256] }),
  }))
}
