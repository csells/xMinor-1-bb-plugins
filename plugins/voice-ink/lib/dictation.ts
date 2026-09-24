// Microphone capture that hands over speech in pieces instead of one file.
//
// The built-in microphone sends one recording after you stop talking, so the
// whole wait for recognition happens after "stop". Here the audio is cut at
// pauses while you speak and each piece is recognized right away, which leaves
// only the last piece to wait for.
//
// Everything runs at 16 kHz mono — Whisper's own rate, so nothing is resampled
// twice.

const TARGET_SAMPLE_RATE = 16_000;
/** Speech quieter than this counts as a pause. */
const SILENCE_RMS = 0.006;
/** A pause this long can end a segment. */
const SILENCE_HOLD_MS = 550;
/**
 * Whisper always runs its encoder over a 30-second window, so a 3-second
 * segment costs the same as a 25-second one: cutting at every pause would
 * multiply the work instead of spreading it. Segments are therefore only cut
 * once they are long enough to be worth their own window.
 */
const MIN_SEGMENT_MS = 15_000;
/** Cut here even mid-sentence: past this the window stops being one pass. */
const MAX_SEGMENT_MS = 28_000;
/** Audio kept before speech starts, so the first syllable is not clipped. */
const PREROLL_MS = 250;
/** Silence kept after speech ends: Whisper reads trailing context. */
const TAIL_MS = 250;

export interface DictationHandlers {
  /** One recognizable chunk of speech, as a 16 kHz mono WAV. */
  onSegment(segment: { index: number; wav: Uint8Array }): void;
  /** 0..1 loudness for the button's animation. */
  onLevel(level: number): void;
  onError(message: string): void;
}

export interface DictationSession {
  /** Finish the current segment and release the microphone. */
  stop(): Promise<{ segments: number }>;
  /** Release the microphone and drop what has not been sent yet. */
  cancel(): Promise<void>;
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** 16-bit PCM WAV around raw mono samples — what the worker decodes fastest. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

/** Browser resampling, used only when the device refuses to record at 16 kHz. */
async function resample(samples: Float32Array, from: number): Promise<Float32Array> {
  if (from === TARGET_SAMPLE_RATE || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * TARGET_SAMPLE_RATE) / from));
  const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  const buffer = offline.createBuffer(1, samples.length, from);
  const owned = new Float32Array(samples.length);
  owned.set(samples);
  buffer.copyToChannel(owned, 0);
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/**
 * Start dictating. Resolves once the microphone is live; segments arrive
 * through `handlers.onSegment` until the returned session is stopped.
 */
export async function startDictation(
  handlers: DictationHandlers,
  deviceId?: string,
): Promise<DictationSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const sampleRate = context.sampleRate;
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but needs no module URL, which an
  // AudioWorklet would have to fetch through the app's CSP. The node only
  // copies samples; the cost the deprecation warns about does not apply.
  const processor = context.createScriptProcessor(2048, 1, 1);
  // Chrome only pulls a ScriptProcessor that is connected to the destination;
  // a zero gain keeps the user from hearing their own voice.
  const mute = context.createGain();
  mute.gain.value = 0;

  const preroll: Float32Array[] = [];
  let prerollSamples = 0;
  let segment: Float32Array[] = [];
  let segmentSamples = 0;
  let speechSamples = 0;
  let silenceSamples = 0;
  let index = 0;
  let closed = false;

  const msToSamples = (ms: number) => Math.round((ms / 1000) * sampleRate);
  const prerollLimit = msToSamples(PREROLL_MS);
  const silenceHold = msToSamples(SILENCE_HOLD_MS);
  const minSegment = msToSamples(MIN_SEGMENT_MS);
  const maxSegment = msToSamples(MAX_SEGMENT_MS);
  const tail = msToSamples(TAIL_MS);

  function concat(parts: Float32Array[], total: number): Float32Array {
    const merged = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }

  async function flush(): Promise<boolean> {
    if (speechSamples === 0 || segmentSamples === 0) {
      segment = [];
      segmentSamples = 0;
      speechSamples = 0;
      silenceSamples = 0;
      return false;
    }
    const merged = concat(segment, segmentSamples);
    segment = [];
    segmentSamples = 0;
    speechSamples = 0;
    silenceSamples = 0;
    const current = index;
    index += 1;
    try {
      const resampled = await resample(merged, sampleRate);
      handlers.onSegment({ index: current, wav: encodeWav(resampled, TARGET_SAMPLE_RATE) });
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (closed) return;
    const input = event.inputBuffer.getChannelData(0);
    const frame = new Float32Array(input); // the event buffer is reused
    const level = rms(frame);
    handlers.onLevel(Math.min(1, level * 12));

    const speaking = level >= SILENCE_RMS;
    if (speechSamples === 0 && !speaking) {
      // Nothing said yet: keep a short rolling window so the segment can start
      // slightly before the first syllable.
      preroll.push(frame);
      prerollSamples += frame.length;
      while (prerollSamples > prerollLimit && preroll.length > 1) {
        prerollSamples -= (preroll.shift() as Float32Array).length;
      }
      return;
    }

    if (speechSamples === 0) {
      segment = [...preroll, frame];
      segmentSamples = prerollSamples + frame.length;
      preroll.length = 0;
      prerollSamples = 0;
      speechSamples = frame.length;
      silenceSamples = 0;
      return;
    }

    segment.push(frame);
    segmentSamples += frame.length;
    if (speaking) {
      speechSamples += frame.length;
      silenceSamples = 0;
    } else {
      silenceSamples += frame.length;
    }

    const pauseEnded = silenceSamples >= silenceHold && segmentSamples >= minSegment;
    if (pauseEnded || segmentSamples >= maxSegment) {
      // Trim all but a short tail of the trailing pause.
      if (silenceSamples > tail) {
        const keep = segmentSamples - (silenceSamples - tail);
        const merged = concat(segment, segmentSamples).subarray(0, keep);
        segment = [new Float32Array(merged)];
        segmentSamples = merged.length;
      }
      void flush();
    }
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  async function teardown(): Promise<void> {
    closed = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    mute.disconnect();
    for (const track of stream.getTracks()) track.stop();
    await context.close().catch(() => {});
  }

  return {
    async stop() {
      closed = true;
      processor.onaudioprocess = null;
      await flush();
      await teardown();
      return { segments: index };
    },
    async cancel() {
      await teardown();
    },
  };
}
