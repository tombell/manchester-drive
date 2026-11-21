import type { Player, Position } from '../game/game-types';
import { boundary } from '../game/region';

function bounds(points: readonly Position[]) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { x, y } of points) {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

const region = bounds(boundary.map(([x, y]) => ({ x, y })));

function fit(area: typeof region, width: number, height: number) {
  const scale = Math.min(
    Math.max(1, width - 48) / Math.max(200, area.right - area.left),
    Math.max(1, height - 48) / Math.max(200, area.bottom - area.top),
  );
  return {
    x: (area.left + area.right - width / scale) / 2,
    y: (area.top + area.bottom - height / scale) / 2,
    scale,
  };
}

interface Marker extends Position {
  players: Player[];
}

function markers(players: Player[], view: ReturnType<typeof fit>, width: number, height: number) {
  const groups: Marker[] = [];
  for (const player of players) {
    const x = (player.x - view.x) * view.scale;
    const y = (player.y - view.y) * view.scale;
    if (x < 0 || y < 0 || x > width || y > height) continue;
    const near = groups.find((marker) => Math.hypot(marker.x - x, marker.y - y) < 34);
    if (near) near.players.push(player);
    else groups.push({ x, y, players: [player] });
  }
  return groups;
}

export function setupWorldMap(releaseControls: () => void) {
  const dialog = document.querySelector<HTMLDialogElement>('#world-map')!;
  const plot = dialog.querySelector<HTMLElement>('#overview-plot')!;
  const svg = plot.querySelector('svg')!;
  const places = svg.querySelector<SVGUseElement>('#overview-places')!;
  const layer = plot.querySelector<HTMLElement>('#overview-markers')!;
  const reset = dialog.querySelector<HTMLButtonElement>('#overview-reset')!;
  const details = dialog.querySelector<HTMLElement>('#overview-details')!;
  const count = dialog.querySelector<HTMLElement>('#overview-count')!;
  let players: Player[] = [], localId: string | undefined, online = false;
  let selection = new Set<string>();
  const buttons = new Map<string, HTMLButtonElement>();

  function describe(p: Player) {
    return p.name + (p.id === localId ? ' (you)' : '') + (p.parkedCar ? ' · on foot' : ' · driving');
  }

  function draw() {
    if (!dialog.open) return;
    const width = plot.clientWidth, height = plot.clientHeight;
    if (!width || !height) return;
    const selected = players.filter((p) => selection.has(p.id));
    if (!selected.length) selection.clear();
    const view = fit(selected.length ? bounds(selected) : region, width, height);
    svg.setAttribute('viewBox', [view.x, view.y, width / view.scale, height / view.scale].join(' '));
    places.style.display = selected.length ? 'none' : '';
    places.setAttribute('font-size', String(11 / view.scale));
    places.setAttribute('transform', 'translate(0 ' + (-20 / view.scale) + ')');
    reset.hidden = !selected.length;
    count.textContent = online
      ? players.length + (players.length === 1 ? ' player' : ' players')
      : 'Reconnecting…';
    const message = selected.length ? selected.map(describe).join(', ')
      : players.length ? 'Select a marker to locate players.' : '';
    if (details.textContent !== message) details.textContent = message;

    // Keep the same buttons across snapshots so keyboard focus and pending taps survive.
    const visible = new Set<string>();
    for (const marker of markers(players, view, width, height)) {
      const [first] = marker.players;
      const many = marker.players.length > 1;
      let button = buttons.get(first.id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        buttons.set(first.id, button);
        layer.append(button);
      }
      visible.add(first.id);
      const local = marker.players.some((p) => p.id === localId);
      button.className = 'player-marker ' + (many ? 'group' : first.parkedCar ? 'walker' : 'driver') +
        (local ? ' local' : '');
      button.style.left = marker.x + 'px';
      button.style.top = marker.y + 'px';
      button.style.setProperty('--player-color', first.color);
      button.style.setProperty('--heading', first.angle + 'rad');
      const caption = many ? String(marker.players.length) : '';
      if (button.textContent !== caption) button.textContent = caption;
      button.title = marker.players.map(describe).join(', ');
      button.setAttribute('aria-label', button.title);
      button.onclick = () => {
        selection = new Set(marker.players.map((p) => p.id));
        draw();
        reset.focus();
      };
    }
    for (const [id, button] of buttons) {
      if (visible.has(id)) continue;
      button.remove();
      buttons.delete(id);
    }
  }

  function toggle() {
    if (dialog.open) {
      dialog.close();
      return;
    }
    releaseControls();
    selection.clear();
    svg.querySelector('#overview-terrain')!.setAttribute('href', '/world-map.svg#terrain');
    places.setAttribute('href', '/world-map.svg#places');
    dialog.showModal();
    draw();
  }
  document.getElementById('open-world-map')!.onclick = toggle;
  dialog.querySelector<HTMLButtonElement>('#overview-close')!.onclick = () => dialog.close();
  reset.onclick = () => {
    selection.clear();
    draw();
    dialog.querySelector<HTMLButtonElement>('#overview-close')!.focus();
  };
  new ResizeObserver(draw).observe(plot);

  return {
    dialog,
    toggle,
    update(next: Player[], me: string | undefined, connected: boolean) {
      players = next;
      localId = me;
      online = connected;
      draw();
    },
  };
}
