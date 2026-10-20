// DemoHunter scene kit — MIT. Copied into a project as scenes/kit/motion.js.
//
// A scene is an HTML page whose every frame is a pure function of time.
// Studio pauses all CSS and Web Animations on the page and sets their
// currentTime to the scene's local time on every frame, then calls the
// handlers registered with onSeek(). So:
//   - Animate with CSS (@keyframes + animation-delay) or with animate() below.
//   - Never use timers, Date.now(), requestAnimationFrame loops or random
//     values that change between frames; use seeded random() instead.
//   - Create every element up front (hidden is fine), not on the fly.
// Opened directly in a browser, the page plays in real time for authoring.

const handlers = [];
/** Run fn(ms) on every frame with the scene's local time in milliseconds. */
export function onSeek(fn) {
  handlers.push(fn);
}
function seek(ms) {
  for (const handler of handlers) handler(ms);
}
window.demohunterScene = { seek };

// Standalone preview (not inside Studio): play and loop in real time.
if (window.parent === window) {
  const length = Number(
    document.querySelector('meta[name="demohunter:duration"]')?.content ?? 6000,
  );
  const start = performance.now();
  const loop = () => {
    const ms = (performance.now() - start) % (length + 800);
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = ms;
    }
    seek(ms);
    requestAnimationFrame(loop);
  };
  addEventListener("load", () => requestAnimationFrame(loop));
}

// Lifted elements load asynchronously; Studio waits for this before frames.
const pending = [];
function settle() {
  window.demohunterScene.ready = Promise.all(pending).then(
    () => new Promise((resolve) => setTimeout(resolve, 0)),
  );
}

/**
 * Pick up an element lifted from the recording (`bun run studio lift`):
 * returns a box positioned exactly where the element was on the page, so it
 * can be animated out of the page. `box.ready` resolves once its HTML is in
 * (query and animate inner parts then); `box.rect` is its page rectangle.
 */
export function lift(name, parent = document.body) {
  if (!document.querySelector('link[data-lift-fonts]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "lifts/fonts.css";
    link.dataset.liftFonts = "";
    document.head.append(link);
  }
  const box = document.createElement("div");
  box.className = "lift";
  box.dataset.lift = name;
  box.style.position = "absolute";
  box.style.transformOrigin = "50% 50%";
  parent.append(box);
  box.ready = Promise.all([
    fetch(`lifts/${name}.json`).then((r) => r.json()),
    fetch(`lifts/${name}.html`).then((r) => r.text()),
  ]).then(([meta, html]) => {
    Object.assign(box.style, {
      left: `${meta.rect.x}px`,
      top: `${meta.rect.y}px`,
      width: `${meta.rect.width}px`,
      height: `${meta.rect.height}px`,
    });
    box.rect = meta.rect;
    box.innerHTML = html;
    return box;
  });
  pending.push(box.ready);
  settle();
  return box;
}

/** Easing curves for CSS/WAAPI (strings) — premium defaults. */
export const ease = {
  out: "cubic-bezier(0.16, 1, 0.3, 1)", // expo out: entrances
  soft: "cubic-bezier(0.22, 1, 0.36, 1)", // quint out: gentle settles
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)", // camera moves, morphs
  in: "cubic-bezier(0.7, 0, 0.84, 0)", // exits
  back: "cubic-bezier(0.34, 1.56, 0.64, 1)", // small overshoot pops
};

/** Same curves as functions of t∈[0,1] for onSeek() code. */
export const easeFn = {
  linear: (t) => t,
  out: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  soft: (t) => 1 - Math.pow(1 - t, 5),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: (t) => t * t * t * t,
};

/**
 * A damped spring as a CSS `linear()` easing plus the time it needs to
 * settle. damping 1 = no overshoot; 0.8 ≈ iOS-like; lower bounces more.
 */
export function spring({ stiffness = 180, damping = 0.82, mass = 1 } = {}) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = Math.min(1.5, Math.max(0.05, damping));
  const value = (s) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return (
        1 -
        Math.exp(-zeta * w0 * s) *
          (Math.cos(wd * s) + ((zeta * w0) / wd) * Math.sin(wd * s))
      );
    }
    return 1 - Math.exp(-w0 * s) * (1 + w0 * s);
  };
  let settle = 0.1;
  for (let s = 0.1; s < 10; s += 0.01) {
    settle = s;
    let still = true;
    for (let k = s; k < s + 0.3; k += 0.02)
      if (Math.abs(1 - value(k)) > 0.002) still = false;
    if (still) break;
  }
  const points = [];
  for (let i = 0; i <= 48; i++)
    points.push(Math.round(value((settle * i) / 48) * 1000) / 1000);
  points[points.length - 1] = 1;
  return { easing: `linear(${points.join(", ")})`, durationMs: settle * 1000 };
}

/** Web Animation starting at `at` ms on the scene clock (seekable). */
export function animate(element, keyframes, { at = 0, dur = 600, easing = ease.out } = {}) {
  return element.animate(keyframes, {
    delay: at,
    duration: dur,
    easing,
    fill: "both",
  });
}

/** Animate a list of elements one after another. */
export function stagger(elements, keyframes, { at = 0, every = 45, dur = 600, easing = ease.out } = {}) {
  return [...elements].map((element, i) =>
    animate(element, keyframes, { at: at + i * every, dur, easing }),
  );
}

/** Wrap each character (or word) in a span so it can be staggered. */
export function split(element, by = "char") {
  const text = element.textContent ?? "";
  element.textContent = "";
  element.setAttribute("aria-label", text);
  const parts = by === "word" ? text.split(/(\s+)/) : [...text];
  const spans = [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      element.append(document.createTextNode(part));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = part;
    span.style.display = "inline-block";
    span.style.whiteSpace = "pre";
    span.setAttribute("aria-hidden", "true");
    span.style.setProperty("--i", String(spans.length));
    element.append(span);
    spans.push(span);
  }
  return spans;
}

/**
 * Type text into an element from `at` ms at `cps` characters per second.
 * Returns the times (ms) each character appears — use them for key sounds.
 */
export function typewriter(element, text, { at = 0, cps = 18, jitter = 0.35, seed = 1 } = {}) {
  const rand = random(seed);
  const times = [];
  let t = at;
  for (let i = 0; i < text.length; i++) {
    times.push(t);
    const pause = /[,.:;!?]/.test(text[i]) ? 3.2 : text[i] === " " ? 1.3 : 1;
    t += (1000 / cps) * pause * (1 - jitter / 2 + rand() * jitter);
  }
  onSeek((ms) => {
    let shown = 0;
    while (shown < times.length && times[shown] <= ms) shown++;
    const next = text.slice(0, shown);
    if (element.textContent !== next) element.textContent = next;
  });
  return times;
}

/** A number counting from `from` to `to` between at and at+dur. */
export function counter(element, from, to, { at = 0, dur = 1200, format = (n) => String(Math.round(n)), easing = easeFn.out } = {}) {
  onSeek((ms) => {
    const t = Math.min(1, Math.max(0, (ms - at) / dur));
    element.textContent = format(from + (to - from) * easing(t));
  });
}

/** Seeded random numbers (mulberry32): same values on every frame. */
export function random(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Progress of a time window, eased: 0 before `at`, 1 after `at + dur`. */
export function progress(ms, at, dur, easing = easeFn.out) {
  return easing(Math.min(1, Math.max(0, (ms - at) / dur)));
}
