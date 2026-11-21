import type { Position } from '../game/game-types';

// The world point under "from" stays under "to", including when a pinch also pans.
export function bindMapGestures(
  plot: HTMLElement,
  changeView: (from: Position, to: Position, factor: number) => void,
) {
  const pointers = new Map<number, Position>();
  let start: Position, dragged = false;
  function point(e: MouseEvent) {
    const rect = plot.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  plot.addEventListener('wheel', (event) => {
    event.preventDefault();
    const anchor = point(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plot.clientHeight : 1;
    const delta = Math.max(-600, Math.min(600, event.deltaY * unit));
    changeView(anchor, anchor, Math.exp(-delta * 0.003));
  }, { passive: false });

  function gesture() {
    const [a, b] = pointers.values();
    return b
      ? { centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span: Math.hypot(a.x - b.x, a.y - b.y) }
      : { centre: a, span: 0 };
  }
  plot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pointers.size >= 2 || !(e.target instanceof Element)) return;
    if (e.target.closest('.overview-zoom')) return;
    const p = point(e);
    if (!pointers.size) {
      start = p;
      dragged = false;
    } else dragged = true;
    pointers.set(e.pointerId, p);
    // Capturing on the marker preserves its normal click for a stationary tap.
    (e.target.closest('.player-marker') ?? plot).setPointerCapture(e.pointerId);
  });
  plot.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const before = gesture(), p = point(e);
    if (!dragged && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
    dragged = true;
    plot.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, p);
    const after = gesture();
    changeView(before.centre, after.centre, before.span && after.span ? after.span / before.span : 1);
  });
  const release = (e: PointerEvent) => { pointers.delete(e.pointerId); };
  plot.addEventListener('pointerup', release);
  plot.addEventListener('pointercancel', release);
  plot.addEventListener('lostpointercapture', (e) => {
    if (!plot.hasPointerCapture(e.pointerId)) release(e);
  });
  plot.addEventListener('click', (e) => {
    if (dragged && e.detail && (e.target as Element).closest('.player-marker')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  return () => pointers.clear();
}
