try {
  const response = await fetch('./launch-config.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Configuration unavailable');
  const config = await response.json();
  if (config.mode !== 'demo' || config.cluster !== 'solana:devnet') throw new Error('Live gameplay is not implemented');
  await import('./app.js');
} catch {
  for (const id of ['play-button', 'lever-handle', 'claim-rewards']) document.getElementById(id).disabled = true;
  document.getElementById('result-title').textContent = 'Preview unavailable';
  document.getElementById('result-detail').textContent = 'Configuration could not be verified. No transaction was submitted.';
}
