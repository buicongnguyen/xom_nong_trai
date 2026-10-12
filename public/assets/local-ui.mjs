import { c as hudStore, aP as storageStore } from './index-Gy4nOY45.js';

const installationKey = Symbol.for('xnt.localUI');
let dismissNotice;
const onlineControls = new Set([
  'hud-xu', 'hud-feedback', 'dock-friends', 'dock-invite', 'dock-pass', 'dock-events', 'dock-chat',
  'panel-chat-ticker-toggle', 'panel-shop-tab-xu', 'panel-shop-tab-affiliate', 'login-toggle',
  'panel-settings-switchAccount', 'panel-settings-switchAccountContinue', 'panel-settings-pushMaster',
  'dock-hamlet', 'dock-explore', 'dock-leaderboard', 'dock-marketLevels', 'dock-watch',
  'dock-reputation', 'dock-fair', 'dock-feedbackFame',
]);

function language() {
  try { const locale = localStorage.getItem('xnt.locale'); if (locale === 'en' || locale === 'vi') return locale; } catch {}
  return document.documentElement.lang.startsWith('en') ? 'en' : 'vi';
}
function availabilityNotice(trigger) {
  dismissNotice?.();
  const english = language() === 'en';
  const overlay = document.createElement('div');
  overlay.id = 'xnt-local-notice';
  overlay.dataset.testid = 'local-availability';
  Object.assign(overlay.style, { position: 'fixed', inset: '0', display: 'grid', placeItems: 'center', padding: '16px', zIndex: '2147483646', background: 'rgba(30,45,22,.25)' });
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'xnt-local-notice-title');
  Object.assign(dialog.style, { width: '100%', maxWidth: '390px', maxHeight: '85dvh', boxSizing: 'border-box', overflow: 'auto', padding: '24px', background: '#fff6e6', color: '#503414', border: '2px solid #33812a', borderRadius: '22px', font: '16px/1.5 system-ui' });
  const title = document.createElement('h2'); title.id = 'xnt-local-notice-title';
  title.textContent = english ? 'Play on this device' : 'Chơi trên thiết bị này';
  title.style.margin = '0 0 12px';
  const message = document.createElement('p');
  message.textContent = english
    ? 'This feature needs an online service and is unavailable in this edition. Your farm saves automatically in this browser. You can earn Xu from daily rewards and leveling up.'
    : 'Tính năng này cần dịch vụ trực tuyến và chưa có trong bản này. Nông trại tự lưu trên trình duyệt hiện tại. Bạn có thể nhận Xu từ điểm danh và lên cấp.';
  const close = document.createElement('button'); close.type = 'button'; close.dataset.testid = 'local-availability-close';
  close.textContent = english ? 'Continue playing' : 'Tiếp tục chơi';
  Object.assign(close.style, { padding: '10px 18px', borderRadius: '12px', border: '2px solid #33812a', background: '#e4f2cf', color: '#503414', font: '700 15px system-ui', cursor: 'pointer' });
  function dismiss() { overlay.remove(); document.removeEventListener('keydown', keydown); dismissNotice = undefined; trigger?.focus(); }
  function keydown(event) { if (event.key === 'Escape') dismiss(); else if (event.key === 'Tab') { event.preventDefault(); close.focus(); } }
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
  document.addEventListener('keydown', keydown);
  dismissNotice = dismiss;
  dialog.append(title, message, close); overlay.append(dialog); document.body.append(overlay); close.focus();
}

// Run after the Pages backend and mirrored client have loaded. Browser storage
// events update the authoritative farm; this refreshes the corresponding HUD.
export function installLocalUI() {
  if (globalThis[installationKey]) return globalThis[installationKey];
  const basePath = new URL('../', import.meta.url).pathname;
  const saveKey = `xnt:pages:${basePath}:farm/farm.json`;
  let disposed = false;
  let pending = false;
  let inFlight;
  // Do not send users into online-only panels or forms that cannot succeed.
  // Keep the original controls discoverable and explain their availability.
  function blocked(button) {
    if (onlineControls.has(button.dataset.testid)) return true;
    if (button.matches('[data-testid="panel-settings-account"] .xacc-actions button:not([data-testid])')) return true;
    const action = button.getAttribute('data-action-id') || button.getAttribute('data-action') || '';
    return /^(?:shortcut|menu)\.(?:friends|invite|pass|events|leaderboards|village|hamlet|chat|fair|reputation|explore|watch|feedback)/.test(action);
  }
  function annotate() {
    for (const button of document.querySelectorAll('button')) if (blocked(button)) {
      if (button.dataset.xntOnline !== 'true') button.dataset.xntOnline = 'true';
      const title = language() === 'en' ? 'Online feature unavailable in this edition' : 'Tính năng trực tuyến chưa có trong bản này';
      if (button.title !== title) button.title = title;
    }
    const actions = document.querySelector('[data-testid="panel-settings-account"] .xacc-actions');
    if (actions) {
      const note = [...actions.children].find(child => child.tagName !== 'BUTTON');
      const text = language() === 'en' ? 'Your farm saves automatically in this browser. Online accounts are unavailable.' : 'Nông trại tự lưu trên trình duyệt này. Tài khoản trực tuyến chưa khả dụng.';
      if (note && note.textContent !== text) note.textContent = text;
    }
  }
  function guard(event) {
    const button = event.target.closest?.('button');
    if (!button || !blocked(button)) return;
    event.preventDefault(); event.stopImmediatePropagation(); availabilityNotice(button);
  }
  document.addEventListener('click', guard, true);
  const onOnlineRequest = () => availabilityNotice(document.activeElement);
  globalThis.addEventListener('xnt:online-unavailable', onOnlineRequest);
  const observer = new MutationObserver(annotate);
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  annotate();

  function refresh() {
    if (disposed) return Promise.resolve(false);
    if (inFlight) { pending = true; return inFlight; }
    inFlight = (async () => {
      if (globalThis.__xntLocalReady) await globalThis.__xntLocalReady;
      const [profileResponse, storageResponse] = await Promise.all([
        globalThis.fetch('/api/users/me'), globalThis.fetch('/api/storage'),
      ]);
      if (!profileResponse.ok || !storageResponse.ok) return false;
      const [profile, inventory] = await Promise.all([profileResponse.json(), storageResponse.json()]);
      if (disposed) return false;
      hudStore.getState().setWallet(profile.wallet);
      storageStore.getState().applyStorage(inventory.storage);
      return true;
    })().catch(error => {
      console.warn('Unable to refresh local farm display:', error);
      return false;
    }).finally(() => {
      inFlight = undefined;
      if (pending && !disposed) { pending = false; refresh(); }
    });
    return inFlight;
  }

  const onStorage = event => {
    if (event.key === null || event.key === saveKey) refresh();
  };
  const onVisible = () => { if (!globalThis.document.hidden) refresh(); };
  const onPageShow = () => refresh();
  globalThis.addEventListener('storage', onStorage);
  globalThis.addEventListener('pageshow', onPageShow);
  globalThis.document.addEventListener('visibilitychange', onVisible);
  const installation = {
    refresh,
    dispose() {
      disposed = true;
      globalThis.removeEventListener('storage', onStorage);
      globalThis.removeEventListener('pageshow', onPageShow);
      globalThis.document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('click', guard, true);
      globalThis.removeEventListener('xnt:online-unavailable', onOnlineRequest);
      dismissNotice?.();
      observer.disconnect();
      delete globalThis[installationKey];
    },
  };
  globalThis[installationKey] = installation;
  return installation;
}

export default installLocalUI;

// Node edition uses native API calls; Pages explicitly installs after boot.
if (!globalThis.__xntLocalReady) installLocalUI();
