import { SYMBOLS, outcomeSymbols } from '../web-source/symbols.js';
import { createLeverGesture } from './lever-gesture.js';

// Artwork supplies the cabinet; every reel symbol and control is live DOM.
// The game engine supplies one accepted result. Animation never draws an outcome.
export function createJackpotWorld(container, onPlay) {
  const doc = container.ownerDocument, handle = doc.getElementById('lever-handle');
  const art = container.querySelector('.machine-art'), host = doc.getElementById('playground-reels');
  const help = doc.getElementById('lever-help'), announcement = doc.getElementById('reel-result');
  const gesture = createLeverGesture(), finishers = new Set();
  let enabled = false, motion = true, spinning = false, symbols = [0, 0, 0];
  const reels = [0, 1, 2].map(() => {
    const reel = doc.createElement('div'); reel.className = 'toy-reel';
    const track = doc.createElement('div'); track.className = 'reel-track';
    reel.append(track); host.append(reel); return { reel, track, height:0, symbol:-1 };
  });
  const cell = index => {
    const el = doc.createElement('div'); el.className = 'reel-cell';
    const img = doc.createElement('img'); img.src = SYMBOLS[index].image; img.alt = ''; img.draggable = false; img.decoding = 'async';
    el.append(img); return el;
  };
  function paint(index, symbol, height) {
    const item=reels[index],{ reel, track }=item;
    if(item.height===height&&item.symbol===symbol&&track.childElementCount===1&&!reel.classList.contains('is-spinning'))return;
    item.height=height;item.symbol=symbol;
    reel.style.setProperty('--reel-height', `${height}px`);
    track.style.transition = 'none'; track.style.transform = 'translateY(0)'; track.replaceChildren(cell(symbol));
    reel.classList.remove('is-spinning');
  }
  function renderSymbols() { const heights=reels.map(({reel})=>reel.getBoundingClientRect().height||180);symbols.forEach((symbol,index)=>paint(index,symbol,heights[index])); }
  function releaseLever() { handle.style.setProperty('--pull', '0'); help.textContent = 'Pull down & release to spin'; }
  handle.addEventListener('pointerdown', e => {
    if (!enabled || spinning || e.button !== 0) return;
    if (!gesture.begin(e.pointerId, e.clientY, Math.max(65, handle.getBoundingClientRect().height * .55))) return;
    handle.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!gesture.active) return;
    const progress = gesture.move(e.pointerId, e.clientY); handle.style.setProperty('--pull', String(progress));
    help.textContent = progress >= .85 ? 'Release to spin!' : 'Keep pulling…';
  });
  handle.addEventListener('pointerup', e => {
    const commit = gesture.release(e.pointerId);
    if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    releaseLever(); if (commit && enabled && !spinning) onPlay();
  });
  for (const event of ['pointercancel', 'lostpointercapture']) handle.addEventListener(event, e => { gesture.cancel(e.pointerId); releaseLever(); });
  // Native keyboard activation is supported; a short pointer click does not spend.
  handle.addEventListener('click', e => { if (e.detail === 0 && enabled && !spinning) onPlay(); });
  const observer = new ResizeObserver(() => { if (!spinning) renderSymbols(); }); observer.observe(host);
  renderSymbols(); container.classList.add('scene-ready');
  return {
    setStyle(value) { container.dataset.style = value; },
    setPot(pot, usd = '—', quoteLabel = 'USD UNAVAILABLE', network = 'demo', exactValue = null) {
      const value = exactValue ?? pot.toFixed(3);
      container.setAttribute('aria-label', `SolSlot slot machine. ${value} ${network} SOL in the pot.`);
      doc.getElementById('machine-jackpot').textContent = value;
      doc.getElementById('machine-jackpot-usd').textContent = usd;
      doc.getElementById('machine-quote-label').textContent = usd === '—' ? 'USD unavailable' : quoteLabel.startsWith('LAST') ? '≈ USD · last quote' : '≈ USD · live';
      const display = doc.querySelector('.machine-jackpot-display');
      display.dataset.compact = String(Math.max(value.length, usd.length) > 9);
    },
    setEnabled(value) { enabled = value; handle.disabled = !value; if (!value) { gesture.cancel(); releaseLever(); } },
    setMotion(value) { motion = value; if (!motion) for (const finish of [...finishers]) finish(); },
    reset() { for (const finish of [...finishers]) finish(); symbols = [0, 0, 0]; renderSymbols(); art.classList.remove('is-jackpot', 'is-consolation'); announcement.textContent = ''; },
    async spin(result, {quick=false,onReelStop=()=>{}}={}) {
      if (spinning) throw Error('Reels are already spinning');
      spinning = true; art.classList.remove('is-jackpot', 'is-consolation');
      const target = outcomeSymbols(result.number);
      const heights=reels.map(({reel})=>reel.getBoundingClientRect().height||180);
      announcement.textContent = 'Reels spinning.';
      try {
        await Promise.all(reels.map(({ reel, track }, index) => new Promise(resolve => {
          // Roll together first, then land left to right. Keep each unrevealed
          // target beyond the rolling section so it cannot settle early.
          const rollDuration = (quick ? 1000 : 1450) + index * 400;
          const rollSteps = Math.round(rollDuration / 50), landingDuration = 280;
          const sequence = [symbols[index], ...Array.from({ length: rollSteps + 3 }, (_, i) => (i + index) % SYMBOLS.length), target[index]];
          const height = heights[index];
          reel.style.setProperty('--reel-height', `${height}px`);
          track.style.transition = 'none'; track.style.transform = 'translateY(0)'; track.replaceChildren(...sequence.map(cell));
          let rollTimer, landingTimer, finished = false;
          const finish = (landed=false) => {
            if (finished) return;
            finished = true; clearTimeout(rollTimer); clearTimeout(landingTimer);
            finishers.delete(finish); paint(index, target[index],height);
            try { if (landed && motion) onReelStop(index); } catch { /* Audio must never block result playback. */ }
            resolve();
          };
          finishers.add(finish);
          if (!motion) { landingTimer = setTimeout(finish, 90); return; }
          // Commit the start position before the CSS transition begins.
          void track.offsetHeight;
          track.style.transition = `transform ${rollDuration}ms linear`;
          track.style.transform = `translateY(-${rollSteps * height}px)`;
          reel.classList.add('is-spinning');
          rollTimer = setTimeout(() => {
            if (finished) return;
            track.style.transition = `transform ${landingDuration}ms cubic-bezier(.14,.65,.12,1)`;
            track.style.transform = `translateY(-${(sequence.length - 1) * height}px)`;
            landingTimer = setTimeout(() => finish(true), landingDuration + 30);
          }, rollDuration);
        })));
        symbols = target; renderSymbols();
        if (result.won) art.classList.add('is-jackpot'); else if (result.reward) art.classList.add('is-consolation');
        announcement.textContent = target.map(index => SYMBOLS[index].label).join(', ') + (result.won ? '. Jackpot.' : result.reward ? (result.burn === 0 ? '. Entry back.' : '. Half back.') : '. No match.');
      } finally { spinning = false; }
    },
    dispose() { observer.disconnect(); for (const finish of [...finishers]) finish(); },
  };
}
