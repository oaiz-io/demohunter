# Sound

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

Sound is half of how a film feels, and you cannot hear it. Plan it on purpose, place it by numbers, measure the result, and say what you could not judge. The full procedure (SFX hit points, beat-locking, a bed drop-out) is in `sound-procedure.md`.

## 1. The clock

- **Narrated**: the voice is the clock. After `narrate`, each segment's `audio.durationMs` is a measured length; time the beat from it and land each change on the line that names it.
- **Music only**: the music is the clock. Land the payoff and the close on the score's `strongCues`, and cut on motion, not on every drum.
- **Silent** only for films made to play muted (a looping site background); then type and pictures carry it.

## 2. Choosing the score

`bun run studio kit <dir> --mood calm|bright|cinematic [--seed N]` writes a generated, licence-free score fitted to the timeline length, its cues (`bpm`, `beats`, `strongCues`, `resolveMs`, `sfxAnchorsMs`) and SFX in its key.

| Mood | For |
| --- | --- |
| `calm` | voice-dense films, explainers, essays |
| `bright` | consumer products, playful explainers, shorts |
| `cinematic` | cold opens, big reveals, documentaries with a turn |

The score resolves at the timeline's end, so re-run `kit` whenever the length changes, last after `narrate --fit`; `--seed` gives another arrangement. A licensed track the person gives you goes in `audio/` as `audio.music` with its licence in FACTS; cue data exists only for kit scores. The kit score is procedurally generated: say so in the delivery note and offer a produced track as the upgrade.

## 3. Effects only for visible actions

Every effect has a cause on screen; an effect with no cause reads as a template.

| Sound | Only on |
| --- | --- |
| `click` | a cursor click the viewer sees |
| `whoosh`, `whoosh-soft` | a cut, a whip, a large card or camera moving fast |
| `key`, `tick` | text arriving letter by letter, a count, list rows (every 2nd–3rd item) |
| `pop` | a badge, chip or number landing |
| `riser` into `impact` | the payoff, once in the film |
| `chime` | a success state the story turns on |

Place the hit point on the picture's frame or one frame (33 ms) after it, never before: light arrives before sound, and an early sound feels wrong sooner than a late one. The hit point is not the file's start: `atMs = eventOutputMs − sfxAnchorsMs[kind]` in `audio.sfx[]`, or `data-start = (eventLocalMs − anchor) / 1000` on a page `<audio>`. Use page `<audio>` for moves inside a scene or overlay, so the sound travels with the page when you retime it.

One effect every 3–5 s is plenty. Accent the first and last of a sequence. Never stack two whooshes within 300 ms; vary `volume` by ±0.05 or alternate `whoosh` and `whoosh-soft` so repeated cuts do not sound identical.

## 4. Levels and loudness

| Item | Default |
| --- | --- |
| Music bed `volume` | 0.3–0.4 under a voice; up to 0.5 for music only |
| `duck` | 0.3–0.4, so the bed under speech is about 0.1–0.15 |
| SFX `volume` | 0.2–0.45; under a voice line about 0.7× that |
| Music-only stretches | 4–8 LU (short-term) under the voice stretches |
| Export | `--lufs -14` for YouTube and feeds, `-16` for speech-first; true peak ≤ −1 dBTP |

Export normalises loudness in two passes, so never push the voice up; if it fights the bed, lower the bed.

## 5. Ducking gaps

The bed ducks over 180 ms before each narration segment and releases over 450 ms after it. A gap under about 0.6 s stays ducked. A gap of about 1 s or more swells back up; that is where the music should speak, with the picture doing something. A film with many short swells pumps: in one real film the bed rose to within 1.7 LU of the voice in every gap. Fix it by merging lines so gaps are either under 0.6 s or deliberate, or by lowering `volume` to about 0.25.

## 6. Honesty

Measure the export; report numbers, not impressions:

```sh
ffmpeg -hide_banner -i <out>/video.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -14
ffmpeg -hide_banner -i <out>/video.mp4 -af silencedetect=n=-45dB:d=0.6 -f null - 2>&1 | grep silence_
```

Commands for short-term windows and transient timing are in `sound-procedure.md` ("Measure the mix"). In the delivery note, write that the sound was measured, not heard, and name what nobody checked: how the music sounds, the voice's timbre and pronunciation, and whether each effect feels right.

## 7. Worked example

A 48 s narrated explainer. `kit --mood calm` after `narrate --fit`; bed `volume` 0.32, `duck` 0.35, `fadeInMs` 600. Three effects: `pop` on each of two diagram parts as they land, and one `whoosh-soft` timed to the camera dive's fastest frame (`startMs + easeMs/2 − 302`). The narration has one 1.4 s gap, at the dive, where the bed swells; every other gap is under 0.5 s. Delivery note: "Integrated −14.2 LUFS, true peak −1.6 dBTP, no silence over 0.6 s. Music-only stretch at 26 s sits 5 LU under the voice. Measured, not heard: I could not judge the score's character or the voice's pronunciation of 'amylopectin'."
