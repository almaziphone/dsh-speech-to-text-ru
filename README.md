# dsh-speech-to-text-ru

**Local Russian speech recognition for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) voice input.**
Adds a second, fully offline recognizer — **GigaAM-v3 e2e CTC int8** — next to the shipped
SenseVoice provider, which understands only Chinese, English, Cantonese, Japanese and Korean.
Audio never leaves the machine.

[![CI](https://github.com/almaziphone/dsh-speech-to-text-ru/actions/workflows/ci.yml/badge.svg)](https://github.com/almaziphone/dsh-speech-to-text-ru/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.5-4b6cf0)](https://github.com/deepseek-ai/deepseek-harness)
[![Русская версия](https://img.shields.io/badge/README-по--русски-success)](README.ru.md)

```
┌───────────────┐     ┌──────────────────────┐     ┌───────────────────────────┐
│  Microphone   │ ──► │  DSH speechToText    │ ──► │  gigaam-ru (this bundle)  │
│  (voice UI)   │     │  service (Host)      │     │  GigaAM-v3 CTC int8, CPU  │
└───────────────┘     └──────────────────────┘     └───────────────────────────┘
                        pinned model download + SHA-256 verify + managed worker
```

## Why

DSH's built-in **Voice input** plugin transcribes with SenseVoiceSmall, which has no Russian
support. This bundle registers another `speechToText` provider backed by GigaAM-v3 (Sber's
Russian ASR foundation model, MIT) running on the `sherpa-onnx` native runtime that DSH already
ships. No cloud, no API keys, no Python, no extra services.

## Highlights

| | |
|---|---|
| Model | GigaAM-v3 **e2e** CTC INT8 (punctuation, casing and number normalization included) |
| Quality | **3.0 % WER** on the reference Russian set, **0 lexical errors** (only inverse text normalization differences) |
| Speed | **RTF 0.017** @ 2 threads — an 8.4 s phrase decodes in **~0.17 s**, model load ~0.36 s |
| Memory | peak RSS **~564 MiB**; the worker is stopped after `idleTimeoutMs` |
| Download | 319.9 MB model + 2 KB tokens + 1.8 MB Silero VAD, verified by size and SHA-256 |
| Languages | `ru` (native), `auto`; multilingual Whisper fallback engine adds `en` and 99 more |
| Privacy | CPU inference on the Host; audio never leaves the machine |
| Platforms | macOS arm64/x64, Linux x64/arm64, Windows x64 (whatever DSH Desktop supports) |

## Requirements

- **DSH Desktop ≥ 0.2.1-rc.5** (or a CLI/Web profile composed from `dsh-base` + `dsh-web-app`).
- ~330 MB disk for the model cache and ~0.6 GB RAM while the recognizer is loaded.
- Network access for the first model download (Hugging Face, with `hf-mirror.com` fallback).
  Fully offline machines can pre-seed the cache — see [Offline install](#offline-install).

## Install

> **Order matters.** Enable the built-in **Voice input** first, then add this bundle. DSH applies
> bundle patches in `dsh.profile.bundles` order, so the Russian bundle has to sit *after* the
> voice-input bundle to make itself the default recognizer. The one-command installer below does
> this for you; with the manual route, pick **GigaAM-v3 · RU (int8)** once in Settings if the order
> was the other way round (DSH persists the selection), or append the small patch block that
> `scripts/install.sh` writes.

### One command (recommended)

```bash
# one line, no clone needed:
bash -c "$(curl -fsSL https://raw.githubusercontent.com/almaziphone/dsh-speech-to-text-ru/main/scripts/install.sh)" install.sh

# or from a clone (add `--spec .` to install the checkout itself instead of GitHub):
git clone https://github.com/almaziphone/dsh-speech-to-text-ru
cd dsh-speech-to-text-ru
./scripts/install.sh
```

The script uses the `dsh` CLI that ships with DSH Desktop, backs up the profile, enables **Voice
input**, installs/selects this bundle (`dsh plugin add`, so pnpm pulls the pinned
`sherpa-onnx-node@1.13.8` runtime for your platform) and pins `defaultProvider: gigaam-ru`,
`language: ru` in the profile patch — so later toggling cannot change the default.

### Manual

1. In DSH open **Plugins** and switch **Voice input** on — that adds the microphone UI, the
   `speechToText` service and its settings.
2. Add the bundle (the `dsh` CLI is
   `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` on macOS; add it to
   `PATH` or call it by full path):

   ```bash
   dsh plugin --profile desktop add github:almaziphone/dsh-speech-to-text-ru
   ```

3. Refresh the app window (`Cmd+R` / `Ctrl+R`). Open **Settings → Voice input**: the recognizer
   should be **GigaAM-v3 · RU (int8)** with language **ru**. If it is not (for example you enabled
   Voice input after installing the bundle), select it once — DSH stores the choice per profile.

Other sources:

```bash
dsh plugin --profile desktop add ./dsh-speech-to-text-ru-0.1.0.tgz   # release tarball
dsh plugin --profile desktop add dsh-speech-to-text-ru               # npm, once published
dsh plugin --profile desktop add /path/to/cloned/checkout            # local checkout (link:)
```

## Distribution

The package is a normal DSH bundle, so it can be distributed in several ways:

| Source | Command |
|---|---|
| GitHub (recommended) | `dsh plugin --profile desktop add github:almaziphone/dsh-speech-to-text-ru` |
| Release tarball | `dsh plugin --profile desktop add ./dsh-speech-to-text-ru-0.1.0.tgz` |
| npm registry | `dsh plugin --profile desktop add dsh-speech-to-text-ru` |
| Local checkout | `dsh plugin --profile desktop add /path/to/checkout` |

Model weights are **not** bundled: the published package is ~30 KB, while the pinned GigaAM-v3
INT8 weights (319.9 MB) and Silero VAD (1.8 MB) — ~322 MB together — are downloaded once on the
target machine at first preparation and verified against the pinned SHA-256 hashes. Offline
machines can copy `~/.dsh/speech-to-text/gigaam-ru/` instead, or use `scripts/install-from-checkout.sh`
on a clone.

Maintainers publish with:

```bash
npm publish --access public   # from this repository (package.json is the bundle manifest)
gh release create v0.1.0 --generate-notes dsh-speech-to-text-ru-0.1.0.tgz
```

## First use

The model is **not** bundled with the package. On first preparation DSH downloads the pinned
assets from Hugging Face (revision pinned, size + SHA-256 verified while streaming) into
`~/.dsh/speech-to-text/gigaam-ru/`:

```
~/.dsh/speech-to-text/gigaam-ru/models/gigaam-v3/model.onnx         319 869 121 B
~/.dsh/speech-to-text/gigaam-ru/models/gigaam-v3/tokens.txt               2 006 B
~/.dsh/speech-to-text/gigaam-ru/models/silero/silero_vad.onnx         1 807 522 B
```

Use **Download and prepare** in the voice settings, or just press the microphone: the provider
wakes the worker and loads the model (≈0.4 s) once the cache is complete.

### Offline install

Copy the cache directory from a prepared machine to the same path on the target machine (the
provider re-verifies every file against the pinned SHA-256 before use), or point the provider at
existing files through `modelDirectory` / `vadModelPath` in your profile patch. To forbid public
downloads entirely, set `modelOrigin` to an internal Hugging Face-compatible mirror (see
[Configuration](#configuration)).

## Use

1. Press the microphone in the message input, dictate in Russian, press **Stop**.
2. The transcript is inserted into the draft — with punctuation, capitalization and normalized
   numbers (`в 15:30`, `9:00`), ready to edit or send.
3. Switch recognizers/languages any time in **Settings → Voice input**; the selection is stored
   per profile by DSH's Settings service.

## Quality (measured on the reference set)

| | GigaAM-v3 e2e CTC INT8 (default) | Whisper Small INT8 (fallback) |
|---|---|---|
| Corpus WER | **3.03 %** (0 lexical errors) | 13.64 % |
| Exact normalized matches | 4 / 5 clips | 2 / 5 |
| RTF @ 2 threads | **0.017** | 0.257 |
| RTF @ 4 threads | 0.014 | 0.264 |
| Peak RSS | **564 MiB** | 1.40 GiB |
| Load | 0.36 s | 0.61 s |
| Punctuation / ITN | yes / yes | yes / yes |

Reference clips, per-clip transcripts and the full benchmark are in
[docs/asr-validation.md](docs/asr-validation.md) and
[docs/model-assets.json](docs/model-assets.json).

## Configuration

The provider row in a profile is `speech-to-text-gigaam`. Override it in
`~/.dsh/profiles/<profile>/cordis.patch.yml` (the user patch always wins over the bundle layer):

```yaml
- id: speech-to-text-gigaam
  config:
    threads: 4              # CPU threads (default 2)
    precision: int8         # int8 (default) or fp32 (larger, not pinned yet)
    engine: gigaam-ctc      # gigaam-ctc (default) or whisper
    idleTimeoutMs: 300000   # unload the worker after 5 min of silence
    # modelDirectory: /abs/path/to/models/gigaam-v3
    # vadModelPath: /abs/path/to/silero_vad.onnx
    # modelOrigin: https://hf-mirror.com     # single explicit mirror, no fallback
```

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `gigaam-ru` | Id the provider registers under (shown in the selector) |
| `engine` | `gigaam-ctc` | `gigaam-ctc` (Russian) or `whisper` (multilingual fallback) |
| `precision` | `int8` | `int8` / `fp32` (only INT8 assets are pinned today) |
| `threads` | `2` | Native inference threads (4 gives ~20 % on this CPU) |
| `dataRoot` | `~/.dsh/speech-to-text/gigaam-ru` | Absolute model cache root |
| `modelDirectory`, `vadModelPath` | – | Use existing absolute files instead of downloading |
| `modelOrigin`, `modelOrigins` | Hugging Face + HF-Mirror | Download sources (single `modelOrigin` disables fallback) |
| `segmentSeconds` | `30` | Max VAD segment duration |
| `vadThreshold`, `minSpeechSeconds`, `minSilenceSeconds`, `vadOnsetPaddingSeconds` | `0.5`, `0.25`, `0.5`, `0.4` | Silero VAD segmentation tuning |
| `idleTimeoutMs` | `300000` | Stop the worker after inactivity (`0` keeps it) |
| `maxPending`, `inferenceTimeoutMs`, `prepareTimeoutMs` | `4`, `120000`, `3600000` | Queue and time bounds |

The service-level default selection lives on the `speech-to-text` row
(`defaultProvider: gigaam-ru`, `language: ru`).

## Engines

- **`gigaam-ctc`** (default) — GigaAM-v3 e2e CTC converted for sherpa-onnx NeMo-CTC. Russian,
  MIT-licensed, best quality and speed. English is *not* advertised: GigaAM transliterates English
  words into Cyrillic and makes spelling errors.
- **`whisper`** — Whisper Small INT8 (multilingual, 99 languages). Slower and less accurate on
  Russian, but useful for mixed Russian/English dictation. Set `engine: whisper` and choose
  language `ru`, `en` or `auto` in the voice settings. (Note: sherpa-onnx accepts only `""` for
  auto-detect; the provider maps `auto` to `""` so the native layer never sees the literal
  string.)

## How it works

```
Host plugin (lib/index.js)                     worker subprocess (lib/worker.js)
─────────────────────────                      ──────────────────────────────────
inspect cache on activation (no downloads)     load sherpa-onnx OfflineRecognizer
prepare(): download → verify → load            load Silero VAD
transcribe(): POST WAV to 127.0.0.1:PORT  ───► decode VAD segments (GigaAM or Whisper)
  bearer token, one serial worker               → JSON transcript back
idle timeout / cancellation → terminate
```

- Assets are **revision-pinned** on Hugging Face with size + SHA-256 verification while
  streaming; a verified file is never downloaded again.
- The native `sherpa-onnx-node` runtime comes from the package dependency (or the copy inside the
  DSH app bundle as a fallback) — this package never bundles platform binaries.
- The worker is a Node child process with a random 32-byte bearer token; the loopback listener
  only accepts `POST /transcribe` from the Host. Audio stays in memory.
- The provider is a normal DSH plugin entry (`apply/inject`) with a preparation state machine
  (`check → download → verify → load`), so the standard voice UI cards, progress, cancellation and
  settings work unchanged.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No microphone in the composer | Enable **Plugins → Voice input**; refresh the window (`Cmd+R`). |
| Provider not in the selector | Check **Plugins** for a load error on this bundle; make sure Voice input is enabled (the provider needs the `speechToText` service) and the profile lists the bundle after it. |
| "Download and prepare" errors | Check network/disk; the UI shows source and reason. `modelOrigin` can point at a mirror. |
| Cache from another machine ignored | File names must match `runtime/assets.json`; the provider verifies filename, size and SHA-256. |
| Slow / high CPU | Lower `segmentSeconds`, keep `threads: 2`; the worker unloads after `idleTimeoutMs`. |
| Need to remove | `dsh plugin --profile desktop remove dsh-speech-to-text-ru` and toggle **Voice input** off (or leave it for SenseVoice). |

## Privacy

Model weights are downloaded from Hugging Face; nothing else touches the network. Recordings are
transcribed on the Host CPU, in memory, by a local process, and are never uploaded. No API keys,
no telemetry from this plugin.

## Development

```bash
npm install                      # only the pinned sherpa native runtime
node --test test/smoke.test.mjs  # 15 model-free contract/unit tests (CI runs these)
npm pack                         # produces the installable tarball
node scripts/transcribe.mjs --wav samples/16k.wav --model-dir ~/.dsh/speech-to-text/gigaam-ru/models
```

Dev install from a checkout (`file://` module URL, no package install):

```bash
dsh plugin --profile dev-profile add /path/to/checkout
```

## Upstream / official bundle

DeepSeek Harness' [`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)
currently states that external pull requests are not accepted, so instead of opening a PR the
integration proposal was posted in the project's discussions:

- Upstream proposal (Ideas): https://github.com/deepseek-ai/deepseek-harness/discussions/11745
- Plugin announcement (Show Your Plugins!): https://github.com/deepseek-ai/deepseek-harness/discussions/11746

The implementation-ready change set — new `packages/experimental/speech-to-text-gigaam` package
mirroring `speech-to-text-sensevoice`, the `voice-input-bundle` patch row, official-bundle
manifests, docs and tests — is described in [docs/upstream.md](docs/upstream.md). If the project
opens external contributions (or the maintainers ask for the code), the port is mechanical and
this repository is the working prototype.

## Credits & licenses

- **GigaAM-v3** — © SaluteDevices / Sber, MIT. ONNX conversion for sherpa-onnx by
  [Smirnov75](https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx).
- **sherpa-onnx** — Apache-2.0 (next-gen Kaldi team); Silero VAD is MIT.
- **DeepSeek Harness** — the provider architecture (preparation state machine, worker transport,
  VAD segmentation, plugin contract) is adapted from the MIT-licensed
  `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` package and the documented
  `speechToText` service contract.
- This bundle: MIT, see [LICENSE](LICENSE).

---

Русская документация: [README.ru.md](README.ru.md)
