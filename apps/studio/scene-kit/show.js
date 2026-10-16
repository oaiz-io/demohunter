// DemoHunter scene kit — commercial moves (MIT). Copied with motion.js into
// a project's scenes/kit/. Proven patterns; prefer these over hand-rolled
// versions — they encode lessons from real renders:
//
// - Cursors are positioned with `translate` and pressed with `scale` around
//   the arrow tip. CSS applies translate → rotate → scale → transform, so a
//   cursor positioned with `transform` would be scaled by its own press and
//   slide toward the page corner, missing its target.
// - Click targets must not move during the press: liftShow's float is a
//   sampled sine that its `place(el, at)` predicts.
// - One Web Animation per element and property; later fill-both
//   animations override earlier ones. Studio pauses and persists all
//   animations, so none are auto-removed during long exports.
import { animate, ease, lift, onSeek, spring, split, stagger } from "./motion.js";

/** Deepest element whose own text is exactly `text`. */
export function byText(root, text) {
  return [...root.querySelectorAll("*")]
    .reverse()
    .find((e) => e.textContent.trim() === text);
}

/** Elements whose inline background colour is `rgb` (e.g. "rgb(41, 168, 113)"). */
export function byColour(root, rgb) {
  return [...root.querySelectorAll("*")].filter(
    (e) => e.style.backgroundColor === rgb,
  );
}

const CURSOR_WIDTH = 54;
// Arrow tip inside the cursor (the path starts at 2,2 of a 28×36 box).
export const CURSOR_TIP = (2 * CURSOR_WIDTH) / 28;

/**
 * An oversized cursor that glides in, clicks with its tip exactly on
 * `point` at `at` ms, and leaves. `point` is in page pixels of `parent`.
 */
export function cursorClick(parent, point, { at, from = { x: 1900, y: 1150 }, glideMs = 850, ripple = "rgba(31, 124, 226, 0.5)" } = {}) {
  const cursor = document.createElement("div");
  cursor.className = "kit-cursor";
  Object.assign(cursor.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${CURSOR_WIDTH}px`,
    zIndex: "50",
    pointerEvents: "none",
    transformOrigin: `${CURSOR_TIP}px ${CURSOR_TIP}px`,
    filter: "drop-shadow(0 8px 12px rgba(0, 0, 0, 0.25))",
  });
  cursor.innerHTML = `<svg viewBox="0 0 28 36" width="${CURSOR_WIDTH}" style="display:block;overflow:visible"><path d="M2 2 L2 28 L9 21.5 L13.5 33 L18 31 L13.6 19.8 L23 19.8 Z" fill="#191919" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const ring = document.createElement("i");
  Object.assign(ring.style, {
    position: "absolute",
    left: `${CURSOR_TIP - 15}px`,
    top: `${CURSOR_TIP - 15}px`,
    width: "30px",
    height: "30px",
    borderRadius: "50%",
    background: ripple,
    opacity: "0",
  });
  cursor.append(ring);
  parent.append(cursor);
  const x = point.x - CURSOR_TIP,
    y = point.y - CURSOR_TIP;
  // Position: translate (never transform — see header).
  animate(cursor, [
    { translate: `${from.x}px ${from.y}px`, opacity: 0 },
    { translate: `${x}px ${y}px`, opacity: 1 },
  ], { at: at - glideMs - 50, dur: glideMs, easing: ease.inOut });
  // Press: scale around the tip.
  animate(cursor, [{ scale: 1 }, { scale: 0.86 }, { scale: 1 }], { at, dur: 220, easing: "ease-in-out" });
  animate(ring, [
    { opacity: 0.6, transform: "scale(0.2)" },
    { opacity: 0, transform: "scale(3.2)" },
  ], { at, dur: 600, easing: ease.out });
  // Leave: transform is free for the exit offset.
  animate(cursor, [
    { opacity: 1, transform: "none" },
    { opacity: 0, transform: "translate(60px, 80px)" },
  ], { at: at + 650, dur: 500, easing: ease.in });
  return cursor;
}

/** Switch an element's look and/or text at `at` ms (with a small pop). */
export function flip(el, at, { text, style } = {}) {
  const before = { text: el.textContent, css: el.getAttribute("style") ?? "" };
  onSeek((ms) => {
    const done = ms >= at;
    const want = done ? (text ?? before.text) : before.text;
    if (el.textContent !== want) el.textContent = want;
    const css = done ? `${before.css};${style ?? ""}` : before.css;
    if ((el.getAttribute("style") ?? "") !== css) el.setAttribute("style", css);
  });
  animate(el, [{ scale: 1 }, { scale: 1.18 }, { scale: 1 }], { at, dur: 420, easing: ease.out });
}

/**
 * Lift & show: pick a lifted element (`bun run studio lift`) up off the
 * page, bring it to the camera beside a kinetic headline, let `act(box,
 * place)` animate what it does, then put it back exactly where it was.
 *
 * @param {HTMLElement} stage full-frame container (e.g. 1920×1080, perspective set)
 * @param {string} name lifted element name (scenes/lifts/<name>.html)
 * @param {{dur:number, side?:"left"|"right", scale?:number, centre?:{x:number,y:number},
 *   kicker?:string, headline?:string, act?:(box:HTMLElement, place:(el:Element, at?:number)=>{x:number,y:number})=>void}} o
 */
export function liftShow(stage, name, o) {
  const { dur, side = "right", scale = 2, kicker = "", headline = "", act } = o;
  const width = stage.clientWidth || 1920,
    height = stage.clientHeight || 1080;
  const centre = o.centre ?? { x: side === "right" ? width * 0.68 : width * 0.32, y: height * 0.505 };
  const box = lift(name, stage);
  box.classList.add("kit-hero-card");
  box.style.zIndex = "2";
  if (headline) {
    const copy = document.createElement("div");
    copy.className = `kit-copy ${side === "right" ? "left" : "right"}`;
    copy.innerHTML = `${kicker ? `<div class="kit-kicker">${kicker}</div>` : ""}<h1>${headline}</h1>`;
    stage.append(copy);
    const words = split(copy.querySelector("h1"), "word");
    const k = copy.querySelector(".kit-kicker");
    if (k)
      animate(k, [
        { opacity: 0, transform: "translateY(14px)", filter: "blur(8px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ], { at: 420, dur: 700 });
    stagger(words, [
      { opacity: 0, transform: "translateY(26px)", filter: "blur(14px)" },
      { opacity: 1, transform: "none", filter: "blur(0)" },
    ], { at: 560, every: 85, dur: 820 });
    animate(copy, [{ opacity: 1 }, { opacity: 0, filter: "blur(10px)", transform: "translateY(-18px)" }], {
      at: dur - 1050,
      dur: 420,
      easing: ease.in,
    });
  }
  box.ready.then(() => {
    const r = box.rect;
    const dx = centre.x - (r.x + r.width / 2),
      dy = centre.y - (r.y + r.height / 2);
    const out = `translate(${dx}px, ${dy}px) scale(${scale})`;
    const pop = spring({ stiffness: 120, damping: 0.78 });
    animate(box, [{ transform: "translate(0, 0) scale(1)" }, { transform: out }], { at: 60, dur: pop.durationMs, easing: pop.easing });
    animate(box, [{ rotate: "x 18deg" }, { rotate: "x 0deg" }], { at: 60, dur: 1100, easing: ease.out });
    animate(box, [
      { filter: "drop-shadow(0 1px 1px rgba(25,25,25,0.04))" },
      { filter: "drop-shadow(0 26px 38px rgba(25,25,25,0.22))" },
    ], { at: 60, dur: 900, easing: ease.out });
    // Float: a sampled sine, so place(el, at) can predict it for clicks.
    const floatAt = 1000,
      floatDur = Math.max(1200, dur - 2100);
    const float = (ms) => -8 * Math.sin(Math.PI * Math.min(1, Math.max(0, (ms - floatAt) / floatDur)));
    animate(box, Array.from({ length: 25 }, (_, i) => ({ translate: `0 ${(-8 * Math.sin((Math.PI * i) / 24)).toFixed(3)}px` })), {
      at: floatAt,
      dur: floatDur,
      easing: "linear",
    });
    animate(box, [{ transform: out }, { transform: "translate(0, 0) scale(1)" }], { at: dur - 950, dur: 860, easing: ease.inOut });
    animate(box, [
      { filter: "drop-shadow(0 26px 38px rgba(25,25,25,0.22))" },
      { filter: "drop-shadow(0 1px 1px rgba(25,25,25,0.04))" },
    ], { at: dur - 950, dur: 860, easing: ease.inOut });
    /** Where `el` (inside the card) sits on screen at `at` ms while held out. */
    const place = (el, at) => {
      let x = 0,
        y = 0,
        n = el;
      while (n && n !== box) {
        x += n.offsetLeft;
        y += n.offsetTop;
        n = n.offsetParent;
      }
      const ex = r.x + x + el.offsetWidth / 2,
        ey = r.y + y + el.offsetHeight / 2;
      const bx = r.x + r.width / 2,
        by = r.y + r.height / 2;
      return {
        x: bx + dx + (ex - bx) * scale,
        y: by + dy + (ey - by) * scale + (at === undefined ? 0 : float(at)),
      };
    };
    act?.(box, place);
  });
  return box;
}
