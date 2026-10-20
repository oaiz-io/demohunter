# Sound design for commercials

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

A mix is a set of relationships. Voice first, then the hero hits, then the music, then the small sounds. Write music and SFX as one piece: DemoHunter's kit renders the score and every effect in the **same key**, so stay inside that palette.

## 1. What the kit gives you

`bun run studio kit <project> --mood calm|bright|cinematic [--seed N]` writes:

| File | Contents |
|---|---|
| `audio/score-<mood>.wav` | License-free score, mastered to about −16 LUFS. It is composed to the **current edited timeline length** and resolves on the tonic at the end. |
| `audio/score-<mood>.cues.json` | `bpm`, `key`, `beats[]` (ms), `bars[]`, `strongCues[] {timeMs, kind}`, `sections[]`, `chords[]`, `resolveMs`, `sfxAnchorsMs{}`, `music.integratedLufs` |
| `audio/sfx/<kind>.wav` | whoosh, whoosh-soft, pop, click, key, tick, riser, impact, chime, swell, glitch, drop |
| `scenes/kit/motion.js` | The scene kit |

`strongCues[].kind` is one of `start | section | lift | drop | breakdown | cadence | resolve | end`.

Re-run the kit **after** narration (`--fit`) and all retiming, and again whenever the total length changes. Otherwise the resolve lands in the wrong place. Re-check every beat lock after each kit run. A different `--seed` gives a different arrangement in the same mood.

| Mood | Use for |
|---|---|
| `calm` | Trust-led B2B, VO-dense films, security, finance, health |
| `bright` | Consumer apps, playful tools, feature-card energy |
| `cinematic` | Trailer tone, big reveals, cold opens, "before/after" drama |

## 2. SFX palette: hit points and starting levels

Each effect is pre-levelled. `sfxAnchorsMs[kind]` is the offset from the file's start to its hit point. The values below come from the generator; always read the real ones from `cues.json`.

| Kind | Length | Hit point (anchor) | Use for | Start volume |
|---|---|---|---|---|
| `whoosh` | ~650 ms | ~403 ms (peak) | Fast cuts, whip pans, big lifts | 0.3–0.5 |
| `whoosh-soft` | ~520 ms | ~302 ms | Camera push-ins, lift & expand, iris | 0.25–0.4 |
| `pop` | ~110 ms | 2 ms | Element or badge appears, chip flip | 0.25–0.4 |
| `click` | ~40 ms | 3 ms | Cursor press, button | 0.3–0.45 |
| `key` | ~80 ms | 2 ms | Typing (thin to every 2nd–3rd char) | 0.12–0.25 |
| `tick` | ~30 ms | 2 ms | Counters, steps, list rows | 0.12–0.2 |
| `riser` | ~2000 ms | 2000 ms (its end) | Build into a reveal | 0.3–0.45 |
| `impact` | ~1600 ms | 4 ms | Hero landing on a strong cue (the loudest effect) | 0.35–0.55 |
| `chime` | ~900 ms | 3 ms | Success state, counter lands, CTA | 0.3–0.45 |
| `swell` | ~1500 ms | 1500 ms (its end) | Soft build under the promise or proof | 0.3–0.45 |
| `glitch` | ~320 ms | 2 ms | The "before / pain" beat, error states | 0.2–0.35 |
| `drop` | ~900 ms | 5 ms | Low hit for a reveal after a breakdown | 0.35–0.5 |

`volume` and `data-volume` map to dB as `20·log10(v)`: 0.5 → −6, 0.4 → −8, 0.3 → −10.5, 0.2 → −14, 0.15 → −16.5, 0.1 → −20 dB.

## 3. Placing a sound

There are two places to declare one. Each uses its own clock.

| Where | Field | Clock | Formula |
|---|---|---|---|
| `edits.audio.sfx[]` | `{id, src, atMs, volume}` | OUTPUT ms | `atMs = eventOutputMs − anchor` |
| Page `<audio>` | `data-start`, `data-volume` | Page-local **seconds** | `data-start = (eventLocalMs − anchor) / 1000` |

Use page `<audio>` when the sound belongs to a move inside a scene or overlay, so it travels with the page if you retime it. Use `audio.sfx[]` for events in the recording itself, such as the recorded click.

**Alignment rules:**

| Event | Align |
|---|---|
| Element enters | Hit on its first visible frame (0–100 ms before is fine) |
| Cut / whip / zoom-through | Whoosh **peak** on the cut frame (peak velocity) |
| Lift & expand, push-in (`inOut` travel) | Whoosh-soft peak at mid-travel |
| Cursor click | `click` on the press frame; the target's reaction starts on the same frame |
| Riser / swell | **Ends** on the impact or reveal: `atMs = revealMs − 2000` (riser) / `− 1500` (swell) |
| Impact / drop | On a strong cue, the same frame the hero lands |
| Counter | `tick` every 3rd–5th step, or none; `chime` the frame the final value is fully visible |
| Typing | `typewriter()` returns per-character times; thin to every 2nd–3rd, and vary the volume with `random(seed)` |

## 4. Density and restraint

- Budget about 15–25 cues for a 75 s film, about one every 3–5 s. Hero hits (`impact`, `drop`, big `whoosh`) are limited to the 1–3 beat locks.
- In sequences, accent only the first, the last or the rhythmically important item. Don't score every row.
- Never stack two whooshes within 300 ms. Never put a riser under every reveal.
- Under VO words, use only clicks, pops and ticks, at about 0.7× their normal volume. Save the big sounds for VO gaps.
- Use the kit palette only. If you must add an external sound, use CC0 only and log its license.
- Silence is a tool. Two or three VO-free moments let the score and the magic breathe. Drop the bed for 0.3–0.75 s before the climax (§6).

## 5. Music bed and ducking

```json
{ "audio": { "music": [
  { "id": "bed", "src": "audio/score-cinematic.wav", "startMs": 0, "offsetMs": 0,
    "volume": 0.35, "fadeInMs": 0, "fadeOutMs": 800, "duck": 0.35 }
] } }
```

| Field | Commercial default | Why |
|---|---|---|
| `volume` | 0.3–0.4, never above 0.5 | The bed sits about 8–10 dB under the voice before ducking |
| `duck` | 0.3–0.4 | Effective bed under VO = volume × duck ≈ 0.10–0.15 |
| `fadeInMs` | 0 for a cold open or a hook on the `start` cue; 400–800 for calm openings | The hook needs energy from frame 1 |
| `fadeOutMs` | 600–1000 | Keeps the tonic resolve audible under the lockup |
| `startMs` / `offsetMs` | 0 / 0 | The score is composed for this exact timeline |

The duck ramps down over **180 ms before** each narration segment and back up over **450 ms after** it. Narration gaps shorter than about 0.6 s therefore keep the bed ducked. Leave gaps of about 1 s or more where the music should swell, such as a magic moment with no words. DemoHunter has no EQ, carve or sidechain. If the voice fights the bed, lower `volume` to about 0.25 or `duck` to about 0.25, or switch to `calm`. Don't push the VO up: the master loudnorm levels everything anyway.

## 6. Beat-locking with strongCues

1. List the cues:

   ```sh
   bun -e 'const c = await Bun.file(process.argv[1]).json(); console.log("bpm", c.bpm, "key", c.key, "resolve", c.resolveMs); for (const s of c.strongCues) console.log(s.timeMs, s.kind); console.log("anchors", c.sfxAnchorsMs)' .demohunter/replays/<name>/audio/score-cinematic.cues.json
   ```

2. Map cues to the film's 1–3 hero moves:

   | Cue kind | Natural lock |
   |---|---|
   | `start` / first `section` | Hook slam, first word |
   | `lift` / `drop` | Reveal (product name), the biggest magic payoff |
   | `breakdown` | Stillness before the climax (drop the bed, hold the frame) |
   | `cadence` | Proof landing |
   | `resolve` (`resolveMs`) | CTA lockup arrives; it holds ≥ 2.5 s to the end |

3. Move each hero move to land within **±150 ms** of its cue. Prefer, in order: the move's local `at` inside its page; an overlay's `startMs`; a preceding recording clip's `holdMs`. Changing a scene clip's `durationMs` shifts everything after it, so re-check the rest.
4. Snap small sequential entrances to consecutive `beats[]` within **±100 ms**. For text the viewer must read, never reveal a new line on every beat above 110 bpm (beats under 545 ms apart): use every other beat, or reveal quickly and hold the set.
5. If a cue is more than about 150 ms from where the story wants the move, don't force it. Keep the natural timing, or try another `--seed`.
6. Record each lock in the storyboard, for example `beat-locked: 10.90 s (drop)`. Re-verify after every kit re-run.

**Drop-out before the climax.** Split the bed into two entries that share the music's clock. Put an `impact` or `drop` on the downbeat where bed B re-enters:

```json
{ "id": "bed-a", "src": "audio/score-cinematic.wav", "startMs": 0, "endMs": 40200, "offsetMs": 0, "volume": 0.35, "fadeInMs": 0, "fadeOutMs": 120, "duck": 0.35 },
{ "id": "bed-b", "src": "audio/score-cinematic.wav", "startMs": 40800, "offsetMs": 40800, "volume": 0.35, "fadeInMs": 30, "fadeOutMs": 800, "duck": 0.35 }
```

Setting `offsetMs` equal to `startMs` keeps bed B on the score's clock. Confirm on the waveform (review checklist §6) that the beat grid continues across the gap.

## 7. Voice-over

- The provider and voice live in `project.json tts` (`openai` or `elevenlabs`). Credentials come from the environment only.
- Put the delivery in `tts.instructions` (examples in `storyboard.md` §5). One segment per beat. Start each segment 150–300 ms after the beat's first visible motion.
- Spell out numbers, acronyms and URLs the way they should be spoken.
- Generate with `bun run studio narrate <project> --fit`. Regenerate only changed segments. Report whether audio is draft, stale or current.

## 8. Loudness and export

| Target | Integrated | True peak | Export flags |
|---|---|---|---|
| YouTube / social | −14 LUFS | ≤ −1 dBTP (export uses −1.5) | `--fps 30 --crf 16 --lufs -14` |
| Speech-first (webinar, docs embed) | −16 LUFS | ≤ −1.5 dBTP | `--lufs -16` (the default) |

Export mixes narration, the ducked music and the SFX, then runs a two-pass `loudnorm` (`I=<lufs>:TP=-1.5:LRA=11`, linear when possible). Always measure the result. See `review-checklist.md` §6 for the commands and pass bands.

## 9. Mix sanity rules

- The voice is intelligible in every VO window. If one is not, the bed is too loud there. Fix `volume`/`duck`, not the VO.
- Music-only passages sit about 4–8 LU (short-term) under the VO passages (practitioner default). They shouldn't jump up when the voice stops.
- No SFX peak louder than the VO around it, except the 1–3 hero hits.
- The final lockup lands on `resolveMs`, and the last hit rings out under the short fade.
