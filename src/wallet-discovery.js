import { getWallets } from '@wallet-standard/app';

export const DEVNET_CHAIN = 'solana:devnet';
const solanaChain = chain => typeof chain === 'string' && chain.startsWith('solana:');
export function supportsStandardConnection(wallet) {
  return wallet?.chains?.some(solanaChain)
    && typeof wallet.features?.['standard:connect']?.connect === 'function'
    && typeof wallet.features?.['standard:events']?.on === 'function';
}
export function standardWallets() { return getWallets().get().filter(supportsStandardConnection); }
export function watchStandardWallets(listener) {
  const registry = getWallets();
  const changes = new Map();
  const watch = wallet => {
    if (changes.has(wallet) || typeof wallet.features?.['standard:events']?.on !== 'function') return;
    changes.set(wallet, wallet.features['standard:events'].on('change', listener));
  };
  registry.get().forEach(watch);
  const offRegister = registry.on('register', (...wallets) => { wallets.forEach(watch); listener(); });
  const offUnregister = registry.on('unregister', (...wallets) => {
    wallets.forEach(wallet => { changes.get(wallet)?.(); changes.delete(wallet); }); listener();
  });
  return () => { offRegister(); offUnregister(); changes.forEach(off => off()); changes.clear(); };
}

// Older providers have no universal registry. Accept the Solana injection surface
// as a fallback; Wallet Standard remains the preferred, brand-independent path.
export function injectedWallets(scope = globalThis, wallets = standardWallets()) {
  const providers = [
    { name: 'Phantom', id: 'phantom', provider: scope.phantom?.solana },
    { name: 'Solflare', id: 'solflare', provider: scope.solflare },
    ...[...(Array.isArray(scope.solana?.providers) ? scope.solana.providers : []), scope.solana].map(provider => ({ provider })),
  ];
  const seen = new Set(), names = new Set(wallets.map(w => w.name?.toLowerCase()));
  return providers.flatMap(item => {
    const p = item.provider;
    if (!p || seen.has(p) || typeof p.connect !== 'function' || typeof p.signTransaction !== 'function') return [];
    seen.add(p);
    const name = item.name ?? (p.isPhantom ? 'Phantom' : p.isSolflare ? 'Solflare' : typeof p.name === 'string' && p.name ? p.name : 'Solana wallet');
    if (names.has(name.toLowerCase())) return [];
    return [{ ...item, name, id: item.id ?? (p.isPhantom ? 'phantom' : p.isSolflare ? 'solflare' : undefined) }];
  });
}

// This module only discovers wallets and requests public account access.
export async function connectStandardAddress(wallet, { chain = DEVNET_CHAIN } = {}) {
  if (!supportsStandardConnection(wallet)) throw Error('This wallet must support Solana connections and account-change events');
  await wallet.features['standard:connect'].connect();
  const available = () => supportsStandardConnection(wallet) ? (wallet.accounts ?? []).filter(a => chain
    ? wallet.chains.includes(chain) && a.chains?.includes(chain)
    : a.chains?.some(solanaChain)) : [];
  let selected = available()[0]?.address ?? null, active = true;
  const listeners = new Set();
  const account = () => active ? available().find(a => a.address === selected) ?? null : null;
  if (!account()) throw Error(chain==='solana:mainnet'?'Select Mainnet in your wallet’s network settings, then reconnect.': 'Select Devnet in your wallet’s network settings, save, then reconnect. This game does not use Mainnet or Testnet.');
  const off = wallet.features['standard:events'].on('change', () => {
    if (!account()) selected = null; // Reconnect explicitly if the approved account disappears.
    for (const listener of listeners) listener();
  });
  const dispose = () => { active = false; selected = null; off(); listeners.clear(); };
  return {
    wallet,
    get account() { return account(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose,
    async disconnect() { dispose(); await wallet.features['standard:disconnect']?.disconnect(); },
  };
}
