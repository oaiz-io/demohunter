# The look

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

Adjectives are where the default look lives. Turn each into numbers in the LOOK line of `PLAN.md` before the first scene.

## 1. Words into numbers

| The word | Becomes |
| --- | --- |
| premium | one material: a satin ground with 2% noise, a contact shadow `0 24px 60px` at 18%, arrivals on `ease.soft` over 700–900 ms |
| modern | a 1.2 s push on `ease.inOut`, a display face at 8% of frame height, tracking −0.03 em |
| clean | 12 columns, 96 px margins at 1920 wide, the accent on one word per beat |
| dynamic | something new every 2 s, one hero move per beat, cuts at the fastest frame |
| playful | `spring({ damping: 0.5 })` on position and scale, never on opacity; poses 10–30% exaggerated |
| cinematic | a key light from upper left, a 6% vignette, one slow push to 1.15 over 1.6 s |
| calm | holds at 1.5 × `readTime`, no whips, a hard cut at most every third seam |

## 2. A look from one medium

A look holds together when it is the rules of one medium, not a palette. Give each part one job, and let motion come from the medium. Risograph: paper (one flat colour with fibre noise), ink A (every word and line), ink B (one fluorescent accent per frame), overprint (B 3 px off register), halftone (every gradient is dots); the frame is printed plate by plate, not faded in. Product UI is its own medium: its surfaces, radii, colours and type, with nothing added that the product lacks.

## 3. Where the look comes from

Banning a default only moves the film to the next one; outside input breaks it, in this order:

1. **The real brand**: the product's CSS custom properties, its fonts (after a lift, `scenes/lifts/fonts.css`), its logo files. Quote hex values and families exactly. Scale sizes and borders for video; a 1 px web border vanishes on screen.
2. **A reference the person gave**: its grammar, never its content (shot lengths, title entrances, transitions, palette roles, type scale).
3. **The subject's own world**: its era, materials and place of use. A CLI lives in its terminal's monospace and colour scheme; a history essay in the archive's paper and print.

## 4. Banned defaults

Where generated films land when nothing was decided. Use one only as the brand or reference does.

| Default | Instead |
| --- | --- |
| Frame 0 an empty gradient or a lone word | the subject and one line, finished |
| A dark navy void with small things floating | a ground from the medium; the hero fills 40%+ of the frame |
| Glow, bloom, neon, flares, particles | depth from the medium: a shadow, a surface |
| Purple-blue or mesh gradients, glass cards | a flat brand ground; a radial fill for depth |
| Cream paper, serif display with an italic last word, mono caps labels | the brand's faces; `show.css` defaults to exactly this, so override its variables |
| A motif unrelated to the subject (clouds and stars on an invoicing film) | one motif from the subject itself |
| The same word-by-word blur-in on every line | an entrance per role (`motion.md` §3) |
| Everything centred, everything sliding up | a grid with a hero side |
| Three cards in a row, KPI grids, a title over a dimmed screenshot | one subject per beat, shown working |
| A full-width app recording at camera scale 1 | the active region framed (§6) |
| Inter, Space Grotesk, Instrument Serif, Geist, JetBrains Mono, system-ui | the brand's face, or one chosen for the subject, as woff2 in `scenes/` |
| The logo docked in a corner | the mark lands once, with weight, on the close |
| Cuts between a black terminal and a white page | a dip cut, or match their brightness |

After your first sheet, name every default the frames show, listed or not, and add it to BANNED with its replacement. The list grows with every film.

## 5. Type for video

Defaults from practice. `fitText(element, { max, min })` sizes a line to its box.

| Role | 1920×1080 | 1080×1920 |
| --- | --- | --- |
| Hero word or number | 140–220 px | 160–240 px |
| Title | 72–120 px, 1–2 lines | 96–150 px, ≤ 5 words a line |
| Body, captions, callouts | 40–56 px | 44–60 px |
| Floor for anything read | 28 px | 32 px |

- At most three sizes per beat and two families per film, besides the product's UI. One expressive face, one quiet; weight contrast 300 against 800.
- Display tracking −0.02 to −0.04 em. `tabular-nums` on changing numbers.
- One accent word per beat. Contrast at least 4.5:1 against what is really behind the text.
- Words inside the central 90%; vertical bands: `genres/short.md`.

## 6. Readable footage

Real UI, code, terminals and tables are dense: at full width, 13–16 px product text becomes 2–3 px on a phone. Frame it.

- **The region of interest fills most of the frame**: 60–90% of its width or height, with a 5% margin, cut on component edges, never through words. Keep the 30–40% that proves the line.
- **Scale from the text**: `scale ≈ wanted px ÷ source px`. Desktop-width UI usually needs camera `scale` 1.8–3, so product body text reaches about 28 px on the 1080p frame and the words the beat is about reach 40 px or more.
- **Use `target` cameras**: `{ "startMs", "endMs", "target": { "ref": "<ref>" }, "scale": 2.4, "easeMs": 1200 }` centres the element and follows it as the page scrolls. Without a target, `x`/`y` is the source point to centre. The camera clamps at page edges.
- **One push per beat**, done in its first half. Chain windows back to back (`endMs` equal to the next `startMs`) to move from one framing to the next without a return to the full page. To arrive framed, start a window exactly at a clip cut with `easeMs: 0`.
- **Make the source dense before capture.** The frame is the capture viewport (`viewport` in `demohunter.config.ts`, default 1440×900, not 16:9). For vertical or square films, capture at that narrower viewport so the app takes its narrow layout. Close side panels; set terminals to 28–32 px, ≤ 60 characters a line, no wrapping; use shell variables instead of typing long IDs.

## 7. Worked example

An invoice list recorded at 1920×1080. The beat's line: "Every invoice shows when it was paid." The proof is one invoice row, 14 px text, in an 820×300 region. A camera targets the row's ref at `scale` 2.2, `easeMs` 1100: the region spans 1800 px and its text is 31 px. LOOK: ground `#F7F6F2`, ink `#1A1A1A`, accent `#2F6FEB` on the paid date only; display in the product's own sans from `lifts/fonts.css`, 700 at 96 px, −0.03 em; the medium is the product's UI itself.
