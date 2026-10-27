// A single serialized worker retries only the already accepted on-chain request.
// It never purchases entries, chooses outcomes, or substitutes a new oracle seed.
export function createSettlementRecovery({ recover, intervalMs = 5000, maxBackoffMs = 60000, timers = globalThis, now = Date.now } = {}) {
  if (typeof recover !== 'function') throw Error('A pending-settlement recovery function is required');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs) throw Error('Invalid settlement recovery interval');
  let timer = null, active = null, stopped = true, failures = 0;
  let status = { running: false, state: 'stopped', consecutiveFailures: 0, lastCheckedAt: null, lastSettledAt: null };
  function schedule(delay) {
    if (stopped || timer !== null) return;
    timer = timers.setTimeout(() => { timer = null; void tick(); }, delay);
    timer?.unref?.();
  }
  function tick() {
    if (active) return active;
    if (stopped) return Promise.resolve();
    active = (async () => {
      try {
        const result = await Promise.resolve().then(recover);
        failures = 0;
        status = { ...status, state: result?.settled ? 'settled' : 'idle', consecutiveFailures: 0, lastCheckedAt: now(), ...(result?.settled ? { lastSettledAt: now() } : {}) };
      } catch {
        failures += 1;
        // Do not expose provider errors, URLs, filesystem paths, or secrets.
        status = { ...status, state: 'retrying', consecutiveFailures: failures, lastCheckedAt: now() };
      } finally {
        active = null;
        if (stopped) status = { ...status, running: false, state: 'stopped' };
        else schedule(Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 10)));
      }
    })();
    return active;
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      status = { ...status, running: true, state: 'starting' };
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
      await active;
      status = { ...status, running: false, state: 'stopped' };
    },
    status: () => ({ ...status }),
  };
}
