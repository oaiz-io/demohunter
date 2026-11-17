# Social short (vertical or square)

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

## Shape

One change, shown once, in 15–45 s. The viewer decides in about a second whether to stay, often with the sound off, and the app's own buttons and captions sit on top of your frame.

- **Frame 0 is the thumbnail and the hook**: a face, the result, or one bold line already on screen. Never black, never a logo.
- **The change or the question arrives in the first beat.** The payoff comes before the swipe, around 60–70% in.
- **Faster than landscape**: shots of 1–2 s, a new beat every 2–4 s.
- **Sound off works**: speech is burned in as captions, and the picture carries the hook alone.
- **One subject, stacked vertically.** A landscape layout (panels side by side, a wide chart) is rebuilt as a vertical sequence, not squeezed.

## `PLAN.md` additions

```text
PLATFORM:      where it plays (Shorts, Reels, TikTok, LinkedIn, a site), aspect
SAFE BAND:     the band text and the product live in, for that platform
SOUND-OFF READ: what a muted viewer understands from the pictures and captions alone
LOOP?:         does the last frame cut back to the first on purpose
```

## Safe bands on 1080×1920

Practitioner defaults; check the platform you are making for, because ads and some apps reserve more.

- Nothing in the top 168 px (status and search bar).
- Every word and the product between y 168 and y 1330.
- Below y 1330 (caption, handle, buttons) only texture or decoration.
- Keep the right 140 px clear below the middle (the action rail).
- On 1080×1080, keep words inside the central 90%.

Type is larger than in landscape: titles 96–150 px with at most 5 words a line, nothing read under 32 px (`../look.md` §5). Burned-in captions sit at the bottom of the safe band (`../words.md` §4).

## In DemoHunter

- **No product footage**: `bun run studio new <dir> --title "<title>" --size 1080x1920` (or `1080x1080`). Every beat is a scene.
- **Product footage**: capture the tour with `viewport` set to 1080×1920 in `demohunter.config.ts`. The film's frame is the capture viewport, and the app takes its narrow layout. Then frame with `target` cameras as in landscape (`../look.md` §6).
- Draw the safe band as a temporary outline in each scene while building, look at it on a `sheet`, then remove it before export.
- Take `sheet --phone` before export; on a short it is the real viewing size.

## Typical mistakes

- A landscape film letterboxed into 9:16.
- Captions under the platform's own caption and buttons.
- A slow brand intro: the swipe happens before it ends.
- Text in the top 168 px or under the action rail.
- A loop by accident: the last frame jumps to the first without intent.

## Worked example

A 20 s vertical short for a note-taking app: "Your meeting notes write their own to-do list." Frame 0: a phone-width note already full of text with the line "Watch the to-dos appear" at y 300. Beat 1 (0–3 s): the camera targets the note. Beat 2 (3–9 s): three to-dos lift out of the text one by one, each with a `pop`. Beat 3 (9–15 s): the list docks into the app's task view. Beat 4 (15–20 s): the app name and URL at y 980, held 2.5 s. Captions run at y 1180–1300 in groups of 3 words.
