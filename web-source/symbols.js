import { classifyOutcome } from './outcomes.js';
// User-selected reel artwork. Index 0 is always the gold Solana jackpot symbol.
// Transparent square images work best. The symbol at index 0 is the win symbol.
export const SYMBOLS = Object.freeze([
  { id: 'jackpot', label: 'Solana', text: '◎', color: '#f2b400', image: './assets/optimized/solana.webp' },
  { id: 'pepe', label: 'Pepe', text: 'P', color: '#52823a', image: './assets/optimized/pepe.webp' },
  { id: 'bitcoin', label: 'Bitcoin', text: '₿', color: '#f7931a', image: './assets/reels/bitcoin.svg' },
  { id: 'pumpfun', label: 'pump.fun', text: 'P', color: '#5fcb88', image: './assets/reels/pumpfun.svg' },
  { id: 'doge', label: 'Doge', text: 'D', color: '#bb944e', image: './assets/optimized/doge.webp' },
]);

// The reels reveal one uniform draw, not three independent draws.
// Every triple is a prize. Mixed losses exclude triples and double Solana symbols.
const losses = [];
for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) {
  if (!(a === b && b === c) && [a, b, c].filter(n => n === 0).length < 2) losses.push([a, b, c]);
}
export function outcomeSymbols(number) {
  const { tier, symbol } = classifyOutcome(number);
  return tier !== 'loss' ? [symbol, symbol, symbol] : [...losses[(number * 37) % losses.length]];
}
