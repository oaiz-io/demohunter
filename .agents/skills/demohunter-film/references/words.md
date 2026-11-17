# Words

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

Words fail in two ways: too many, and out of step with the picture.

## 1. Pacing

- TTS speaks about 2.2 words a second. Keep a scene or beat to about 19 spoken words (9 s); at most two beats may reach 26 words. A 30–90 s film is about 155 words or fewer.
- Start each segment (`offsetMs`) 150–300 ms after the beat's first motion, so the eye leads the ear.
- Sentences of 3–9 words, varied in length, ending on the strong word.
- Leave two or three 1–2 s moments without words where picture and music carry the film. A gap over about 1.5 s on a still screen is dead air.
- Write as spoken: "forty-two percent", "A P I", "example dot com".

## 2. The voice says the outcome; the screen shows the mechanism

| The screen shows | The voice says |
| --- | --- |
| the click, the bar filling, the step | what it gets you ("Sent in a minute.") |
| the exact number | what the number means |
| the labels and the UI text | nothing; never read screen text aloud |
| the URL on the close | the action, if there is one |

On-screen type never repeats the spoken sentence; it carries the word the line turns on, a label, or the number.

## 3. Narration and picture agree at every moment

Write each line against what is on screen while it is spoken, not against the beat's topic. A line that promises a browser while the terminal is on screen, or names output that never appears, costs the viewer's trust.

- For each segment, take `get_screenshot({ outputMs })` at its start (the clip's output start + `offsetMs`) and near its end (+ `audio.durationMs`). What the line names is visible, or the line changes.
- Land the change on the word that names it. There is no word-timing tool, so estimate: the word's time ≈ segment start + `audio.durationMs` × (words before it ÷ words in the segment). Check the estimate with a frame, and do not treat it as exact.
- When they disagree, change the cheaper side: re-cut, move `offsetMs`, or rewrite the line.

## 4. Captions and on-screen copy

- `export` writes `captions.vtt` and `captions.json` from the current script, as sidecar files. Players that support them show them.
- For a muted feed, burn captions in as an overlay: 2–3 words a group for high energy, 3–5 conversational, 4–6 calm. One group on screen at a time, sized with `fitText`, inside the safe band, never over the subject. Start the first group 100–300 ms in. Without word timings, spread each segment's duration across its groups by word count and say in the delivery note that caption timing is estimated.
- Titles take at most 6 words a line (10 in an explainer) and hold `readTime(text)`. Brand names keep one casing everywhere: type, voice script and captions.
- Banned in voice and type: "Welcome to", "Introducing" as the first line, "unlock", "seamless", "streamline", "supercharge", "revolutionary", "in today's fast-paced world", and anything that sounds like a brochure when read aloud.

## 5. `tts.instructions` is a director's note

`project.json` `tts.instructions` sets the delivery for every segment; a segment's own `instructions` overrides it for one line. Write it the way a director talks to a voice actor: who is speaking, to whom, the pace, the energy, how lines land, and what to avoid.

- Product: "Warm, confident voice-over. Unhurried, clear diction, a slight smile. A firm landing on the last word of each sentence. Never salesy."
- Explainer: "A curious teacher talking to one friend. Even pace, small rises on questions, a short pause before each answer."
- Essay: "Low and deliberate. Let sentences end. A beat of silence before a turn."

Regenerate only changed segments; it may cost provider credits.

## 6. Worked example

The beat: 6.2 s on an invoice list; the send dialog opens at 2.8 s into the beat.

- Before: "Fill in the customer and click send, and from now on the app will chase the payment for you." (19 words, about 8.5 s). It narrates clicks, it runs past the beat, and "chase the payment" has no picture.
- After: "Draft it, then send it. The reminders run themselves." (9 words, about 4.1 s). At `offsetMs` 250, "send" (word 4 of 9) falls about 1.4 s into the line, 1.6 s into the beat, but the dialog opens at 2.8 s. Set `offsetMs` to about 1450 so the word lands on the dialog, and check with a frame. The screen carries the mechanism; the type shows two words, "Sent today", on the invoice's row.
