// Browser accounting model only. Production accounting must use integer wei.
export const GAS_RESERVE_USD = 2;
export const DEMO_BATCH_COST_USD = 0.10;
export function initialTreasury() { return { available: 0, reserve: 0, seeded: 0, gross: 0, spent: 0, paid: 0, batches: 0 }; }
function amount(value) { if (!Number.isFinite(value) || value < 0) throw new Error('Invalid SOL amount.'); }
export function creditCreator(treasury, eth) {
  amount(eth);
  return { ...treasury, available: treasury.available + eth, gross: treasury.gross + eth };
}
export function seedGas(treasury, eth) {
  amount(eth);
  if (treasury.seeded > 0 || eth === 0) throw new Error('The demo gas seed must be funded once.');
  return { ...treasury, reserve: treasury.reserve + eth, seeded: eth };
}
export function settleCreator(treasury, { gasCost, reserveTarget }) {
  amount(gasCost); amount(reserveTarget);
  if (treasury.available <= 0) throw new Error('No new creator fees to settle.');
  const total = treasury.available + treasury.reserve;
  // Leave both the estimated transaction cost and the full next-batch reserve funded.
  if (total < gasCost + reserveTarget) throw new Error('Creator funds are too low for this cost and the next gas reserve. Fees stay held.');
  return { ...treasury, available: 0, reserve: reserveTarget, spent: treasury.spent + gasCost, paid: treasury.paid + total - gasCost - reserveTarget, batches: treasury.batches + 1 };
}
