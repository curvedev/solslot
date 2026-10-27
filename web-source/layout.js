// Keep the complete cabinet, pedestal and controls inside a desktop viewport.
// A small-window floor preserves readable controls and allows normal scrolling.
export function fitMachineSize({ viewportHeight, stageTop, controlsHeight, standHeight, columnWidth, gutter = 24 }) {
  const widthLimit = Math.min(620, columnWidth * .86);
  const heightLimit = viewportHeight - stageTop - controlsHeight - standHeight - gutter;
  return Math.floor(Math.max(Math.min(220, widthLimit), Math.min(widthLimit, heightLimit)));
}

export function initPlaygroundLayout(doc) {
  const win = doc.defaultView;
  const stage = doc.querySelector('.playground-stage');
  const area = doc.querySelector('.playground-machine-area');
  const controls = doc.querySelector('.playground-control-wrap');
  const pedestal = doc.querySelector('.toy-pedestal');
  let frame = null, disposed = false;
  function update() {
    frame = null;
    if (disposed) return;
    if (win.innerWidth < 960) { stage.style.removeProperty('--machine-size'); return; }
    const rect = stage.getBoundingClientRect();
    const columnWidth = area.getBoundingClientRect().width;
    if (!rect.width || !columnWidth || doc.getElementById('page-play').hidden) return;
    const pedestalMargin = parseFloat(win.getComputedStyle(pedestal).marginTop) || 0;
    const size = fitMachineSize({
      viewportHeight: win.visualViewport?.height || win.innerHeight,
      stageTop: rect.top + win.scrollY,
      controlsHeight: controls.getBoundingClientRect().height,
      standHeight: pedestal.getBoundingClientRect().height + pedestalMargin,
      columnWidth,
    });
    const value = `${size}px`;
    if (stage.style.getPropertyValue('--machine-size') !== value) stage.style.setProperty('--machine-size', value);
  }
  function schedule() { if (!disposed && frame === null) frame = win.requestAnimationFrame(update); }
  const observer = new win.ResizeObserver(schedule);
  for (const el of [stage, controls, doc.querySelector('.site-header'), doc.getElementById('top-rules'), doc.querySelector('.chain-toolbar')].filter(Boolean)) observer.observe(el);
  win.addEventListener('resize', schedule);
  win.addEventListener('hashchange', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  doc.fonts?.ready.then(schedule);
  schedule();
  return { dispose() {
    disposed = true; observer.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    win.removeEventListener('resize', schedule); win.removeEventListener('hashchange', schedule);
    win.visualViewport?.removeEventListener('resize', schedule);
  } };
}
