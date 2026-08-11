/* ============================================================
   Notify — a portable popup notification system
   ------------------------------------------------------------
   Drop this single file into any web page:

     <script src="notify.js"></script>

   It needs nothing else (no CSS file, no framework, no other
   script on the page) — it injects its own scoped stylesheet
   and exposes one global: `Notify`.

   WHAT IT GIVES YOU
   -----------------
   1. Toast popups  — small cards that stack in a corner of the
      screen and auto-dismiss. Multiple can be on screen at once.
        Notify.success("Saved.");
        Notify.error("Could not save changes.");
        Notify.info("Heads up: maintenance at 10pm.");
        Notify.warning("Your session will expire soon.");
        Notify.toast("Custom message", { type: "success", duration: 4000 });

   2. Notification centre — an optional bell icon + dropdown
      panel that keeps a running, unread-counted list of
      notifications (for things the user should be able to look
      back on later, not just a fleeting toast).
        Notify.mountBell("#bell-slot");     // renders the bell button
        Notify.notify({ title: "Leave approved", message: "…" });

   `Notify.notify(...)` is the "do both" call: it shows a toast
   AND (if a bell is mounted) adds an entry to the notification
   centre. Use `Notify.toast(...)` when you only want the toast.

   No demo/sample notifications ship with this file — the panel
   starts empty and only ever shows what your app pushes to it.

   CONFIGURATION (all optional — call before or after mountBell)
   ---------------------------------------------------------
     Notify.init({
       position: "top-right",   // top-right | top-left | bottom-right | bottom-left
       maxToasts: 4,             // stacked toasts before the oldest is dropped
       defaultDuration: 4200,    // ms a toast stays up (0 = sticky/manual close)
       persistKey: null          // e.g. "myapp_notifications" to remember the
                                  // notification-centre list across reloads via
                                  // localStorage. Left null by default so every
                                  // page starts with a clean, empty list.
     });

   INTEGRATION NOTES
   ------------------
   - Colours fall back to CSS vars already defined on the host
     page when present (--brand, --absent, --amber, --ink, etc.),
     and to sensible defaults otherwise — so it reskins itself
     automatically to match Alignt, but still looks fine on a
     page with none of those variables defined.
   - Everything is namespaced under "nk-" class names and is
     rendered inside a single <div id="nk-root"> appended to
     <body>, so it won't collide with existing markup/CSS.
   ============================================================ */

(function (global) {
  "use strict";

  if (global.Notify) return; // avoid double-init if included twice

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */
  const state = {
    position: "top-right",
    maxToasts: 4,
    defaultDuration: 4200,
    persistKey: null,
    items: [],          // notification-centre entries
    idSeq: 1,
    bell: null,         // { root, btn, badge, panel, list, empty } once mounted
    panelOpen: false,
    listeners: []        // subscribers via Notify.subscribe
  };

  let root = null;         // #nk-root container
  let toastLayer = null;   // toast stack element
  let stylesInjected = false;

  /* ----------------------------------------------------------
     Style injection (scoped, variable-driven, single <style>)
     ---------------------------------------------------------- */
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;

    const css = `
#nk-root{
  --nk-accent: var(--brand, #2563EB);
  --nk-accent-ink: var(--brand-dark, #1E4FBF);
  --nk-success: var(--present, #1F9D6C);
  --nk-warning: var(--amber, #F2A93B);
  --nk-danger: var(--absent, #D9534F);
  --nk-info: var(--nk-accent);
  --nk-card: var(--card, #FFFFFF);
  --nk-ink: var(--ink, #16241F);
  --nk-ink-soft: var(--ink-soft, #4B5A54);
  --nk-muted: var(--muted, #7C8A84);
  --nk-line: var(--line, #E1E5E3);
  --nk-radius-s: var(--radius-s, 8px);
  --nk-radius-m: var(--radius-m, 14px);
  --nk-shadow: var(--shadow-2, 0 16px 40px -16px rgba(20,30,25,.32));
  --nk-font: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif);
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: var(--nk-font);
}

/* ---- toast stack ---- */
.nk-toast-layer{
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: min(360px, calc(100vw - 32px));
  padding: 16px;
  pointer-events: none;
}
.nk-pos-top-right{ top: 0; right: 0; align-items: flex-end; }
.nk-pos-top-left{ top: 0; left: 0; align-items: flex-start; }
.nk-pos-bottom-right{ bottom: 0; right: 0; align-items: flex-end; flex-direction: column-reverse; }
.nk-pos-bottom-left{ bottom: 0; left: 0; align-items: flex-start; flex-direction: column-reverse; }

.nk-toast{
  pointer-events: auto;
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: flex-start;
  background: var(--nk-card);
  color: var(--nk-ink);
  border: 1px solid var(--nk-line);
  border-radius: var(--nk-radius-m);
  box-shadow: var(--nk-shadow);
  padding: 12px 12px 12px 14px;
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(-8px) scale(.98);
  transition: opacity .22s ease, transform .22s ease;
  border-left: 4px solid var(--nk-accent);
}
.nk-pos-bottom-right .nk-toast,
.nk-pos-bottom-left .nk-toast{ transform: translateY(8px) scale(.98); }
.nk-toast.nk-show{ opacity: 1; transform: translateY(0) scale(1); }
.nk-toast.nk-hide{ opacity: 0; transform: translateY(-6px) scale(.97); }
.nk-toast--success{ border-left-color: var(--nk-success); }
.nk-toast--warning{ border-left-color: var(--nk-warning); }
.nk-toast--danger{  border-left-color: var(--nk-danger); }
.nk-toast--info{    border-left-color: var(--nk-info); }

.nk-toast-icon{
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-top: 1px;
  background: color-mix(in srgb, var(--nk-accent) 16%, transparent);
  color: var(--nk-accent);
}
.nk-toast--success .nk-toast-icon{ background: color-mix(in srgb, var(--nk-success) 16%, transparent); color: var(--nk-success); }
.nk-toast--warning .nk-toast-icon{ background: color-mix(in srgb, var(--nk-warning) 20%, transparent); color: #8a5e13; }
.nk-toast--danger  .nk-toast-icon{ background: color-mix(in srgb, var(--nk-danger) 16%, transparent);  color: var(--nk-danger); }
.nk-toast-icon svg{ width: 13px; height: 13px; }

.nk-toast-body{ min-width: 0; }
.nk-toast-title{ margin: 0; font-weight: 700; font-size: .88rem; line-height: 1.3; }
.nk-toast-msg{ margin: 2px 0 0; font-size: .82rem; line-height: 1.4; color: var(--nk-ink-soft); word-wrap: break-word; }

.nk-toast-close{
  border: none; background: transparent; color: var(--nk-muted);
  cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px;
  border-radius: 6px; flex-shrink: 0;
}
.nk-toast-close:hover{ background: var(--nk-line); color: var(--nk-ink); }

.nk-toast-progress{
  position: absolute; left: 0; bottom: 0; height: 3px;
  background: var(--nk-accent); opacity: .55;
  width: 100%;
  transform-origin: left;
  animation: nk-shrink linear forwards;
}
.nk-toast--success .nk-toast-progress{ background: var(--nk-success); }
.nk-toast--warning .nk-toast-progress{ background: var(--nk-warning); }
.nk-toast--danger  .nk-toast-progress{ background: var(--nk-danger); }
@keyframes nk-shrink{ from{ transform: scaleX(1); } to{ transform: scaleX(0); } }
.nk-toast[data-paused="true"] .nk-toast-progress{ animation-play-state: paused; }

/* ---- bell + panel ---- */
.nk-bell-wrap{ position: relative; display: inline-flex; pointer-events: auto; }
.nk-bell-btn{
  width: 38px; height: 38px; border-radius: 50%;
  border: 1px solid var(--nk-line); background: var(--nk-card);
  color: var(--nk-ink-soft); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  position: relative; transition: background .15s ease, color .15s ease;
}
.nk-bell-btn:hover{ background: var(--nk-line); color: var(--nk-ink); }
.nk-bell-btn svg{ width: 18px; height: 18px; }
.nk-bell-badge{
  position: absolute; top: -3px; right: -3px;
  min-width: 17px; height: 17px; padding: 0 4px;
  border-radius: 999px; background: var(--nk-danger); color: #fff;
  font-size: .65rem; font-weight: 700; line-height: 17px; text-align: center;
  border: 2px solid var(--nk-card);
}
.nk-bell-badge[hidden]{ display: none; }

.nk-panel{
  position: absolute; top: calc(100% + 10px); right: 0;
  width: 340px; max-width: calc(100vw - 24px);
  max-height: 420px; display: flex; flex-direction: column;
  background: var(--nk-card); border: 1px solid var(--nk-line);
  border-radius: var(--nk-radius-m); box-shadow: var(--nk-shadow);
  overflow: hidden; opacity: 0; transform: translateY(-6px) scale(.98);
  pointer-events: none; transition: opacity .16s ease, transform .16s ease;
}
.nk-panel.nk-open{ opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
.nk-panel-head{
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 1px solid var(--nk-line);
}
.nk-panel-head h4{ margin: 0; font-size: .92rem; font-weight: 700; color: var(--nk-ink); }
.nk-panel-mark{
  border: none; background: transparent; color: var(--nk-accent);
  font-size: .76rem; font-weight: 600; cursor: pointer; padding: 4px 6px; border-radius: 6px;
}
.nk-panel-mark:hover{ background: var(--nk-line); }
.nk-panel-list{ list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; }
.nk-panel-empty{ padding: 32px 16px; text-align: center; color: var(--nk-muted); font-size: .85rem; }
.nk-item{
  display: flex; gap: 10px; padding: 10px 14px; cursor: default;
  border-bottom: 1px solid var(--nk-line); position: relative;
}
.nk-item:last-child{ border-bottom: none; }
.nk-item.nk-unread{ background: color-mix(in srgb, var(--nk-accent) 6%, transparent); }
.nk-item-dot{
  width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0;
  background: var(--nk-accent);
}
.nk-item--success .nk-item-dot{ background: var(--nk-success); }
.nk-item--warning .nk-item-dot{ background: var(--nk-warning); }
.nk-item--danger  .nk-item-dot{ background: var(--nk-danger); }
.nk-item-body{ flex: 1; min-width: 0; }
.nk-item-title{ margin: 0; font-size: .84rem; font-weight: 700; color: var(--nk-ink); }
.nk-item-msg{ margin: 2px 0 0; font-size: .8rem; color: var(--nk-ink-soft); line-height: 1.35; word-wrap: break-word; }
.nk-item-time{ margin: 4px 0 0; font-size: .7rem; color: var(--nk-muted); }
.nk-item-remove{
  border: none; background: transparent; color: var(--nk-muted);
  cursor: pointer; font-size: 13px; align-self: flex-start; padding: 2px 5px; border-radius: 6px;
}
.nk-item-remove:hover{ background: var(--nk-line); color: var(--nk-ink); }
.nk-panel-foot{ padding: 8px 14px; border-top: 1px solid var(--nk-line); text-align: right; }
.nk-panel-clear{
  border: none; background: transparent; color: var(--nk-muted);
  font-size: .76rem; font-weight: 600; cursor: pointer; padding: 4px 6px; border-radius: 6px;
}
.nk-panel-clear:hover{ background: var(--nk-line); color: var(--nk-danger); }

@media (max-width: 480px){
  .nk-toast-layer{ padding: 10px; max-width: 100vw; }
  .nk-panel{ position: fixed; top: 64px; right: 8px; left: 8px; width: auto; }
}
    `.trim();

    const styleEl = document.createElement("style");
    styleEl.id = "nk-styles";
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  /* ----------------------------------------------------------
     Root / toast layer bootstrap
     ---------------------------------------------------------- */
  function ensureRoot() {
    if (root) return root;
    injectStyles();
    root = document.createElement("div");
    root.id = "nk-root";
    document.body.appendChild(root);

    toastLayer = document.createElement("div");
    toastLayer.className = "nk-toast-layer nk-pos-" + state.position;
    root.appendChild(toastLayer);

    return root;
  }

  function setPosition(pos) {
    state.position = pos;
    if (toastLayer) {
      toastLayer.className = "nk-toast-layer nk-pos-" + state.position;
    }
  }

  /* ----------------------------------------------------------
     Icons (inline, no external deps)
     ---------------------------------------------------------- */
  const ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l4.5 4.5L20 6"/></svg>',
    danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L2.5 20h19z"/><path d="M12 9.5v4.2"/><path d="M12 17h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5h.01"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9.5a6 6 0 0 0-12 0c0 5-2.2 6.5-2.2 6.5h16.4S18 14.5 18 9.5z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>'
  };

  function normalizeType(type) {
    return ["success", "warning", "danger", "info"].includes(type) ? type : "info";
  }

  /* ----------------------------------------------------------
     Toasts
     ---------------------------------------------------------- */
  function toast(message, opts) {
    opts = opts || {};
    ensureRoot();

    const type = normalizeType(opts.type);
    const duration = opts.duration === 0 ? 0 : (opts.duration || state.defaultDuration);

    // Cap the stack — drop the oldest toast if we're over the limit.
    const current = toastLayer.querySelectorAll(".nk-toast");
    if (current.length >= state.maxToasts) {
      removeToastEl(current[0]);
    }

    const el = document.createElement("div");
    el.className = "nk-toast nk-toast--" + type;
    el.innerHTML = `
      <span class="nk-toast-icon">${ICONS[type]}</span>
      <span class="nk-toast-body">
        ${opts.title ? `<p class="nk-toast-title">${escapeHtml(opts.title)}</p>` : ""}
        <p class="nk-toast-msg">${escapeHtml(message)}</p>
      </span>
      <button class="nk-toast-close" aria-label="Dismiss">&times;</button>
      ${duration > 0 ? `<span class="nk-toast-progress" style="animation-duration:${duration}ms"></span>` : ""}
    `;

    toastLayer.appendChild(el);
    requestAnimationFrame(() => el.classList.add("nk-show"));

    let timer = null;
    const startTimer = () => {
      if (duration > 0) timer = setTimeout(() => removeToastEl(el), duration);
    };
    const pause = () => {
      if (timer) { clearTimeout(timer); timer = null; el.dataset.paused = "true"; }
    };
    const resume = () => { el.dataset.paused = "false"; startTimer(); };

    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", resume);
    el.querySelector(".nk-toast-close").addEventListener("click", () => removeToastEl(el));

    startTimer();
    return el;
  }

  function removeToastEl(el) {
    if (!el || el.classList.contains("nk-hide")) return;
    el.classList.remove("nk-show");
    el.classList.add("nk-hide");
    setTimeout(() => el.remove(), 220);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  /* ----------------------------------------------------------
     Notification centre (bell + panel)
     ---------------------------------------------------------- */
  function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const s = Math.floor(diff / 1000);
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24);
    return d + "d ago";
  }

  function persist() {
    if (!state.persistKey) return;
    try {
      localStorage.setItem(state.persistKey, JSON.stringify(state.items));
    } catch (e) { /* storage unavailable — fail silently */ }
  }

  function loadPersisted() {
    if (!state.persistKey) return;
    try {
      const raw = localStorage.getItem(state.persistKey);
      if (raw) state.items = JSON.parse(raw) || [];
    } catch (e) { state.items = []; }
  }

  function unreadCount() {
    return state.items.filter(i => !i.read).length;
  }

  function renderBell() {
    if (!state.bell) return;
    const count = unreadCount();
    state.bell.badge.textContent = count > 99 ? "99+" : String(count);
    state.bell.badge.hidden = count === 0;
  }

  function renderPanel() {
    if (!state.bell) return;
    const { list, empty } = state.bell;
    list.innerHTML = "";

    if (!state.items.length) {
      empty.style.display = "block";
      list.style.display = "none";
      return;
    }
    empty.style.display = "none";
    list.style.display = "block";

    state.items.forEach(item => {
      const li = document.createElement("li");
      li.className = "nk-item nk-item--" + item.type + (item.read ? "" : " nk-unread");
      li.innerHTML = `
        <span class="nk-item-dot"></span>
        <span class="nk-item-body">
          ${item.title ? `<p class="nk-item-title">${escapeHtml(item.title)}</p>` : ""}
          <p class="nk-item-msg">${escapeHtml(item.message)}</p>
          <p class="nk-item-time">${timeAgo(item.ts)}</p>
        </span>
        <button class="nk-item-remove" aria-label="Remove">&times;</button>
      `;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".nk-item-remove")) return;
        item.read = true;
        persist();
        renderBell();
        renderPanel();
      });
      li.querySelector(".nk-item-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        state.items = state.items.filter(i => i.id !== item.id);
        persist();
        renderBell();
        renderPanel();
      });
      list.appendChild(li);
    });
  }

  function openPanel() {
    if (!state.bell) return;
    state.panelOpen = true;
    state.bell.panel.classList.add("nk-open");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey, true);
  }
  function closePanel() {
    if (!state.bell) return;
    state.panelOpen = false;
    state.bell.panel.classList.remove("nk-open");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey, true);
  }
  function onDocClick(e) {
    if (!state.bell) return;
    if (!state.bell.root.contains(e.target)) closePanel();
  }
  function onDocKey(e) {
    if (e.key === "Escape") closePanel();
  }

  function mountBell(target) {
    ensureRoot();
    const host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) {
      console.warn("Notify.mountBell: target not found —", target);
      return null;
    }

    const wrap = document.createElement("div");
    wrap.className = "nk-bell-wrap";
    wrap.innerHTML = `
      <button class="nk-bell-btn" type="button" aria-label="Notifications">
        ${ICONS.bell}
        <span class="nk-bell-badge" hidden>0</span>
      </button>
      <div class="nk-panel" role="menu">
        <div class="nk-panel-head">
          <h4>Notifications</h4>
          <button class="nk-panel-mark" type="button">Mark all read</button>
        </div>
        <ul class="nk-panel-list"></ul>
        <div class="nk-panel-empty">No notifications yet.</div>
        <div class="nk-panel-foot">
          <button class="nk-panel-clear" type="button">Clear all</button>
        </div>
      </div>
    `;
    host.appendChild(wrap);

    state.bell = {
      root: wrap,
      btn: wrap.querySelector(".nk-bell-btn"),
      badge: wrap.querySelector(".nk-bell-badge"),
      panel: wrap.querySelector(".nk-panel"),
      list: wrap.querySelector(".nk-panel-list"),
      empty: wrap.querySelector(".nk-panel-empty")
    };

    state.bell.btn.addEventListener("click", () => {
      state.panelOpen ? closePanel() : openPanel();
    });
    wrap.querySelector(".nk-panel-mark").addEventListener("click", () => {
      state.items.forEach(i => (i.read = true));
      persist();
      renderBell();
      renderPanel();
    });
    wrap.querySelector(".nk-panel-clear").addEventListener("click", () => {
      state.items = [];
      persist();
      renderBell();
      renderPanel();
    });

    loadPersisted();
    renderBell();
    renderPanel();
    return state.bell;
  }

  /* ----------------------------------------------------------
     Public: add a notification-centre entry (+ optional toast)
     ---------------------------------------------------------- */
  function notify(opts) {
    if (typeof opts === "string") opts = { message: opts };
    opts = opts || {};
    const type = normalizeType(opts.type);
    const entry = {
      id: state.idSeq++,
      title: opts.title || "",
      message: opts.message || "",
      type,
      ts: Date.now(),
      read: false
    };
    state.items.unshift(entry);
    persist();
    renderBell();
    renderPanel();
    state.listeners.forEach(fn => {
      try { fn(entry); } catch (e) { /* subscriber error shouldn't break notify */ }
    });

    if (opts.toast !== false) {
      toast(entry.message, { type, title: entry.title, duration: opts.duration });
    }
    return entry;
  }

  function subscribe(fn) {
    if (typeof fn === "function") state.listeners.push(fn);
    return () => { state.listeners = state.listeners.filter(f => f !== fn); };
  }

  function markAllRead() {
    state.items.forEach(i => (i.read = true));
    persist();
    renderBell();
    renderPanel();
  }

  function clearAll() {
    state.items = [];
    persist();
    renderBell();
    renderPanel();
  }

  function getAll() {
    return state.items.slice();
  }

  /* ----------------------------------------------------------
     Init / config
     ---------------------------------------------------------- */
  function init(opts) {
    opts = opts || {};
    if (opts.position) setPosition(opts.position);
    if (typeof opts.maxToasts === "number") state.maxToasts = opts.maxToasts;
    if (typeof opts.defaultDuration === "number") state.defaultDuration = opts.defaultDuration;
    if ("persistKey" in opts) {
      state.persistKey = opts.persistKey;
      loadPersisted();
      renderBell();
      renderPanel();
    }
    ensureRoot();
  }

  /* ----------------------------------------------------------
     Public API
     ---------------------------------------------------------- */
  const Notify = {
    init,
    toast,
    success: (msg, opts) => toast(msg, Object.assign({}, opts, { type: "success" })),
    error: (msg, opts) => toast(msg, Object.assign({}, opts, { type: "danger" })),
    warning: (msg, opts) => toast(msg, Object.assign({}, opts, { type: "warning" })),
    info: (msg, opts) => toast(msg, Object.assign({}, opts, { type: "info" })),
    notify,
    mountBell,
    markAllRead,
    clearAll,
    getAll,
    subscribe
  };

  global.Notify = Notify;
})(window);
