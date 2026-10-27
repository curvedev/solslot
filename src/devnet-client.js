import { devnetConnection } from './devnet-rpc.js';
import { planGameAction, prepareDevnetTransaction, signAndSendDevnet, publicDevnetConfig, readPlayerSnapshot } from './solana-game.js';
import { planDevnetSpin } from './devnet-spin.js';
import { standardWallets, watchStandardWallets } from './wallet-discovery.js';
import { connectStandardDevnetWallet } from './standard-devnet-wallet.js';
const c = devnetConnection();
const $ = id => document.getElementById(id);
let config = null, provider = null, prepared = null, busy = false, removeWalletListeners = () => {}, selectedStandardWallet = null;
let pendingReceipt = null;
const receiptKey = () => config && provider?.publicKey ? `solpot:devnet:${config.gameProgram}:${config.mint}:${provider.publicKey.toBase58()}` : null;
function saveReceipt(value, key = receiptKey()) {
  if (!key) throw Error('Wallet context changed; reconnect before signing');
  try { if(value) localStorage.setItem(key,JSON.stringify(value)); else localStorage.removeItem(key); }
  catch { throw Error('Transaction receipt storage is unavailable. Enable site storage before signing.'); }
  if (key === receiptKey()) pendingReceipt = value;
}
function showReceipt() {
  $('receipt').replaceChildren();
  if (!pendingReceipt) return;
  const link = document.createElement('a');link.textContent = 'Check submitted devnet transaction';link.href = 'https://explorer.solana.com/tx/'+pendingReceipt.signature+'?cluster=devnet';link.target='_blank';link.rel='noopener noreferrer';$('receipt').append(link);
}
function restoreReceipt() {
  pendingReceipt = null;
  try { const saved = JSON.parse(localStorage.getItem(receiptKey()) || 'null'); if(saved && typeof saved.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(saved.signature) && Number.isSafeInteger(saved.lastValidBlockHeight)) pendingReceipt=saved; } catch {}
  showReceipt();
}
const units = (value, decimals) => { const scale = 10n ** BigInt(decimals); const whole = value / scale, rest = (value % scale).toString().padStart(decimals,'0').replace(/0+$/,''); return whole.toLocaleString('en-US')+(rest?'.'+rest:''); };
function clearSnapshot() { for(const id of ['chain-pot','chain-balance','chain-prepaid','chain-rewards','chain-burned']) $(id).textContent='—'; $('chain-pending').textContent='Load configuration and connect to read the game.'; $('chain-status').textContent='No current wallet data loaded.'; }
async function refreshSnapshot() {
  if (!config || !provider?.publicKey) return;
  const chosen = provider.publicKey.toBase58(), selectedConfig = config;
  const a = await readPlayerSnapshot(c,config,provider.publicKey), s=a.state,p=a.playerState;
  if(config!==selectedConfig || provider?.publicKey?.toBase58()!==chosen)return;
  $('chain-pot').textContent=units(s.pot+(s.pending?.lockedPot??0n),9)+' SOL';
  $('chain-balance').textContent=units(a.balance,6)+' $SOLPOT';
  $('chain-prepaid').textContent=String((p?.prepaid??0n)/s.entry);
  $('chain-rewards').textContent=units(p?.tokenRewards??0n,6)+' $SOLPOT + '+units(p?.solRewards??0n,9)+' SOL';
  $('chain-burned').textContent=units(s.burned,6)+' $SOLPOT';
  $('chain-pending').textContent=s.pending ? `Spin #${s.pending.nonce} is pending for ${s.pending.player.toBase58()}. Resume settlement of this request; do not start another spin.` : s.closed ? 'Game is closed. Claims and unused-credit refunds remain available.' : 'No spin pending.';
  $('chain-status').textContent=`Confirmed on devnet at slot ${a.slot}. Global burns and your wallet balances are read from the program.`;
}
function invalidate() { prepared = null; $('review').hidden = true; $('sign').disabled = true; }
function refresh() { $('prepare').disabled = busy || !config || !provider?.publicKey || Boolean(pendingReceipt); $('refresh-chain').disabled=busy || !config || !provider?.publicKey; $('check-receipt').disabled=busy || !pendingReceipt; $('disconnect').disabled = busy || !provider; for (const id of ['phantom','solflare','config-file','load-config','action','count']) $(id).disabled = busy; for (const button of $('standard-wallets').children) button.disabled = busy; $('pack-label').hidden = $('action').value !== 'buy'; }
function message(text) { $('status').textContent = text; }
async function run(fn) { if (busy) return; busy = true; refresh(); try { await fn(); } catch (e) { invalidate(); message(String(e.message || 'Action failed').slice(0,400)); } finally { busy = false; refresh(); } }
async function loadConfig(value) {
  invalidate(); clearSnapshot(); config = null; pendingReceipt = null; showReceipt();
  config = publicDevnetConfig(value);
  restoreReceipt(); await refreshSnapshot();
  $('config-status').textContent = 'Devnet game '+config.gameProgram+'. Account identities will be verified on chain before each action.';
  message('Connect the matching devnet wallet, then choose an action.');
}
$('load-config').addEventListener('click',()=>run(async()=>{
  const response=await fetch('./devnet-config.json',{cache:'no-store'});
  if(!response.ok)throw Error('The deployed test configuration is not available in this build yet.');
  const text=await response.text();if(text.length>20000)throw Error('Configuration is too large');
  await loadConfig(JSON.parse(text));
}));
$('config-file').addEventListener('change', () => run(async () => {
  invalidate(); clearSnapshot(); config = null;
  const file = $('config-file').files?.[0]; if (!file || file.size > 20000) throw Error('Choose a small public configuration JSON file');
  await loadConfig(JSON.parse(await file.text()));
}));
function resetWallet() { removeWalletListeners(); removeWalletListeners = () => {}; provider?.dispose?.(); provider = null; selectedStandardWallet = null; pendingReceipt=null; invalidate(); clearSnapshot(); $('wallet-status').textContent = 'No wallet connected.'; showReceipt(); refresh(); }
function attachWallet(p, wallet = null) {
  resetWallet(); provider = p; selectedStandardWallet = wallet;
  const changed = () => { if (provider !== p) return; invalidate(); clearSnapshot(); restoreReceipt(); $('wallet-status').textContent = p.publicKey?.toBase58() || 'Disconnected. Reconnect your wallet.'; refresh(); refreshSnapshot().catch(e=>{$('chain-status').textContent=e.message;}); };
  const disconnected = () => { if (provider === p) resetWallet(); };
  if (p.subscribe) removeWalletListeners = p.subscribe(changed);
  else {
    p.on?.('accountChanged', changed); p.on?.('disconnect', disconnected);
    removeWalletListeners = () => { p.removeListener?.('accountChanged', changed); p.removeListener?.('disconnect', disconnected); };
  }
  changed(); message('Wallet connected. No transaction has been signed.');
}
function refreshStandardWallets() {
  const wallets = standardWallets();
  if (selectedStandardWallet && !wallets.includes(selectedStandardWallet)) resetWallet();
  $('standard-wallets').replaceChildren(...wallets.map(wallet => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Connect ' + wallet.name; button.disabled = busy;
    button.addEventListener('click', () => run(async () => {
      const previous = provider; resetWallet(); await previous?.disconnect?.();
      const adapter = await connectStandardDevnetWallet(wallet); attachWallet(adapter, wallet);
    })); return button;
  }));
  $('standard-wallet-note').textContent = wallets.length ? 'Wallet Standard connections use devnet and request a signature only after review.' : 'No Solana wallet detected. Open this page in your wallet’s browser and enable this site in the extension.';
}
for (const id of ['phantom','solflare']) $(id).addEventListener('click', () => run(async () => {
  const p = id === 'phantom' ? window.phantom?.solana : window.solflare;
  if (!p?.connect || !p?.signTransaction) throw Error('This wallet extension is not available');
  const previous = provider; resetWallet(); await previous?.disconnect?.();
  await p.connect(); attachWallet(p);
}));
$('disconnect').addEventListener('click', () => run(async () => { const p = provider; resetWallet(); await p?.disconnect?.(); }));
for (const id of ['action','count']) $(id).addEventListener('change', () => { invalidate(); refresh(); });
$('prepare').addEventListener('click', () => run(async () => {
  if(pendingReceipt)throw Error('Resolve the previous receipt before preparing another action');
  invalidate(); message('Checking devnet identities and simulating…');
  const action=$('action').value, selectedConfig=config, selectedProvider=provider, wallet=provider.publicKey;
  const plan = ['commit','settle'].includes(action) ? await planDevnetSpin(c,config,wallet,action) : await planGameAction(c, config, wallet, action, Number($('count').value));
  const draft = await prepareDevnetTransaction(c, wallet, plan.ixs);
  if(config!==selectedConfig || provider!==selectedProvider || !provider?.publicKey?.equals(wallet))throw Error('Wallet or configuration changed; prepare again');
  prepared = draft; prepared.wallet = wallet;
  $('details').textContent = JSON.stringify({ ...plan.summary, baseFeeLamports: prepared.baseFeeLamports, note: plan.summary.note + ' Account deposits may also be required. Your wallet shows the final transaction.' }, null, 2);
  $('review').hidden = false; $('sign').disabled = false; message('Simulation passed. Review the addresses before signing.');
}));
$('sign').addEventListener('click', () => run(async () => {
  const reviewed = prepared, storageKey = receiptKey(); if (!reviewed) throw Error('Prepare a new transaction first'); $('sign').disabled = true;
  message('Approve this test transaction in your wallet.');
  const signature = await signAndSendDevnet(c, provider, reviewed, reviewed.wallet, submitted => {
    saveReceipt({signature:submitted,lastValidBlockHeight:reviewed.latest.lastValidBlockHeight},storageKey);showReceipt();
  });
  saveReceipt(null,storageKey); if(storageKey!==receiptKey())return; invalidate(); await refreshSnapshot(); message('Confirmed on Solana devnet.');
  const link = document.createElement('a'); link.textContent = 'View confirmed devnet transaction'; link.href = 'https://explorer.solana.com/tx/' + signature + '?cluster=devnet'; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('receipt').replaceChildren(link);
}));
$('refresh-chain').addEventListener('click',()=>run(refreshSnapshot));
$('check-receipt').addEventListener('click',()=>run(async()=>{
  if(!pendingReceipt)return;
  const receipt=pendingReceipt, storageKey=receiptKey();
  const result=(await c.getSignatureStatuses([receipt.signature],{searchTransactionHistory:true})).value[0];
  if(storageKey!==receiptKey() || receipt!==pendingReceipt)return;
  if(result && ['confirmed','finalized'].includes(result.confirmationStatus)) { saveReceipt(null);await refreshSnapshot();message(result.err?'The submitted transaction failed. Refresh and prepare a new action.':'The submitted transaction is confirmed. Balances refreshed.'); }
  else if(!result && await c.getBlockHeight('finalized')>receipt.lastValidBlockHeight) {if(storageKey!==receiptKey() || receipt!==pendingReceipt)return;saveReceipt(null);await refreshSnapshot();message('The transaction expired with no recorded confirmation. Balances refreshed; prepare again if needed.');}
  else message('Confirmation is still pending. Keep this receipt and check again; no transaction has been resubmitted.');
}));
watchStandardWallets(refreshStandardWallets); refreshStandardWallets(); refresh();
