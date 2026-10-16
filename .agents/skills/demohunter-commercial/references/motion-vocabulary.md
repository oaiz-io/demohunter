# Motion vocabulary

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

Named moves you can build with DemoHunter primitives, with exact parameters and code. Every snippet runs in a scene or overlay page that imports `./kit/motion.js`. Every snippet is seekable: Studio pauses all CSS and Web Animations, sets `currentTime` to local ms on every frame, and calls `onSeek` handlers. No GSAP.

Name the move in the beat sheet ("lift & expand", "waterfall cut"). Then build it from this file.

## 0. Shared header, eases and the one-animation rule

Paste this at the top of a page's module script:

```js
import { animate, stagger, split, typewriter, counter, random, progress, onSeek, spring, lift, ease, easeFn } from "./kit/motion.js";

// GSAP-style names as CSS curves. power1 = quad, power2 = cubic, power3 = quart, power4 = quint.
const E = {
  ...ease,                                       // out = expo.out, soft = power4.out, inOut = power2.inOut, in = expo.in, back
  in1: "cubic-bezier(0.11, 0, 0.5, 0)",
  in2: "cubic-bezier(0.32, 0, 0.67, 0)",   out2: "cubic-bezier(0.33, 1, 0.68, 1)",
  in3: "cubic-bezier(0.5, 0, 0.75, 0)",    out3: "cubic-bezier(0.25, 1, 0.5, 1)",
  in4: "cubic-bezier(0.64, 0, 0.78, 0)",   out4: "cubic-bezier(0.22, 1, 0.36, 1)",  // mirrored pair
  inOut3: "cubic-bezier(0.76, 0, 0.24, 1)", sine: "cubic-bezier(0.37, 0, 0.63, 1)",
};

// Pose ladder: ONE seekable animation for one element, keyframes in local ms.
// Each entry is [ms, props, easingOfTheSegmentThatStartsHere]. Two entries at the same ms = a hard cut.
const poses = (el, list, total) => el.animate(
  list.map(([ms, props, easing = "linear"]) => ({ ...props, offset: Math.min(1, ms / total), easing })),
  { duration: total, fill: "both" });
const SCENE = Number(document.querySelector('meta[name="demohunter:duration"]').content);
```

**The one-animation rule.** Kit `animate()` and `stagger()` use `fill: "both"`. A later animation on the same element and property therefore applies its *first* keyframe before it starts, and that overrides the earlier one. Your entrance never shows. This is the Web Animations version of GSAP's `immediateRender` trap. Fix it one of two ways:

1. Use one `poses()` ladder per element per property for the whole page (entrance → hold → exit).
2. Split work across nested wrappers: entrance on `.wrap`, exit on `.wrap > .inner`.

Separate properties on one element are fine. For example, a `transform` ladder plus a separate `opacity` animation: zoom-through needs a linear opacity fade apart from its eased scale. Never drive one property from both `onSeek` (inline style) and `animate()`: Web Animations wins.

**Ease direction.** Entering → `.out`. Leaving → `.in`. Moving between two positions → `.inOut`. The ease is the adverb: `E.out` reads confident, `E.sine` dreamy, `E.back` playful (small pops only). Use at most two independent animations with the same ease in one scene. Never use bounce or elastic. Overshoot (`E.back`, or `spring({damping: 0.7})`) is a rare, playful exception.

**Durations.**

| Band | ms | Reads as |
|---|---|---|
| Fast | 150–300 | Energy, a cut, a UI state flip |
| Medium | 300–500 | Most content, exits |
| Slow | 500–800 | Weight, premium |
| Cinematic | 800–2000 | Camera moves, hero lifts, lockups |

- Start the first motion 100–300 ms into a page. Motion at 0 ms reads as a jump cut.
- Entrances run 400–1000 ms. Exits take about 75% of the entrance (0.4 s in, 0.25–0.3 s out). A single element's entry stays ≤ 800 ms; for a longer build, stagger more elements.
- A whole stagger sequence stays ≤ 500 ms, ordered by importance, not DOM order. Letters 30–60 ms, words 80–120 ms, rows 45–80 ms.
- Shape each beat as build 0–30%, breathe 30–70% (one meaningful motion or a held read), resolve 70–100%.
- The slowest beat in the film is about 3× the fastest.

## 1. Lift & expand (the pick-up)

Use it for a hero element of the real UI that should come off the page toward the camera.

| Parameter | Value |
|---|---|
| Overlay `startMs` | = the lift's `--at` (frame 1 is identical to the page) |
| Hold before moving | 80–150 ms ("it's really the page") |
| Travel | 900–1200 ms, `E.inOut` (or `E.inOut3` for weightier) |
| Target scale | Element fills 45–60% of frame width: `min(0.55·vw/w, 0.7·vh/h)` |
| Lean | rotateX 6° at mid-travel → 0° on arrival |
| Shadow | `0 0 0` → `0 40px 90px rgba(8,16,32,.35)` |
| Backdrop | `{blur: 10–14, dim: 0.3–0.45}` |
| Sound | `whoosh-soft` peak at mid-travel: `atMs = startMs + hold + travel/2 − sfxAnchorsMs["whoosh-soft"]` |

```js
const card = lift("score");                      // absolutely positioned at its page rect
card.ready.then(() => {
  const { x, y, width: w, height: h } = card.rect;
  const s = Math.min((0.55 * innerWidth) / w, (0.7 * innerHeight) / h);
  const dx = innerWidth / 2 - (x + w / 2), dy = innerHeight / 2 - (y + h / 2);
  const T = (tx, ty, sc, rx) => `translate(${tx}px,${ty}px) scale(${sc}) rotateX(${rx}deg)`;
  const flat = "0 0 0 rgba(0,0,0,0)", deep = "0 40px 90px rgba(8,16,32,.35)";
  poses(card, [
    [0,    { transform: T(0, 0, 1, 0),                     boxShadow: flat }],
    [120,  { transform: T(0, 0, 1, 0),                     boxShadow: flat }, E.inOut],
    [670,  { transform: T(dx / 2, dy / 2, (1 + s) / 2, 6), boxShadow: deep }, E.out3],
    [1220, { transform: T(dx, dy, s, 0),                   boxShadow: deep }],
    [SCENE, { transform: T(dx, dy, s, 0),                  boxShadow: deep }],   // put-back: see §2
  ], SCENE);
});
```

Set `body { perspective: 1400px }` so rotateX reads as depth. Hide the original element under the overlay with an `animations[]` opacity 0→0 window on its ref (see SKILL.md). Lift only at camera scale 1.

## 2. Put back / hand-off

| Variant | When | Parameters |
|---|---|---|
| Put back | The beat is over and the page continues | Mirror the pick-up: 900–1100 ms `E.inOut`; home pose by `endMs − 100`; shadow back to flat |
| Hand-off (match) | The next beat shows the same element bigger or elsewhere | Lift it again at the next beat's start; this overlay ends exactly on that lift's rect |
| Hand-off (cut-the-curve) | The next beat is a different subject | Card exits in the film's current (§10); the next overlay or scene enters mid-flight |
| Dock | The element becomes part of the outro | The card shrinks into its slot in the outro layout (FLIP: translate + uniform scale, no width/height) |

Put-back ladder tail (append to §1's list, replacing the last entry):

```js
    [SCENE - 1200, { transform: T(dx, dy, s, 0), boxShadow: deep }, E.inOut],
    [SCENE - 100,  { transform: T(0, 0, 1, 0),   boxShadow: flat }],
    [SCENE,        { transform: T(0, 0, 1, 0),   boxShadow: flat }],
```

## 3. 3D tilt reveal

Use it to present a lifted card, phone, or panel as a physical object. Scale alone is fake depth. You need perspective, rotation, z travel and shadow.

| Parameter | Value |
|---|---|
| Parent | `perspective: 1200–1600px; transform-style: preserve-3d` |
| From | `rotateY(-24deg) rotateX(12deg) translateZ(-220px) scale(0.92)`, opacity 0 |
| Rest | `rotateY(-8deg) rotateX(4deg)` (a resting tilt reads as an object) |
| Entry | 900 ms `E.out`; opacity 0→1 over the first 300 ms (linear) |
| Settle | Optional 1200 ms `E.sine` to `rotateY(0) rotateX(0)` once the VO names it |
| Sheen | Gradient bar `translateX(-120%)→120%`, 900 ms `E.inOut3`, starting 200 ms after landing, opacity ≤ 0.25 |

```js
const panel = document.querySelector(".panel"), sheen = panel.querySelector(".sheen");
poses(panel, [
  [0,    { transform: "translateZ(-220px) rotateY(-24deg) rotateX(12deg) scale(0.92)" }],
  [200,  { transform: "translateZ(-220px) rotateY(-24deg) rotateX(12deg) scale(0.92)" }, E.out],
  [1100, { transform: "translateZ(0px) rotateY(-8deg) rotateX(4deg) scale(1)" }],
  [2600, { transform: "translateZ(0px) rotateY(-8deg) rotateX(4deg) scale(1)" }, E.sine],
  [3800, { transform: "translateZ(0px) rotateY(0deg) rotateX(0deg) scale(1)" }],
], SCENE);
animate(panel, [{ opacity: 0 }, { opacity: 1 }], { at: 200, dur: 300, easing: "linear" });
animate(sheen, [{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], { at: 1300, dur: 900, easing: E.inOut3 });
```

## 4. Card explode / row stagger

Use it to split a lifted list, table or card stack into its rows so each can be read or highlighted, then reassemble.

| Parameter | Value |
|---|---|
| Spread | Row i → `translateY(i·gap) translateZ(i·30px)`, gap 12–24 px; or fan `rotateZ((i−mid)·2.5deg)` |
| Explode | 700 ms `E.out`, every `min(80, 500/(n−1))` ms, first row first |
| Hold | One VO cue per row group; the active row 1.04× scale + accent outline, others opacity 0.55 |
| Reassemble | Reverse order, every 40 ms, 500 ms `E.inOut` |
| Sound | `pop` on the first and last row only, volume 0.3 |

```js
const card = lift("plans");
card.ready.then(() => {
  const rows = [...card.querySelectorAll("tr, li, [role=row]")];
  const parts = rows.length ? rows : [...card.firstElementChild.children];
  const every = Math.min(80, 500 / Math.max(1, parts.length - 1)), gap = 18, AT = 600, BACK = SCENE - 900;
  parts.forEach((row, i) => {
    const open = `translateY(${i * gap}px) translateZ(${i * 30}px)`, shut = "translateY(0px) translateZ(0px)";
    poses(row, [
      [0, { transform: shut }], [AT + i * every, { transform: shut }, E.out],
      [AT + i * every + 700, { transform: open }],
      [BACK + (parts.length - 1 - i) * 40, { transform: open }, E.inOut],
      [BACK + (parts.length - 1 - i) * 40 + 500, { transform: shut }], [SCENE, { transform: shut }],
    ], SCENE);
  });
});
```

Rows must be block or inline-block, because transforms do nothing on inline elements. Lifted HTML keeps its computed display, so check the result with `get_screenshot`.

## 5. Inner life of a lifted element

Make the real UI *do* its thing while it's held up to the camera. Only show states the product really has.

| Part | Move | Parameters |
|---|---|---|
| Progress bar | `scaleX(0 → p)`, `transform-origin: left` | 900–1400 ms `E.out3`; sharp UI ease-out |
| Status chip | Swap two lifts ("Connect" → "Connected") | Outgoing `rotateX(0→90deg)` 150 ms `E.in2`; incoming `rotateX(-90→0)` 220 ms `E.out3`; `pop` at the swap; optional `spring({stiffness: 220, damping: 0.75})` scale 0.96→1 |
| Score dial (SVG) | `stroke-dashoffset` via `onSeek` | 1200–1800 ms `easeFn.out`; land + `chime` |
| Number | `counter(el, from, to, {at, dur, format})` | from/to = real values seen in the recording; `font-variant-numeric: tabular-nums` |
| Row / badge appears | Opacity 0→1 + `translateY(8px)→0` | 300 ms `E.out`, `tick` |

```js
// Chip flip: both states lifted from the recording at their real moments.
const off = lift("chip-connect"), on = lift("chip-connected");
const SWAP = 1800;
Promise.all([off.ready, on.ready]).then(() => {
  poses(off, [[0, { transform: "rotateX(0deg)" }], [SWAP - 150, { transform: "rotateX(0deg)" }, E.in2],
              [SWAP, { transform: "rotateX(90deg)" }], [SCENE, { transform: "rotateX(90deg)" }]], SCENE);
  poses(on,  [[0, { transform: "rotateX(-90deg)" }], [SWAP, { transform: "rotateX(-90deg)" }, E.out3],
              [SWAP + 220, { transform: "rotateX(0deg)" }], [SCENE, { transform: "rotateX(0deg)" }]], SCENE);
});
// Dial: an SVG ring inside the lift (or your own ring on top of it), filled to the real score.
const ring = document.querySelector("#ring"), C = 2 * Math.PI * 54, SCORE = 0.87;  // SCORE from the recording
ring.style.strokeDasharray = `${C}`;
onSeek((ms) => { ring.style.strokeDashoffset = `${C * (1 - SCORE * progress(ms, 900, 1500, easeFn.out))}`; });
```

`<audio data-start="1.8" data-volume="0.3" src="../audio/sfx/pop.wav">` sits on the swap frame; the `pop` anchor is 2 ms.

## 6. Match cut onto the page (scene → recording)

This is the best scene-to-recording transition. A scene element ends on the **identical** pixels of the same element in the next clip's first frame, and then the scene dissolves away around it.

| Step | Parameters |
|---|---|
| Measure | Lift the target at the next clip's first output ms (`--at` = clip start), or read bounds with MCP `get_node_info` |
| Arrive | The scene element reaches the target rect (translate + uniform scale) by `SCENE − 300`, `E.inOut`, 700–1000 ms |
| Dissolve | Scene background opacity 1→0 over 250 ms `E.in`, ending at `SCENE − 50`; the element itself stays until `SCENE` |
| Best case | Use the lift itself as the scene's hero (same fonts via `lifts/fonts.css`) so the match is pixel-exact |

```js
const hero = lift("hero-title");      // lifted at the first frame of the next recording clip
hero.ready.then(() => {
  poses(hero, [
    [0,           { transform: "translate(0px, 220px) scale(1.9)", opacity: 0 }],
    [200,         { transform: "translate(0px, 220px) scale(1.9)", opacity: 0 }, E.out],
    [900,         { transform: "translate(0px, 0px) scale(1.9)",   opacity: 1 }],
    [SCENE - 1000, { transform: "translate(0px, 0px) scale(1.9)",  opacity: 1 }, E.inOut],
    [SCENE - 300, { transform: "translate(0px, 0px) scale(1)",     opacity: 1 }],
    [SCENE,       { transform: "translate(0px, 0px) scale(1)",     opacity: 1 }],
  ], SCENE);
});
animate(document.querySelector(".bg"), [{ opacity: 1 }, { opacity: 0 }], { at: SCENE - 300, dur: 250, easing: E.in });
```

The scene sits above the held recording, so the dissolving background reveals the real page under a pixel-identical element.

## 7. Push-in with backdrop blur

Use it to focus on one area of the recording, then put a callout or lifted detail over it.

| Parameter | Value |
|---|---|
| Camera | `{startMs, endMs, x, y, scale: 1.25–1.8, easeMs: 900–1600}`; x,y = page point to centre |
| One push per beat | Finish the push in the first half of the beat. No slow push in the back half. |
| Callout overlay | Starts at `startMs + 0.6·easeMs`; label 28–40 px, accent rule `scaleX(0→1)` 500 ms `E.out` |
| Backdrop | Only when the overlay brings its own focal point: `{blur: 6–12, dim: 0.25–0.45}`. Otherwise use a spotlight (below) |
| Sound | `whoosh-soft` timed so its peak (≈ 302 ms) falls at the push's peak speed (`startMs + easeMs/2`); volume 0.25 |

```json
{ "camera": [{ "id": "push-score", "startMs": 18000, "endMs": 24000, "x": 1310, "y": 420, "scale": 1.45, "easeMs": 1200 }] }
```

Overlays are not zoomed by the camera; confirm this with `get_screenshot`. To place a callout on a zoomed page point `p`: `screen = (vw/2 + (p.x − x)·scale, vh/2 + (p.y − y)·scale)`.

A spotlight without blur, in an overlay page:

```css
.spot { position: absolute; inset: 0; background: radial-gradient(circle 360px at 62% 40%, transparent 70%, rgba(6,10,20,.55) 100%); }
```

## 8. Whip pan

Use it for a high-energy handoff between two scenes or overlays: a camera snap sideways.

| Side | Motion | Blur | Duration | Ease |
|---|---|---|---|---|
| Exit | x 0 → −400 px | 0 → 24 px | 300 ms (the scene's last 300 ms) | `E.in3` |
| Entry | x +400 → 0 | 24 → 0 px | 300 ms (the next scene's first 300 ms) | `E.out3` |

Variants from the same law: **velocity-matched upward** (exit y 0→−150, blur 30, 330 ms `E.in2` → entry y 150→0, blur 30→0, 1000 ms `E.out2`), and **blur through** (exit blur 0→20 over 300 ms → entry blur 20→0 over 250 ms `E.out3`).

```js
// Exit side, in scene A. Move .stage, never body: the body background stays opaque (no flash).
poses(document.querySelector(".stage"), [
  [0, { transform: "translateX(0px)", filter: "blur(0px)" }],
  [SCENE - 300, { transform: "translateX(0px)", filter: "blur(0px)" }, E.in3],
  [SCENE, { transform: "translateX(-400px)", filter: "blur(24px)" }],
], SCENE);
// Entry side, in scene B: [0, {translateX(400px), blur(24px)}, E.out3] → [300, {translateX(0), blur(0)}]
```

## 9. Zoom-through and inverse zoom-through

Z-axis velocity-matched cuts for swapping one text or surface for another. **Never show both at once.**

| | Exit | Hard cut | Entry |
|---|---|---|---|
| Zoom-through (push, "deeper") | scale 1→1.2, blur 0→10 px, 200 ms `E.in3`; opacity 1→0.15 **linear, separate** | out → 0; in = scale 0.75, blur 10, opacity 0.15 | → 1 / 0 / 1, 500 ms `E.out` |
| Inverse (pull, "arrival") | scale 1→0.8, blur 0→10, ~200 ms `E.in3`; opacity 1→0.15 linear | in = scale 1.25, blur 10, opacity 0.15 | 1.25→1, ~500 ms `E.out` |

Use 10 px peak blur for text and 18–20 px for full-frame surfaces, the same on both sides. Headlines and short phrases only. **Z sign rule:** both sides of a push grow and both sides of a pull shrink. A receding exit followed by a grow-from-small entry is a mirrored vector, which is the most common mistake.

```js
const A = document.querySelector("#line-a"), B = document.querySelector("#line-b");
const EXIT = 1800, CUT = EXIT + 200;
const z = (s, b) => ({ transform: `scale(${s})`, filter: `blur(${b}px)` });
poses(A, [[0, z(1, 0)], [EXIT, z(1, 0), E.in3], [CUT, z(1.2, 10)], [SCENE, z(1.2, 10)]], SCENE);
poses(A, [[0, { opacity: 1 }], [EXIT, { opacity: 1 }], [CUT, { opacity: 0.15 }], [CUT, { opacity: 0 }], [SCENE, { opacity: 0 }]], SCENE);
poses(B, [[0, z(0.75, 10)], [CUT, z(0.75, 10), E.out], [CUT + 500, z(1, 0)], [SCENE, z(1, 0)]], SCENE);
poses(B, [[0, { opacity: 0 }], [CUT, { opacity: 0 }], [CUT, { opacity: 0.15 }, E.out], [CUT + 500, { opacity: 1 }], [SCENE, { opacity: 1 }]], SCENE);
```

Two ladders on one element are fine here because they write different properties: transform+filter in one, opacity in the other.

## 10. Cut the curve and the waterfall cut

**Cut the curve** is the default boundary between beats inside a page, in the film's current (default LEFT). The outgoing hero accelerates, the cut lands mid-motion, and the incoming hero continues the same direction while decelerating.

| Parameter | Value |
|---|---|
| Travel | ±230 px (~12% of 1920), never fully off-screen |
| Exit | 330 ms `E.in4`; opacity → 0 over 180–300 ms (`E.in2`), finishing just before the cut |
| Entry | 330–420 ms `E.out4` (the mirrored half: same velocity at the cut); ignites at opacity 0.35 |
| Blur | Optional 8 px peak on both sides |

**Waterfall cut** is cut the curve per word, for text-to-text seams.

| Parameter | Value |
|---|---|
| Exit | Each word x 0→−230, 340 ms `E.in4`; fade 180 ms `E.in1`; stagger +22 ms in reading order, so the last word dies at the cut |
| Entry | Each word x +230→0, opacity 0.35→1, 300 ms `E.out4`; gaps start at 50 ms and shrink ×0.84 per word |

```js
const out = split(document.querySelector("#a"), "word"), inn = split(document.querySelector("#b"), "word");
const C = 2300;
out.forEach((w, i) => {
  const s = C - 0.32 * 1000 + i * 22;
  poses(w, [[0, { transform: "translateX(0px)" }], [s, { transform: "translateX(0px)" }, E.in4], [s + 340, { transform: "translateX(-230px)" }], [SCENE, { transform: "translateX(-230px)" }]], SCENE);
  poses(w, [[0, { opacity: 1 }], [s, { opacity: 1 }, E.in1], [Math.min(C, s + 180), { opacity: 0 }], [SCENE, { opacity: 0 }]], SCENE);
});
let off = 0, gap = 50;
inn.forEach((w) => {
  const s = C + off; off += gap; gap *= 0.84;
  poses(w, [[0, { transform: "translateX(230px)" }], [s, { transform: "translateX(230px)" }, E.out4], [s + 300, { transform: "translateX(0px)" }], [SCENE, { transform: "translateX(0px)" }]], SCENE);
  poses(w, [[0, { opacity: 0 }], [s, { opacity: 0 }], [s, { opacity: 0.35 }, E.out4], [s + 300, { opacity: 1 }], [SCENE, { opacity: 1 }]], SCENE);
});
```

## 11. Iris / circle wipe

Use it to reveal the recording through a growing circle from a point of interest (scene → recording), or to close onto one.

| Parameter | Value |
|---|---|
| Centre | The next beat's focal point (a button, the hero element) |
| Radius | 0 → `hypot(vw, vh)` |
| Duration | 500–700 ms `E.inOut3`; an accent ring 3 px on the edge, opacity 0.6 → 0 |
| Sound | `whoosh-soft` timed to peak at mid-wipe |

```js
const cover = document.querySelector(".bg");          // the scene's opaque layer
const CX = 1310, CY = 420, AT = SCENE - 650, DUR = 600, R = Math.hypot(innerWidth, innerHeight);
const inOut3 = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);
onSeek((ms) => {
  const r = R * progress(ms, AT, DUR, inOut3);
  const m = `radial-gradient(circle at ${CX}px ${CY}px, transparent ${r}px, #000 ${r + 1}px)`;
  cover.style.maskImage = m; cover.style.webkitMaskImage = m;
});
```

## 12. Kinetic type

Every word on screen comes from the beat sheet or the claims ledger. Use ≤ 3 sizes per beat and tracking −0.03 to −0.05 em at display sizes.

| Move | Use | Parameters |
|---|---|---|
| Focus-in | Headlines, promises | Per word: opacity 0→1, y 16→0 px, blur 14→0 px; 800 ms `E.out`; every 80–120 ms |
| Mask rise | Wordmarks, product name | Chars in an `overflow: hidden` line; `translateY(110%)→0`; 700 ms `E.out`; every 40–60 ms |
| Beat slam | Punchy hook words, one per beat | Binary opacity on, scale 1.6→1, blur 6→0; 160 ms `E.out4`; on beats (§ sound-design) |
| Waterfall entry | Title cards, segment openers | Binary opacity on; y offset anchor 60–80 / word 40–50 / light 30–48 px; 160–200 / 130–160 / 100–130 ms `E.out4`; next starts 1–2 frames before the previous settles |
| Typewriter | Prompts, search boxes, commands | `typewriter(el, text, {at, cps: 14–20})`; caret blink `steps(1)`, finite iterations |
| Keyword glow | The word the VO stresses | color → accent + `text-shadow 0 0 24px` accent at 40%; 250 ms attack, hold, 600 ms decay |

```html
<style>
  .line { overflow: hidden; padding-bottom: 0.08em; line-height: 1.05; }
  .caret { display: inline-block; width: 0.08em; height: 1em; background: currentColor; animation: blink 1s steps(1) 0s 12 both; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
```

```js
// Mask rise
const chars = split(document.querySelector("#name"), "char");
stagger(chars, [{ transform: "translateY(110%)" }, { transform: "translateY(0%)" }], { at: 250, every: 45, dur: 700, easing: E.out });
// Typewriter, with sparse key sounds: thin to every 3rd char and vary the volume with seeded random
const times = typewriter(document.querySelector("#prompt"), "find duplicate invoices", { at: 600, cps: 16 });
const r = random(7);
for (const [i, t] of times.entries()) if (i % 3 === 0) {
  const a = document.createElement("audio");   // created synchronously at load, never in onSeek
  a.src = "../audio/sfx/key.wav"; a.dataset.start = (t / 1000).toFixed(3); a.dataset.volume = (0.15 + r() * 0.1).toFixed(2);
  document.body.append(a);
}
```

Check that script-created `<audio>` tags show on Studio's Sound track. If they don't, put the times in `edits.audio.sfx[]` (`atMs = overlay.startMs + t`).

## 13. Counter / data in motion

| Parameter | Value |
|---|---|
| Duration | 1200–1800 ms `easeFn.out`; final value holds ≥ 1.2 s |
| Values | Only real numbers: read them from the recording or the ledger |
| Weight | Pair every number with a visual (bar, ring, the lifted chart); never a number floating alone |
| Type | `font-variant-numeric: tabular-nums`; 120–200 px for the hero number |
| Sound | `tick` every 3rd–5th step (volume 0.15) or none; `chime` on landing (0.35) |

```js
counter(document.querySelector("#n"), 0, 87, { at: 700, dur: 1500, format: (n) => `${Math.round(n)}` });
animate(document.querySelector("#bar"), [{ transform: "scaleX(0)" }, { transform: "scaleX(0.87)" }], { at: 700, dur: 1500, easing: E.out3 });
```

Successive stats about the same concept stay in the same visual space; only the value changes. Avoid pie charts, gridlines, legends and dashboards of six panels.

## 14. Cursor choreography

An oversized pointer that walks the eye, clicks to *cause* the next beat, and leaves. Put it in an overlay and align its click with the recorded click: `local ms = clickOutputMs − overlay.startMs`. If the replay shows the captured pointer, hide one of the two.

| Rule | Parameters |
|---|---|
| Size | 7vw (≈ 134 px at 1920); inside a small mock 4.6–5.5vw; never smaller |
| Look | White body + 1.4 px dark stroke (or the reverse); `drop-shadow(0 4px 6px rgba(0,0,0,.3))`; constant per film |
| Enter | Always from off-screen (below, y 115%), one continuous glide, 400–900 ms `E.out3`. Never fade it in. |
| Target | The **tip** lands on the target's centre |
| Click | Press scale 0.84 over 100 ms `E.in2` → 1 over 220 ms `E.out2`, pivoting on the tip; target press 0.94 in parallel; ripple ring scale 0.2→2.4, opacity 0.55→0, 500 ms `E.out` |
| Causality | The click frame starts the next thing: chip flip, lift, typing, scene cut |
| During VO it doesn't own | Drift aside 500–900 ms `E.out2`; no idle wobble |
| Exit | Accelerate off the nearest edge, 500–700 ms `E.in2`, or hand off across a cut |
| Sound | `click` at the press frame (anchor 3 ms), volume 0.3–0.4 |

```html
<div class="cur"><svg class="arrow" viewBox="0 0 24 24"><path d="M5.5 3.2v16.6l4.3-4.1 2.9 6.6 2.6-1.1-2.9-6.5h6z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
<div class="ripple"></div>
<style>
  .cur { position: absolute; left: 0; top: 0; width: 7vw; height: 7vw; z-index: 20; pointer-events: none; filter: drop-shadow(0 4px 6px rgba(0,0,0,.3)); }
  .arrow { width: 100%; height: 100%; transform-origin: 23% 13%; }   /* the tip */
  .ripple { position: absolute; width: 80px; height: 80px; margin: -40px 0 0 -40px; border: 3px solid var(--accent); border-radius: 50%; opacity: 0; }
</style>
```

```js
const cur = document.querySelector(".cur"), arrow = cur.firstElementChild, rip = document.querySelector(".ripple");
const size = innerWidth * 0.07, tip = [0.23 * size, 0.13 * size];
const at = (x, y) => ({ transform: `translate(${x - tip[0]}px, ${y - tip[1]}px)` });
const [TX, TY] = [1180, 610], CLICK = 1400;                       // target centre, click time (local ms)
poses(cur, [[0, at(TX, innerHeight * 1.15)], [250, at(TX, innerHeight * 1.15), E.out3], [1100, at(TX, TY)],
            [CLICK + 900, at(TX, TY), E.in2], [CLICK + 1500, at(innerWidth * 1.18, TY)], [SCENE, at(innerWidth * 1.18, TY)]], SCENE);
poses(arrow, [[0, { transform: "scale(1)" }], [CLICK, { transform: "scale(1)" }, E.in2], [CLICK + 100, { transform: "scale(0.84)" }, E.out2],
              [CLICK + 320, { transform: "scale(1)" }], [SCENE, { transform: "scale(1)" }]], SCENE);
rip.style.left = `${TX}px`; rip.style.top = `${TY}px`;
animate(rip, [{ transform: "scale(0.2)", opacity: 0.55 }, { transform: "scale(2.4)", opacity: 0 }], { at: CLICK + 100, dur: 500, easing: E.out });
```

The translate lives on the outer `.cur` and the press scale on the inner `.arrow`, so the two never fight.

## 15. Parallax depth layers

Every frame needs at least 2–3 depth layers. Move them at different rates **once, with intent**, then hold.

| Layer | Content | Travel over one move | Scale |
|---|---|---|---|
| Background | Recording under backdrop, brand glow, ghost type at 12–25% | −24 px | 1.00 → 1.02 |
| Midground | Lifted card, product shot | −60 px | 1.00 → 1.03 |
| Foreground | Label, callout, cursor | −120 px | 1.00 → 1.05 |

Each layer moves over 1500–2500 ms with `E.inOut3`, finishing in the first half of the beat. Decorative opacity below 10% disappears after compression. Avoid full-screen linear gradients on dark backgrounds because they band; use a radial gradient.

```js
[["#bg", -24, 1.02], ["#mid", -60, 1.03], ["#fg", -120, 1.05]].forEach(([sel, dx, s]) =>
  animate(document.querySelector(sel), [{ transform: "translateX(0px) scale(1)" }, { transform: `translateX(${dx}px) scale(${s})` }],
    { at: 300, dur: 2000, easing: E.inOut3 }));
```

## 16. Nudge curve (group repositions to make room)

No single ease does slow-fast-slow without a hard stop at the end. Use three segments on one ladder:

| Phase | Distance | Time | Ease |
|---|---|---|---|
| Ramp-in | ~10% | ~20% | `E.in3` |
| Burst | ~65% | ~18% | linear (reveal new content during this phase) |
| Tail | ~25% | ~62% (≥ 3× the ramp-in) | `E.out4` |

```js
const t = 1600;   // 270 px leftward over 570 ms
poses(document.querySelector(".row"), [[0, { transform: "translateX(0px)" }], [t, { transform: "translateX(0px)" }, E.in3],
  [t + 120, { transform: "translateX(-30px)" }, "linear"], [t + 220, { transform: "translateX(-210px)" }, E.out4],
  [t + 570, { transform: "translateX(-270px)" }], [SCENE, { transform: "translateX(-270px)" }]], SCENE);
```

## 17. Rack-focus blur cut (the cut you want seen)

Use it for a state swap of the same surface, at most once every ~8 s, never under a caption or a held read.

Outgoing: fully opaque, x 0→−80, scale 1→1.06, blur 0→12 px, 300 ms `E.in2`. Hard cut at peak blur. Incoming: x 80→0, scale 1.06→1, blur 12→0, 350 ms `E.out2`. Blur a wrapper, never a `<video>` or the lifted element's inner parts.

## 18. Motion blur (faked, seek-safe)

Blur is a shutter smear. It is only correct when travel exceeds about one element-width per frame. Use it on 1–3 snaps per film: a slam, a whip, a fast fly-in. Land sharp, and never blur text that is meant to be read at that moment.

| Parameter | Value |
|---|---|
| Direction | Along the motion: `feGaussianBlur stdDeviation="σ 0"` (horizontal) |
| σ | `min(24, 0.35 × px-per-frame)`, at 30 fps (33.3 ms per frame) |
| Drive | The same `onSeek` function writes position and blur, so they can't drift apart |

```html
<svg width="0" height="0" style="position:absolute"><filter id="mb" x="-50%" y="-10%" width="200%" height="120%"><feGaussianBlur id="mbBlur" stdDeviation="0 0"/></filter></svg>
```

```js
const el = document.querySelector("#slab"), blur = document.querySelector("#mbBlur");
const AT = 400, DUR = 380, FROM = -1400, TO = 0, FRAME = 1000 / 30;
const x = (ms) => FROM + (TO - FROM) * progress(ms, AT, DUR, easeFn.soft);      // power4.out
onSeek((ms) => {
  const v = Math.abs(x(ms) - x(ms - FRAME));                                    // px per frame
  el.style.transform = `translateX(${x(ms)}px)`;
  blur.setAttribute("stdDeviation", `${Math.min(24, v * 0.35).toFixed(1)} 0`);
  el.style.filter = v > 0.5 ? "url(#mb)" : "none";
});
```

## 19. Draw a connector or a highlight

| Move | Parameters |
|---|---|
| Connector line (SVG) | `stroke-dasharray = L`, `stroke-dashoffset L→0`, 500–800 ms `E.out`; 2–4 px; must link two **real** anchors (a lifted card → its label) and do a job |
| Underline / marker | `scaleX(0→1)`, `transform-origin: left`, 400 ms `E.out`; accent at full saturation |
| Recording highlight | `highlights[]` `{target:{ref}, color: <brand accent>, padding: 8–14}` for 1.5–3 s, in sync with the VO word |

```js
const path = document.querySelector("#link"), L = path.getTotalLength();   // measured once at load
path.style.strokeDasharray = `${L}`;
animate(path, [{ strokeDashoffset: `${L}px` }, { strokeDashoffset: "0px" }], { at: 1300, dur: 650, easing: E.out });
```

## 20. Seam and transition craft rules

**The vector law.** How beat A exits decides how beat B enters.

1. **Axis.** x stays x, y stays y, Z stays Z.
2. **Direction.** Never mirror it. On Z, direction is the sign of the scale change.
3. **Speed.** Mirrored eases (`E.in4` → `E.out4`, same distance and duration).
4. **Phase.** Cut mid-motion on both sides. An exit that settles to rest, or an entry that starts from rest, is a dead beat.

**The current.** Choose one dominant direction for ordinary seams (default LEFT). The other vectors are reserved and mean something when you spend them:

| Vector | Meaning |
|---|---|
| Up | A conclusion or reveal rises |
| Z forward (zoom-through) | Deeper into the same thought |
| Z back (inverse zoom) | Arrival: something bigger lands. Use it for the proof or the CTA. |
| Explode / scale-burst | Leaving a world |

Never run consecutive seams in opposite directions. A direction change needs a visible cause, such as a click or an impact.

**Budget and carriers.** Use 2–3 transition types per film and repeat them. The default inside pages is cut the curve; the default scene → recording transition is the match cut. Hand a concrete carrier across each cut: the lifted card, the cursor, the word group.

**Scene ↔ recording options, best first:**

| Seam | How |
|---|---|
| Match cut | §6: a scene element lands on the identical page pixels, then the background dissolves |
| Lift hand-off | The overlay starts on the lift's rect (pick-up) or ends on it (put back) |
| Iris | §11 from the next focal point |
| Dip through brand color | The scene background goes to the brand color, the content staggers out, then the background fades to reveal the first frame |
| Inverse-zoom arrival | A camera window that **starts** before the clip (hidden under the scene) at scale 1.08, easing back to 1 just after the clip begins. Verify the frames. |

**Never:**

- A crossfade between two busy layouts (it looks like a double exposure).
- Both texts visible during a zoom-through.
- An overlay page with a non-transparent background, unless it is meant to cover.
- A scene fading to transparent while a dense layout is still on it.
- An exit animation that finishes and *then* the scene changes.
- A reaction that starts a few frames after its cause. Effects start on the causing frame.

**Stillness before climax.** Put a 0.3–0.75 s held pause between the action and its result: the click, the hold, then the dial fills.

**Calm alternatives** for soft brand moments: a blur crossfade over 500–800 ms with a 20–30 px peak, only between simple frames. Timing presets: snappy 200, smooth 400, gentle 600, luxe 700 ms.

## 21. Anti-patterns

| Don't | Instead |
|---|---|
| Two `animate()` calls on one element and property | `poses()` ladder, or nested wrappers |
| Breathing, floating or pulsing loops to fill time | Add story: a staged reveal, inner UI life, cursor action |
| A slow push or pan in the back half of a beat | One push, done in the first half; then hold |
| `bounce`, `elastic` or overshoot on everything | Long-tail `E.out` / `E.soft`; `E.back` only for small pops |
| The same `y: 30, opacity: 0` entrance everywhere | Vary direction, scale, blur and mask; at most 2 animations share an ease |
| Animating `width`, `height`, `top` or `left` | `transform` and `opacity` (plus `filter`, `clip-path`, `mask`) |
| Measuring `getBoundingClientRect()` inside `onSeek` | Measure once at load or in `lift().ready` |
| Creating elements in `onSeek` | Create at load, toggle with opacity |
| A blurred word that the viewer must read | Blur the approach, land sharp, hold |
| A lifted element left floating as decoration | Every lift has a job: expand, come alive, go back or hand off |


## Cursor clicks that land

- Position the cursor with the `translate` property (or left/top), never `transform`, when the press uses `scale`: CSS applies `translate` → `rotate` → `scale` → `transform`, so a `transform` position gets scaled by the press and the cursor slides toward the page corner.
- Press around the arrow **tip**: `transform-origin` at the tip (for the kit cursor, `3.86px 3.86px` at 54 px wide). Scaling around the centre moves the tip off the target.
- The target must not move during the click: stop or predict any float/drift of the held card (sample the float as keyframes so its offset at the click time is known, and add it to the click point).
- Arrive just before the press and hold still for it; centre the ripple on the tip, not on the element.
- Verify with cropped stills 100 ms before, at and after the press: the tip must not move.
