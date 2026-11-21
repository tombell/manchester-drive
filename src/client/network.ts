import type { ChatEvent } from '../protocol/chat';
import type { Snapshot } from '../protocol/snapshots';
import type { Commands, Credentials } from '../protocol/commands';
import { areaKey } from '../protocol/view';
import type { CellBounds } from '../game/spatial';
import { decodeSnapshot, snapshotPath } from '../protocol/snapshots';

type Reply<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };
export async function post<P extends keyof Commands>(
  path: P,
  data: Commands[P],
): Promise<Reply<P extends '/join' ? Credentials : object>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const body = (await response.json()) as { error: string };
    return { ok: false, status: response.status, error: body.error };
  }
  return { ok: true, status: response.status, data: await response.json() };
}

export function subscribeToRoom(
  onSnapshot: (world: Snapshot) => void,
  onChat: (update: ChatEvent) => void,
  onDisconnect: (restarting: boolean) => void,
  currentView: () => { area: CellBounds; token?: string },
) {
  const events = new EventSource(snapshotPath);
  let viewer = '',
    sent = '',
    pending = false,
    nextAttempt = 0,
    build = '',
    restarting = false;
  // A reconnect that reaches a new deploy needs the new client and map.
  events.addEventListener('build', (event) => {
    if (build && build !== event.data) location.reload();
    build = event.data;
  });
  events.addEventListener('restart', () => {
    restarting = true;
  });
  events.addEventListener('viewer', (event) => {
    viewer = event.data;
    restarting = false;
    sent = '';
    nextAttempt = 0;
    void updateView();
  });
  events.addEventListener('chat', (event) => onChat(JSON.parse(event.data)));
  events.onerror = () => {
    viewer = '';
    onDisconnect(restarting);
  };
  events.onmessage = (event) => onSnapshot(decodeSnapshot(event.data));

  // Keep the event stream and chat history intact while panning or resizing.
  async function updateView() {
    const now = performance.now();
    if (!viewer || pending || now < nextAttempt) return;
    const { area, token } = currentView();
    const key = areaKey(area) + '/' + (token ?? '');
    if (sent === key) return;
    const id = viewer;
    pending = true;
    try {
      const result = await post('/view', { viewer: id, area, token });
      if (result.ok && viewer === id) sent = key;
      else nextAttempt = performance.now() + 500;
    } catch {
      nextAttempt = performance.now() + 500;
    } finally {
      pending = false;
    }
  }
  setInterval(updateView, 100);
}

export function leaveOnPageHide(token: string) {
  navigator.sendBeacon('/leave', JSON.stringify({ token } satisfies Commands['/leave']));
}
