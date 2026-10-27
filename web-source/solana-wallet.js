// Read-only injected-wallet connection. No signing or transaction API is used.
import { standardWallets, watchStandardWallets, connectStandardAddress } from './wallet-discovery.js';
export function getSolanaProviders(scope = globalThis) {
  return [
    { id: 'phantom', provider: scope.phantom?.solana ?? (scope.solana?.isPhantom ? scope.solana : null) },
    { id: 'solflare', provider: scope.solflare?.isSolflare ? scope.solflare : null },
  ];
}

export function initSolanaWallet() {
  const $ = id => document.getElementById(id);
  let current = null, pending = false, removeListeners = () => {};
  const reset = () => {
    removeListeners(); removeListeners = () => {}; current?.dispose?.(); current = null;
    $('wallet-label').textContent = 'Connect wallet';
    $('disconnect-button').hidden = true;
  };
  const showAccount = publicKey => {
    const address = publicKey?.toBase58?.() ?? publicKey?.toString?.();
    if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) { reset(); return; }
    $('wallet-label').textContent = `${address.slice(0, 4)}…${address.slice(-4)}`;
    $('wallet-status').textContent = 'Solana address connected. All game balances remain simulated.';
    $('disconnect-button').hidden = false;
  };
  function refreshProviders() {
    for (const { id, provider } of getSolanaProviders()) {
      $(id + '-hint').textContent = provider ? 'Connect ↗' : 'Not detected';
      $(id + '-connect').disabled = pending || !provider;
    }
    const wallets = standardWallets();
    $('standard-wallets').replaceChildren(...wallets.map(wallet => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'provider-button'; button.disabled = pending;
      const name = document.createElement('span'); name.className = 'wallet-name'; name.textContent = wallet.name;
      const hint = document.createElement('span'); hint.className = 'wallet-hint'; hint.textContent = 'Wallet Standard ↗';
      button.append(name, hint); button.addEventListener('click', () => connectStandard(wallet)); return button;
    }));
    $('standard-wallet-note').textContent = wallets.length ? 'Compatible wallets detected above. Choose the wallet you trust.' : 'No Solana wallet detected. Open this page in your wallet’s browser and enable access to this site.';
  }
  async function connectStandard(wallet) {
    if (pending) return;
    pending = true; refreshProviders();
    $('wallet-status').textContent = 'Approve public-address access in your wallet. No signature or payment is requested.';
    try {
      const connection = await connectStandardAddress(wallet, { chain: null });
      reset(); current = connection;
      const changed = () => showAccount(connection.account?.address);
      removeListeners = connection.subscribe(changed); changed();
    } catch (error) { $('wallet-status').textContent = String(error.message || 'Connection was not completed.').slice(0, 250); }
    finally { pending = false; refreshProviders(); }
  }
  $('wallet-button').addEventListener('click', () => { refreshProviders(); $('wallet-dialog').showModal(); });
  for (const id of ['phantom', 'solflare']) $(id + '-connect').addEventListener('click', async () => {
    if (pending) return;
    const provider = getSolanaProviders().find(p => p.id === id)?.provider;
    if (!provider) return;
    pending = true; refreshProviders();
    $('wallet-status').textContent = 'Approve the address connection in your wallet. No signature or payment is requested.';
    try {
      const result = await provider.connect();
      reset(); current = provider;
      const changed = key => showAccount(key);
      const disconnected = () => reset();
      provider.on?.('accountChanged', changed); provider.on?.('disconnect', disconnected);
      removeListeners = () => { provider.removeListener?.('accountChanged', changed); provider.removeListener?.('disconnect', disconnected); };
      showAccount(result?.publicKey ?? provider.publicKey);
    } catch { $('wallet-status').textContent = 'Connection was not completed. The demo is still available.'; }
    finally { pending = false; refreshProviders(); }
  });
  $('disconnect-button').addEventListener('click', async () => {
    if (pending) return;
    const provider = current; reset();
    try { await provider?.disconnect(); } catch { /* Local connection is already cleared. */ }
    $('wallet-status').textContent = 'Disconnected from this preview.';
  });
  watchStandardWallets(() => {
    if (current?.wallet && !standardWallets().includes(current.wallet)) reset();
    refreshProviders();
  });
  $('wallet-rescan').onclick = refreshProviders;
  window.addEventListener('focus', refreshProviders);
  refreshProviders();
}
