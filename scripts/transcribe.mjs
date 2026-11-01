#!/usr/bin/env node
/**
 * Sanity-check the recognizer without DSH: decode one canonical 16 kHz mono PCM16 WAV
 * with the same native configuration the provider's worker uses.
 *
 *   npm install   # once, pulls the pinned sherpa-onnx-node runtime
 *   node scripts/transcribe.mjs --wav samples/16k.wav --model-dir ~/.dsh/speech-to-text/gigaam-ru/models
 *
 * Options:
 *   --wav <path>        required, canonical 16 kHz mono PCM16 WAV
 *   --model-dir <path>  required, directory containing gigaam-v3/{model.onnx,tokens.txt}
 *                       and silero/silero_vad.onnx (the provider cache layout)
 *   --engine <name>     gigaam-ctc (default) or whisper
 *   --threads <n>       native threads (default 2)
 *   --language <code>   ru (default), en or auto/"" (whisper only)
 *   --json              print machine-readable JSON instead of the transcript
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadNativeModule } from '../lib/native.js'
import { validateWave } from '../lib/wave.js'
import { buildNativeConfig, canDecode } from '../lib/worker.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  return args[index + 1]
}
const flag = (name) => args.includes(`--${name}`)

const wav = option('wav')
const modelDir = option('model-dir')
if (!wav || !modelDir) {
  console.error('usage: node scripts/transcribe.mjs --wav <16k.wav> --model-dir <models-dir> [--engine gigaam-ctc|whisper] [--threads N] [--language ru|en|auto] [--json]')
  process.exit(2)
}
const engine = option('engine', 'gigaam-ctc')
const threads = Number(option('threads', '2'))
const language = option('language', 'ru')
const nativeLanguage = engine === 'whisper' && language !== 'auto' ? language : engine === 'whisper' ? '' : ''

const modelConfig = engine === 'whisper'
  ? {
      whisper: {
        encoder: join(modelDir, 'whisper-small', 'small-encoder.int8.onnx'),
        decoder: join(modelDir, 'whisper-small', 'small-decoder.int8.onnx'),
        language: nativeLanguage,
        task: 'transcribe',
        tailPaddings: -1,
      },
      tokens: join(modelDir, 'whisper-small', 'small-tokens.txt'),
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    }
  : {
      nemoCtc: { model: join(modelDir, 'gigaam-v3', 'model.onnx') },
      tokens: join(modelDir, 'gigaam-v3', 'tokens.txt'),
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    }

const audio = readFileSync(wav)
const audioSeconds = validateWave(audio, 600)
const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44)
const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, index) => pcm.getInt16(index * 2, true) / 32768)
if (!canDecode(samples.length)) {
  console.error(`recording is shorter than the native minimum (${samples.length} samples)`)
  process.exit(1)
}

const sherpa = loadNativeModule()
const started = performance.now()
const recognizer = new sherpa.OfflineRecognizer(buildNativeConfig({ engine, threads, model: modelConfig.nemoCtc?.model, tokens: modelConfig.tokens }, nativeLanguage))
const loadMs = performance.now() - started
const decodeStart = performance.now()
const stream = recognizer.createStream()
stream.acceptWaveform({ sampleRate: 16000, samples })
recognizer.decode(stream)
const result = recognizer.getResult(stream)
const inferenceSeconds = (performance.now() - decodeStart) / 1000
const payload = {
  engine,
  language: engine === 'whisper' ? nativeLanguage : 'ru',
  text: result.text.trim(),
  audioSeconds,
  inferenceSeconds,
  loadMs,
  rtf: inferenceSeconds / audioSeconds,
}
if (flag('json')) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
else process.stdout.write(`${payload.text}\n`)
