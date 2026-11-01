# Upstream integration proposal — Russian speech-to-text as an official optional bundle

Status: **community proposal** (see the DeepSeek Harness Discussions post linked from
[README.md](../README.md#upstream)). DeepSeek Harness' `CONTRIBUTING.md` currently states that
external pull requests are not accepted, so this document is the implementation-ready form of the
PR we would send as soon as that policy changes — or that the maintainers can apply themselves.

## Why this belongs in the product

Voice input is one of the experimental capabilities DSH ships (optional bundle
`@deepseek-ai/dsh-experimental-voice-input-bundle`). Today it has exactly one local recognizer —
SenseVoiceSmall — whose language hints are `auto, zh, en, yue, ja, ko`. Russian is not among them,
although Russian is one of the largest non-English user bases of DSH. There is no cloud provider
in the experimental voice-input composition either, so a Russian-speaking user simply cannot use
this feature today.

Adding a Russian provider closes that gap without new native dependencies:

- `sherpa-onnx-node` (the ONNX runtime) is **already** a runtime dependency of the installation
  (`packages/experimental/speech-to-text-sensevoice` depends on it). The new provider reuses it.
- The model is a **download**, not a shipped binary: GigaAM-v3 e2e CTC INT8, 319.9 MB, revision
  pinned, verified by size + SHA-256 (same preparation state machine as SenseVoice).
- The provider registers into the existing `speechToText` service, so the microphone UI, the
  preparation cards, cancellation, settings persistence, byte/duration limits and the "insert
  transcript" flow all work unchanged.
- GigaAM-v3 is MIT (SaluteDevices/Sber); the sherpa-onnx conversion is published by Smirnov75
  (MIT). No new licensing burden for the installation.

## Measured (reference set, macOS arm64, the app's own sherpa-onnx-node 1.13.8)

| | GigaAM-v3 e2e CTC INT8 | Whisper Small INT8 (fallback engine in the community package) |
|---|---|---|
| WER | **3.03 %** (0 lexical errors) | 13.64 % |
| RTF @2 threads | **0.017** | 0.257 |
| Peak RSS | **564 MiB** | 1.40 GiB |
| Load | 0.36 s | 0.61 s |
| Output | punctuation, casing, number normalization | same |
| Download | 321.7 MB (model + tokens) + 1.8 MB VAD | 375.5 MB + 1.8 MB VAD |

Full evidence, per-clip transcripts, VAD tuning and the two native crash modes we had to guard
(`<160`-sample decode, `language: "auto"` in sherpa-onnx) are in
[asr-validation.md](asr-validation.md) and [model-assets.json](model-assets.json).

## Proposed change set

The community implementation is a dependency-free ESM DSH plugin
([this repository](../README.md)). To land it in the monorepo we would restructure it to the
repository conventions and touch the following files:

1. **New package `packages/experimental/speech-to-text-gigaam/`** — mirrors
   `packages/experimental/speech-to-text-sensevoice/`:

   | Path | Content |
   |---|---|
   | `package.json` | `publishConfig.access: public`, `dsh.bundle.patch`, dependency on `sherpa-onnx-node` (same version as the sensevoice package), peers on `cordis`, `dsh-experimental-speech-to-text`, `dsh-subprocess` |
   | `src/index.ts` | provider plugin: config schema (`schemastery`), preparation state machine, pinned download + verification, subprocess worker lifecycle, idle reclamation, registration into `speechToText` |
   | `src/worker.ts` | child process: `sherpa-onnx` `OfflineRecognizer` with `nemoCtc` config, Silero VAD segmentation, authenticated loopback transport (same contract as the SenseVoice worker) |
   | `src/assets.ts` / `runtime/assets.json` | pinned Hugging Face revision + bytes + SHA-256 (GigaAM model, tokens, Silero VAD) |
   | `locale/en.json`, `locale/zh.json` | provider strings; `README.md`, `README.zh.md`, `README.i18n.yaml` |
   | `tests/` | unit tests for language mapping, config normalization, decode-length guard, WAV validation, worker transport; CI-friendly (no model download) |
   | `tsconfig.json`, `tsdown.config.ts` | same build setup as the neighbouring packages |

2. **`packages/experimental/voice-input-bundle/cordis.patch.yml`** — insert the provider row
   (`id: speech-to-text-gigaam`, `dataRoot: !!js dshHomePath('speech-to-text', 'gigaam')`) and keep
   `sensevoice-local` as the shipped default; users pick the recognizer in
   Settings → Voice input. (A separate bundle would also work, but the provider only makes sense
   together with the speech service, so extending the existing voice-input bundle is simpler and
   keeps one optional-bundle entry, icon and locale set.)
3. **`packages/util/official-bundles/src/bundles.ts`** — no new bundle if (2) is chosen; otherwise
   add the bundle name, icon/locale metadata and admission per the optional-bundle process in
   `.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md`.
4. **Release/installation manifests** — `apps/desktop/package.json` + runtime dependency list must
   carry the new package (as they do for `speech-to-text-sensevoice`); update
   `scripts/optional-bundles.spec.ts` and the installed-product isolation checks if they enumerate
   experimental packages.
5. **Docs** — `docs/subsystems/voice-input.md` + `.zh.md` + `.i18n.yaml`: mention the second
   provider, its language hints, model size and preparation steps; add the package to
   `packages/experimental/README.md`; mention GigaAM in `THIRD_PARTY_NOTICES.md` (MIT attribution).

Estimated size: ~1,300 lines of provider code (mostly a direct port of the SenseVoice provider
structure with a different native config and asset manifest), plus tests and docs. The community
package is the functional prototype; the port is mechanical, and we are happy to do it in the
repository's TypeScript conventions.

## Open questions for maintainers

- Preferred placement: extend `voice-input-bundle` (as proposed) or ship a separate
  `voice-input-ru-bundle` that also composes the UI (one more entry in the plugin list)?
- Is an additional CPU-only language model acceptable under the optional-bundle disk/RAM budget,
  given the model is an on-demand download (`SpeechSetupEstimate`: ~800 MB disk, ~1.2 GB memory,
  1–10 min)?
- Chinese documentation: we can draft EN; a zh review would be needed (or we can defer the zh
  README/locale to a follow-up).
- AI-declaration: the community implementation was built and validated with an AI coding agent
  under human direction. We can fill the repository's AI-declaration table for the port.

## Compatibility and risk

- No change to the `speechToText` service contract, no change to released packages' dependencies
  (experimental isolation rules stay satisfied: the new package may depend on release packages).
- The provider never touches the network except for the pinned model download, and the native
  runtime is the same one the installation already loads for SenseVoice.
- DoS/resource bounds mirror SenseVoice: 4 MB audio cap, bounded queue, inference/prepare
  timeouts, worker killed on cancellation and after `idleTimeoutMs`.
- Two native quirks are guarded in the worker: sherpa-onnx aborts on a `<160`-sample decode, and
  the literal `"auto"` language aborts the Whisper engine — both covered by tests.

## Proof

The community bundle was installed into a clean DSH home directly from GitHub
(`dsh plugin --profile desktop add github:almaziphone/dsh-speech-to-text-ru`), the host
recomposed with the provider registered (`gigaam-ru`, languages `ru`/`auto`), preparation reused a
verified cache, and a Russian recording was transcribed through the real `speechToText` service
in 1.8 s wall time with correct text, punctuation and number normalization.
