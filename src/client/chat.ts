import {
  chatHistoryLimit,
  chatTextLimit,
  localChatMetres,
  withinEarshot,
  type ChatEvent,
  type ChatMessage,
} from '../protocol/chat';
import type { VisiblePlayer } from '../protocol/snapshots';
import { el } from './hud';
import { post } from './network';

export function setupChat(releaseControls: () => void) {
  const panel = el('chat-panel'),
    log = el('chat-log');
  const form = el('chat-form'),
    input = el('chat-input'),
    send = el('chat-send');
  const status = el('chat-status'),
    channel = el('chat-channel'),
    layer = el('speech-bubbles');
  const bubbles = new Map<string, { element: HTMLElement; until: number }>();
  input.maxLength = chatTextLimit;
  let token: string | undefined,
    online = false,
    sending = false,
    error = '';

  panel.addEventListener('focusin', releaseControls);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      el('map').focus({ preventScroll: true });
    }
  });

  function refreshForm() {
    form.hidden = !token;
    channel.hidden = !token;
    channel.disabled = sending;
    const local = channel.value === 'local';
    el('chat-title').textContent = local ? 'Local chat' : 'Global chat';
    input.placeholder = local ? `Speak within ${localChatMetres} m…` : 'Message everyone…';
    log.hidden = local;
    el('chat-empty').hidden = local || !!log.childElementCount;
    send.disabled = !online || sending || !input.value.trim();
    status.textContent = !online
      ? 'Reconnecting…'
      : !token
        ? 'Join the game to send a message.'
        : error;
    status.hidden = !status.textContent;
  }
  input.oninput = refreshForm;
  function channelChanged() {
    error = '';
    refreshForm();
  }
  channel.onchange = () => {
    channelChanged();
    input.focus();
  };
  window.addEventListener('keydown', (event) => {
    if (!token || event.key !== 'Enter' || !event.altKey) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (event.repeat || channel.disabled) return;
    channel.value = channel.value === 'global' ? 'local' : 'global';
    channelChanged();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const draft = input.value,
      sender = token;
    if (!sender || !online || sending || !draft.trim()) return;
    input.focus();
    sending = true;
    error = '';
    refreshForm();
    try {
      const reply = await post('/chat', {
        token: sender,
        text: draft.trim(),
        channel: channel.value === 'local' ? 'local' : 'global',
      });
      if (sender !== token) return;
      if (!reply.ok) error = reply.error;
      else if (input.value === draft) input.value = '';
    } catch {
      if (sender === token)
        error = 'Message could not be confirmed. Check the chat before retrying.';
    } finally {
      sending = false;
      refreshForm();
    }
  };

  function append(message: ChatMessage) {
    const line = document.createElement('p'),
      name = document.createElement('strong');
    name.style.color = message.color;
    name.textContent = message.name;
    line.append(name, ' ', message.text);
    log.append(line);
  }

  function receive(event: ChatEvent) {
    if (event.type === 'local') {
      if (!token) return;
      const element = bubbles.get(event.playerId)?.element ?? document.createElement('span');
      element.className = 'speech-bubble';
      element.hidden = true;
      element.textContent = event.text;
      if (!element.isConnected) layer.append(element);
      bubbles.set(event.playerId, { element, until: performance.now() + 6000 });
      return;
    }
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 12;
    if (event.type === 'history') {
      log.replaceChildren();
      for (const message of event.messages) append(message);
    } else {
      append(event.message);
      if (log.childElementCount > chatHistoryLimit) log.firstElementChild!.remove();
    }
    el('chat-empty').hidden = log.hidden || !!log.childElementCount;
    if (atEnd) log.scrollTop = log.scrollHeight;
  }

  function drawBubbles(
    players: VisiblePlayer[],
    listener: VisiblePlayer | null,
    now: number,
    view: { x: number; y: number; width: number; height: number },
  ) {
    for (const [id, { element, until }] of bubbles) {
      if (now >= until) {
        element.remove();
        bubbles.delete(id);
        continue;
      }
      const speaker = players.find((p) => p.id === id);
      if (!speaker || !listener || !withinEarshot(speaker, listener)) {
        element.hidden = true;
        continue;
      }
      if (element.hidden) {
        element.setAttribute('aria-label', speaker.name + ' says ' + element.textContent);
        element.hidden = false;
      }
      element.style.left = ((speaker.x - view.x) / view.width) * 100 + '%';
      element.style.top = ((speaker.y - view.y - 25) / view.height) * 100 + '%';
    }
  }

  function updateSession(next: string | undefined, connected: boolean) {
    if (next === token && connected === online) return;
    if (next !== token) {
      channel.value = 'global';
      input.value = '';
      error = '';
    }
    if (next !== token || !connected) {
      layer.replaceChildren();
      bubbles.clear();
    }
    token = next;
    online = connected;
    refreshForm();
  }
  return { receive, updateSession, drawBubbles };
}
