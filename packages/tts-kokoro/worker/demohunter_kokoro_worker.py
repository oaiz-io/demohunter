#!/usr/bin/env python3
"""DemoHunter Kokoro JSONL worker. Requires user-owned kokoro-onnx assets; downloads nothing."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import traceback
from typing import Any

PROTOCOL = 1
SAMPLE_RATE = 24000
LANGUAGES = {"en-us", "en-gb", "es", "fr", "hi", "it", "ja", "pt-br", "zh"}


class KokoroOnnxBackend:
    version = "kokoro-onnx"

    def __init__(self, model_path: str, voices_path: str) -> None:
        try:
            module = importlib.import_module("kokoro_onnx")
        except ImportError as error:
            raise RuntimeError("kokoro-onnx is not installed; install it separately before using Kokoro") from error
        self._engine = module.Kokoro(model_path, voices_path)

    def synthesize(self, text: str, voice: str, language: str, speed: float, output_path: str) -> None:
        try:
            soundfile = importlib.import_module("soundfile")
        except ImportError as error:
            raise RuntimeError("soundfile is not installed; install it separately before using Kokoro") from error
        samples, sample_rate = self._engine.create(text, voice=voice, speed=speed, lang=language)
        if sample_rate != SAMPLE_RATE:
            raise RuntimeError(f"kokoro-onnx returned {sample_rate} Hz instead of {SAMPLE_RATE} Hz")
        soundfile.write(output_path, samples, sample_rate, format="WAV")


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("protocol") != PROTOCOL or value.get("op") != "synthesize":
        raise ValueError("expected a protocol-v1 synthesize object")
    required = {"id": str, "text": str, "voice": str, "language": str, "outputPath": str}
    for key, expected in required.items():
        if not isinstance(value.get(key), expected):
            raise ValueError(f"{key} must be {expected.__name__}")
    if value["language"] not in LANGUAGES:
        raise ValueError(f"unsupported language: {value['language']}")
    speed = value.get("speed")
    if not isinstance(speed, (int, float)) or isinstance(speed, bool) or speed <= 0 or speed > 4:
        raise ValueError("speed must be greater than 0 and at most 4")
    if value.get("format") != "wav" or value.get("sampleRate") != SAMPLE_RATE:
        raise ValueError("only WAV at 24000 Hz is supported")
    if not os.path.isabs(value["outputPath"]):
        raise ValueError("outputPath must be absolute")
    return value


def run(backend: Any) -> int:
    emit({"protocol": PROTOCOL, "op": "ready", "backendVersion": str(backend.version)})
    for raw_line in sys.stdin:
        request_id = "invalid"
        try:
            message = json.loads(raw_line)
            request_id = message.get("id") if isinstance(message, dict) else "invalid"
            if isinstance(message, dict) and message.get("protocol") == PROTOCOL and message.get("op") == "shutdown":
                emit({"protocol": PROTOCOL, "id": request_id, "ok": True})
                return 0
            request = validate_request(message)
            backend.synthesize(request["text"], request["voice"], request["language"], float(request["speed"]), request["outputPath"])
            emit({"protocol": PROTOCOL, "id": request["id"], "ok": True, "path": request["outputPath"], "format": "wav", "sampleRate": SAMPLE_RATE})
        except Exception as error:  # worker boundary must turn backend failures into protocol errors
            print(f"Kokoro request failed: {error}", file=sys.stderr, flush=True)
            emit({"protocol": PROTOCOL, "id": request_id, "ok": False, "error": {"code": "SYNTHESIS_FAILED", "message": str(error)}})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--backend-module", help=argparse.SUPPRESS)
    args = parser.parse_args()
    for label, path in (("model", args.model), ("voices", args.voices)):
        if not os.path.isfile(path):
            parser.error(f"{label} file missing: {path}")
    try:
        if args.backend_module:
            backend = importlib.import_module(args.backend_module).create_backend(args.model, args.voices)
        else:
            backend = KokoroOnnxBackend(args.model, args.voices)
        return run(backend)
    except Exception as error:
        print(f"Kokoro worker startup failed: {error}", file=sys.stderr, flush=True)
        if os.environ.get("DEMOHUNTER_KOKORO_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
