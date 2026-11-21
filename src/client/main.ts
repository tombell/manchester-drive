import type { Position } from '../game/game-types';
import { heldOnGrid } from '../game/race';
import { clampToM60, mapChunk } from '../game/region';
import { useBrowserMap } from './map';
import { snapshotRoadUsers, type Snapshot, type VisiblePlayer } from '../protocol/snapshots';
import { cameraCells } from '../protocol/view';
import { streetAt } from '../game/streets';
import { createWorld, drive, walk, JUNCTION } from '../game/world';
import type { Credentials } from '../protocol/commands';
import { setupChat } from './chat';
import { el, notice, outfit, setupGarage, updateHud } from './hud';
import { leaveOnPageHide, post, subscribeToRoom } from './network';
import { makeRenderer, viewport } from './renderer';

useBrowserMap();
const map = el('map');
const render = makeRenderer(map),
  initial: Snapshot = { ...createWorld(), players: [], parkedCars: [], playerCount: 0 };
const keyBits: Record<string, number> = { KeyW: 1, KeyS: 2, KeyA: 4, KeyD: 8 };
let session: Credentials | null = null,
  sequence = 0,
  keyboard = 0,
  touch = 0,
  busy = false;
let frames: { state: Snapshot; now: number }[] = [],
  predicted: VisiblePlayer | null = null,
  connected = false;
let freeCam = false;
const panKeys = new Set<string>();
const panDirections: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};
let drag: { id: number; x: number; y: number } | null = null;
let focus = { ...JUNCTION },
  lastDraw = performance.now();
let doorBusy = false,
  raceBusy = false,
  dismissedRace: string | undefined;
setupGarage();
const chat = setupChat(release);

function updateUI() {
  chat.updateSession(session?.token, connected);
  updateHud({
    world: frames.at(-1)?.state,
    playerId: session?.id,
    predicted,
    freeCam,
    connected,
    busy,
    doorBusy,
    raceBusy,
    dismissedRace,
  });
}
el('dismiss-results').onclick = () => {
  dismissedRace = frames.at(-1)?.state.race?.id;
  updateUI();
};
el('race-action').onclick = async () => {
  if (!session || raceBusy) return;
  const { action, raceId } = el('race-action').dataset;
  if (action !== 'open' && action !== 'join' && action !== 'withdraw') return;
  raceBusy = true;
  updateUI();
  notice('');
  try {
    const response = await post('/race', { token: session.token, action, raceId: raceId || null });
    if (!response.ok) notice(response.error || 'Could not update race.');
  } catch {
    notice('Could not reach the race. Try again.');
  } finally {
    raceBusy = false;
    updateUI();
  }
};
function reset() {
  session = null;
  predicted = null;
  keyboard = touch = 0;
  document
    .querySelectorAll<HTMLButtonElement>('.touch button')
    .forEach((b) => b.classList.remove('active'));
  updateUI();
}
async function sendInput() {
  if (!session || doorBusy) return;
  const token = session.token;
  try {
    const result = await post('/input', {
      token,
      keys: keyboard | touch,
      seq: ++sequence,
      onFoot: !!predicted?.parkedCarId,
    });
    if (!result.ok && result.status === 401 && session?.token === token) {
      reset();
      notice(result.error);
    }
  } catch {
    /* EventSource reports the connection state and the heartbeat retries. */
  }
}
el('join').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || session || !connected) return;
  busy = true;
  updateUI();
  notice('');
  try {
    const result = await post('/join', { name: el('name').value, ...outfit() });
    if (!result.ok) throw new Error(result.error || 'Could not join.');
    session = result.data;
    sequence = 0;
    el('name').blur();
    sendInput();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'Could not join.');
  } finally {
    busy = false;
    updateUI();
  }
});
async function openDoor() {
  if (!session || !predicted || !connected || doorBusy || freeCam) return;
  doorBusy = true;
  release();
  updateUI();
  notice('');
  try {
    const result = await post('/vehicle', {
      token: session.token,
      seq: ++sequence,
      action: predicted.parkedCarId ? 'enter' : 'exit',
    });
    if (!result.ok) notice(result.error || 'Could not use the car door.');
  } catch {
    notice('Could not reach the car. Try again.');
  } finally {
    doorBusy = false;
    updateUI();
  }
}
el('door').onclick = openDoor;
el('leave').onclick = async () => {
  if (!session) return;
  const token = session.token;
  try {
    const result = await post('/leave', { token });
    if (result.status === 200 || result.status === 401) {
      reset();
      notice('');
    } else notice('Could not leave. Try again.');
  } catch {
    notice('Could not reach the junction. Try again.');
  }
};
function release() {
  panKeys.clear();
  if (drag) {
    if (map.hasPointerCapture(drag.id)) map.releasePointerCapture(drag.id);
    drag = null;
  }
  if (!keyboard && !touch) return;
  keyboard = touch = 0;
  document
    .querySelectorAll<HTMLButtonElement>('.touch button')
    .forEach((b) => b.classList.remove('active'));
  sendInput();
}
window.addEventListener('blur', release);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) release();
});
window.addEventListener('pagehide', () => {
  if (session) leaveOnPageHide(session.token);
});
function moveCamera(dx = 0, dy = 0) {
  Object.assign(focus, clampToM60(focus.x + dx, focus.y + dy));
}
function toggleCamera() {
  release();
  freeCam = !freeCam;
  map.classList.toggle('free-cam', freeCam);
  if (freeCam) moveCamera();
  else Object.assign(focus, session && predicted ? predicted : JUNCTION);
  updateUI();
}
el('camera').onclick = toggleCamera;
map.addEventListener('pointerdown', (event) => {
  if (!freeCam || !event.isPrimary || event.button !== 0) return;
  map.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
map.addEventListener('pointermove', (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  const view = viewport(map);
  moveCamera(
    ((drag.x - event.clientX) * view.width) / map.clientWidth,
    ((drag.y - event.clientY) * view.height) / map.clientHeight,
  );
  drag.x = event.clientX;
  drag.y = event.clientY;
});
map.addEventListener('lostpointercapture', (event) => {
  if (drag?.id === event.pointerId) drag = null;
});
for (const type of ['keydown', 'keyup'] as const)
  window.addEventListener(type, (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    if (
      event.target instanceof HTMLElement &&
      (event.target.isContentEditable || event.target.matches('input, textarea, select'))
    )
      return;
    if (session && event.code === 'KeyT' && type === 'keydown' && !event.repeat) {
      event.preventDefault();
      el('chat-input').focus({ preventScroll: true });
      return;
    }
    if (event.target instanceof Element && event.target.closest('#chat-panel')) return;
    if (freeCam) {
      if (event.code === 'Escape' && type === 'keydown') toggleCamera();
      else if (Object.hasOwn(panDirections, event.code)) {
        event.preventDefault();
        if (type === 'keyup') panKeys.delete(event.code);
        else if (!event.repeat) panKeys.add(event.code);
      }
      return;
    }
    if (session && event.code === 'KeyE' && type === 'keydown' && !event.repeat) {
      event.preventDefault();
      openDoor();
      return;
    }
    if (doorBusy) return;
    const bit = keyBits[event.code];
    if (!session || !bit || (type === 'keydown' && event.repeat)) return;
    event.preventDefault();
    const next = type === 'keydown' ? keyboard | bit : keyboard & ~bit;
    if (next !== keyboard) {
      keyboard = next;
      sendInput();
    }
  });
for (const button of document.querySelectorAll<HTMLButtonElement>('.touch button')) {
  const bit = Number(button.dataset.bit);
  button.onpointerdown = (event) => {
    if (doorBusy) return;
    event.preventDefault();
    map.focus({ preventScroll: true });
    button.setPointerCapture(event.pointerId);
    touch |= bit;
    button.classList.add('active');
    sendInput();
  };
  button.onlostpointercapture = () => {
    touch &= ~bit;
    button.classList.remove('active');
    sendInput();
  };
}
setInterval(sendInput, 900);

subscribeToRoom(
  (state) => {
    connected = true;
    frames.push({ state, now: performance.now() });
    if (frames.length > 6) frames.shift();
    const player = state.players.find((p) => p.id === session?.id);
    if (player) predicted = { ...player };
    const count = state.playerCount;
    el('count').textContent = count === 1 ? '1 player' : count + ' players';
    updateUI();
  },
  chat.receive,
  () => {
    connected = false;
    frames = [];
    release();
    updateUI();
  },
  () => {
    const { width, height } = viewport(map);
    return { area: cameraCells(focus, width, height), token: session?.token };
  },
);

function interpolate<
  T extends Position & { id: string; angle?: number; parkedCarId?: string | null },
>(list: T[], before: T[], t: number): T[] {
  const prior = new Map(before.map((o) => [o.id, o]));
  return list.map((v) => {
    const p = prior.get(v.id);
    if (!p || p.parkedCarId !== v.parkedCarId || Math.hypot(v.x - p.x, v.y - p.y) > 100) return v;
    return {
      ...v,
      x: p.x + (v.x - p.x) * t,
      y: p.y + (v.y - p.y) * t,
      angle:
        v.angle === undefined || p.angle === undefined
          ? undefined
          : p.angle + Math.atan2(Math.sin(v.angle - p.angle), Math.cos(v.angle - p.angle)) * t,
    };
  });
}
function scene(now: number): Snapshot {
  if (!frames.length) return initial;
  const target = now - 90;
  const end = frames.findIndex((f) => f.now >= target);
  if (end === 0) return frames[0].state;
  if (end < 0) return frames.at(-1)!.state;
  const a = frames[end - 1],
    b = frames[end],
    t = (target - a.now) / (b.now - a.now);
  return {
    ...b.state,
    time: a.state.time + (b.state.time - a.state.time) * t,
    players: interpolate(b.state.players, a.state.players, t),
    traffic: interpolate(b.state.traffic, a.state.traffic, t),
    people: interpolate(b.state.people, a.state.people, t),
  };
}
function draw(now: number) {
  const dt = Math.min(0.05, (now - lastDraw) / 1000);
  lastDraw = now;
  let world = scene(now);
  if (predicted && session && connected) {
    const latest = frames.at(-1)!.state;
    const { vehicles, people } = snapshotRoadUsers(latest);
    const terrainReady = !!mapChunk(predicted.x, predicted.y);
    if (predicted.parkedCarId) {
      if (terrainReady) walk(predicted, keyboard | touch, dt, vehicles, people);
      const carId = predicted.parkedCarId;
      const parking = latest.parkingPosition ?? latest.parkedCars.find((car) => car.id === carId);
      if (parking) {
        const dx = parking.x - predicted.x,
          dy = parking.y - predicted.y;
        const directions = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
        const heading = directions[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
        el('car-location').textContent =
          'Car · ' + Math.round(Math.hypot(dx, dy) / 5) + ' m ' + heading;
      } else el('car-location').textContent = 'Locating car…';
    } else if (terrainReady && !heldOnGrid(latest.race, session.id)) {
      drive(predicted, keyboard | touch, dt, vehicles, people, false);
    }
    // Predict the local pose, but render the same lamp signals spectators receive.
    const local = predicted;
    world = {
      ...world,
      players: world.players.map((p) =>
        p.id === local.id ? { ...local, rearLights: p.rearLights } : p,
      ),
    };
    el('speed').textContent = String(Math.round(Math.abs(predicted.speed) * 0.45)).padStart(2, '0');
    el('gear').textContent =
      Math.abs(predicted.speed) < 0.8 ? 'N' : predicted.speed > 0 ? 'D' : 'R';
  }
  if (freeCam) {
    let dx = 0,
      dy = 0;
    for (const key of panKeys) {
      dx += panDirections[key][0];
      dy += panDirections[key][1];
    }
    const distance = (520 * dt) / (Math.hypot(dx, dy) || 1);
    moveCamera(dx * distance, dy * distance);
  } else {
    const target = session && predicted ? predicted : JUNCTION;
    focus.x += (target.x - focus.x) * (1 - Math.exp(-5 * dt));
    focus.y += (target.y - focus.y) * (1 - Math.exp(-5 * dt));
  }
  const street = streetAt(focus.x, focus.y);
  const streetLabel = el('street-name');
  if (streetLabel.textContent !== street) streetLabel.textContent = street;
  render(world, freeCam ? undefined : session?.id, focus);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
