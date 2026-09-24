#!/usr/bin/env python3
"""Resident faster-whisper worker for the voice-ink plugin.

One JSON request per line on stdin, one JSON response per line on stdout. The
model is loaded once and stays in memory: loading costs seconds, transcribing a
spoken phrase costs a fraction of that, and dictation is only usable when the
second number is the one the user waits for.

Requests:
    {"id": "1", "op": "transcribe", "path": "/tmp/a.webm",
     "language": "ru" | null, "prompt": "glossary" | null}
    {"id": "2", "op": "ping"}

Responses:
    {"id": "1", "ok": true, "text": "...", "audioSec": 3.2, "elapsedSec": 1.7}
    {"id": "1", "ok": false, "code": "request_failed", "message": "..."}

A single line is written before the first response, so the caller can tell a
warm worker from one that is still loading:
    {"event": "ready", "model": "medium", "computeType": "int8"}
    {"event": "error", "code": "auth_required", "message": "..."}
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

# Batching splits the audio into windows transcribed together. It pays off on
# anything long enough to hold several windows and costs setup time on short clips,
# so short segments take the plain path.
BATCH_MIN_AUDIO_SEC = 8.0

# Whisper hears words, not writing: it punctuates unevenly, rarely marks a
# question and never starts a paragraph. A small ONNX model trained for exactly
# this restores punctuation, sentence boundaries and capitalization in about
# half a second on CPU — no API key, no network, nothing leaves the machine.
PUNCTUATION_MODEL = "1-800-BAD-CODE/xlm-roberta_punctuation_fullstop_truecase"
# How often a long recognition reports what it has so far.
PARTIAL_INTERVAL_SEC = 2.0

# One CPU pass over Whisper leaves cores idle — the model saturates at roughly
# one and a half of them. Splitting a long recording at pauses and recognizing
# the pieces side by side nearly halves the wait, which is what decides whether
# a minute of dictation fits inside bb's ten-second attempt or not.
PARALLEL_MIN_AUDIO_SEC = 45.0
PARALLEL_TARGET_CHUNK_SEC = 45.0
# The model expects unpunctuated input; feeding it Whisper's own commas back
# produces ",,," runs.
PUNCTUATION_STRIP = re.compile(r"[.,!?;:…]+")


class Chunk:
    """A slice of the recording, and where it sits in the original timeline."""

    __slots__ = ("audio", "offset")

    def __init__(self, audio, offset: float):
        self.audio = audio
        self.offset = offset


class Shifted:
    """A segment reported in the timeline of the whole recording."""

    __slots__ = ("start", "end", "text")

    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text


def split_at_pauses(audio, sample_rate: int, parts: int) -> list:
    """Cut the recording into `parts` pieces, each boundary landing in a pause.

    Cutting on a fixed clock would slice words in half. The voice-activity
    detector already knows where the speaker stopped, so the boundary nearest
    each target position is used instead.
    """
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    total = len(audio)
    if parts <= 1:
        return [Chunk(audio, 0.0)]

    speech = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=500))
    if len(speech) < parts:
        return [Chunk(audio, 0.0)]

    # Candidate cut points: the middle of every silence between speech runs.
    gaps = [
        (previous["end"] + current["start"]) // 2
        for previous, current in zip(speech, speech[1:])
    ]
    if not gaps:
        return [Chunk(audio, 0.0)]

    cuts = []
    for index in range(1, parts):
        target = total * index // parts
        nearest = min(gaps, key=lambda gap: abs(gap - target))
        if nearest not in cuts:
            cuts.append(nearest)
    cuts.sort()

    chunks = []
    start = 0
    for cut in [*cuts, total]:
        if cut - start < sample_rate:  # nothing worth its own pass
            continue
        chunks.append(Chunk(audio[start:cut], start / sample_rate))
        start = cut
    return chunks or [Chunk(audio, 0.0)]


class Punctuator:
    """The punctuation model, loaded once and reused."""

    def __init__(self, enabled: bool):
        self.model = None
        self.error = None
        if not enabled:
            return
        try:
            from punctuators.models import PunctCapSegModelONNX

            self.model = PunctCapSegModelONNX.from_pretrained(PUNCTUATION_MODEL)
        except Exception as error:  # noqa: BLE001 - absence is not fatal
            self.error = f"{type(error).__name__}: {error}"

    def apply(self, blocks: list) -> list:
        """Punctuate each block of speech; a block becomes one paragraph."""
        if self.model is None:
            return blocks
        prepared = [PUNCTUATION_STRIP.sub("", block).lower().strip() for block in blocks]
        prepared = [block for block in prepared if block != ""]
        if not prepared:
            return []
        try:
            return [" ".join(sentences) for sentences in self.model.infer(prepared)]
        except Exception:  # noqa: BLE001 - keep the transcript rather than lose it
            return blocks


def split_into_blocks(segments: list, pause_sec: float) -> list:
    """Group Whisper segments into paragraphs, cutting where the speaker paused."""
    blocks = []
    current = []
    previous_end = None
    for segment in segments:
        text = segment.text.strip()
        if text == "":
            continue
        if previous_end is not None and segment.start - previous_end >= pause_sec and current:
            blocks.append(" ".join(current))
            current = []
        current.append(text)
        previous_end = segment.end
    if current:
        blocks.append(" ".join(current))
    return blocks


def normalize(text: str) -> str:
    return " ".join(text.lower().split()).strip(" .,!?…-")


def deduplicate(segments: list) -> list:
    """Drop Whisper's repetition loops without touching real speech.

    On a phrase that runs out mid-word the model sometimes emits the same
    fragment again and again. A repetition penalty stops that but also deletes
    genuine sentences, so the loop is removed after the fact: a fragment
    repeated back to back survives once.
    """
    kept = []
    previous = None
    for segment in segments:
        current = normalize(segment.text)
        if current == "":
            continue
        if current == previous:
            continue
        previous = current
        kept.append(segment)
    return kept


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def failure(request_id, code: str, message: str) -> dict:
    return {"id": request_id, "ok": False, "code": code, "message": message}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="medium")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--download-root", default=None)
    parser.add_argument("--punctuate", default="on", choices=["on", "off"])
    parser.add_argument("--parallel", type=int, default=3)
    args = parser.parse_args()

    # Whisper is a guest on this machine: bb, the agents and everything else
    # share the same cores. CTranslate2 sizes its own pool from --threads, but
    # the numeric libraries under ONNX and NumPy read the environment, so the
    # ceiling is set here, before anything imports them.
    for variable in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[variable] = str(max(1, args.threads))

    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
        from faster_whisper.audio import decode_audio
    except Exception as error:  # noqa: BLE001 - reported to the host verbatim
        emit({
            "event": "error",
            "code": "auth_required",
            "message": f"faster-whisper is not installed: {error}",
        })
        return 1

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            cpu_threads=args.threads,
            num_workers=max(1, args.parallel),
            download_root=args.download_root,
        )
        batched = BatchedInferencePipeline(model=model) if args.batch_size > 1 else None
    except Exception as error:  # noqa: BLE001
        emit({
            "event": "error",
            "code": "service_unavailable",
            "message": f"could not load model {args.model}: {error}",
        })
        return 1

    punctuator = Punctuator(args.punctuate == "on")
    if punctuator.error is not None:
        emit({"event": "note", "message": f"punctuation disabled: {punctuator.error}"})

    emit({
        "event": "ready",
        "model": args.model,
        "punctuation": punctuator.model is not None,
        "cores": max(1, args.threads) * max(1, args.parallel),
        "computeType": args.compute_type,
        "device": args.device,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit(failure(None, "request_failed", f"malformed request: {error}"))
            continue

        request_id = request.get("id")
        op = request.get("op")

        if op == "ping":
            emit({"id": request_id, "ok": True, "text": "", "audioSec": 0.0, "elapsedSec": 0.0})
            continue
        if op != "transcribe":
            emit(failure(request_id, "request_failed", f"unknown op {op!r}"))
            continue

        path = request.get("path")
        if not isinstance(path, str) or not path:
            emit(failure(request_id, "request_failed", "path is required"))
            continue

        started = time.monotonic()
        try:
            audio = decode_audio(path)
        except Exception as error:  # noqa: BLE001
            emit(failure(request_id, "request_failed", f"could not decode audio: {error}"))
            continue

        audio_sec = len(audio) / 16000.0
        if audio_sec < 0.2:
            emit({"id": request_id, "ok": True, "text": "", "audioSec": audio_sec, "elapsedSec": 0.0})
            continue

        options = {
            "beam_size": 1,
            "vad_filter": True,
            # faster-whisper waits two seconds of silence before splitting, which
            # on a dictated phrase leaves one long block whose opening words the
            # smaller models drop. Splitting at half a second keeps them.
            "vad_parameters": {"min_silence_duration_ms": 500},
            "condition_on_previous_text": False,
            "language": request.get("language") or None,
            "initial_prompt": request.get("prompt") or None,
        }
        try:
            parts = 1
            if args.parallel > 1 and audio_sec > PARALLEL_MIN_AUDIO_SEC:
                parts = min(args.parallel, math.ceil(audio_sec / PARALLEL_TARGET_CHUNK_SEC))
            chunks = split_at_pauses(audio, 16000, parts) if parts > 1 else [Chunk(audio, 0.0)]

            if len(chunks) > 1:
                # Each pass fills its own slot as it goes, so the partial text
                # published below stays in the order it was spoken even though
                # the pieces are recognized at the same time.
                collected = [[] for _ in chunks]

                def run(index):
                    chunk = chunks[index]
                    produced, _ = model.transcribe(chunk.audio, **options)
                    for segment in produced:
                        collected[index].append(
                            Shifted(
                                segment.start + chunk.offset,
                                segment.end + chunk.offset,
                                segment.text,
                            )
                        )

                with ThreadPoolExecutor(max_workers=len(chunks)) as pool:
                    running = [pool.submit(run, index) for index in range(len(chunks))]
                    last_publish = time.monotonic()
                    while not all(task.done() for task in running):
                        time.sleep(0.2)
                        if time.monotonic() - last_publish < PARTIAL_INTERVAL_SEC:
                            continue
                        last_publish = time.monotonic()
                        so_far = [s for group in collected for s in group]
                        if so_far:
                            emit({
                                "id": request_id,
                                "event": "partial",
                                "text": " ".join(
                                    part.text.strip() for part in deduplicate(so_far)
                                ),
                            })
                    for task in running:
                        task.result()  # surface a failed pass as this request's error
                raw = [s for group in collected for s in group]
            elif batched is not None and audio_sec >= BATCH_MIN_AUDIO_SEC:
                raw, _ = batched.transcribe(audio, batch_size=args.batch_size, **options)
            else:
                raw, _ = model.transcribe(audio, **options)
            # Consume the generator as it produces, publishing what is ready:
            # a caller whose budget runs out mid-recognition can still be handed
            # the part that is done instead of an error.
            segments = []
            last_publish = time.monotonic()
            for segment in raw:
                segments.append(segment)
                if time.monotonic() - last_publish >= PARTIAL_INTERVAL_SEC:
                    last_publish = time.monotonic()
                    emit({
                        "id": request_id,
                        "event": "partial",
                        "text": " ".join(part.text.strip() for part in deduplicate(segments)),
                    })
            segments = deduplicate(segments)
            pause_sec = float(request.get("paragraphPauseSec") or 1.2)
            blocks = punctuator.apply(split_into_blocks(segments, pause_sec))
            text = "\n\n".join(block.strip() for block in blocks if block.strip() != "")
        except Exception as error:  # noqa: BLE001
            emit(failure(
                request_id,
                "service_unavailable",
                f"transcription failed: {error}\n{traceback.format_exc(limit=3)}",
            ))
            continue

        emit({
            "id": request_id,
            "ok": True,
            "text": text,
            "audioSec": round(audio_sec, 2),
            "elapsedSec": round(time.monotonic() - started, 2),
        })

    return 0


if __name__ == "__main__":
    sys.exit(main())
