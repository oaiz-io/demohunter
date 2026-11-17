# Data story

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

## Shape

One dataset, and the one number in it that matters. A number is earned by the scene before it, then made physical: a count that becomes a skyline, a share that becomes a crowd, a gap that becomes a distance the camera travels. The story is the comparison that makes the number mean something: against last year, against a person, against a thing the viewer can picture.

## `PLAN.md` additions

```text
DATASET:       file in scenes/, source, date, licence, rounding rule
THE ONE NUMBER: the value, what it is compared with, and the beat where it lands
CHART STATES:  the build order: frame and axis → reference line → data → one annotation
ANNOTATION:    the one point that matters, and the words on it
```

## In DemoHunter

Start with `bun run studio new <dir> --title "<title>" --size 1920x1080` (or a vertical size for a feed).

- **One data module drives every figure.** Put the numbers in `scenes/data.js` as `export const data = { … }` and import it in every scene. Do not fetch it; an ES module import is synchronous with the page and keeps every number in agreement.
- **Charts are SVG you build**, in reading order: the frame and axis, a reference line, the data drawing in (`stroke-dashoffset` or `scaleY` from a baseline with `animate`), then one annotation on the mark itself. No legends.
- **Highlight one series**, grey the rest at about 35% opacity. A chart with one thing to say says it in its title.
- **The number is the biggest thing on screen** (140–220 px at 1080p), in `tabular-nums`. `counter(el, from, to, { at, dur, format })` counts over 1200–1600 ms, then holds at least `readTime`; count only between real values.
- **A source line on screen** for every figure, at the type floor (28 px at 1080p), held as long as the figure.
- **The same object carries across beats**: a bar becomes the ground of the next scene; a line becomes the road the camera follows (a wrapper moved with `animate`, `../motion.md` §5).

## Typical mistakes

- A grid of KPI cards, a dashboard, a pie chart.
- Every number counting up at once.
- A number with no source, or rounded differently in two scenes.
- A chart dropped in finished, then explained.
- Axis labels and gridlines too small to read on a phone. Drop what the story does not need; keep the rest at the floor.

## Worked example

Dataset: a city's monthly bike-share trips for two years, from its open-data portal (URL, licence, retrieved date in DATASET). The one number: winter trips grew more than summer trips. Beat 1: an empty winter street at dawn (made in SVG) and "Who rides in January?" Beat 2: the axis, then last year's line in grey. Beat 3: this year's line draws in, in the accent, and the January gap is annotated on the line. Beat 4: `counter` lands the January change, with the source line under it. The rounding rule ("nearest thousand trips") is the same in every scene because every scene imports `data.js`.
