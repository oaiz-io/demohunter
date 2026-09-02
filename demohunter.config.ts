export default {
  baseURL: "https://github.com/oaiz-io/demohunter",
  viewport: { width: 1440, height: 900 },
  tts: {
    provider: "elevenlabs",
    voice: "hpp4J3VqNfWAUOO0d1Us",
    model: "eleven_multilingual_v2",
    format: "mp3_44100_128",
    instructions: "Speak clearly, confidently, and naturally for a polished product documentation demo.",
    voiceSettings: {
      stability: 0.55,
      similarityBoost: 0.85,
      style: 0.12,
      useSpeakerBoost: true,
    },
  },
};
