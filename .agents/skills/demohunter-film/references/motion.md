# Motion

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

The numbers are defaults measured from strong films; a reference the person gave wins for its beat. For lifts, put-backs, cursor clicks, match cuts and seam rules with full code, use `moves-with-code.md` rather than rebuilding them.

Contents: 1 The kit · 2 Eases and springs · 3 Entrances, exits, staggers · 4 Holds and rhythm · 5 Camera moves · 6 Ken Burns · 7 Transitions · 8 Cuts, J and L · 9 Moves that look generated · 10 Worked example

## 1. The kit

```js
import { animate, stagger, split, spring, ease, easeFn, onSeek, progress, readTime, fitText, kenBurns } from "./kit/motion.js";
```

`animate(el, keyframes, { at, dur, easing })` is a Web Animation on the page's local clock with `fill: "both"`, so two `animate()` calls on one element and property fight: the later one holds its first keyframe early and hides the earlier one. Use one keyframe ladder per element and property, or nest wrappers (entrance on the wrapper, exit on the child). Animate `transform`, `opacity`, `filter`, `clip-path` and masks, never `width`, `height`, `top` or `left`.

## 2. Eases and springs

| Role | Kit ease |
| --- | --- |
| Arrival | `ease.out` (expo) or `ease.soft` (quint): lands on a long tail |
| Move between places, camera, morph, colour flood | `ease.inOut` |
| Exit, zoom-through | `ease.in`: accelerates away in one motion |
| Small pop (badge, chip) | `ease.back` or a spring, the only overshoot in the film |
| Progress, rotation | `"linear"`, when constant speed is the point |

The same ease at 500 ms on everything is the flat default of generated films; at most two animations in a scene share an ease and duration.

`spring({ stiffness, damping })` returns `{ easing, durationMs }`. Damping is a ratio: 1.0 never overshoots, 0.7–0.85 reads premium, 0.4–0.6 playful, under 0.3 a cartoon. Springs go on position and scale, never on opacity or colour.

```js
const pop = spring({ stiffness: 220, damping: 0.75 });
animate(badge, [{ transform: "scale(0.6)" }, { transform: "scale(1)" }], { at: 1400, dur: pop.durationMs, easing: pop.easing });
```

## 3. Entrances, exits, staggers

- First move 100–300 ms into a page. Entrances 400–900 ms; too snappy reads as a glitch.
- An exit takes 0.5–0.65× its entrance, as one motion: never slide, stop, then leave.
- The next element starts when the previous is 30–50% done. Fully sequential looks robotic; all at once looks cheap.
- Staggers: letters 30–60 ms, words 60–120 ms, rows 40–80 ms; a whole stagger under about 500 ms, ordered by importance.
- Vary title entrances by role: per word blur 6 px → 0 in 130 ms, 70 ms apart, no translate; per word from light grey to ink; the whole line blurring in over 150 ms; per letter for a name, opacity 0.3 → 1, 100 ms apart; a masked rise for a wordmark.
- One hero move per beat. Secondary moves travel 50–70% as far and start 100–200 ms later; everything else holds.

## 4. Holds and rhythm

- A line the viewer must read stays settled (landed, sharp, still) for `readTime(text)` ms: 500 + 300 per word. The last line holds 2 s or more; a one- or two-word chapter line may hold 400 ms.
- A landed title is dead still; motion moves on.
- Contrast speeds: montage cuts every 130–800 ms; a recording holds one framing 4–8 s; the slowest beat is about 3× the fastest.
- Hold 300–750 ms of stillness before the payoff, which plays at normal speed.
- Over about 3 s with nothing changing and nothing to read is dead: cut it, speed the clip (`rate` 1.3–2), or give it a line.

## 5. Camera moves

The camera works on recording clips in OUTPUT ms (framing numbers: `look.md` §6). A window eases from the full frame into its `scale` and back out over `easeMs`, clamped to half the window. When one window ends where the next starts (`endMs` equal to the next `startMs`), the camera travels from the first framing to the second and does not go back to the full frame between them. So keep the camera framed through a whole run of beats with back-to-back windows, and leave a gap only where the full page is the point.

| Move | Build | Caused by |
| --- | --- | --- |
| Push | `scale` 1.8–3, `easeMs` 900–1600, done in the beat's first half | the line turning to one region |
| Punch-in | a window starting exactly at a clip cut, `easeMs: 0` | a cut to the detail |
| Follow | `target: { ref }`; tracks the element as the page scrolls | something the story travels with |
| Pull-out reveal | hold the push, then end the window with `easeMs` 1000–1400 | the detail placed back in its whole |

In a scene, the camera is a wrapper you move: `animate(world, [{ transform: "scale(1)" }, { transform: "translate(-180px,-60px) scale(1.6)" }], { at: 300, dur: 1200, easing: ease.inOut })`.

## 6. Ken Burns

`kenBurns(element, { from, to, at, dur })` pans and zooms a still or a video. `from` and `to` are `{ x, y, scale }`: an offset in px and a scale around the centre (defaults: from `{0, 0, 1}`, to scale 1.12). Move toward what the voice names, change scale 5–15% over the hold, and alternate direction between consecutive stills so the cuts do not read as one long drift. Wrap it in a frame-sized box with `overflow: hidden` so no edge shows.

## 7. Transitions

Use 3–5 kinds per film, each caused by something on screen. At most a third of the seams between beats are plain hard cuts, and busy layouts never crossfade.

| Transition | Build | Caused by |
| --- | --- | --- |
| Cut on motion | hard cut at a move's fastest frame, same direction and speed both sides | any move that carries across |
| Match cut | a shape lands on the identical pixels of the next shot, the rest dissolves (`moves-with-code.md` §6) | one object in two worlds |
| Object becomes the world | a card grows past the frame in 650 ms `ease.inOut`, its radius shrinking; the rest blurs 15 px and fades in 300 ms | opening the thing clicked |
| Zoom through | a button scales from about 8% to 250% of the frame in 350 ms `ease.in`; its fill is the next frame | a click into a new screen |
| Morph | a container widens into the next (110 → 880 px, 200 ms `ease.out`), horizontal blur 12 → 0 | one thing turning into another |
| Carry across | the result shrinks 1 → 0.6, blur peaking at 6 px, and lands inside the next shot | an output becoming an input |
| Colour flood | the hero stays; the ground changes colour in 400 ms `ease.inOut` | a change of state or chapter |
| Whip | a 130–300 ms smear on one axis; the arrival sharpens in 130 ms | a jump in place or time |
| Iris | `clip-path: circle()` opens from the clicked point in 150–600 ms | a click |
| Dip cut | the outgoing frame darkens about 40% over 100 ms, then a hard cut | a jump between very different brightnesses |

Scenes sit above the held recording, so fading a scene's background at its end reveals the next clip's first frame.

## 8. Cuts, J and L

Cut while something moves, never after it settles. A click into a new screen cuts on the click's rebound; the new screen arrives at 1.04 and settles.

Let sound bridge picture so cuts feel motivated:

- **J cut**: the next line starts 300–600 ms before its picture. Anchor its narration segment to the outgoing clip with `offsetMs` = that clip's duration − the lead.
- **L cut**: the line runs 300–600 ms over the next picture. Anchor it to the outgoing clip and let it run past the cut.

`narrate --fit` extends any clip a segment overruns, undoing the J or L cut. Run `--fit` first, then re-anchor; changing `clipId` or `offsetMs` does not make audio stale. Music crossing a cut is a free L cut.

## 9. Moves that look generated

| Default | Instead |
| --- | --- |
| Breathing or floating loops to keep a frame alive | the UI doing its job, a staged reveal, a cut |
| Titles drifting or scaling after they land | land, hold still, leave |
| A slow creeping push late in a beat | one push, done in the first half |
| Every scene entering the same way | an entrance chosen by role |
| A blurred word the viewer must read | blur the approach, land sharp |
| An effect a few frames after its cause | the effect starts on the causing frame |

## 10. Worked example

A title in an explainer lands, holds for its read, then the ground floods to the next chapter's colour as the line leaves.

```js
const line = document.querySelector("#line");
const words = split(line, "word");
stagger(words, [{ opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0px)" }],
  { at: 200, every: 70, dur: 130, easing: ease.soft });
const settled = 200 + 70 * (words.length - 1) + 130;
const leave = settled + readTime(line.getAttribute("aria-label"));
animate(line, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-12px)" }],
  { at: leave, dur: 260, easing: ease.in });
animate(document.body, [{ backgroundColor: "#F3EFE6" }, { backgroundColor: "#1D3B2A" }],
  { at: leave + 80, dur: 400, easing: ease.inOut });
```

The entrance is on the words and the exit on the line, so they never fight. Set the page's duration meta to at least `leave + 480`.
