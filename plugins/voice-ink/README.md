# Voice Ink

Dictate into bb's composer with a Whisper model running on your own machine.
No account, no API key, no audio leaving the box.

bb routes voice transcription to whichever plugin registers an AI service of
kind `voice`. Out of the box that is the Codex plugin, so the microphone button
disappears when Codex is disabled. This plugin registers its own service and
answers it from [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
running next to bb.

## What you get

- **bb's own microphone button**, working again — every client has it,
  including the phone app. Point `BB_TRANSCRIPTION` at this plugin (below).
- **A History panel**, opened by the microphone in the sidebar footer: every
  dictation with its recording and its full text, searchable. It is where a
  long dictation ends up in one piece (below).
- **`bb voice-ink transcribe <file>`** for anything already recorded.
- **An optional second button in the composer** (setting: *Show this plugin's
  own microphone button*, off by default). It cuts speech at pauses and
  recognizes it while you keep talking, and has no per-request time limit —
  useful with a slower model on a machine that can spare the CPU. It renders
  only where plugin frontends run, so not in the phone app.

## Requirements

- Python 3.10+ on the machine bb runs on, with `faster-whisper` importable:
  ```sh
  pip install faster-whisper
  ```
  Point the **Python interpreter** setting at a virtualenv if you keep one.
- Roughly 1.5 GB of RAM for the `medium` model and 0.5 GB for `small`; the
  model is downloaded on first use into the plugin's data directory.
- For local punctuation, `punctuators` in the same interpreter:
  ```sh
  pip install punctuators
  ```
  Without it recognition still works, unpunctuated, and the worker logs why.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin voice-ink
bb voice-ink status          # engine state, model, resolved interpreter
bb voice-ink warmup          # load the model now instead of on the first phrase
```

To also take over bb's built-in microphone button:

```sh
npx bb-app config set BB_TRANSCRIPTION voice-ink/local
```

The part after the slash is a label; the model comes from the plugin's
settings.

## From speech to writing

Whisper hears words; it punctuates unevenly, rarely marks a question and never
starts a paragraph. Two passes turn its output into text you would have typed,
and the first one needs no key and no network:

**Punctuation (on by default, runs on this machine).** A small ONNX model
restores punctuation, sentence boundaries, question marks and capitalization in
about half a second on CPU. Paragraphs come from the recording itself — a pause
of at least **Start a new paragraph after a pause of N seconds** starts a new
one.

**Vocabulary hints** are fed to the recognizer as context. This is the cheapest
quality win there is: adding `супервизор` turned a stubborn *скривизору* into the
right word.

**Cleanup with a language model (optional, needs a key).** The local pass fixes
punctuation but cannot fix a misheard word. Set **Clean the transcript up with a
language model** to `groq`, `anthropic` or `openai-compatible` and paste a key,
and the transcript — never the audio — is sent for a pass that also repairs
words the recognizer got wrong. Failures fall through to the unpolished text.

## Choosing a model

Whisper always runs its encoder over a 30-second window, so a three-second
phrase costs the same as a twenty-second one. What changes the wait is the
model. Measured on a 4-core Xeon 6140 with no GPU, Russian speech, model
already loaded:

| model | wait after "stop" | quality |
|---|---|---|
| `small` (default) | 4.5 s for a phrase, 10.4 s for a minute | usable, mangles rarer terms |
| `medium` | two to three times that | noticeably better |
| `large-v3-turbo` | slower still | no better than `medium` at int8 on this CPU |

bb's own microphone button gives a plugin **10 seconds per attempt** and retries
once, so on this hardware only `small` fits a minute of speech. `medium` is
worth it for short phrases, or through the plugin's own button, which has no
such limit.

## Long dictations

A minute of speech takes longer to recognize than bb allows for one attempt, so
three things keep it from being lost:

- **A long recording is split at pauses and recognized in parallel** — but only
  when there are cores to spare (see below). One Whisper pass saturates about
  one and a half cores, so on a bigger machine three passes cut a two-minute
  dictation roughly in half.
- **Work outlives the attempt that started it.** The recognition is keyed by the
  audio, so bb's retry joins the job already running instead of starting over.
- **A caller that runs out of time twice gets what has been recognized so far**,
  marked in the composer as partial, while recognition carries on in the
  background.
- **The whole transcript lands in History**, along with the recording — so the
  part bb never waited for is one panel away, not gone.

Measured on this machine (four cores, no GPU, two-core ceiling, `small`): a
2:55 recording reaches the composer as its first 664 characters after bb's
19.4 seconds, and the panel holds all 1993 characters 33 seconds after the
recording arrived.

A machine with an NVIDIA GPU is a different story: set **Precision** to
`float16` and the same models run several times faster.

## History

The microphone in the sidebar footer — next to settings and the theme switch —
drops down the last six dictations, marking what is still being recognized and
what only partly reached the composer. "Open History" (or the sidebar row)
opens the full panel.

The panel lists dictations newest first: when, how long, the transcript. Open
one for the full text, a player for the recording, copy and download.

- Entries whose text outran bb's wait are labelled **only part reached the
  composer** — that label is the whole reason the panel exists.
- What is still being recognized shows as **transcribing** and fills itself in.
- From the terminal: `bb voice-ink history`, `bb voice-ink show <id>`,
  `bb voice-ink forget <id>|--all`. `bb voice-ink last` prints the most recent
  transcript.
- Only bb's own microphone button is recorded. The plugin's streaming button
  sends speech in pieces as you talk, and a list of half-sentences would be
  worse than no list.

Audio and text live in `<host data dir>/history/`, and nothing leaves the
machine. Retention is two settings — *Keep at most N dictations* (200) and
*Delete dictations older than N days* (30) — and *Keep a history of dictations*
turns the whole thing off, which also stops the recordings from being written.

## Settings

| setting | what it does |
|---|---|
| Model | `small`, `medium` or `large-v3-turbo` |
| Spoken language | `auto`, `ru`, `en` — naming the language avoids misdetection on short phrases |
| Vocabulary hints | names and terms fed to the model as context, one line |
| Precision | `int8` (CPU), `int8_float32`, `float32` |
| CPU cores recognition may use | the ceiling, default `2`; the plugin decides how to spend it (one pass with that many threads, or several parallel passes once there are at least four cores) |
| Batch size | off by default: batching hands the model VAD-split chunks whose opening words the smaller models drop |
| Show this plugin's own microphone button | a second, streaming button in the composer next to bb's own |
| Python interpreter | absolute path when `faster-whisper` lives in a virtualenv |
| Unload the model after N idle minutes | `0` keeps it loaded; unloading means the next phrase pays for the load again, which bb's own button has no time for |
| Keep a history of dictations | records audio and transcript for the History panel; off means neither is written |
| Keep at most N dictations | `0` lifts the cap |
| Delete dictations older than N days | `0` keeps them for good |

Changing a setting retires the resident worker; the next phrase runs on the new
configuration.

## Sharing the machine

bb, the agents and everything else live on the same box, so recognition is
capped and de-prioritized rather than allowed to take what it likes:

- **CPU cores recognition may use** (default `2`) is a hard ceiling: threads per
  pass times parallel passes never exceeds it, and the numeric libraries under
  ONNX and NumPy are pinned to the same number before they load. Measured while
  transcribing: 190% of one core on a four-core machine.
- The worker runs at a **lowered priority** (nice 10), so when the machine is
  busy the agents and the bb server get the cores first.

## How it works

```
app.tsx          microphone button in the composer
lib/dictation.ts capture at 16 kHz, cut at pauses, encode WAV
server.ts        AI-service registration, settings, CLI, RPC, audio route
components/      the History panel, its player, and the sidebar-footer drop-down
src/host.ts      the bb.host entry, running on the machine bb runs on
src/history.ts   recordings and transcripts on disk, and their retention
python/worker.py resident faster-whisper process, model kept in memory
```

Loading a model costs seconds and recognizing a phrase costs less than that, so
the Python process stays alive between phrases and, by default, is never
retired for being idle — only a settings change restarts it.

The daemon may still stop the host worker (and with it the model) on its own.
The configuration is therefore mirrored to `<host data dir>/config.json`: a
worker that comes back up reads it instead of refusing the request, and loads
the model itself.

`python/worker.py` is embedded into the host bundle as a string, because the
host artifact ships as a single JavaScript file. After editing it, run:

```sh
npm run embed-worker && bb plugin build .
```
