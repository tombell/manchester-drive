import type { VisiblePlayer, Snapshot } from '../protocol/snapshots';
import { appearance, models, jackets, skinTones } from '../game/garage';
import { gates, raceEntry } from '../game/race';
import { drawGarage } from './renderer';

export function el(id: 'bee' | 'map' | 'garage-preview'): HTMLCanvasElement;
export function el(id: 'model' | 'jacket' | 'skin' | 'chat-channel'): HTMLSelectElement;
export function el(id: 'name' | 'chat-input'): HTMLInputElement;
export function el(
  id: 'camera' | 'door' | 'start' | 'race-action' | 'chat-send',
): HTMLButtonElement;
export function el(id: string): HTMLElement;
export function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing game element ' + id);
  return element;
}

export function outfit() {
  return appearance({
    model: el('model').value,
    jacket: el('jacket').value,
    skin: el('skin').value,
  });
}

export function setupGarage() {
  const bee = el('bee').getContext('2d')!;
  const sprite = [
    '..ww..ww.......',
    '..wWwwWw.......',
    '...wwww........',
    '..yy.bbyybb....',
    '.yyy.bbyybb.yy.',
    'yyyy.bbyybb.yby',
    '.yyy.bbyybb.yy.',
    '..yy.bbyybb....',
    '....b..b..b....',
    '...bb..b..bb...',
  ];
  const beeColors: Record<string, string> = {
    w: '#a3b8ac',
    W: '#e3e8d5',
    y: '#f5c66c',
    b: '#6b6953',
  };
  for (let y = 0; y < sprite.length; y++)
    for (let x = 0; x < sprite[y].length; x++) {
      const c = beeColors[sprite[y][x]];
      if (c) {
        bee.fillStyle = c;
        bee.fillRect(x + 4, y + 5, 1, 1);
      }
    }

  for (const [id, palette] of [
    ['model', models],
    ['jacket', jackets],
    ['skin', skinTones],
  ] as const) {
    for (const [key, value] of Object.entries(palette)) {
      el(id).add(
        new Option(
          typeof value === 'string' ? key[0].toUpperCase() + key.slice(1) : value.name,
          key,
        ),
      );
    }
    el(id).onchange = refreshPreview;
  }
  function refreshPreview() {
    drawGarage(el('garage-preview'), outfit());
  }
  el('skin').value = 'tan';
  refreshPreview();
}

export function notice(message: string) {
  el('notice').textContent = message;
  el('notice').hidden = !message;
}
const walkingButtons: Record<number, [string, string]> = {
  1: ['▲', 'Walk north'],
  2: ['▼', 'Walk south'],
  4: ['◀', 'Walk west'],
  8: ['▶', 'Walk east'],
};
const drivingButtons: Record<number, [string, string]> = {
  1: ['W', 'Accelerate'],
  2: ['S', 'Brake or reverse'],
  4: ['◀', 'Steer left'],
  8: ['▶', 'Steer right'],
};
interface HudState {
  world?: Snapshot;
  playerId?: string;
  predicted: VisiblePlayer | null;
  freeCam: boolean;
  connected: boolean;
  busy: boolean;
  doorBusy: boolean;
  raceBusy: boolean;
  dismissedRace?: string;
}

export function updateHud(state: HudState) {
  const { world, playerId, predicted, freeCam, connected, busy, doorBusy } = state;
  const onFoot = !!predicted?.parkedCarId;
  el('join').hidden = !!playerId || freeCam;
  el('dash').hidden = !playerId || freeCam;
  el('touch').hidden = !playerId || freeCam;
  el('camera').textContent = freeCam
    ? playerId
      ? onFoot
        ? 'Return to player'
        : 'Return to car'
      : 'Back to start'
    : 'Free cam';
  el('camera').disabled = busy;
  el('driving-keys').hidden = freeCam || onFoot;
  el('walking-keys').hidden = freeCam || !onFoot;
  el('readout').hidden = onFoot;
  el('car-location').hidden = !onFoot;
  el('race-action').hidden = onFoot;
  el('leave').hidden = !playerId;
  const race = world?.race,
    entry = raceEntry(race, playerId);
  el('door').textContent = onFoot
    ? 'Enter car'
    : entry && !entry.withdrawn && entry.elapsed === null
      ? 'Exit car & race'
      : 'Get out';
  el('door').disabled = !connected || !predicted || doorBusy;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.touch button')) {
    const [caption, label] = (onFoot ? walkingButtons : drivingButtons)[Number(button.dataset.bit)];
    button.textContent = caption;
    button.setAttribute('aria-label', label);
  }
  el('camera-keys').hidden = !freeCam;
  el('start').disabled = busy || !connected;
  el('network').textContent = connected ? 'Live' : 'Connecting';
  el('network').classList.toggle('live', connected);
  updateRacePanel(state);
}
function lapTime(seconds: number) {
  const ms = Math.floor(Math.max(0, seconds) * 1000);
  return (
    Math.floor(ms / 60000) +
    ':' +
    String(Math.floor(ms / 1000) % 60).padStart(2, '0') +
    '.' +
    String(ms % 1000).padStart(3, '0')
  );
}
function updateRacePanel({
  world,
  playerId,
  predicted,
  freeCam,
  raceBusy,
  connected,
  dismissedRace,
}: HudState) {
  const race = world?.race,
    entry = raceEntry(race, playerId);
  const active = entry && entry.elapsed === null && !entry.withdrawn;
  el('drive-mode').textContent = freeCam
    ? 'Free cam'
    : active && race?.phase !== 'open'
      ? 'One-lap race'
      : predicted?.parkedCarId
        ? 'On foot'
        : 'Free drive';
  const button = el('race-action');
  let action = '',
    caption = 'Race in progress';
  if (!race || race.phase === 'results') {
    action = 'open';
    caption = entry ? 'Race again' : 'Open race';
  } else if (active) {
    action = 'withdraw';
    caption = race.phase === 'open' ? 'Cancel race' : 'Leave race';
  } else if (race.phase === 'open') {
    action = 'join';
    caption = 'Join race';
  }
  button.textContent = caption;
  button.dataset.action = action;
  button.dataset.raceId = race?.id ?? '';
  button.disabled = !action || raceBusy || !connected;
  const visible =
    !freeCam && playerId && race && (entry || race.phase === 'open') && dismissedRace !== race.id;
  el('race-panel').hidden = !visible;
  if (!visible || !world) return;
  let status = '',
    clock = '',
    results = '';
  if (race.phase === 'open')
    status = entry
      ? 'Waiting for a second driver on Piccadilly.'
      : race.racers[0].name + ' opened a race on Piccadilly.';
  else if (race.phase === 'countdown') {
    status = 'On the grid · Get ready';
    clock = String(Math.max(1, Math.ceil(race.startAt! - world.time)));
  } else if (entry) {
    if (race.phase === 'results') status = 'Final results';
    else if (entry.withdrawn) status = 'You left the race';
    else if (entry.elapsed !== null) status = 'Finished · Waiting for the other driver';
    else {
      const gate = gates[entry.next];
      const prefix =
        entry.next === gates.length - 1
          ? 'Finish'
          : 'Gate ' + (entry.next + 1) + '/' + (gates.length - 1);
      status = prefix + ' · ' + gate.street + ' (' + gate.direction + ')';
      const elapsed = world.time - race.startAt!;
      clock = elapsed < 0.8 ? 'GO!' : lapTime(elapsed);
    }
    if (entry.elapsed !== null) clock = lapTime(entry.elapsed);
    if (race.racers.some((r) => r.elapsed !== null || r.withdrawn))
      results = race.racers
        .map((r, i) =>
          r.elapsed !== null
            ? i + 1 + '. ' + r.name + '   ' + lapTime(r.elapsed)
            : r.name + '   ' + (r.withdrawn ? 'DNF' : 'Racing'),
        )
        .join('\n');
  }
  if (el('race-status').textContent !== status) el('race-status').textContent = status;
  el('race-clock').textContent = clock;
  el('race-results').textContent = results;
  el('dismiss-results').hidden = race.phase !== 'results';
}
