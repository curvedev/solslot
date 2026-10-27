// A single uniform draw selects a mutually exclusive prize tier.
export const OUTCOMES = Object.freeze({ total: 400, jackpotCount: 4, consolationPerSymbol: 20, consolationCount: 80 });

export function classifyOutcome(number) {
  if (!Number.isInteger(number) || number < 1 || number > OUTCOMES.total) throw new RangeError('Invalid draw result.');
  if (number <= OUTCOMES.jackpotCount) return { tier: 'jackpot', symbol: 0 };
  const offset = number - OUTCOMES.jackpotCount - 1;
  if (offset < OUTCOMES.consolationCount) return { tier: 'consolation', symbol: 1 + Math.floor(offset / OUTCOMES.consolationPerSymbol) };
  return { tier: 'loss', symbol: null };
}
