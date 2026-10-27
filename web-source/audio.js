// Original, locally synthesized audio. No recordings, downloads, or tracking.
export function createGameAudio({ onChange = () => {}, contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)() } = {}) {
  let ctx, effectsBus, musicBus, master, musicTimer, beat = 0, nextBeat = 0;
  let music = false, effects = true, hidden = false, available = true;
  const voices = new Set(), spinVoices = new Set(), musicVoices = new Set();
  try { const saved = JSON.parse(localStorage.getItem('jackpot-audio-v1')); music = saved?.music === true; effects = saved?.effects !== false; } catch {}
  const status = () => ({ music, effects, available, playing: Boolean(music && !hidden && ctx?.state === 'running'), contextState: ctx?.state || 'not-started' });
  function changed() { onChange(status()); }
  function save() { try { localStorage.setItem('jackpot-audio-v1', JSON.stringify({ music, effects })); } catch {} changed(); }
  function tone(frequency, time, duration, volume, bus, shape = 'sine', endFrequency, track) {
    if (!ctx || ctx.state !== 'running' || hidden) return;
    const oscillator = ctx.createOscillator(), gain = ctx.createGain();
    oscillator.type = shape; oscillator.frequency.setValueAtTime(frequency, time);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(volume, time + Math.min(.018, duration / 4));
    gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    oscillator.connect(gain); gain.connect(bus); voices.add(oscillator); track?.add(oscillator); if (bus === musicBus) musicVoices.add(oscillator);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); voices.delete(oscillator); musicVoices.delete(oscillator); track?.delete(oscillator); };
    oscillator.start(time); oscillator.stop(time + duration + .03);
  }
  function stopVoices(set) { for (const voice of set) { try { voice.stop(); } catch {} } set.clear(); }
  function scheduleMusic() {
    if (!music || hidden || ctx?.state !== 'running') return;
    const chords = [[261.63,329.63,392,493.88],[220,261.63,329.63,392],[174.61,220,261.63,329.63],[196,261.63,293.66,392]];
    while (nextBeat < ctx.currentTime + .22) {
      const chord = chords[Math.floor(beat / 8) % chords.length], part = beat % 8;
      if (part === 0) {
        chord.forEach(f => tone(f, nextBeat, 2.8, .035, musicBus));
        tone(chord[0] / 2, nextBeat, 1.5, .11, musicBus);
      }
      if ([0,2,3,5,6].includes(part)) tone(chord[[0,2,1,3,2,1,3,2][part]] * 2, nextBeat, .65, .055, musicBus, 'sine');
      beat++; nextBeat += 60 / 82 / 2;
    }
  }
  function startMusic() {
    clearInterval(musicTimer); musicTimer = null;
    if (!ctx || !music || hidden || ctx.state !== 'running') return;
    musicBus.gain.setValueAtTime(.32, ctx.currentTime);
    beat = 0; nextBeat = ctx.currentTime + .08; scheduleMusic();
    musicTimer = setInterval(scheduleMusic, 100);
  }
  async function unlock() {
    if (!available || hidden) return false;
    try {
      if (!ctx) {
        ctx = contextFactory(); master = ctx.createGain(); master.gain.value = .65; master.connect(ctx.destination);
        effectsBus = ctx.createGain(); effectsBus.gain.value = effects ? .55 : 0; effectsBus.connect(master);
        musicBus = ctx.createGain(); musicBus.gain.value = music ? .32 : 0; musicBus.connect(master);
        ctx.onstatechange = changed;
      }
      if (ctx.state !== 'running') await ctx.resume();
      if (!musicTimer && music) startMusic();
      changed(); return ctx.state === 'running';
    } catch { available = Boolean(ctx); changed(); return false; }
  }
  function effect(name, animated = true, reel = 0) {
    if (!effects || hidden || ctx?.state !== 'running') return;
    const t = ctx.currentTime;
    const note = (f, delay, duration, volume = .2, type = 'sine', end, track) => tone(f,t+delay,duration,volume,effectsBus,type,end,track);
    if (name === 'spin') {
      stopVoices(spinVoices);
      note(140,0,.13,.27,'triangle',55,spinVoices);
      if (animated) {
        for (let i=0;i<22;i++) note(160+(i%3)*45,.12+i*.075,.025,.085,'triangle',90,spinVoices);
      }
    } else if (name === 'reel-stop') {
      note(360+reel*70,0,.10,.18,'triangle',180);
    } else if (name === 'jackpot') {
      [523.25,659.25,783.99,1046.5,1318.51,1567.98].forEach((f,i) => note(f,i*.105,.7,.19));
      [523.25,659.25,783.99,1046.5].forEach(f => note(f,.72,1.6,.1));
    } else if (name === 'consolation') [659.25,783.99,1046.5].forEach((f,i) => note(f,i*.13,.55,.18));
    else if (name === 'loss') { note(293.66,0,.23,.11,'triangle'); note(220,.16,.32,.085,'sine'); }
    else if (name === 'claim') [523.25,783.99].forEach((f,i) => note(f,i*.08,.32,.16));
    else if (name === 'switch') note(620,0,.07,.075,'sine');
  }
  return {
    status, unlock, effect,
    stopSpin() { stopVoices(spinVoices); },
    async toggleMusic() {
      if (music && ctx?.state === 'running' && !hidden) { music = false; clearInterval(musicTimer); musicTimer = null; stopVoices(musicVoices); musicBus.gain.setTargetAtTime(0,ctx.currentTime,.08); }
      else { music = true; await unlock(); startMusic(); }
      save();
    },
    async toggleEffects() { effects = !effects; await unlock(); if (effectsBus) effectsBus.gain.setValueAtTime(effects ? .55 : 0,ctx.currentTime); if (!effects) stopVoices(spinVoices); save(); if (effects) effect('switch'); },
    async setHidden(value) {
      hidden = value;
      if (hidden) { clearInterval(musicTimer); musicTimer = null; stopVoices(voices); try { await ctx?.suspend(); } catch {} }
      else if (ctx) await unlock();
      changed();
    },
    dispose() { clearInterval(musicTimer); stopVoices(voices); if(ctx) { ctx.onstatechange = null; ctx.close().catch(()=>{}); } }
  };
}
