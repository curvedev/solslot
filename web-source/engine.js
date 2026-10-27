import { OUTCOMES, classifyOutcome } from './outcomes.js';
export { OUTCOMES, classifyOutcome } from './outcomes.js';
const fullBackDemo = typeof document !== 'undefined' && document.body?.dataset.entryTokens === '50000' && document.body?.dataset.consolationTokens === '50000';
export const RULES = Object.freeze({ odds: 100, entry: fullBackDemo ? 50000 : 200000, consolationReward: fullBackDemo ? 50000 : 100000, consolationChance: .2, startingBalance: 10000000, startingPot: 12.5 });
export const FEE_RULES = Object.freeze({ source: 'pump.fun creator fees actually received', jackpotShareBps: 9000, treasuryShareBps: 1000 });

export function splitCreatorFees(receipts) {
  if (!Number.isFinite(receipts) || receipts < 0 || receipts > 1000000) throw new Error('Invalid simulated creator fee receipts.');
  return { total: receipts, pool: receipts * .9, creator: receipts * .1 };
}

export function addCreatorFees(state, receipts) {
  if (state.pending) throw new Error('A draw is already in progress.');
  const split = splitCreatorFees(receipts);
  return { ...state, pot: state.pot + split.pool, fees: state.fees + split.pool, creatorFees: state.creatorFees + split.creator, receivedCreatorFees: (state.receivedCreatorFees ?? 0) + receipts };
}

// Rejection sampling removes modulo bias for any supported range.
export function secureInt(max, source = globalThis.crypto) {
  if (!Number.isInteger(max) || max < 1 || max > 0xffffffff) throw new RangeError('Invalid random range.');
  if (!source?.getRandomValues) throw new Error('Secure randomness is unavailable.');
  const range = 0x100000000;
  const limit = range - (range % max);
  const word = new Uint32Array(1);
  do { source.getRandomValues(word); } while (word[0] >= limit);
  return word[0] % max;
}

export function initialState() {
  return { balance: RULES.startingBalance, prepaid: 0, pot: RULES.startingPot, held: 0, pending: null, claimable: 0, claimed: 0, burned: 0, paid: 0, fees: 0, creatorFees: 0, receivedCreatorFees: 0, draws: [] };
}

export function buyPrepaid(state, count) {
  if (state.pending) throw new Error('Wait for the current spin to settle.');
  if (![1, 5, 10].includes(count) || state.prepaid + count > 10) throw new Error('Choose 1, 5 or 10 spins, with at most 10 unused credits.');
  if (state.balance < count * RULES.entry) throw new Error('Not enough demo tokens for this pack.');
  return { ...state, balance: state.balance - count * RULES.entry, prepaid: state.prepaid + count };
}

export function withdrawPrepaid(state) {
  if (state.pending) throw new Error('Wait for the current spin to settle.');
  if (!state.prepaid) throw new Error('No unused prepaid credits to return.');
  return { ...state, balance: state.balance + state.prepaid * RULES.entry, prepaid: 0 };
}

export function beginPlay(state, draw = secureInt) {
  if (state.pending) throw new Error('A draw is already in progress.');
  if (state.balance < RULES.entry && !state.prepaid) throw new Error('Not enough demo $SLOT. Claim rewards or reset the playground to refill.');
  if (state.pot <= 0) throw new Error('The jackpot is empty. Add simulated creator fees before playing.');
  const number = draw(OUTCOMES.total) + 1;
  const { tier, symbol } = classifyOutcome(number);
  const won = tier === 'jackpot';
  const reward = tier === 'consolation' ? RULES.consolationReward : 0;
  const payout = won ? state.pot : 0;
  const pending = Object.freeze({ id: state.draws.length + 1, number, tier, symbol, won, entry: RULES.entry, burn: RULES.entry - reward, reward, potBefore: state.pot, payout });
  return { ...state, balance: state.balance - (state.prepaid ? 0 : RULES.entry), prepaid: Math.max(0, state.prepaid - 1), held: RULES.entry, pending };
}

export function settlePlay(state) {
  const result = state.pending;
  if (!result || state.held !== result.entry) throw new Error('No pending draw to settle.');
  return { ...state, pending: null, held: 0, pot: result.won ? 0 : state.pot, burned: state.burned + result.burn, claimable: state.claimable + result.reward, paid: state.paid + result.payout, draws: [...state.draws, result] };
}

export function claimRewards(state) {
  if (state.pending) throw new Error('Wait for the current spin to settle before claiming.');
  if (state.claimable <= 0) throw new Error('No rewards to claim yet.');
  return { ...state, balance: state.balance + state.claimable, claimed: state.claimed + state.claimable, claimable: 0 };
}

export function play(state, draw = secureInt) {
  return settlePlay(beginPlay(state, draw));
}

export function chanceAtLeastOne(odds, attempts) {
  return -Math.expm1(attempts * Math.log1p(-1 / odds));
}

export function simulate({ odds, attempts, startingPot, dailyFees, trials = 1000 }, draw = secureInt) {
  if (![50, 100].includes(odds) || !Number.isInteger(attempts) || attempts < 1 || attempts > 1000 || !Number.isInteger(trials) || trials < 1 || trials > 1000 || !Number.isFinite(startingPot) || startingPot < 0 || !Number.isFinite(dailyFees) || dailyFees < 0) throw new Error('Invalid simulation settings.');
  let wins = 0, totalPayout = 0, totalRemaining = 0, dryScenarios = 0;
  for (let i = 0; i < trials; i++) {
    let pot = startingPot;
    let scenarioWins = 0;
    for (let j = 0; j < attempts; j++) {
      pot += dailyFees / attempts;
      if (draw(odds) === 0) { wins++; scenarioWins++; totalPayout += pot; pot = 0; }
    }
    totalRemaining += pot;
    if (!scenarioWins) dryScenarios++;
  }
  return { odds, averageWins: wins / trials, averagePayout: totalPayout / trials, averageRemaining: totalRemaining / trials, noWinnerPercent: 100 * dryScenarios / trials, trials };
}
