// Disposable starter config: replace this with your real demo target once setup is proven.
export default {
  baseURL: new URL("./demos/sample-site/index.html", import.meta.url).href,
  // Narration language is explicit. Set this when your narrated text is not English.
  // tts: { language: "sv" },
  // Local Kokoro is opt-in. Import kokoro/kokoroTTS from "demohunter", then add:
  // providers: { tts: [kokoro({ modelPath: "/path/kokoro.onnx", voicesPath: "/path/voices.bin" })] },
  // tts: kokoroTTS({ voice: "af_heart", language: "en-US" }),
  // Cookie dismissal is opt-in: record: { cookieBanners: { enabled: true, action: "reject" } },
  // Social output is opt-in: output: { formats: [{ preset: "square" }, { preset: "gif" }] },
};
