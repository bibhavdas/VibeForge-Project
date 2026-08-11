/* ============================================================
   Alignt HRMS — shared helpers
   Used by both the sign-in page (auth.js) and the dashboard
   page (app.js). Everything here is static/front-end only;
   Firebase Auth + Firestore will replace the mocked bits later.
   ============================================================ */

const SESSION_KEY = "alignt_session";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------------------------------------------------
   Safety net: if the three.js / anime.js CDN scripts are
   blocked (offline, restrictive network, ad-blocker, etc.)
   the page must still work — just without the animation and
   the 3D badge. Without this shim, a missing THREE/anime
   global throws inside the click handlers below and silently
   breaks sign-in entirely.
   --------------------------------------------------------- */
if (typeof anime === "undefined"){
  window.anime = function(opts){
    if (opts && typeof opts.update === "function") opts.update();
    if (opts && typeof opts.complete === "function") opts.complete();
    return {};
  };
  window.anime.stagger = () => 0;
  window.anime.remove = () => {};
  window.anime.timeline = () => ({
    set(){ return this; },
    add(opts){ if (opts && typeof opts.complete === "function") opts.complete(); return this; }
  });
}
const HAS_THREE = typeof THREE !== "undefined";

function toast(msg, type){
  // If notify.js is on the page, route through the real popup
  // notification system (stacked, dismissible, themed toasts).
  if (typeof Notify !== "undefined"){
    Notify.toast(msg, { type: type || "info" });
    return;
  }

  // Fallback: original single-line toast, used only if notify.js
  // hasn't been included on this page.
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  anime.remove(el);
  anime.timeline()
    .set(el, { opacity: 0, translateY: 10 })
    .add({ targets: el, opacity: 1, translateY: 0, duration: 260, easing: "easeOutQuad" })
    .add({ targets: el, opacity: 0, translateY: 10, duration: 260, delay: 1800, easing: "easeInQuad" });
}

function deriveNameFromEmail(email){
  const local = (email || "").split("@")[0] || "user";
  const words = local.split(/[._\-+0-9]+/).filter(Boolean);
  if (!words.length) return "New User";
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function initialsOf(name){
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map(w => w[0].toUpperCase()).join("");
}

function randomEmpId(){
  return "EMP-" + Math.floor(1000 + Math.random() * 9000);
}

function getSession(){
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch (e) {
    return null;
  }
}

function setSession(session){
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession(){
  sessionStorage.removeItem(SESSION_KEY);
}

/* ---------------------------------------------------------
   Three.js punch badge
   Creates an independent mini-scene inside a given canvas.
   Returns a controller with .flip() and .destroy()
   --------------------------------------------------------- */
function createBadge(canvas, { accent = "#1F6F5C", faceBg = "#0F332B" } = {}){
  if (!HAS_THREE || !canvas){
    // three.js didn't load (or canvas is missing) — hide the canvas
    // and hand back a no-op controller so callers don't need to care.
    if (canvas) canvas.style.display = "none";
    return { flip(){}, destroy(){} };
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (err) {
    canvas.style.display = "none";
    return { flip(){}, destroy(){} };
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 6.4);

  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(3, 4, 5);
  scene.add(ambient, dir);

  function makeFaceTexture(label, sub){
    const c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    const ctx = c.getContext("2d");
    ctx.fillStyle = faceBg;
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 6;
    ctx.strokeRect(18, 18, 476, 476);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(256, 150, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#EFF6F3";
    ctx.font = "600 40px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ALIGNT", 256, 230);
    ctx.font = "700 76px 'Space Grotesk', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, 256, 330);
    ctx.font = "500 26px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText(sub, 256, 380);
    return new THREE.CanvasTexture(c);
  }

  function edgeMaterial(){
    return new THREE.MeshStandardMaterial({ color: 0x0b241d, roughness: 0.6 });
  }

  const frontTex = makeFaceTexture("IN", "tap to punch in");
  const backTex = makeFaceTexture("OUT", "tap to punch out");

  const materials = [
    edgeMaterial(), edgeMaterial(), edgeMaterial(), edgeMaterial(),
    new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.5 })
  ];

  const geo = new THREE.BoxGeometry(3.6, 3.6, 0.32);
  const badge = new THREE.Mesh(geo, materials);
  scene.add(badge);

  let disposed = false;
  let flipping = false;

  function resize(){
    const w = canvas.clientWidth || 200;
    const h = canvas.clientHeight || 200;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  function tick(){
    if (disposed) return;
    if (!flipping) badge.rotation.y += 0.0035;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();

  function flip(){
    if (flipping) return;
    flipping = true;
    const target = badge.rotation.y + Math.PI;
    anime({
      targets: badge.rotation,
      y: target,
      duration: 700,
      easing: "easeInOutBack",
      complete: () => { flipping = false; }
    });
  }

  function destroy(){
    disposed = true;
    ro.disconnect();
    renderer.dispose();
  }

  return { flip, destroy };
}
