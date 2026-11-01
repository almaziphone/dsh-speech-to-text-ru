# Russian ASR validation for the DSH "Voice input" plugin

**Verdict: ship `GigaAM-v3 e2e CTC int8` (NeMo-CTC via sherpa-onnx) as the Russian engine.**
It runs on the app's already-bundled `sherpa-onnx-node` 1.13.8 native addon with no new
dependencies, transcribes Russian with **0 lexical errors on our test set**, emits
**punctuation + casing + number normalization**, and is **~15× faster and ~2.5× lighter**
than the whisper-small fallback.

Validated on 2026-11-01 by teammate `asr-model-ru`.
Test lab (scripts + raw JSON): `voice-ru/tools/asr-lab/`, `voice-ru/notes/`.

---

## 1. Runtime proof — the app's own binary, not a reimplementation

| Fact | Value |
|---|---|
| JS package | `sherpa-onnx-node` **1.13.8** (`gitSha1` `11afbd00`, `gitDate` Thu Sep 10 13:52:45 2026) |
| Native addon | `sherpa-onnx-darwin-arm64` (`sherpa-onnx.node` 659 136 B, `libsherpa-onnx-c-api.dylib`, `libonnxruntime.dylib` 29 MB) |
| ONNX Runtime | **1.28.2** (reported by the addon) |
| Host | Node v24.21.0, darwin/arm64 |
| Verified load | `require('sherpa-onnx-node')` → 24 exports, `OfflineRecognizer` present |

**Layout finding (important for the plugin):** the JS package resolves the native addon from
a *sibling* directory `../sherpa-onnx-darwin-arm64/sherpa-onnx.node` (`addon-static-import.js`
+ `addon.js` `possible_paths`). With the flat `node_modules/` layout the app bundle ships,
**no `DYLD_LIBRARY_PATH` is needed** — a plain `require('sherpa-onnx-node')` works. I verified
this both with and without `DYLD_LIBRARY_PATH`; results identical.

---

## 2. Candidate comparison (measured on the same 5 Russian clips + 1 real recording)

| | **GigaAM-v3 e2e CTC int8** ✅ | whisper-small int8 (fallback) |
|---|---|---|
| Engine | NeMo-CTC (`modelConfig.nemoCtc`) | whisper (`modelConfig.whisper`) |
| Download size | **319.9 MB** (model + 2 KB tokens) | 375.5 MB (encoder + decoder + tokens) |
| Load time | **348–400 ms** (median 363 ms warm, 590 ms cold disk) | 612–615 ms |
| Peak RSS (whole process) | **591 413 248 B ≈ 564 MiB** | 1 470 087 168 B ≈ **1.40 GiB** |
| Model RAM delta | ≈ 497 MiB | ≈ 1.05 GiB |
| Corpus WER (5 clips) | **3.03 %** (2 edits / 66 words) | 13.64 % (9 edits / 66 words) |
| Lexical errors | **0** — the 2 "edits" are ITN formatting only | 9, incl. word splits, wrong word forms, truncated phrase |
| Exact normalized matches | **4 / 5** | 2 / 5 |
| RTF, 2 threads | **0.0171** | 0.2574 |
| RTF, 4 threads | **0.0135** | 0.2642 |
| Decode 8.39 s clip | **111 ms** (2t) / 109 ms (4t) | 2 190 ms / 2 067 ms |
| Decode 25.17 s clip | **418 ms** (2t) / 296 ms (4t) | not tested (est. ~6.5 s) |
| Punctuation / casing | **yes** + ITN | yes |
| Languages | ru (native), en (weak) | 99 (multilingual) |
| License | MIT | MIT |

4 threads buy only ~20 % over 2 threads (RTF 0.0171 → 0.0135) while adding CPU pressure, so
**2 threads is the recommended default**; the UI can offer 4 as a "faster" option.

---

## 3. Evidence table — expected vs actual (GigaAM-v3 e2e CTC int8, 2 threads)

| Clip | Audio s | Expected (ground truth) | Actual transcript | WER | Decode ms | RTF |
|---|---|---|---|---|---|---|
| clip1 | 8.39 | Надиктуй заметку: встреча с командой перенесена на четверг, в 15:30, в переговорной на третьем этаже. | Надиктуй заметку: «Встреча с командой перенесена на четверг в 15:30 в переговорной на третьем этаже» | 0 | 110.7 | 0.0132 |
| clip2 | 5.63 | Пожалуйста, напомни мне завтра в девять утра позвонить в банк и уточнить статус заявки. | Пожалуйста, напомни мне завтра в 9:00 утра позвонить в банк и уточнить статус заявки | 0.1429\* | 84.3 | 0.0150 |
| clip3 | 7.43 | Мы обсудили новый релиз: нужно исправить ошибки в авторизации, обновить документацию и подготовить демо для клиентов. | Мы обсудили новый релиз. нужно исправить ошибки в авторизации, обновить документацию и подготовить демо для клиентов | 0 | 129.6 | 0.0175 |
| clip4 | 4.93 | Отправь письмо Анне Сергеевне и попроси прислать счёт на оплату до конца недели. | Отправь письмо Анне Сергеевне и попроси прислать счёт на оплату до конца недели | 0 | 80.8 | 0.0164 |
| clip5 | 3.29 | Привет, как дела? Давай созвонимся в обед. | Привет! Как дела? Давай созвонимся в обед | 0 | 83.5 | 0.0254 |
| oam1_16k | 7.28 | *unknown (real user recording)* | Саша, ты можешь сейчас забрать меня из Ханты-Мансийска? До Дениса не могу дозвониться. Напиши, Макс, когда подъедешь. | n/a | 141.8 | 0.0195 |

\* **The only "error" is inverse text normalization, not recognition.** Spoken «в девять утра»
was written «в 9:00 утра». Word-level edit distance counts it as 1 substitution + 1 deletion,
but the audio was heard correctly. **Ignoring ITN-only differences, the corpus WER is 0.00 %.**

Threads=4 reproduces byte-identical text with lower latency (clip1 108.9 ms, clip3 91.2 ms,
clip4 64.9 ms, clip5 50.0 ms, oam1 102.5 ms; corpus RTF 0.0135).

Corpus totals: 36.95 s audio, 630.7 ms decode @2t (RTF 0.0171) / 499.5 ms @4t (RTF 0.0135).
Raw data: `voice-ru/notes/bench-gigaam.json`, `bench-whisper-4t.json`, `bench-whisper-empty-lang.json`.

### Test set

Generated with macOS Russian TTS voice "Milena", converted with
`afconvert -f WAVE -d LEI16@16000 -c 1`, so 16 kHz mono s16 PCM — exactly the app's input
format. Manifest with expected texts: `voice-ru/test-audio/clips.json`. The TTS provenance is
a **known limitation** (synthetic speech is easier than real speech) — that is why the real
recording `oam1_16k.wav` was included; its fluent, correctly punctuated output there is the
strongest available evidence for real-world quality.

---

## 4. Exact `OfflineRecognizer` config for NeMo-CTC (copy-paste)

```js
const { OfflineRecognizer } = require('sherpa-onnx-node');

const recognizer = new OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    nemoCtc: { model: '<models>/gigaam-v3/model.onnx' },   // gigaam_v3_e2e_ctc_int8.onnx, renamed
    tokens: '<models>/gigaam-v3/tokens.txt',                // gigaam_v3_e2e_ctc_tokens.txt, renamed
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
  maxActivePaths: 4,
  hotwordsFile: '',
  hotwordsScore: 1.5,
  ruleFsts: '',
  ruleFars: '',
  blankPenalty: 0,
});

const stream = recognizer.createStream();
stream.acceptWaveform({ samples /* Float32Array, [-1,1] */, sampleRate: 16000 });
recognizer.decode(stream);
const { text } = recognizer.getResult(stream);
```

This mirrors the model's own README invocation
(`--nemo-ctc-model=gigaam_v3_e2e_ctc.onnx --tokens=gigaam_v3_e2e_ctc_tokens.txt`), which I
fetched from the pinned revision to confirm the mapping. `greedy_search` is correct and
sufficient for CTC; `maxActivePaths` is irrelevant for CTC but harmless.

Audio must be **16 kHz mono s16 → Float32 in [-1,1]**. Non-16 kHz input is not resampled by
the recognizer, so the plugin must resample before decoding.

---

## 5. Model behaviour Q&A

### (a) Punctuation, casing, number normalization — yes, all three
The repo's own description of this variant is *"end-to-end CTC model with punctuation and text
normalization"* (README at the pinned revision). Observed in practice:

> **Expected:** `…напомни мне завтра в девять утра позвонить в банк…`
> **Actual:** `Пожалуйста, напомни мне завтра в 9:00 утра позвонить в банк и уточнить статус заявки.`
> **Actual (clip1):** `Надиктуй заметку: «Встреча с командой перенесена на четверг в 15:30 в переговорной на третьем этаже»`

- Casing: sentence-initial capitals, proper names (`Анне Сергеевне`, `Макс`, `Ханты-Мансийска`) — good.
- Punctuation: `.` `,` `?` `!` `:` `«»` are emitted and mostly right.
- ITN: spoken times become digits (`15:30`, `9:00`).
- **Caveats:** punctuation is not perfect — clip3's colon came out as `. «нужно»` lowercase, and
  clip1 gained «» quotes around a clause that had none. Repetition instability exists: the same
  sentence repeated 3× inside a 25 s file produced `наретьем` / `на тьм` / `на ретьем` at
  segment boundaries. Treat punctuation as "good enough to display", not as authoritative.

### (b) English: do NOT advertise it for this engine
The HF card tags `ru, en`, and the model does emit English — but badly:

> `Hello, can you sent Me the Report by Fridey Autornoon`  ← for "Hello, can you send me the report by Friday afternoon?"

Misspellings (`Fridey`), wrong verb forms (`sent`), random casing (`Report`). Russian/English
code-mixing is worse — English words are phonetically Cyrillicized:

> `Слушай, давай сделаем коуд ревью завтра, а потом я отправлю  пол-реквеt`
> (expected: `…сделаем code review завтра, а потом я отправлю pull request.`)

**Recommendation:** keep `languages: ["ru", "en"]` in the asset facts only to describe the
model, but in the UI offer GigaAM as **Russian** and fall back to the whisper engine when the
user's language setting is English. Do not promise English quality from GigaAM.

### (c) Does `nemoCtc` accept a language hint? — **No**
Confirmed two ways: (1) the JS typedef `NemoCtcModelConfig` has exactly one field, `model`
(no `language`); the C++ `OfflineNemoCtcModelConfig` mirrors it. (2) The model README's
NeMo-CTC invocation passes only `--nemo-ctc-model` and `--tokens` — there is no language flag.
GigaAM-v3 e2e CTC is a fixed Russian(+weak en) model; language selection is not a model
parameter. **`autoLanguage` should therefore be `""`**, so the plugin can represent "auto"
uniformly and simply ignore it for this engine.

### (d) Edge cases — and one hard crash the plugin must guard
Measured with GigaAM-v3 int8, 16 kHz:

| Input | Samples | Result | Notes |
|---|---|---|---|
| silence, 1.5 s | 24 000 | `""` (29 ms) | clean, no hallucination — safe |
| white noise, 2 s | 32 000 | `"."` (33 ms) | harmless punctuation-only artifact |
| long, 25.17 s (3× clip1) | 402 720 | full text (418 ms, RTF 0.0166 @2t / 296 ms, 0.0118 @4t) | scales linearly, no truncation |
| **empty WAV, 0 s** | **0** | **PROCESS ABORT — exit 134, `Invalid input shape: {0}`** | `decode()` aborts via `Ort::Exception` → `libc++abi`; **not catchable by `try/catch`** |
| **too short** | **1, 16** samples | **PROCESS ABORT — exit 134** | same fatal path |
| short | 160 samples (10 ms) | `""` (safe) | **160 samples is the working minimum** |

**Consequence for the worker:** never call `stream.acceptWaveform`/`decode` with fewer than
160 samples (the safe rule is `samples.length < 160 → return ""`). A VAD or recorder that hands
over an empty buffer will otherwise **kill the whole plugin process (SIGABRT)**, and the crash
cannot be intercepted in JS — I verified `try { … } catch` does not help because the abort
happens in native code. `transcribe.js` in the lab already implements this guard.

### (e) Real recording `oam1_16k.wav` (resampled from `~/Documents/oam1.wav`, 24 kHz → 16 kHz, 7.28 s)

> **Саша, ты можешь сейчас забрать меня из Ханты-Мансийска? До Дениса не могу дозвониться. Напиши, Макс, когда подъедешь.**

Ground truth is unknown (no reference text on disk), but the output is fluent, grammatical,
correctly punctuated, keeps the hyphenated toponym `Ханты-Мансийска`, and infers two speaker
names — a good real-world sanity check. Whisper on the same file was worse:
`…Ханты Мансиска? Да Дениса не могу дозвониться. Напиши Макс когда подъедешь.` (lost the hyphen
and case, lost most punctuation).

---

## 6. VAD recommendation (needed if the plugin segments long dictation)

Silero VAD **works** with this runtime (`new Vad(...)` + `CircularBuffer`, sentence-piece
tokenizer not required), but the naive config destroys quality:

| `minSilenceDuration` | Padding | Segments | Result |
|---|---|---|---|
| 0.25 s | none | 6 | **over-segmented**: `Диктуй заметку` (onset clipped), `Пятнадцать часов` + `30 минут` (15:30 split, ITN lost) |
| 0.5 s | none | 2 | full text, but onsets still clipped (`Диктуй`, `Письмо`) and `третьм` |
| 0.5 s | 0.4 s before / 0.2 s after | 2 | ✅ `Надиктуй заметку: … в 15:30 …`, `Отправь письмо …` — everything recovered |
| 0.8 s | 0.4 s / 0.2 s | 2 | ✅ same, best punctuation |
| 1.2 s | none | 1 | segments merged, onset clipped (`Пиктуй`) |

**Use `threshold: 0.5, minSilenceDuration: 0.5–0.8, minSpeechDuration: 0.25, windowSize: 512,
maxSpeechDuration: 20`, and pad each segment ≈ 0.4 s before / 0.2 s after** by slicing the
original ring buffer rather than using the VAD's tight cut. VAD lives at
`FeatConfig`/`VadConfig` level; measured VAD+decode pipeline cost for 15.3 s of audio: **288 ms**
(≈ RTF 0.019), i.e. negligible.

---

## 7. Whisper-small fallback — facts and one dangerous trap

Config: `modelConfig.whisper = { encoder, decoder, language: "ru", task: "transcribe",
tailPaddings: -1 }` + `tokens`, `numThreads`, `provider: "cpu"`; `decodingMethod: "greedy_search"`.
Load 612 ms, peak RSS ≈ **1.40 GiB**, RTF **0.257 @2t / 0.264 @4t** (4 threads give nothing —
it is decoding-bound). Corpus WER **13.64 %**, 2/5 exact. Concrete failures:
`Надиктуй → На диктую`, `напомни → напомним`, clip4 truncated at `…до конца` (lost `недели`),
`Ханты-Мансийска → Ханты Мансиска`. Punctuation/casing are comparable to GigaAM.

### ⚠️ `language: "auto"` is FATAL — only `""` means auto-detect
Verified by running each value through the real addon:

| `language` value | Outcome |
|---|---|
| `"ru"` | ✅ works |
| `""` (empty string) | ✅ works — **this is the only correct auto-detect value**; output byte-identical to `"ru"` on our Russian clips |
| `"en"` | ✅ works (correctly produced the English transcription of an English clip) |
| `"auto"` | ❌ **native abort, exit 255/134**: `offline-whisper-greedy-search-decoder.cc:Decode:58 Invalid language: auto` |
| `"Auto"` | ❌ same abort |

The abort is unrecoverable from JS. **The plugin must never forward the literal string `"auto"`
to the native layer** — map the UI's "auto" to `""`. `transcribe.js` does this mapping and warns.

---

## 8. Assets — sizes and sha256 (all verified byte-for-byte)

### Chosen model — GigaAM-v3 e2e CTC int8
Repo `Smirnov75/GigaAM-v3-sherpa-onnx`, revision **`6888903da215c7735f51101d939f3bfa679fb2b8`**
(HF API reports the same sha for `main`; pinned revision returns HTTP 200).

| File (HF name) | Bytes | sha256 |
|---|---|---|
| `gigaam_v3_e2e_ctc_int8.onnx` | 319 869 121 | `0aacb41f70f0f5aaac4b45dd430337b9e16b180f22c72af04db8516e7609c3c0` |
| `gigaam_v3_e2e_ctc_tokens.txt` | 2 006 | `f8eb9b115e2748db9c40a5897cae11dd0678cc0b40fd7e25f8c43b3bf28715e4` |

`https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx/resolve/6888903da215c7735f51101d939f3bfa679fb2b8/<file>`

### VAD — silero
`https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx`
— 1 807 522 B, sha256 `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28`.
**Matches the expected hash given in the task exactly**; the pinned revision equals current `main`.

### Fallback — whisper-small int8
Repo `csukuangfj/sherpa-onnx-whisper-small`, revision **`8f3c18b358db4d1f2fc1eae49d75cd20989e4309`** (HTTP 200):

| File | Bytes | sha256 |
|---|---|---|
| `small-encoder.int8.onnx` | 112 442 483 | `4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9` |
| `small-decoder.int8.onnx` | 262 226 114 | `acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee` |
| `small-tokens.txt` | 816 730 | `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126` |

Machine-readable version of all of the above, with config snippets and measured numbers:
**`voice-ru/notes/model-assets.json`**.

### fp32 variant — deliberately NOT downloaded
`gigaam_v3_e2e_ctc.onnx` (885 950 432 B) was skipped: int8 already leaves **zero lexical
errors**, so a 566 MB download + ~0.5 GiB extra RAM buys nothing. It is a drop-in replacement
(same `nemoCtc` config, just a different `model:` path) if int8 ever regresses.

Total downloaded for validation: **697 163 918 B ≈ 665 MiB** (GigaAM 320 MB + whisper 375 MB +
VAD 2 MB), well under the 1.4 GB budget. Recommended shipping set is only
**321 676 649 B ≈ 307 MiB** (GigaAM + tokens) or **+2 MB** with VAD.

---

## 9. Reproduce / independently re-verify

```bash
NODE=/Users/almaz/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
cd voice-ru/tools/asr-lab

# JSON out: {text, audioSeconds, inferenceSeconds, engine, loadMs, rtf, ...}
$NODE transcribe.js ../../test-audio/clip1.wav
$NODE transcribe.js ../../test-audio/clip1.wav --engine gigaam --threads 4
$NODE transcribe.js ../../test-audio/oam1_16k.wav ru --engine whisper   # fallback engine
$NODE transcribe.js ../../test-audio/clip1.wav --text                    # transcript only

# full accuracy/performance tables -> voice-ru/notes/bench-gigaam.json
$NODE bench.js --engine gigaam --threads 2,4 --json ../../notes/bench-gigaam.json
```

`transcribe.js` accepts any 16 kHz mono s16 WAV; it resamples other rates linearly, refuses
(the requested) `--engine` values other than `gigaam|whisper`, guards the <160-sample crash,
maps whisper `"auto"` → `""`, and exits 1 on bad usage/IO, 2 on model-load failure.

---

## 10. Risks and open items

1. **Synthetic-speech optimism.** 4/5 exact comes from TTS audio. The one real recording looked
   good, but the honest expectation for noisy real dictation is a few % WER, not 0. Recommend the
   plugin keep the transcript editable before insert.
2. **Native crash surfaces (2 found, both must be guarded in the plugin, not just the lab):**
   - `< 160` samples → `decode()` aborts the process (`Invalid input shape: {0}`), uncatchable.
   - whisper engine + `language: "auto"`/`"Auto"` → abort (`Invalid language`), uncatchable.
3. **Punctuation is approximate.** Occasionally wrong marks (`: → .`), spurious «», and
   word-boundary spelling wobble (`третьем`/`ретьем`) when audio is segmented tightly — the
   VAD padding in §6 mitigates the segment-boundary cases.
4. **English/code-mix must not be advertised** for GigaAM (§5b). Route English users to whisper
   or another engine.
5. **Memory:** ~564 MiB peak for the process with GigaAM loaded. If the app also loads the
   whisper engine concurrently, expect ~2 GiB — load the fallback lazily and free it on switch.
6. **No streaming.** This is an offline recognizer; "voice input" needs VAD segmentation or
   press-to-talk capture, then one decode per utterance. That matches RTF 0.017 (a 10 s
   utterance transcribes in ~170 ms), so a single-shot UX is fine.
7. **Model download at install/first-run:** 307 MiB (or 375 MiB more for whisper). Needs the
   sha256 verification above and a resumable downloader; HF URLs are revision-pinned so they
   are immutable.
8. Tokens file must always match the model (`e2e` tokens with `e2e` model) — mixing
   `gigaam_v3_ctc_tokens.txt` with the `e2e` model would silently corrupt output. Both files are
   pinned to the same revision here.

---

## 11. Files produced by this task

| Path | What |
|---|---|
| `voice-ru/notes/model-assets.json` | machine-readable assets: repo, revision, URLs, bytes, sha256, config snippets, measurements |
| `voice-ru/notes/asr-validation.md` | this report |
| `voice-ru/notes/bench-gigaam.json` | raw per-clip GigaAM results, threads 2 & 4 |
| `voice-ru/notes/bench-whisper-4t.json` | raw whisper results, 4 threads |
| `voice-ru/notes/bench-whisper-empty-lang.json` | whisper with `language: ""` (auto-detect) |
| `voice-ru/tools/asr-lab/transcribe.js` | **re-verification CLI** (JSON `{text, audioSeconds, inferenceSeconds}`) |
| `voice-ru/tools/asr-lab/bench.js` | accuracy/perf benchmark harness |
| `voice-ru/tools/asr-lab/{smoke,rss-probe,long-test,vad-smoke,vad-tune,vad-pad,edge-test,one-case}.js` | focused probes used for the numbers above |
| `voice-ru/test-audio/clips.json` | test-set manifest: wav → expected text |
| `voice-ru/test-audio/clip1..5.wav` | 5 Russian TTS clips (3.3–8.4 s), 16 kHz mono s16 |
| `voice-ru/test-audio/oam1_16k.wav` | real user recording, resampled to 16 kHz |
| `voice-ru/test-audio/edge/*.wav` | empty, silence, noise, 25 s, English, ru-en mixed |
| `voice-ru/models/{gigaam-v3,whisper-small,vad}/` | downloaded, sha256-verified assets |
