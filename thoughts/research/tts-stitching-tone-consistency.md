# TTS narration stitching: tone and pacing consistency

**Research date:** 2026-08-10

**Scope:** DemoHunter's current local narration pipeline, ElevenLabs and OpenAI speech APIs, and ffmpeg-based post-processing.

**Decision:** Improve continuity in layers. First fix an ffmpeg gain change in the current renderer, then add audio-conditioned ElevenLabs request stitching, then add conservative mastering and boundary control. Crossfading speech is not a primary fix.

## Executive summary

The disconnected-take effect is not one problem. It is the sum of four largely independent discontinuities:

1. **Prosody is regenerated from scratch for every API call.** Each call independently chooses pitch contour, energy, speaking rate, phrase breaks, and sentence-final delivery. Text-only `previous_text` / `next_text` helps the model plan linguistically, but it does not condition the next request on the actual performance that was generated.
2. **Every segment is framed like a complete utterance.** Short inputs and terminal punctuation encourage a fresh onset and a conclusive cadence. Longer-form TTS research consistently finds that cross-sentence context and sentence position affect perceived naturalness and prosody ([Clark et al., 2019](https://arxiv.org/abs/1909.03965), [Xue et al., 2022](https://arxiv.org/abs/2209.06484)).
3. **The rendered level currently changes over time.** DemoHunter delays each complete clip and mixes all delayed inputs with ffmpeg `amix=...:dropout_transition=0`. Because `amix` normalization defaults to enabled, it renormalizes as inputs end. A local reproduction with three identical tones produced mean levels of **-30.6, -27.1, and -21.1 dB** at the three positions. Adding `normalize=0` held all three at -21.1 dB. A roughly 9.5 dB rise can easily be perceived as a different take, even if the source clips match.
4. **Boundary timing and mastering are uncontrolled.** Provider-dependent leading/trailing silence, codec delay, the fixed 300 ms hold padding, and the next clip's leading silence all accumulate. The pipeline measures duration but not active-speech boundaries, loudness, true peak, or realized words per second.

The highest-value path is therefore:

- Fix `amix` gain behavior immediately and add a final peak/loudness guard.
- For ElevenLabs v2/v2.5, capture response `request-id` values and pass up to three `previous_request_ids` during a left-to-right synthesis session, with `next_text` as lookahead. This is the main request-stitching feature DemoHunter is not using.
- Keep a single explicit direction and global speed for the whole narration; use a higher, tested ElevenLabs stability setting and keep style exaggeration at zero.
- Normalize and trim conservatively in a versioned derived-audio layer, preserving raw provider responses for cache/offline use.
- Treat speech crossfades as a small boundary-click tool only. Crossfading voiced material overlaps phonemes and can sound worse while doing nothing about pitch, emotion, or rate.

## Current DemoHunter architecture

The present flow is below. Although this is often described as concatenation, the current renderer does not use ffmpeg's concat filter: it places complete clips on a shared timeline and mixes them.

```text
.tour.ts narration events
        |
        v
collect timeline and find adjacent narration text
        |
        v
resolve one segment -> cache lookup -> one provider request on miss
        |
        v
provider-encoded file + ffprobe duration in .demohunter/cache
        |
        v
replay records each start time and waits duration + holdPaddingMs
        |
        v
ffmpeg: adelay every clip -> amix all clips -> AAC/Opus output
```

Relevant details from the code:

- [`collect-timeline.ts`](../../packages/generator-playwright/src/execute/collect-timeline.ts) finds the nearest prior and next narration events, even across intervening actions. It adds context only when provider, model, voice, format, language, and ElevenLabs voice settings match. It supplies one neighboring text on each side, and disables the feature for `eleven_v3`.
- [`resolve-narration.ts`](../../packages/generator-playwright/src/narration/resolve-narration.ts) adds `previousText` and `nextText` only for ElevenLabs. OpenAI requests receive no surrounding script context.
- [`elevenlabs-provider.ts`](../../packages/tts-elevenlabs/src/elevenlabs-provider.ts) sends `previous_text`, `next_text`, language, and the configured stability/similarity/style/speaker-boost/speed controls. It returns audio bytes but discards response headers, so the generation's `request-id` cannot be used for stronger stitching.
- [`openai-provider.ts`](../../packages/tts-openai/src/openai-provider.ts) sends model, voice, instructions, response format, and input. It does not send the Speech API's numeric `speed` parameter. Its default direction is the fairly broad “Speak clearly, calm, concise, product-demo style.”
- [`cache-key.ts`](../../packages/tts-core/src/cache/cache-key.ts) includes provider options in the cache identity. Consequently, adjacent-text context is already cache-safe: changing a neighbor invalidates the affected ElevenLabs segment. The cache stores each provider result independently and has no concept of a synthesis session or derived/mastered audio.
- [`cache-store.ts`](../../packages/tts-core/src/cache/cache-store.ts) validates bytes/checksum and measures only total duration with `ffprobe`. It does not measure loudness, active-speech duration, silence, peak, or rate.
- [`replay-timeline.ts`](../../packages/generator-playwright/src/execute/replay-timeline.ts) waits for a normal narration's entire measured duration plus `holdPaddingMs` (300 ms by default). Total audible separation is therefore provider trailing silence + 300 ms + next provider leading silence.
- [`renderer.ts`](../../packages/media-ffmpeg/src/renderer.ts) applies `adelay` and then `amix=inputs=N:duration=longest:dropout_transition=0`. It does not specify `normalize`, so ffmpeg's enabled-by-default normalization remains active. It also has no explicit resampling/layout, fades, silence handling, loudness normalization, compressor, or limiter.

This architecture is strong for local/offline reuse: a cache hit needs no provider key, corrupt entries regenerate cleanly, and `.demohunter/` remains portable. Continuity changes should preserve those properties.

## 1. Root causes

### 1.1 Independent generation resets utterance-level planning

Modern generative TTS is probabilistic. Voice identity is only one part of the output; prosody also includes pitch contour, intensity, duration, pauses, emphasis, and phrase-final shape. A separate request has no acoustic memory of the exact prior result unless the API explicitly carries audio/request state forward.

ElevenLabs itself describes abrupt prosody changes between chunks as the problem solved by Request Stitching. Its guide distinguishes the stronger request-ID workflow—generate in order, capture each response's `request-id`, and supply prior IDs—from mere byte concatenation ([Request Stitching guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching)). DemoHunter currently implements the text fields but not request IDs.

`previous_text` tells the model what was said, not how it was realized. Two generations of the same prior sentence can differ in energy and cadence. `previous_request_ids` can condition the next sample on actual previous generations, which is closer to “continue this take.”

### 1.2 Segments are too short or cut at the wrong prosodic boundary

Every segment starts with a cold onset and usually ends with punctuation that implies closure. The model may repeatedly produce an intro-like attack and outro-like fall. This is especially visible when a logical sentence is divided for action timing, or when each step is a one-line imperative.

Paragraph-based TTS research reports better cross-sentence breaks and prosodic variation when the model represents paragraph context and sentence position, rather than synthesizing isolated sentences ([ParaTTS](https://arxiv.org/abs/2209.06484)). This supports three practical rules:

- Split at natural sentence or clause boundaries, not arbitrary UI-action boundaries.
- Give the provider more discourse context than the current single neighbor where the API permits it.
- Tell instruction-following models whether a segment is opening, continuing, or closing the narration.

For Eleven v3 specifically, ElevenLabs warns that very short prompts are more inconsistent and recommends prompts longer than 250 characters during the current alpha stage ([v3 prompting guide](https://elevenlabs.io/docs/best-practices/prompting)). That makes v3 a poor automatic drop-in for many short DemoHunter events despite its richer audio tags.

### 1.3 Sampling and voice settings permit variation

ElevenLabs states that the system is non-deterministic and that lower stability broadens emotional range and randomness. Higher stability produces a more consistent, though potentially more monotonous, result. Style exaggeration can make the model less stable; ElevenLabs recommends keeping it at zero for normal use ([Text to Speech guide](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)).

DemoHunter's ElevenLabs defaults are stability `0.5`, similarity `0.75`, speaker boost enabled, and no explicit speed/style. These are reasonable general defaults, but a neutral product narration may benefit from a tested stability around `0.65–0.8`, style `0`, and one global speed. The exact value should be voice-specific and validated by listening; setting stability extremely high trades away natural emphasis.

The ElevenLabs `seed` request field is not used. It makes a best effort at repeatability but does not guarantee determinism ([Create speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)). A stable seed is useful for reproducible cache misses and comparisons, but the same seed across different text is not acoustic continuation and should not be marketed as a stitching fix.

### 1.4 OpenAI has direction control, but no cross-request speech state in this endpoint

`gpt-4o-mini-tts` accepts instructions for accent, emotional range, intonation, speed, and tone ([OpenAI TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech)). DemoHunter sends instructions, but its default does not specify a measurable pace, pitch/energy range, boundary behavior, or the segment's position in the full take.

The Speech API also exposes a numeric `speed` value from 0.25 to 4.0, default 1.0, which DemoHunter does not send ([OpenAI Audio API reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)). The numeric control can establish a global pace; instructions should carry the performance direction. Neither control provides prior-audio state, so separate OpenAI calls can still vary.

The legacy `tts-1` and `tts-1-hd` models do not support the `instructions` control according to the same API reference. DemoHunter currently sends instructions for all three allowed OpenAI models, so consistency guidance should explicitly favor `gpt-4o-mini-tts` when directions matter.

### 1.5 Current `amix` settings create a deterministic level ramp

FFmpeg documents that `amix` normalization is enabled by default and that `dropout_transition` controls volume renormalization when inputs end ([FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#amix)). DemoHunter sets the transition to zero but leaves normalization on.

All delayed clips are inputs from time zero; future clips initially contribute delayed silence. As prior input streams end, ffmpeg immediately changes the normalization divisor. A reproduction on ffmpeg 7.1.4 used three identical one-second tones delayed to 0, 2, and 4 seconds:

| Mix configuration | Tone 1 mean | Tone 2 mean | Tone 3 mean |
|---|---:|---:|---:|
| Current behavior (`normalize` default, `dropout_transition=0`) | -30.6 dB | -27.1 dB | -21.1 dB |
| `normalize=0` | -21.1 dB | -21.1 dB | -21.1 dB |

The magnitude depends on clip count, durations, and overlap, but the mechanism is deterministic. This must be fixed before judging provider-level continuity because loudness strongly changes perceived energy and “distance from the microphone.”

### 1.6 Variable silence and lossy segment boundaries change rhythm

Each cached file can contain a different amount of leading/trailing silence. MP3 also introduces codec framing/delay considerations, and every source is decoded before final AAC/Opus encoding. The replay then adds fixed padding after the file's total duration, not after detected active speech.

The result is an uncontrolled boundary gap:

```text
tail inside clip A + 300 ms hold padding + head inside clip B
```

Even perfectly matched voices sound like separate takes when every boundary has a different pause. Conversely, blindly removing all silence can clip breaths, fricatives, or intentional punctuation pauses.

### 1.7 Post-processing cannot repair semantic prosody

Loudness normalization can match level, `atempo` can correct a rate outlier without intentionally shifting pitch, and tiny fades can prevent clicks. None can turn a conclusive falling cadence into a continuing phrase, align emotion, or restore a different pitch contour. Those problems must be addressed during synthesis through context, direction, grouping, or regeneration.

## 2. Available techniques

| Technique | What it helps | Limits / risks | DemoHunter status |
|---|---|---|---|
| ElevenLabs `previous_request_ids` | Actual acoustic/prosodic continuation from up to three prior generations | IDs should be under two hours old; unavailable for v3; requires ordered session orchestration | Not used; response headers discarded |
| ElevenLabs `next_request_ids` | Regenerating a middle clip while matching already-generated neighbors | Only available after the future neighbor exists; same freshness/model constraints | Not used |
| Wider `previous_text` / `next_text` | Discourse and phrase planning | Still text-only; larger context widens cache invalidation | One adjacent narration on each side |
| ElevenLabs `seed` | Best-effort repeatability and controlled comparisons | Not guaranteed; not continuity across different text | Not used |
| Stability/style/speed | Narrows variation and fixes a global pace | High stability can sound flat; extreme speed harms quality | Supported for ElevenLabs; defaults not continuity-tuned |
| Eleven v3 audio tags | Explicit emotion, delivery, pauses, pacing | Request stitching and numeric speed are unavailable; short prompts are inconsistent; tags must be authored in text | v3 context intentionally disabled |
| ElevenLabs multi-context WebSocket | Keeps prosodic state within one logical context | Advanced, sessionful, not available for v3, more complex than offline REST | Not used |
| One long synthesis + alignment/splitting | Best global planning because the model sees the whole narration | Coarse cache invalidation, provider limits/cost, word/character alignment and safe cutting required | Not used |
| OpenAI detailed instructions | Tone, intonation, emotion, and requested pace | No actual prior-audio state; directions are guidance, not guarantees | Used, but default is broad |
| OpenAI numeric `speed` | One stable global rate | Does not align pitch contour/emotion; extreme values can sound processed | Not used |
| Explicit model snapshot | Reproducibility across future reruns | Does not fix segments within one run; current provider rejects snapshot IDs | Not used |
| `amix normalize=0` | Removes clip-count/end-time-dependent gain changes | Overlapping clips can sum and clip; add peak protection | Not used |
| Two-pass `loudnorm` / group-relative gain | Level and loudness consistency | Short clips can yield unstable integrated measurements; dynamic mode can pump | Not used |
| `aresample` + `aformat` | Uniform sample rate/layout before mixing | Does not change prosody | Left implicit to ffmpeg |
| Conservative silence trim + fixed gap | Boundary rhythm and excessive dead air | Thresholds can clip quiet phonemes/breaths | Not used |
| 5–20 ms edge fades | Click/pop suppression | Does not blend performances | Not used |
| `acrossfade` | Smooth amplitude transition between adjacent streams | Overlaps speech/phonemes and changes duration; ineffective across intentional gaps | Not used |
| `atempo` outlier correction | Brings a clearly fast/slow segment toward group pace | Can sound processed and changes timeline duration; should be tightly clamped | Not used in media pipeline |

### API features worth prioritizing

#### ElevenLabs request IDs

The REST API accepts up to three prior and future request IDs. If both `previous_text` and `previous_request_ids` are present, the text field is ignored; the same precedence applies on the next side. Results are best when model identity is unchanged ([Create speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)). The guide says IDs should be no older than two hours and that the response must be fully consumed before its ID conditions the next streaming request ([Request Stitching guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching)).

A practical hybrid for DemoHunter is:

- Synthesize cache misses left-to-right.
- Keep successful response IDs in memory for the current generation run.
- Pass up to three fresh prior IDs plus current `next_text` lookahead.
- If the immediate prior segment came from an old/offline cache entry, fall back to `previous_text` rather than forcing regeneration.
- When regenerating a middle segment in the same live session, pass fresh previous and next request IDs.
- Offer an explicit future “continuity/quality regeneration” mode that refreshes an entire compatible narration group when the user prefers quality over cache savings.

Do not make request IDs a durable dependency of portable output. They expire, may be unavailable under ElevenLabs zero-retention behavior, and should not be required for offline regeneration. The generated audio remains the durable artifact.

#### Longer/sessionful generation

ElevenLabs' multi-context WebSocket maintains prosodic consistency within a logical context, but its documentation positions the API for advanced real-time voice applications and limits it to non-v3 models ([Multi-Context WebSocket guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket)). It is technically possible from Bun, but request-ID REST stitching is a much smaller architectural step for an offline CLI.

Generating a whole compatible narration group in one request has the highest theoretical continuity. It should be a later quality mode, using the ElevenLabs “with timing” response or a forced-alignment pass to cut only at safe boundaries. For OpenAI, whole-group generation plus alignment is the only strong way to give the Speech endpoint global script context without changing APIs.

### Prompt and text engineering

Use one immutable narration direction for every compatible group. For OpenAI, a stronger default could express:

> Deliver this as one continuous product-demo narration: warm, composed, medium energy, about 150 words per minute, with a narrow pitch range and consistent vocal distance. Use natural sentence stress. Do not introduce a new-show greeting on each segment. On non-final segments, avoid a conclusive sign-off cadence.

The exact wording should be A/B tested by voice. Important practices:

- Keep direction identical across segments; segment-specific creative adjectives cause drift.
- Automatically append structural position (“opening,” “continuation,” “final”) rather than asking authors to repeat style prose.
- Preserve natural punctuation. Do not split mid-phrase merely to align with an action.
- Normalize ambiguous numbers, abbreviations, URLs, and product names consistently. ElevenLabs notes that symbols/digits and text structure can destabilize pronunciation and delivery ([TTS best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)).
- For ElevenLabs v2, do not assume DemoHunter's `instructions` field affects output: the current adapter does not send it, and this API uses text/voice settings rather than an OpenAI-style instruction field. For Eleven v3, supported audio tags live in the input text, but v3 gives up request stitching.

### Loudness normalization and dynamics

FFmpeg's `loudnorm` implements EBU R128 normalization, supports one- and two-pass modes, and can target integrated loudness, loudness range, and true peak ([FFmpeg `loudnorm`](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)). For file-based generation, two-pass processing is preferable because the first pass measures and the second applies a known correction.

Recommended shape:

1. Decode every clip to a common floating-point sample format, sample rate, and channel layout.
2. Correct the `amix` behavior with `normalize=0`.
3. Optionally measure active-speech loudness per segment and apply bounded group-relative gain (for example, cap correction to a few dB). Do not independently force every very short clip to a hard LUFS target.
4. Apply final-bus two-pass loudness normalization and a true-peak/limiter guard.

This matches level and protects against overlap/clipping. It will not match timbre or prosodic intent, so it should remain downstream of provider-level continuity work.

### Silence, fades, and crossfading

Use `silencedetect` or a conservative `silenceremove` analysis to identify excessive head/tail silence; retain safety margins and then insert a deterministic boundary gap. FFmpeg supports trimming while retaining a configured amount of silence ([FFmpeg `silenceremove`](https://ffmpeg.org/ffmpeg-filters.html#silenceremove)). Gap policy can vary by semantic boundary: shorter for a continuation, longer for a chapter change.

Apply a 5–20 ms fade-in/fade-out at decoded clip edges to suppress discontinuities or codec clicks. Do not default to a material `acrossfade` over voiced audio. FFmpeg's `acrossfade` overlaps the end of one stream with the start of another and changes the effective duration ([FFmpeg `acrossfade`](https://ffmpeg.org/ffmpeg-filters.html#acrossfade)); overlapping two different pitch contours can produce doubled consonants, combing, or an audible dip. If used at all, crossfade only verified silence/room-tone regions or use a non-overlapping fade.

### Speed adjustment

Prefer one provider-level speed for the whole narration. DemoHunter already exposes ElevenLabs speed; it should expose OpenAI speed too. Provider guidance says ElevenLabs supports roughly 0.7–1.2 and warns that extremes can reduce quality ([ElevenLabs TTS guide](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)).

As a second-line guard, compute realized words per active-speech second. Only correct clear outliers toward the compatible group's median, clamp `atempo` tightly (for example, within about 3–5%), and recompute duration/timeline data after processing. FFmpeg's `atempo` adjusts tempo and supports a broad numeric range ([FFmpeg `atempo`](https://ffmpeg.org/ffmpeg-filters.html#atempo)), but a technically valid extreme is not appropriate for natural narration.

## 3. Feasibility in a local-first Bun CLI

All recommended post-processing is feasible with the existing ffmpeg/ffprobe dependency and `spawn`/argument-array pattern. No hosted DemoHunter backend or native Node add-on is required.

The main architectural constraint is caching:

- Keep **raw synthesis artifacts** keyed by provider, model, voice, full direction/settings, stable continuity text, and input text.
- Create a **derived/mastered artifact** keyed by the raw checksum plus a versioned processing recipe (sample rate, trim policy, gain, tempo, fades). This lets users change the mastering pipeline and regenerate offline without another paid API request.
- Store measured duration, active-speech bounds, integrated/short-term loudness as available, true peak, applied gain, tempo, and processing version in metadata.
- Add every stable synthesis-affecting field—OpenAI speed, ElevenLabs seed, wider text context, direction position—to the raw cache identity.
- Do **not** key portable cache entries on ephemeral request IDs. Record them only as optional diagnostic/session metadata, if at all.
- Increment a processing schema/version whenever filter behavior changes so old assets are either reused safely as raw input or rebuilt deterministically.

Request-ID stitching needs a coordinator above the current stateless `resolveNarrationSegment()` loop. The coordinator must inspect cache state before synthesis, group compatible narrations, and generate misses in order. This is a medium-sized refactor, not an adapter-only change. Bun's built-in `fetch` can already read response headers, so no provider SDK is required.

Lossless intermediate formats are also feasible. OpenAI supports WAV/PCM output ([OpenAI TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech#supported-output-formats)); ElevenLabs exposes PCM/WAV formats on eligible plans. Lossless raw cache increases disk use and may depend on provider tier, so keep MP3 compatibility and always normalize decoded streams before the final mix.

## 4. Ranked implementation recommendations

| Rank | Recommendation | Expected impact | Feasibility | Why this order |
|---:|---|---|---|---|
| 1 | Set `amix ...:normalize=0`; explicitly normalize format/rate; add final peak protection | **Very high** for apparent level/energy consistency | **Very high** | Fixes a confirmed deterministic gain ramp in one local filter change; provider-independent |
| 2 | Implement ElevenLabs `previous_request_ids` in a left-to-right generation session, retaining `next_text` lookahead | **High** for actual tone/prosody flow | **Medium** | Uses the provider feature designed for this exact problem; requires coordination and header metadata |
| 3 | Add a single continuity-focused direction and global speed; auto-label opening/continuation/final position for OpenAI | **High** for pacing and cadence | **High** | Small API/config change; especially useful because OpenAI has no REST request-stitching state |
| 4 | Tune ElevenLabs narration defaults per tested voice: higher stability, style 0, fixed speed; add optional stable seed | **Medium–high** | **High** | Reduces random performance spread while preserving the current provider architecture |
| 5 | Add a versioned derived-audio mastering layer: bounded segment gain matching, final two-pass loudness normalization, limiter | **Medium–high** for level/“distance” | **Medium** | Corrects residual acoustic differences without spending API credits and preserves offline rebuilds |
| 6 | Detect excessive boundary silence, retain margins, and insert semantic fixed gaps; add micro-fades | **Medium** for flow | **Medium** | Replaces provider/codec-dependent pauses with controlled rhythm; needs careful thresholds |
| 7 | Detect realized-rate outliers and apply tightly clamped `atempo`; always update duration/timeline metadata | **Medium** for occasional bad segments | **Medium** | Useful guardrail, but broad use makes speech sound processed |
| 8 | Add a quality mode that generates compatible narration groups as one long request and splits by alignment | **Very high** potential | **Low–medium** | Best global prosody, but largest cache, timing, alignment, and provider-specific change |
| 9 | Explore ElevenLabs multi-context WebSocket | **Medium–high** potential | **Low** | Session continuity is attractive, but REST request IDs fit batch CLI generation better |
| 10 | Add material speech crossfades | **Low / possibly negative** | **Medium** | Can hide a click, not a different performance; overlaps phonemes and changes timing |

### Recommended delivery sequence

#### Phase A: renderer correctness and observability

- Add `normalize=0` to the existing `amix` graph.
- Add explicit `aresample`/`aformat` before delay/mix and a final limiter or verified loudness pass.
- Extend tests with equal-amplitude synthetic clips at staggered times; assert output levels remain within a small tolerance.
- Log or persist per-segment duration, active-speech duration, loudness, true peak, and realized words/second for diagnostics.

This phase may remove a large part of the reported “tone change” without touching provider behavior.

#### Phase B: synthesis continuity

- Introduce a narration-generation coordinator that preflights cache entries and groups same-identity narration.
- Extend synthesis metadata to surface the ElevenLabs response `request-id`.
- Generate misses left-to-right with up to three fresh prior IDs and textual future lookahead.
- Preserve text-only fallback around old cache hits and preserve fully offline operation.
- Add OpenAI `speed` to typed config/request/cache identity and strengthen the group-wide instruction.
- Expose a stable ElevenLabs seed as an opt-in reproducibility control, not a continuity guarantee.

#### Phase C: controlled boundaries and derived cache

- Preserve raw provider audio and create versioned derived clips.
- Trim only excessive head/tail silence with margins.
- Apply bounded group-relative gain and only outlier tempo correction.
- Use deterministic continuation/chapter gap policies and edge micro-fades.
- Recompute all derived durations before replay timing and subtitle generation.

#### Phase D: quality mode experiment

- Prototype one-request generation for a compatible narration group.
- For ElevenLabs, evaluate the timing/alignment endpoint for safe segment extraction.
- Compare it against request-ID stitching on the same scripts before committing to the added invalidation and alignment complexity.

## Validation plan

Use both objective guardrails and listening tests; long-form quality cannot be judged reliably by isolated clips alone ([Clark et al., 2019](https://arxiv.org/abs/1909.03965)).

1. **Renderer regression fixture:** stagger identical generated tones and short speech fixtures. Adjacent non-overlapping clips should retain the same measured level; the final bus must not clip.
2. **Provider A/B set:** 8–12 segments covering short imperatives, normal sentences, `narrateWhile`, chapter transitions, numbers/acronyms, and a final sign-off. Generate baseline, text context, request-ID context, and request-ID + mastering variants.
3. **Measurements:** adjacent active-speech loudness difference, true peak, leading/trailing silence, active words/second, and total timing drift. Use these as outlier detectors, not as a claim that identical metrics imply identical prosody.
4. **Blind listening:** rate continuity of voice identity, energy/tone, pacing, boundary naturalness, and overall “single take” impression over the full video. Test headphones and laptop speakers because level jumps present differently.
5. **Cache/offline tests:** verify that a fully cached run needs no API key; a mastering recipe change rebuilds locally; a changed neighboring text invalidates only the intended continuity window; expired/missing request IDs cleanly fall back to text context.
6. **Failure tests:** mixed cache hits/misses, v3 (no stitching), zero-retention ElevenLabs behavior, deliberate voice/model changes, overlapping clips, very quiet speech, and ffmpeg builds missing an optional filter.

## Bottom line

The first fix should be local and deterministic: stop `amix` from changing gain as delayed inputs end. Then use ElevenLabs' audio-linked `previous_request_ids`, because it is materially stronger than the text-only context already present. A versioned mastering layer can make loudness, silence, and occasional rate outliers consistent without sacrificing DemoHunter's offline cache. Prompting and global speed should tighten provider behavior, while crossfading should remain a tiny edge treatment rather than the stitching strategy.
