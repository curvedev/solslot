export const PRICE_URL = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';
export const PRICE_FRESH_MS = 120000;
export const PRICE_EXPIRES_MS = 300000;

export function parsePrice(body, receivedAt = Date.now()) {
  const data = body?.data;
  const usd = typeof data?.amount === 'string' && data.amount.trim() ? Number(data.amount) : NaN;
  if (data?.base !== 'SOL' || data?.currency !== 'USD' || !Number.isFinite(usd) || usd <= 0 || !Number.isFinite(receivedAt)) throw new Error('Invalid SOL/USD quote.');
  return Object.freeze({ usd, receivedAt });
}

export function quoteStatus(quote, now = Date.now()) {
  if (!quote || !Number.isFinite(quote.usd) || quote.usd <= 0 || !Number.isFinite(now) || !Number.isFinite(quote.receivedAt)) return 'unavailable';
  const age = now - quote.receivedAt;
  if (age < 0 || age > PRICE_EXPIRES_MS) return 'unavailable';
  return age <= PRICE_FRESH_MS ? 'live' : 'delayed';
}

export function dollarValue(eth, quote, now = Date.now()) {
  if (quoteStatus(quote, now) === 'unavailable') return null;
  const value = eth * quote.usd;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export const formatUSD = value => value === null ? 'USD unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);

export async function fetchPrice(fetcher = globalThis.fetch, now = Date.now) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(PRICE_URL, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) throw new Error('SOL/USD quote unavailable.');
    return parsePrice(await response.json(), now());
  } finally { clearTimeout(timer); }
}
