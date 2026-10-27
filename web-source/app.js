import { initSolanaWallet } from './solana-wallet.js';
import { initOddsLab } from './odds-lab.js';
import { RULES, FEE_RULES, splitCreatorFees, addCreatorFees, initialState, beginPlay, settlePlay, buyPrepaid, withdrawPrepaid, claimRewards, OUTCOMES, classifyOutcome, secureInt, chanceAtLeastOne, simulate } from './engine.js';
import { fetchPrice, quoteStatus, dollarValue, formatUSD } from './price.js';
import { GAS_RESERVE_USD, DEMO_BATCH_COST_USD, initialTreasury, creditCreator, seedGas, settleCreator } from './treasury.js';
import { SYMBOLS, outcomeSymbols } from './symbols.js';
import { createGameAudio } from './audio.js';
import { resultPresentation } from './presentation.js';
import { initPlaygroundLayout } from './layout.js';
const $ = (id) => document.getElementById(id);
let state = initialState();
let busy = false;
let selected = null;
let world = null;
const machineStyle = 'playground';
let selectedPack = 1, autoplay = false, autoplayTimer = null;
function stopAutoplay() { autoplay = false; clearTimeout(autoplayTimer); autoplayTimer = null; }
function canPlay() { return !busy && (state.prepaid > 0 || state.balance >= RULES.entry) && state.pot > 0; }
const gameAudio = createGameAudio({ onChange: renderAudio });
function renderAudio() {
  const s = gameAudio.status();
  $('music-toggle').setAttribute('aria-pressed', String(s.music));
  $('music-toggle').setAttribute('aria-label', s.playing ? 'Turn music off' : 'Turn music on');
  $('music-toggle').querySelector('span').textContent = s.playing ? 'Music on' : s.music ? 'Music paused' : 'Music off';
  $('effects-toggle').setAttribute('aria-pressed', String(s.effects));
  $('effects-toggle').setAttribute('aria-label', s.effects ? 'Turn sound effects off' : 'Turn sound effects on');
  $('effects-toggle').querySelector('span').textContent = s.effects ? 'Sound on' : 'Sound off';
  $('music-toggle').disabled = $('effects-toggle').disabled = !s.available;
  $('audio-status').textContent = s.available ? '' : 'Audio is unavailable in this browser. Gameplay is still available.';
}
$('music-toggle').addEventListener('click', () => { gameAudio.toggleMusic(); });
$('effects-toggle').addEventListener('click', () => { gameAudio.toggleEffects(); });
renderAudio();
function renderPresentationControls() {
  for (const button of document.querySelectorAll('[data-preview-result]')) button.disabled = busy;
}
let popupShowsRewards = false;
function presentResult(result, preview = false) {
  const card = resultPresentation(result,preview), dialog = $('outcome-dialog');
  if (dialog.open) dialog.close();
  dialog.dataset.tier = card.tier; dialog.dataset.preview = String(preview);
  for (const key of ['eyebrow','title','amount','detail']) $('outcome-'+key).textContent = card[key];
  const usd = result.won ? dollarValue(result.payout,quote) : null;
  $('outcome-usd').textContent = usd === null ? '' : `≈ ${formatUSD(usd)} · ${quoteStatus(quote) === 'live' && !quoteFailed ? 'live' : 'last'} SOL/USD quote`;
  $('outcome-action').textContent = card.action;
  popupShowsRewards = card.tier === 'consolation' && !preview;
  $('outcome-symbols').replaceChildren(...outcomeSymbols(result.number).map(index => { const img = document.createElement('img'); img.src = SYMBOLS[index].image; img.alt = ''; return img; }));
  const confetti = dialog.querySelector('.outcome-confetti'); confetti.replaceChildren();
  if (card.tier !== 'loss') for (let i=0;i<(card.tier==='jackpot'?32:14);i++) { const piece=document.createElement('i'); piece.style.setProperty('--x',((i*37)%100)+'%'); piece.style.setProperty('--delay',((i%8)*.055)+'s'); piece.style.setProperty('--twist',(i%2?1:-1)*260+'deg'); piece.style.setProperty('--drift',((i*13)%90-45)+'px'); confetti.append(piece); }
  dialog.showModal();
  gameAudio.stopSpin(); if (!preview) gameAudio.effect(card.tier);
}
$('outcome-action').addEventListener('click', () => { $('outcome-dialog').close(); if (popupShowsRewards) { location.hash = 'rewards'; navigate(); $('reward-panel').scrollIntoView({behavior:motionEnabled?'smooth':'instant',block:'center'}); if (!$('claim-rewards').disabled) $('claim-rewards').focus({preventScroll:true}); } });
$('outcome-dialog').addEventListener('click', event => { if (event.target === $('outcome-dialog')) $('outcome-dialog').close(); });
for (const button of document.querySelectorAll('[data-preview-result]')) button.addEventListener('click', () => {
  if (busy) return;
  const tier=button.dataset.previewResult, number=tier==='jackpot'?1:tier==='consolation'?5:85;
  const preview={number,won:tier==='jackpot',reward:tier==='consolation'?RULES.consolationReward:0,burn:tier==='consolation'?RULES.entry-RULES.consolationReward:RULES.entry,payout:tier==='jackpot'?state.pot:0,potBefore:state.pot};
  const ready=gameAudio.unlock(); presentResult(preview,true);
  ready.then(()=>{if($('outcome-dialog').open && $('outcome-dialog').dataset.tier === tier)gameAudio.effect(tier);});
});
document.addEventListener('visibilitychange', () => { gameAudio.setHidden(document.hidden); if (document.hidden) { stopAutoplay(); render(); } });
addEventListener('pagehide', event => { if (!event.persisted) gameAudio.dispose(); });
let treasury = initialTreasury();
let quote = null;
let priceBusy = false;
let quoteFailed = false;
function renderPrice() {
  const status = quoteStatus(quote);
  const delayed = status === 'delayed' || (quoteFailed && status === 'live');
  const usd = dollarValue(state.pot, quote);
  const label = usd === null ? 'USD UNAVAILABLE' : delayed ? 'LAST SOL/USD QUOTE' : 'LIVE SOL/USD';
  const display = usd === null ? '—' : formatUSD(usd);
  $('mobile-jackpot-usd').textContent = usd === null ? (priceBusy ? 'USD quote loading…' : 'USD unavailable') : `≈ ${display}`;
  $('price-status').textContent = usd === null ? (priceBusy ? 'Demo pool · loading SOL/USD quote' : 'Demo pool · USD quote unavailable; retrying automatically') : `Demo pool · ${delayed ? 'last quote' : 'live SOL/USD'} · Coinbase ${new Date(quote.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('machine-value-summary').textContent = `${sol(state.pot)} demo SOL jackpot. ${usd === null ? 'USD unavailable.' : `Approximately ${display}, using the ${delayed ? 'last available' : 'live'} SOL/USD quote.`}`;
  world?.setPot(state.pot, display, label);
}
function maybeSeedGas() {
  if (!treasury.seeded && quoteStatus(quote) === 'live' && !quoteFailed) {
    treasury = seedGas(treasury, GAS_RESERVE_USD / quote.usd);
    $('treasury-status').textContent = 'Initial $2 gas funding simulated. The gas reserve is separate from the prize.';
  }
}
async function refreshPrice() {
  if (priceBusy) return;
  priceBusy = true; renderPrice();
  try { quote = await fetchPrice(); quoteFailed = false; maybeSeedGas(); }
  catch { quoteFailed = true; }
  finally { priceBusy = false; render(); }
}
function renderTreasury() {
  for (const [id, amount] of [['available',treasury.available],['reserve',treasury.reserve],['spent',treasury.spent],['paid',treasury.paid]]) {
    const usd = dollarValue(amount, quote);
    $('creator-'+id).textContent = `${amount.toFixed(6)} SOL${usd === null ? '' : ' · ≈ '+formatUSD(usd)}`;
  }
  $('settle-creator').disabled = busy || treasury.available <= 0;
}
function settleCreatorFees() {
  if (busy) throw new Error('Wait for the spin to settle.');
  if (quoteStatus(quote) !== 'live' || quoteFailed) throw new Error('A fresh SOL/USD quote is needed. Creator fees stay held; the jackpot is unaffected.');
  const input = $('batch-cost');
  if (!input.value.trim() || !input.checkValidity()) throw new Error('Enter an example batch cost from $0 to $100.');
  const cost = Number(input.value);
  const previous = treasury.paid;
  treasury = settleCreator(treasury, { gasCost: cost / quote.usd, reserveTarget: GAS_RESERVE_USD / quote.usd });
  $('treasury-status').textContent = `Demo settlement: ${(treasury.paid-previous).toFixed(6)} SOL paid to the creator, ${formatUSD(cost)} example costs, and ≈ $2 retained in SOL. The jackpot was untouched.`;
  renderTreasury();
}
$('batch-cost').value = DEMO_BATCH_COST_USD.toFixed(2);
$('settle-creator').addEventListener('click', () => { try { settleCreatorFees(); } catch(error) { $('treasury-status').textContent = error.message; } });
let motionEnabled = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
const sol = (n) => n.toFixed(3);
const grid = $('number-grid');
for (let i = 1; i <= OUTCOMES.total; i++) {
  const cell = document.createElement('span');
  cell.className = 'number-cell' + (classifyOutcome(i).tier === 'jackpot' ? ' winning' : classifyOutcome(i).tier === 'consolation' ? ' consolation' : '');
  cell.textContent = String(i).padStart(2, '0');
  cell.dataset.number = i;
  cell.setAttribute('aria-hidden', 'true');
  grid.append(cell);
}
function render() {
  renderPresentationControls();
  $('mobile-jackpot').textContent = sol(state.pot);
  renderPrice();
  renderTreasury();
  world?.setEnabled(canPlay());
  $('balance').textContent = fmt(state.balance) + ' $SLOT';
  $('held-entry').hidden = !state.held;
  $('held-entry').textContent = `${fmt(state.held)} tokens held until this spin settles`;
  $('reward-balance').textContent = fmt(state.claimable);
  $('claim-rewards').disabled = busy || state.claimable === 0;
  $('claim-rewards').textContent = state.claimable ? `Claim ${fmt(state.claimable)} $SLOT ↗` : 'Nothing to claim yet';
  $('reward-claimed').textContent = `${fmt(state.claimed)} $SLOT claimed this session`;
  $('reward-panel').classList.toggle('has-rewards', state.claimable > 0);
  $('summary-claimable').textContent = fmt(state.claimable);
  $('summary-claim').disabled = busy || state.claimable === 0;
  $('summary-reward-note').textContent = state.claimable ? 'Matching rewards, ready for you.' : state.claimed ? `${fmt(state.claimed)} tokens claimed this session.` : 'Your matching triples collect here.';
  $('summary-sol-paid').textContent = sol(state.paid);
  for (const [id, value] of [['balance', state.balance], ['spins', state.draws.length], ['burned', state.burned], ['prepaid', state.prepaid]]) $('summary-' + id).textContent = fmt(value);
  $('fee-receipt').textContent = `Session fees: ${sol(state.fees)} SOL pool · ${sol(state.creatorFees)} SOL treasury gross`;
  $('round-label').textContent = 'DRAW ' + String(state.draws.length + 1).padStart(3, '0');
  $('session-totals').textContent = `${state.draws.length} ${state.draws.length === 1 ? 'spin' : 'spins'} · ${fmt(state.burned)} tokens burned`;
  $('total-burned').textContent = fmt(state.burned);
  $('machine-total-burned').textContent = fmt(state.burned);
  $('play-button').disabled = !canPlay() || (!state.prepaid && state.balance < selectedPack * RULES.entry);
  renderPacks();
  // Keep the same icon and two text lines while spinning so sizing stays stable.
  $('play-button').setAttribute('aria-busy', String(busy));
  $('spin-button-icon').textContent = busy ? '↻' : 'ϟ';
  $('spin-button-title').textContent = busy ? 'SPINNING…' : state.prepaid || selectedPack === 1 ? 'SPIN' : `BUY ${selectedPack} & SPIN`;
  $('spin-button-cost').textContent = busy ? `${fmt(RULES.entry)} tokens held` : state.prepaid ? 'Use 1 prepaid credit' : `${fmt(selectedPack * RULES.entry)} $SLOT`;
  $('add-fees').disabled = busy;
  $('reset-button').disabled = busy;
  $('result-box').classList.toggle('is-win', !busy && Boolean(state.draws.at(-1)?.won || state.draws.at(-1)?.reward));
  if (state.draws.length) $('activity-body').innerHTML = state.draws.slice(-50).reverse().map(r => `<tr><td class="mono">#${String(r.id).padStart(3, '0')}</td><td><span class="status-chip ${r.won || r.reward ? 'win' : ''}">${r.won ? 'Jackpot won' : r.reward ? SYMBOLS[r.symbol].label + ' triple' : 'No match'}</span></td><td class="mono">${String(r.number).padStart(2, '0')}</td><td>${fmt(r.burn)} $SLOT</td><td>${fmt(r.reward)} $SLOT</td><td class="mono">${sol(r.payout)} demo SOL</td></tr>`).join('');
  else $('activity-body').innerHTML = '<tr><td colspan="6" class="empty-state">Your first spin is waiting. Every result will appear here.</td></tr>';
}
function selectNumber(number) {
  selected?.classList.remove('selected');
  selected = grid.children[number - 1];
  selected?.classList.add('selected');
}
async function draw() {
  if (busy) throw new Error('A draw is already in progress.');
  busy = true;
  if ($('outcome-dialog').open) $('outcome-dialog').close();
  render();
  try {
    const audioReady = gameAudio.unlock();
    state = beginPlay(state);
    $('reward-status').textContent = '';
    const result = state.pending;
    audioReady.then(() => { if (state.pending?.id === result.id) gameAudio.effect('spin',motionEnabled); });
    render();
    $('result-title').textContent = 'Spinning… Your tokens are held.';
    $('result-detail').textContent = `${fmt(RULES.entry)} demo $SLOT held. Nothing is burned until the result settles.`;
    // The engine chooses the result once. A rendering failure never redraws it.
    try { await world?.spin(result,{onReelStop:index=>gameAudio.effect('reel-stop',motionEnabled,index)}); } catch { $('scene-hint').textContent = 'Animation unavailable. Your draw still counts.'; }
    state = settlePlay(state);
    if (result.won && treasury.available > 0) {
      // The prize is already settled. A creator accounting failure cannot reduce it.
      busy = false;
      try { settleCreatorFees(); } catch(error) { $('treasury-status').textContent = error.message; }
      busy = true;
    }
    selectNumber(result.number);
    $('result-title').textContent = result.won ? `Jackpot! ${sol(result.payout)} demo SOL won.` : result.reward ? `Three ${SYMBOLS[result.symbol].label}! ${fmt(result.reward)} $SLOT back.` : 'No match this time.';
    $('result-detail').textContent = result.won ? `${fmt(result.burn)} tokens burned; the full demo pot was paid. Add simulated fees for a new pot.` : result.reward ? `${fmt(result.burn)} tokens burned. ${fmt(result.reward)} added to your rewards below; claim when you choose.` : `${fmt(result.burn)} demo $SLOT burned. The jackpot carries over. Each spin keeps the same odds.`;
    if (result.won) stopAutoplay();
    if (!autoplay || state.prepaid === 0) presentResult(result);
    return result;
  } finally {
    gameAudio.stopSpin(); busy = false;
    if (!state.prepaid || state.pot <= 0 || document.hidden) stopAutoplay();
    render();
    if (autoplay) autoplayTimer = setTimeout(() => { if (autoplay && state.prepaid > 0) requestPlay(); }, 700);
  }
}
function requestPlay() {
  if (busy) return;
  clearTimeout(autoplayTimer); autoplayTimer = null;
  try {
    if (!state.prepaid && selectedPack > 1) { if (state.pot <= 0) throw Error('Add simulated fees before playing.'); state = buyPrepaid(state, selectedPack); }
  } catch (error) { stopAutoplay(); $('result-title').textContent = error.message; render(); return; }
  return draw().catch(error => { stopAutoplay(); $('result-title').textContent = error.message; $('result-detail').textContent = 'Unused prepaid credits remain available to return.'; render(); });
}
$('play-button').addEventListener('click', requestPlay);

function renderPacks() {
  for (const b of document.querySelectorAll('[data-pack]')) { b.disabled = busy || state.prepaid > 0; b.setAttribute('aria-pressed', String(Number(b.dataset.pack) === selectedPack)); }
  $('pack-credits').textContent = String(state.prepaid);
  $('pack-status').textContent = state.prepaid ? `${state.prepaid} prepaid ${state.prepaid === 1 ? 'spin' : 'spins'} ready. Unused credits can be returned.` : selectedPack > 1 ? `${fmt(selectedPack * RULES.entry)} tokens buys ${selectedPack} spins. One plays now; the rest are prepaid.` : `${fmt(RULES.entry)} demo tokens per spin. Same odds, every time.`;
  // Selecting a pack reserves this space before its first spin, through its last.
  $('prepaid-actions').hidden = selectedPack === 1 && !state.prepaid;
  $('pack-withdraw').disabled = busy || !state.prepaid;
  $('autoplay-toggle').disabled = !state.prepaid && !autoplay;
  $('autoplay-toggle').setAttribute('aria-checked', String(autoplay));
  $('autoplay-label').textContent = autoplay ? 'Stop autoplay' : 'Autoplay';
  $('autoplay-status').textContent = autoplay ? 'Playing your prepaid credits one at a time. Stop anytime; the current spin will finish.' : 'Autoplay is off. Returning unused credits never changes a settled result.';
}
for (const b of document.querySelectorAll('[data-pack]')) b.addEventListener('click', () => { if (busy || state.prepaid) return; selectedPack = Number(b.dataset.pack); render(); });
$('pack-withdraw').addEventListener('click', () => {
  if (busy) return; stopAutoplay();
  try { const amount = state.prepaid * RULES.entry; state = withdrawPrepaid(state); $('result-title').textContent = 'Unused credits returned.'; $('result-detail').textContent = `${fmt(amount)} demo tokens returned to your balance.`; } catch (error) { $('result-title').textContent = error.message; }
  render();
});
$('autoplay-toggle').addEventListener('click', () => {
  if (autoplay) { stopAutoplay(); render(); return; }
  if (!state.prepaid || state.pot <= 0) return;
  autoplay = true; render(); if (!busy) requestPlay();
});

function requestClaim() {
  if (busy) throw new Error('Wait for the current spin to settle before claiming.');
  const amount = state.claimable;
  state = claimRewards(state);
  gameAudio.unlock().then(()=>gameAudio.effect('claim'));
  if (state.draws.at(-1)?.reward) $('result-detail').textContent = 'Your accumulated token rewards have been claimed.';
  $('reward-status').textContent = `${fmt(amount)} demo $SLOT returned to your available balance.`;
  render();
  return { amount, balance: state.balance, claimable: state.claimable };
}
for (const id of ['claim-rewards', 'summary-claim']) $(id).addEventListener('click', () => { try { requestClaim(); } catch (error) { $('reward-status').textContent = error.message; $('summary-reward-note').textContent = error.message; } });
const summaryTabs = [...document.querySelectorAll('[data-summary-tab]')];
function selectSummaryTab(tab) {
  for (const item of summaryTabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !active;
  }
}
for (const tab of summaryTabs) {
  tab.addEventListener('click', () => selectSummaryTab(tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? summaryTabs.length - 1 : (summaryTabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + summaryTabs.length) % summaryTabs.length;
    selectSummaryTab(summaryTabs[index]); summaryTabs[index].focus();
  });
}
function renderMotion() { document.body.dataset.motion = motionEnabled ? 'on' : 'off'; $('motion-toggle').setAttribute('aria-pressed', String(!motionEnabled)); $('motion-toggle').setAttribute('aria-label', motionEnabled ? 'Pause ambient animation' : 'Enable ambient animation'); $('motion-toggle').innerHTML = motionEnabled ? '<span aria-hidden="true">Ⅱ</span> Motion on' : '<span aria-hidden="true">▷</span> Motion off'; }
$('motion-toggle').addEventListener('click', () => { motionEnabled = !motionEnabled; world?.setMotion(motionEnabled); renderMotion(); });
renderMotion();
import('./scene.js').then(({createJackpotWorld}) => { world = createJackpotWorld($('jackpot-world'), requestPlay); world.setStyle(machineStyle); renderPrice(); world.setMotion(motionEnabled); world.setEnabled(canPlay()); }).catch(() => { $('scene-load-message').textContent = 'The machine artwork is unavailable. The spin button still works.'; $('scene-hint').textContent = 'All 400 outcomes are available below.'; $('motion-toggle').hidden = true; });
$('add-fees').addEventListener('click', () => { if (busy) return; state = addCreatorFees(state, 1); treasury = creditCreator(treasury, splitCreatorFees(1).creator); $('result-title').textContent = '1 SOL of creator fees simulated.'; $('result-detail').textContent = '1 SOL of creator fees received: 0.90 SOL jackpot and 0.10 SOL treasury. No fixed trading-fee rate is assumed. No real funds moved.'; render(); });
$('reset-button').addEventListener('click', () => $('reset-dialog').showModal());
$('confirm-reset').addEventListener('click', () => { if (busy) return; $('outcome-dialog').close(); stopAutoplay(); gameAudio.stopSpin(); state = initialState(); treasury = initialTreasury(); $('treasury-status').textContent = 'Waiting for a fresh quote to simulate the initial $2 gas funding.'; maybeSeedGas(); $('reward-status').textContent = ''; selected?.classList.remove('selected'); selected = null; world?.reset(); $('result-title').textContent = 'Your jackpot moment starts here.'; $('result-detail').textContent = `Three Solana symbols win the pot. Any other triple earns ${fmt(RULES.consolationReward)} tokens to claim.`; render(); $('reset-dialog').close(); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
initSolanaWallet();

const oddsLab = initOddsLab();

$('fairness-content').innerHTML = `
<div class="notice"><strong>Local simulation. No real funds.</strong> Solana wallet connection is read-only. The game program, fee collection, randomness, and prepaid transactions are not live.</div>
<div class="fairness-layout"><section class="info-panel"><h2>The familiar game, on Solana.</h2><ol class="rule-list"><li><strong>${fmt(RULES.entry)} tokens per spin.</strong><p>The entry is held until the result settles. No token burn happens before settlement.</p></li><li><strong>1% jackpot. 20% ${RULES.entry===RULES.consolationReward?'entry back':'half back'}. 79% loss.</strong><p>One uniform draw from 1–400 selects the outcome. Numbers 1–4 win the reserved SOL pot, 5–84 return ${fmt(RULES.consolationReward)} tokens and burn ${fmt(RULES.entry-RULES.consolationReward)}, and 85–400 burn the full entry. The jackpot also burns the full entry.</p></li><li><strong>90% of our received creator fees funds the pot.</strong><p>pump.fun sets the creator-fee schedule before and after graduation to PumpSwap. We split only the creator fees actually received: 90% jackpot, 10% treasury. Protocol and LP fees are not our revenue. Unrelated pools contribute nothing.</p></li><li><strong>Funded prizes only.</strong><p>Only one spin can be pending. New receipts during a spin fund the next pot. Earned rewards and prepaid credits must stay reserved. Operations use treasury funds.</p></li></ol><a href="https://pump.fun/docs/fees" target="_blank" rel="noopener noreferrer">pump.fun fee documentation ↗</a></section>
<section class="info-panel"><h2>What this preview does</h2><p>Play the machine, inspect the outcome history, claim simulated rewards, and explore the odds. Balances reset with this tab.</p><h2>What production still needs</h2><p>Live randomness, wallet transaction screens, and an independent review are still required. The Solana test game works on devnet; Token-2022 compatibility and pump.fun fee routing must be verified before mainnet. This page remains a simulation.</p><p>PumpSwap migration burns the protocol LP tokens; that liquidity cannot be reclaimed. Creator fee rights are separate. Shutdown stops new spins and recovers only funds beyond accepted prizes, earned rewards, and unused prepaid balances. Locked liquidity cannot be reclaimed.</p><h2>Demo randomness</h2><p>Browser randomness is for this simulation only. Production must verify an external randomness account and bind it to the accepted spin; an operator-supplied result is not sufficient.</p><pre class="source-block" id="random-source"></pre><a href="./engine.js" target="_blank" rel="noopener">Read the simulation engine ↗</a></section></div>`;
$('random-source').textContent = secureInt.toString();

const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const validateEmpty = input => { if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length) throw new Error('Expected an empty object.'); };
  const tools = [
    {name:'read_jackpot_demo',title:'Read the demo jackpot',description:'Read this tab’s simulated jackpot, balance, draw history, and fixed rules. Game and treasury values are simulated; SOL/USD may be a live external quote.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){validateEmpty(input);return {mode:'browser simulation',network:'Solana prototype',rules:RULES,feeRules:FEE_RULES,state:structuredClone(state),presentation:{machineStyle,audio:gameAudio.status(),resultPopupOpen:$('outcome-dialog').open},treasury:structuredClone(treasury),solUsd:quoteStatus(quote) === 'unavailable' ? null : {...quote, status: quoteFailed ? 'delayed' : quoteStatus(quote)},drawInProgress:busy};}},
    {name:'play_jackpot_demo',title:'Play one simulated draw',description:`Hold ${RULES.entry} simulated SLOT and settle one draw: 1% SOL jackpot, 20% chance of a ${RULES.consolationReward}-token reward, otherwise a loss. No real funds or wallet transactions. Changes the visible balance, pot, and history.`,inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(input){validateEmpty(input);location.hash='play';return await draw();}},
    {name:'claim_jackpot_rewards',title:'Claim simulated token rewards',description:'Return all accumulated consolation rewards to this tab’s demo balance. No real funds or wallet transactions.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){validateEmpty(input);location.hash='play';return requestClaim();}},
    {name:'run_jackpot_simulation',title:'Run the odds comparison',description:'Run 1,000 hypothetical scenarios for each odds setting using the currently visible lab assumptions. Updates the odds lab results; does not change the gameplay balance.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},async execute(input){validateEmpty(input);if(oddsLab.isBusy())throw new Error('A simulation is already running.');location.hash='lab';return await oddsLab.runSimulation();}}
  ];
  for(const tool of tools){try{Promise.resolve(modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
  addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
function navigate() {
  const page = ['play', 'lab', 'fairness', 'rewards'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'play';
  for (const section of document.querySelectorAll('main > .page')) section.hidden = section.id !== 'page-' + page;
  for (const link of document.querySelectorAll('[data-page]')) { const active = link.dataset.page === page; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
}
addEventListener('hashchange', () => { navigate(); if (['#play','#lab','#fairness','#rewards'].includes(location.hash)) window.scrollTo(0,0); });
navigate(); render();
const playgroundLayout = initPlaygroundLayout(document);
addEventListener('pagehide', event => { if (!event.persisted) playgroundLayout.dispose(); });
refreshPrice();
setInterval(() => { renderPrice(); renderTreasury(); if (!document.hidden) refreshPrice(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refreshPrice(); } });
addEventListener('online', refreshPrice);
