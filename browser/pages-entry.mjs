import { createBackend } from '../src/backend.mjs';

// esbuild emits this file at the Pages project root. Never contact the original
// game's services: API requests and world updates run in this browser instead.
export async function bootPagesRuntime({ baseUrl = new URL('.', import.meta.url), gameSpeed = 1 } = {}) {
  baseUrl = new URL(baseUrl, globalThis.location.href);
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  const realFetch = globalThis.fetch.bind(globalThis);
  const configResponse = await realFetch(new URL('config/game.json', baseUrl));
  if (!configResponse.ok) throw new Error(`Unable to load game configuration (${configResponse.status}).`);
  const config = await configResponse.json();
  // localStorage alone cannot make a read-modify-save transaction atomic across
  // tabs. Hold one project-wide browser lock for initialization and each request.
  if (!globalThis.navigator?.locks?.request) {
    throw new Error('This browser cannot safely save local farms. Use an up-to-date browser on HTTPS or localhost.');
  }
  const lockName = `xnt:pages:${new URL('.', import.meta.url).pathname}:farm`;
  const withFarmLock = callback => globalThis.navigator.locks.request(lockName, { mode: 'exclusive' }, callback);
  const backend = await withFarmLock(() => createBackend({ dataDir: 'farm', config, gameSpeed }));
  const sockets = new Set();
  let publishedWorld = backend.getWorld();
  let publishedObjects = new Map(publishedWorld.objects.map(object => [object.id, JSON.stringify(object)]));
  let publishedTutorialStep = backend.getState().user.tutorialStep;
  let refreshTimer;
  let resetDetected = false;

  function detectReset(error) {
    if (error.code !== 'SAVE_RESET') throw error;
    resetDetected = true;
    globalThis.clearInterval(refreshTimer);
    refreshTimer = undefined;
    const document = globalThis.document;
    if (document && !document.getElementById('xnt-local-save-reset')) {
      const notice = document.createElement('div');
      notice.id = 'xnt-local-save-reset';
      notice.setAttribute('role', 'alert');
      Object.assign(notice.style, {
        position: 'fixed', inset: '16px 16px auto', zIndex: '2147483647', maxWidth: '460px',
        margin: '0 auto', padding: '20px', background: '#fff6e6', color: '#503414',
        border: '2px solid #33812a', borderRadius: '16px', font: '16px system-ui', textAlign: 'center',
      });
      const text = document.createElement('p');
      text.textContent = 'Dữ liệu nông trại đã được đặt lại ở thẻ khác. Hãy tải lại trang để tiếp tục.';
      const button = document.createElement('button');
      button.textContent = 'Tải lại';
      Object.assign(button.style, { padding: '10px 18px', cursor: 'pointer' });
      button.addEventListener('click', () => globalThis.location.reload());
      notice.append(text, button);
      (document.body || document.documentElement).append(notice);
    }
  }

  function reloadFarm() {
    if (resetDetected) return false;
    try {
      backend.reload();
      if (backend.getState().user.id !== publishedWorld.owner.id) {
        throw Object.assign(new Error('This farm was replaced in another tab.'), { code: 'SAVE_RESET' });
      }
      return true;
    }
    catch (error) { detectReset(error); return false; }
  }

  function publishWorld() {
    const world = backend.getWorld();
    const objects = new Map(world.objects.map(object => [object.id, JSON.stringify(object)]));
    const changed = world.objects.filter(object => publishedObjects.get(object.id) !== objects.get(object.id));
    const removed = [...publishedObjects.keys()].filter(id => !objects.has(id));
    if (world.owner.id !== publishedWorld.owner.id) {
      for (const socket of sockets) socket.message({ t: 'resync', p: {} });
    } else if (changed.length || removed.length) {
      for (const socket of sockets) socket.message({ t: 'world_delta', p: {
        ownerId: world.owner.id, objects: changed, removed,
      } });
    }
    const tutorialStep = backend.getState().user.tutorialStep;
    if (tutorialStep !== publishedTutorialStep) {
      for (const socket of sockets) socket.message({ t: 'tutorial_update', p: {
        step: tutorialStep, completedStepId: `local_${publishedTutorialStep}`,
      } });
    }
    publishedWorld = world;
    publishedObjects = objects;
    publishedTutorialStep = tutorialStep;
  }

  function syncWorld() {
    if (resetDetected) return Promise.resolve();
    return withFarmLock(() => {
      if (reloadFarm()) publishWorld();
    });
  }

  function localPath(url) {
    return basePath && url.pathname.startsWith(basePath + '/')
      ? url.pathname.slice(basePath.length) : url.pathname;
  }
  function sameOrigin(url) {
    return url.host === baseUrl.host && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
  }
  function errorResponse(code, message, status = 501) {
    return new Response(JSON.stringify({ error: { code, message } }), { status, headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Server-Time': backend.getServerTime(), 'X-Game-Speed': String(gameSpeed),
    } });
  }

  globalThis.fetch = async function localFetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location.href);
    const pathname = localPath(url);
    if (!sameOrigin(url) || !(pathname === '/api' || pathname.startsWith('/api/'))) return realFetch(input, init);
    const request = new Request(input instanceof Request ? input : url, init);
    if (request.signal.aborted) throw request.signal.reason || new DOMException('Request aborted', 'AbortError');
    let body = {};
    if (!['GET', 'HEAD'].includes(request.method)) {
      const text = await request.text();
      if (text.length > 65536) return errorResponse('BODY_TOO_LARGE', 'Request too large.', 413);
      if (text) {
        try { body = JSON.parse(text); }
        catch { return errorResponse('INVALID_JSON', 'Invalid JSON.', 400); }
      }
    }
    if (['/api/auth/register', '/api/auth/login'].includes(pathname)) {
      return errorResponse('LOCAL_UNAVAILABLE', 'Online accounts are unavailable in this browser-only demo. Play as a guest; your farm saves on this device.');
    }
    let status = 200;
    let contents = '';
    const headers = new Headers();
    const response = {
      setHeader(name, value) { if (name.toLowerCase() !== 'set-cookie') headers.set(name, value); },
      writeHead(code, values) { status = code; for (const [name, value] of Object.entries(values)) headers.set(name, value); },
      end(value = '') { contents = String(value); },
    };
    return withFarmLock(async () => {
      if (request.signal.aborted) throw request.signal.reason || new DOMException('Request aborted', 'AbortError');
      if (!reloadFarm()) return errorResponse('SAVE_RESET', 'This farm was reset in another tab. Reload the game to continue.', 409);
      const handled = await backend.handle({ method: request.method, url: pathname + url.search }, response, pathname, body);
      publishWorld();
      if (request.signal.aborted) throw request.signal.reason || new DOMException('Request aborted', 'AbortError');
      if (!handled) return errorResponse('LOCAL_UNAVAILABLE', 'Tính năng này cần máy chủ trực tuyến của trò chơi gốc. Bản trình duyệt hỗ trợ trồng trọt, chăn nuôi, sản xuất và xây dựng.');
      return new Response(request.method === 'HEAD' ? null : contents, { status, headers });
    });
  };

  class LocalWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0; bufferedAmount = 0; extensions = ''; protocol = ''; binaryType = 'blob';
    onopen = null; onmessage = null; onerror = null; onclose = null;
    constructor(input) {
      super();
      const url = new URL(input, globalThis.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
      this.url = url.href;
      const accepted = sameOrigin(url) && localPath(url) === '/ws';
      setTimeout(() => {
        if (this.readyState !== this.CONNECTING) return;
        if (!accepted) {
          this.emit('error', new Event('error'));
          this.close(1008, 'Only local game connections are available.');
          return;
        }
        this.readyState = this.OPEN;
        sockets.add(this);
        this.emit('open', new Event('open'));
        this.message({ t: 'hello', p: { serverTime: backend.getServerTime(), configVersion: config.version || '1.0.0', lastEventId: 0 } });
      }, 0);
    }
    emit(type, event) {
      this.dispatchEvent(event);
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, event);
    }
    message(value) {
      if (this.readyState === this.OPEN) this.emit('message', new MessageEvent('message', { data: JSON.stringify(value), origin: baseUrl.origin }));
    }
    send(data) {
      if (this.readyState === this.CONNECTING) throw new DOMException('The connection is not open.', 'InvalidStateError');
      if (this.readyState !== this.OPEN) return;
      try { if (JSON.parse(String(data)).t === 'ping') queueMicrotask(() => this.message({ t: 'pong', p: {} })); }
      catch {}
    }
    close(code = 1000, reason = '') {
      if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
      this.readyState = this.CLOSING;
      sockets.delete(this);
      queueMicrotask(() => {
        this.readyState = this.CLOSED;
        this.emit('close', new CloseEvent('close', { code, reason, wasClean: true }));
      });
    }
  }
  globalThis.WebSocket = LocalWebSocket;
  backend.setOnMutation(publishWorld);
  const refresh = () => syncWorld().catch(error => console.error('Unable to refresh local farm:', error));
  const startRefreshing = () => {
    if (!resetDetected && refreshTimer === undefined) refreshTimer = globalThis.setInterval(refresh, 1000);
  };
  startRefreshing();
  globalThis.addEventListener('storage', event => {
    if (event.key === null || event.key.endsWith(':farm/farm.json')) refresh();
  });
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (!globalThis.document.hidden) refresh();
  });
  globalThis.addEventListener('pageshow', () => { startRefreshing(); refresh(); });
  globalThis.addEventListener('pagehide', () => {
    globalThis.clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
  return backend;
}

