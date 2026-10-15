import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, projectFixture, wavBytes } from "./test-support.js";
import { narrationRequestKey } from "./model.js";
import { writeJson } from "./storage.js";
import { serveReplay } from "./server.js";
import { NarrationPlayback } from "./web/audio.js";

function spokenFixture() {
  const bundle = fixture();
  bundle.project.durationMs = 8000;
  bundle.edits.clips = [
    { id: "a", sourceStartMs: 0, sourceEndMs: 8000, rate: 1, holdMs: 0 },
  ];
  bundle.narration.segments = [
    { id: "voice", clipId: "a", offsetMs: 0, text: "A continuous narration." },
  ];
  const segment = bundle.narration.segments[0]!;
  segment.audio = {
    path: "audio/voice.wav",
    durationMs: 6000,
    cacheKey: "test",
    requestKey: narrationRequestKey(bundle.project, segment),
  };
  return bundle;
}

class Media {
  time = 0;
  seeks = 0;
  plays = 0;
  pauses = 0;
  loads = 0;
  paused = true;
  ended = false;
  readyState = 4;
  seeking = false;
  playbackRate = 1;
  preload = "";
  get currentTime() {
    return this.time;
  }
  set currentTime(time: number) {
    this.time = time;
    this.seeks++;
    this.ended = false;
  }
  play = () => {
    this.plays++;
    this.paused = false;
    return Promise.resolve();
  };
  pause() {
    this.pauses++;
    this.paused = true;
  }
  removeAttribute(_name: string) {}
  load() {
    this.loads++;
  }
}

function withLocation(run: () => unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://localhost:4310/projects/abcd/"),
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete (globalThis as any).location;
  }
}

test("normal decoder latency does not cause repeated seeks; explicit seeks align once", () =>
  withLocation(() => {
    const bundle = spokenFixture(),
      media = new Media();
    let now = 0;
    const playback = new NarrationPlayback(
      (e) => {
        throw e;
      },
      () => media as any,
      () => now,
    );
    playback.sync(bundle, 0, true);
    for (let position = 250; position < 5000; position += 16) {
      now = position;
      media.time = (position - 220) / 1000;
      playback.sync(bundle, position, true);
    }
    expect(media.seeks).toBe(0);
    expect(media.plays).toBe(1);
    expect(media.playbackRate).toBeGreaterThan(1);
    expect(media.playbackRate).toBeLessThanOrEqual(1.04);
    playback.sync(bundle, 2000, true, true);
    expect(media.seeks).toBe(1);
    media.seeking = true;
    for (let i = 0; i < 30; i++) playback.sync(bundle, 2200, true);
    expect(media.seeks).toBe(1);
    expect(playback.buffering).toBe(true);
  }));

test("removed or stale speech is released; pending or failed play does not retry each frame", async () => {
  let playback!: NarrationPlayback,
    bundle = spokenFixture();
  const media = new Media(),
    errors: Error[] = [];
  let reject!: (e: Error) => void;
  media.play = () => {
    media.plays++;
    return new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  };
  withLocation(() => {
    playback = new NarrationPlayback(
      (e) => errors.push(e),
      () => media as any,
    );
    for (let i = 0; i < 60; i++) playback.sync(bundle, 0, true);
    expect(media.plays).toBe(1);
    expect(playback.buffering).toBe(true);
  });
  reject(new DOMException("Blocked", "NotAllowedError"));
  await Promise.resolve();
  withLocation(() => {
    for (let i = 0; i < 60; i++) playback.sync(bundle, 0, true);
    expect(media.plays).toBe(1);
    expect(errors).toHaveLength(1);
    expect(playback.buffering).toBe(false);
    bundle.narration.segments[0]!.text = "Changed script";
    playback.sync(bundle, 0, true);
    expect(media.loads).toBe(1);
    bundle.narration.segments = [];
    playback.sync(bundle, 0, true);
    expect(media.loads).toBe(1);
  });
});

test("late metadata holds the playhead, and timing changes realign speech", () =>
  withLocation(() => {
    const bundle = spokenFixture(),
      media = new Media();
    media.readyState = 0;
    const playback = new NarrationPlayback(
      (e) => {
        throw e;
      },
      () => media as any,
    );
    playback.sync(bundle, 1000, true);
    expect(media.seeks).toBe(0);
    expect(playback.buffering).toBe(true);
    media.readyState = 4;
    playback.sync(bundle, 1000, true);
    expect(media.currentTime).toBe(1);
    bundle.narration.segments[0]!.offsetMs = 400;
    playback.sync(bundle, 1000, false);
    expect(media.currentTime).toBe(0.6);
    expect(media.paused).toBe(true);
    bundle.narration.segments = [];
    playback.sync(bundle, 1000, false);
    expect(media.loads).toBe(1);
  }));

test("browser speech produces audio continuously, pauses and seeks without a decoder loop", async () => {
  const { root, dir } = await projectFixture();
  let preview: Awaited<ReturnType<typeof serveReplay>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = spokenFixture();
    for (const [file, value] of [
      ["project", bundle.project],
      ["edits", bundle.edits],
      ["narration", bundle.narration],
    ] as const)
      await writeJson(path.join(dir, `${file}.json`), value);
    await writeJson(path.join(dir, "events.json"), [
      {
        type: 4,
        timestamp: 1000,
        data: { href: "http://example.test", width: 1120, height: 700 },
      },
      {
        type: 2,
        timestamp: 1001,
        data: {
          initialOffset: { left: 0, top: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: "html",
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    id: 3,
                    tagName: "head",
                    attributes: {},
                    childNodes: [],
                  },
                  {
                    type: 2,
                    id: 4,
                    tagName: "body",
                    attributes: {},
                    childNodes: [
                      { type: 3, id: 5, textContent: "Audio playback test" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    await mkdir(path.join(dir, "assets"));
    await mkdir(path.join(dir, "audio"));
    const rrweb = path.dirname(createRequire(import.meta.url).resolve("rrweb"));
    await writeFile(
      path.join(dir, "assets/rrweb.js"),
      await readFile(path.join(rrweb, "rrweb.umd.cjs")),
    );
    await writeFile(
      path.join(dir, "assets/rrweb.css"),
      await readFile(path.join(rrweb, "style.css")),
    );
    const wave = wavBytes(),
      pcm = Buffer.concat(Array.from({ length: 24 }, () => wave.subarray(44)));
    const speech = Buffer.concat([wave.subarray(0, 44), pcm]);
    speech.writeUInt32LE(speech.length - 8, 4);
    speech.writeUInt32LE(pcm.length, 40);
    await writeFile(path.join(dir, "audio/voice.wav"), speech);
    preview = await serveReplay(dir, { port: 0 });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const Original = window.Audio;
      (window as any).Audio = function (url: string) {
        const audio = new Original(url);
        const context = new AudioContext(),
          analyser = context.createAnalyser();
        context.createMediaElementSource(audio).connect(analyser);
        analyser.connect(context.destination);
        const probe = { audio, seeks: 0, rms: 0 };
        (window as any).__audioProbe = probe;
        audio.addEventListener("play", () => {
          void context.resume();
        });
        audio.addEventListener("seeking", () => probe.seeks++);
        setInterval(() => {
          const data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          probe.rms = Math.max(
            probe.rms,
            Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length),
          );
        }, 20);
        return audio;
      };
    });
    // Delay media to cover the startup race that previously moved the timeline
    // ahead of speech and repeatedly flushed its decoder to catch up.
    await page.route("**/files/audio/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.goto(preview.url);
    await page.waitForFunction(
      () => (window as any).__replayLab?.state().ready,
    );
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(
      () => (window as any).__audioProbe?.audio.currentTime > 1.1,
    );
    const first = await page.evaluate(() => {
      const { audio, seeks, rms } = (window as any).__audioProbe;
      return {
        time: audio.currentTime,
        paused: audio.paused,
        seeks,
        rms,
        position: (window as any).__replayLab.state().position,
      };
    });
    expect(first.paused).toBe(false);
    expect(first.rms).toBeGreaterThan(0.001);
    expect(first.seeks).toBeLessThanOrEqual(1);
    expect(Math.abs(first.position - first.time * 1000)).toBeLessThan(300);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(
      await page.evaluate(() => (window as any).__audioProbe.audio.paused),
    ).toBe(true);
    await page.evaluate(() => (window as any).__replayLab.seek(3000));
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(
      () => (window as any).__audioProbe.audio.currentTime > 4,
    );
    const resumed = await page.evaluate(() => ({
      time: (window as any).__audioProbe.audio.currentTime,
      seeks: (window as any).__audioProbe.seeks,
    }));
    expect(resumed.time).toBeLessThan(5);
    expect(resumed.seeks - first.seeks).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
