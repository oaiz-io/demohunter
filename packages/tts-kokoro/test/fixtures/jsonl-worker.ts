const mode = process.argv[2] ?? "ok";
const encoder = new TextEncoder();

function send(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function wav(text: string): Uint8Array {
  const data = encoder.encode(text.length === 0 ? "x" : text);
  const padded = data.length + (data.length % 2);
  const out = new Uint8Array(44 + padded);
  const view = new DataView(out.buffer);
  out.set(encoder.encode("RIFF"), 0); view.setUint32(4, 36 + padded, true); out.set(encoder.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); out.set(encoder.encode("data"), 36); view.setUint32(40, padded, true); out.set(data, 44);
  return out;
}

if (mode === "startup-timeout") await new Promise(() => {});
if (mode === "malformed-startup") process.stdout.write("not-json\n"); else send({ protocol: 1, op: "ready", backendVersion: "fixture-1" });
if (mode === "crash") process.exit(3);

for await (const line of console) {
  const request = JSON.parse(line) as Record<string, unknown>;
  if (request.op === "shutdown") { send({ protocol: 1, id: request.id, ok: true }); process.exit(0); }
  if (mode === "request-timeout") continue;
  if (mode === "malformed") { process.stdout.write("{bad\n"); continue; }
  if (mode === "oversized") { process.stdout.write("x".repeat(10000)); continue; }
  if (mode === "wrong-id") { send({ protocol: 1, id: "wrong", ok: true }); continue; }
  if (mode === "stderr-crash") { process.stderr.write("useful diagnostic"); process.exit(9); }
  await Bun.write(String(request.outputPath), wav(String(request.text)));
  const response = { protocol: 1, id: request.id, ok: true, path: request.outputPath, format: mode === "wrong-format" ? "mp3" : "wav", sampleRate: mode === "wrong-rate" ? 22050 : 24000 };
  send(response);
  if (mode === "duplicate") send(response);
}
