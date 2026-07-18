"""Test-only backend for exercising the production worker without Kokoro or weights."""

import struct


class Backend:
    version = "stub-1"

    def synthesize(self, text, voice, language, speed, output_path):
        if text == "FAIL":
            raise RuntimeError("requested stub failure")
        samples = (text.encode("utf-8") or b"\0\0")
        if len(samples) % 2:
            samples += b"\0"
        byte_rate = 24000 * 2
        wav = b"RIFF" + struct.pack("<I", 36 + len(samples)) + b"WAVE"
        wav += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 24000, byte_rate, 2, 16)
        wav += b"data" + struct.pack("<I", len(samples)) + samples
        with open(output_path, "xb") as output:
            output.write(wav)


def create_backend(model_path, voices_path):
    return Backend()
