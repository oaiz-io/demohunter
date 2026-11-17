# Look at it

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

You wrote the timeline, so you know what happens; the viewer only sees it. Looking at your frames is how you become the viewer, after every real change.

## 1. Which frames, and when

| When | Take |
| --- | --- |
| While editing one beat | `get_screenshot({ outputMs })` at the moment you changed |
| After the rough cut and each pass | `bun run studio sheet <dir>`: start and middle of every clip and overlay, timed |
| After timing or transition changes | `sheet <dir> --cuts`: a strip across each cut |
| Before export, and whenever there is UI or small text | `sheet <dir> --phone`: the same sheet at phone width |
| Chosen moments (frame 0, the payoff, a line's settle and exit) | `sheet <dir> --at 0,4200,18750` |
| To find dead stretches | `sheet <dir> --every 2000` |

`sheet` prints the JPEG paths; open every one. Take `--at` times from `edits.json` and `narration.json`, not by eye.

## 2. How to look

- **Describe each beat frame in one sentence, as a stranger would**, naming every object. One you would have to explain ("those bars are the overdue invoices") is not said yet.
- **Read the frames in order.** Does each cause the next? Does each match its row in BEATS?
- **Cover the words.** Do the pictures alone tell the storyline? Do the words alone?
- **Phone sheet.** If you squint to read the beat's words, the viewer cannot read them: push in further, or set the key line as type.
- **Frame 0.** Would you click this thumbnail?
- **Cut strips.** No double exposure, no dark-to-bright flash, nothing jumping at the seam.
- **Defaults.** Name each banned default you see (`look.md` §4), add it to BANNED, replace it.

Trust numbers over your eye; a 0.6 s line looks fine on a tile. Check holds against `readTime` and sizes against the floor.

## 3. Writing what you find

One line per problem: `time · where · problem → change`.

```text
0.0 s · full frame · empty gradient, no subject → open on the invoice row with the title over it
12.4–15.0 s · table · 14 px rows unreadable on the phone sheet → target camera on row ref, scale 2.4
31.2 s · cut · black terminal to white browser flashes → dip cut over 100 ms
44.0–49.5 s · whole frame · nothing changes for 5.5 s, no voice → trim the hold to 1 s
```

Fix in order: wrong or unreadable, then timing, then detail, and look again at what you changed. When a fix does not hold, take frames either side, list every difference, and change one thing.

## 4. When to stop

Stop when a fresh pass finds only what a viewer would not notice at full speed, or when fixes make as many problems as they solve. A busy film needs less: remove a third of the motion.

## 5. The delivery note

Append it to `PLAN.md` under `DELIVERY`; put its short form in your reply:

- **Built**: the storyline picked, the other two in a line each, export path, runtime.
- **Looked at**: which sheets, at which times, and the notes you fixed.
- **Measured**: loudness, true peak, longest silence, holds against `readTime`, text sizes.
- **Could not judge**: how the sound feels, motion at full speed, colour on real screens, estimated caption timing, media you lacked.
- **Weakest moment**, and what you would change next.
