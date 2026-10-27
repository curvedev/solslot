import { RULES, splitCreatorFees, chanceAtLeastOne, simulate } from './engine.js';
export function initOddsLab() {
const $ = id => document.getElementById(id);
$('lab-content').innerHTML = `
<div class="lab-layout">
  <form class="lab-settings" id="lab-form"><h2>Set the assumptions</h2><p class="secondary">Hypothetical values in SOL. These settings do not change the playground.</p>
    <label class="field"><span>Jackpot chance per attempt</span><select id="lab-odds"><option value="100">1 in 100 · 1%</option><option value="50">1 in 50 · 2%</option></select></label>
    <label class="field"><span>Starting jackpot · SOL</span><input id="lab-pot" type="number" value="1" min="0" max="1000000" step="any" required></label>
    <label class="field"><span>Entry token value per play · SOL</span><input id="lab-cost" type="number" value="0.01" min="0" max="1000000" step="any" required><small>Full entry market value. The model includes a 20% chance of ${100*RULES.consolationReward/RULES.entry}% back.</small></label>
    <label class="field"><span>Other costs per play · SOL</span><input id="lab-overhead" type="number" value="0.0001" min="0" max="1000000" step="any" required><small>Any unsponsored player costs. Creator-funded collection, randomness, and payout costs are excluded from this field.</small></label>
    <label class="field"><span>Total attempts in a day</span><input id="lab-attempts" type="number" value="100" min="1" max="1000" step="1" required></label>
    <label class="field"><span>Creator fees received per day · SOL</span><input id="lab-volume" type="number" value="1" min="0" max="1000000" step="any" required><small>Hypothetical creator revenue already received. 90% funds the jackpot; 10% funds treasury.</small></label>
    <div class="lab-fee-summary" id="lab-fee-summary"></div>
    <p class="error-message" id="lab-error" role="status"></p>
  </form>
  <div><section class="lab-results"><h2>What the numbers say</h2>
    <div class="lab-summary"><div><span class="metric-label">At least one jackpot</span><strong id="lab-chance">63.4%</strong><p>Across the day's attempts</p></div><div><span class="metric-label">First-play expected net</span><strong id="lab-ev">−0.0001</strong><p>SOL, including token rewards & costs</p></div><div><span class="metric-label">Avg. attempts to jackpot</span><strong id="lab-average">100</strong><p>Across repeated trials</p></div></div>
    <div class="eyebrow">CHANCE OF AT LEAST ONE JACKPOT</div><svg class="chart" id="probability-chart" viewBox="0 0 620 265" role="img" aria-labelledby="chart-title chart-description"></svg><p class="chart-caption">More attempts increase the chance of a jackpot somewhere in the sequence. Each individual attempt keeps the same odds.</p>
    <div class="lab-explainer" id="lab-interpretation"></div>
  </section>
  <section class="lab-results spaced"><div class="simulation-heading"><h2>Simulate the jackpot</h2><button class="secondary-button" id="run-simulation">Run 1,000 scenarios ↗</button></div><p class="secondary compact">Each scenario starts with your jackpot. Fees arrive evenly before each play. Every jackpot pays the available pot and resets it to zero.</p>
    <div id="simulation-output" aria-live="polite"><p class="simulation-note">Compare 1-in-50 and 1-in-100 over the same day. These are simulated outcomes, not forecasts.</p></div>
  </section></div>
</div>`;
function readLab() {
  const odds = Number($('lab-odds').value), startingPot = Number($('lab-pot').value), cost = Number($('lab-cost').value), overhead = Number($('lab-overhead').value), attempts = Number($('lab-attempts').value), volume = Number($('lab-volume').value);
  if (!$('lab-form').checkValidity() || ![50, 100].includes(odds) || ![startingPot,cost,overhead,volume].every(v=>Number.isFinite(v)&&v>=0&&v<=1000000) || !Number.isInteger(attempts)||attempts<1||attempts>1000) throw new Error('Enter nonnegative values and 1–1,000 whole attempts.');
  const feeSplit = splitCreatorFees(volume);
  return { odds, startingPot, cost, overhead, attempts, volume, dailyFees: feeSplit.pool, creatorIncome: feeSplit.creator, totalCreatorFees: feeSplit.total };
}
function renderLab() {
  let data;
  try { data = readLab(); $('lab-error').textContent = ''; } catch (e) { $('lab-error').textContent=e.message; return; }
  const {odds, startingPot, cost, overhead, attempts} = data;
  $('lab-fee-summary').innerHTML = `<div><span>To the jackpot / day</span><strong>${data.dailyFees.toFixed(4)} SOL</strong></div><div><span>Treasury gross / day</span><strong>${data.creatorIncome.toFixed(4)} SOL</strong></div><p>Uses entered creator fee receipts, split 90/10 before operating costs. pump.fun sets its own fee schedule; this calculator does not assume a trading-volume rate.</p>`;
  const ev = startingPot / odds + cost * RULES.consolationChance * (RULES.consolationReward / RULES.entry) - cost - overhead;
  $('lab-chance').textContent = (100*chanceAtLeastOne(odds,attempts)).toFixed(1)+'%';
  $('lab-ev').textContent = (ev>=0?'+':'−')+Math.abs(ev).toFixed(4);
  $('lab-ev').style.color = ev >= 0 ? 'var(--green)' : 'var(--accent)';
  $('lab-average').textContent = odds;
  $('lab-interpretation').innerHTML = `<strong>${(100*(1-chanceAtLeastOne(odds,attempts))).toFixed(1)}% chance of no jackpot in ${attempts} attempts.</strong> ${ev>=0?'At the starting jackpot, the expected payout meets or exceeds the entered costs. Players and bots may wait for this point.':'At the starting jackpot, the expected payout is lower than the entered costs.'} Includes a 20% chance of recovering ${RULES.entry===RULES.consolationReward?'the full':'half the'} entry value, assuming all rewards are claimed at the same token price. Enter claim gas in other costs if applicable. The first-play estimate holds the starting pot fixed; later payouts change as fees arrive and winners empty it.`;
  const maxX = Math.max(300,attempts), x = v=>45+v/maxX*545, y = p=>215-p*185;
  const curve = n => Array.from({length:101},(_,i)=>{const a=maxX*i/100;return `${i?'L':'M'}${x(a).toFixed(2)},${y(chanceAtLeastOne(n,a)).toFixed(2)}`;}).join(' ');
  const chart = $('probability-chart');
  chart.innerHTML = `<title id="chart-title">Chance of at least one jackpot</title><desc id="chart-description">For ${attempts} independent attempts, 1-in-50 odds yield ${(100*chanceAtLeastOne(50,attempts)).toFixed(1)} percent chance of a jackpot; 1-in-100 yield ${(100*chanceAtLeastOne(100,attempts)).toFixed(1)} percent.</desc>${[0,.5,1].map(p=>`<line x1="45" x2="590" y1="${y(p)}" y2="${y(p)}"/><text x="36" y="${y(p)+4}" text-anchor="end">${p*100}%</text>`).join('')}${[0,.5,1].map(f=>`<text x="${x(maxX*f)}" y="239" text-anchor="middle">${Math.round(maxX*f)}</text>`).join('')}<path d="${curve(50)}" fill="none" stroke="#54866c" stroke-width="2.5"/><path d="${curve(100)}" fill="none" stroke="#df7045" stroke-width="2.5"/><line x1="${x(attempts)}" x2="${x(attempts)}" y1="30" y2="215" stroke-dasharray="4 5"/><circle cx="${x(attempts)}" cy="${y(chanceAtLeastOne(odds,attempts))}" r="5" fill="${odds===50?'#54866c':'#df7045'}"/><text x="45" y="15" style="fill:#54866c">1 in 50</text><text x="145" y="15" style="fill:#df7045">1 in 100</text><text x="318" y="263" text-anchor="middle">Total attempts</text>`;
}
$('lab-form').addEventListener('submit', e=>e.preventDefault());
$('lab-form').addEventListener('input', () => { renderLab(); $('simulation-output').innerHTML='<p class="simulation-note">Assumptions changed. Run again to update the comparison.</p>'; });
let simBusy=false;
async function runSimulation() {
  if(simBusy) return;
  const settings = readLab(); simBusy=true; $('run-simulation').disabled=true; $('run-simulation').textContent='Simulating…';
  try {
    await new Promise(r=>setTimeout(r,20));
    const pool = new Uint32Array(4096); let index=pool.length;
    const bufferedDraw = max => { const limit=0x100000000-(0x100000000%max); let word; do{if(index===pool.length){crypto.getRandomValues(pool);index=0;}word=pool[index++];}while(word>=limit);return word%max; };
    const rows = [50,100].map(odds=>simulate({...settings,odds,trials:1000},bufferedDraw));
    $('simulation-output').innerHTML = `<div class="table-wrap"><table class="comparison-table"><thead><tr><th>Per-play odds</th><th>1 in 50</th><th>1 in 100</th></tr></thead><tbody><tr><td>Avg. jackpots / day</td>${rows.map(r=>`<td>${r.averageWins.toFixed(2)}</td>`).join('')}</tr><tr><td>Avg. paid / day · SOL</td>${rows.map(r=>`<td>${r.averagePayout.toFixed(4)}</td>`).join('')}</tr><tr><td>Avg. ending pot · SOL</td>${rows.map(r=>`<td>${r.averageRemaining.toFixed(4)}</td>`).join('')}</tr><tr><td>Days with no jackpot</td>${rows.map(r=>`<td>${r.noWinnerPercent.toFixed(1)}%</td>`).join('')}</tr></tbody></table></div><p class="simulation-note">1,000 independent scenarios for each odds setting; ${settings.attempts} attempts per scenario. Starting pot ${settings.startingPot} SOL + jackpot fees ${settings.dailyFees} SOL = payouts + ending pot in every scenario. Creator gross revenue is ${settings.creatorIncome} SOL before operating costs from ${settings.volume} SOL of daily creator fee receipts. Token rewards are held from entries and do not reduce the SOL pot. This table models SOL only; token rewards are included in the first-play expected net above. Assumes a fixed number of attempts; it does not predict demand or token prices.</p>`;
    return rows;
  } finally {simBusy=false;$('run-simulation').disabled=false;$('run-simulation').textContent='Run 1,000 scenarios ↗';}
}
$('run-simulation').addEventListener('click',()=>runSimulation().catch(e=>{$('lab-error').textContent=e.message;}));
renderLab();

return {runSimulation, isBusy:()=>simBusy};
}
