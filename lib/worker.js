/**
 * Private child-process entry for the local Russian recognizer.
 *
 * The Host spawns this file with the validated configuration and verified model paths as one
 * JSON argument in `argv[2]`, and the bearer secret in `DSH_SPEECH_TOKEN`. On startup the
 * process loads the native `sherpa-onnx-node` recognizer (GigaAM-v3 NeMo CTC or Whisper) and
 * the Silero VAD, binds an ephemeral loopback listener, then prints exactly one line,
 * `{"port":N}`, as its only stdout output. A failure before readiness writes only its message
 * to stderr, which the Host includes in the preparation error, and exits with code 1. After
 * readiness the loopback listener keeps the process alive until the Host terminates it.
 *
 * Native inference and VAD segmentation stay in this process; the Host never loads the native
 * addon itself. The module is import-safe: `main()` only runs when this file is the entry point,
 * so tests and tooling can import the helpers without a model or a native addon.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SpeechInputError, mapLanguage } from "./language.js";
import { loadNativeModule } from "./native.js";
import { validateWave } from "./wave.js";

//#region lib/types/config.js
/** Worker-side defaults; the Host configuration schema owns the authoritative validation. */
const defaults = {
	threads: 2,
	segmentSeconds: 30,
	vadThreshold: .5,
	minSpeechSeconds: .25,
	minSilenceSeconds: .5,
	vadOnsetPaddingSeconds: .4,
	maxAudioBytes: 4 * 1024 * 1024
};
/** Reject a missing or empty path early, before the native model load. */
function pathField(value, field) {
	if (typeof value !== "string" || value === "") throw new Error(`Speech worker configuration is missing ${field}`);
	return value;
}
/** Read one numeric tuning field, rejecting values the native library would misread. */
function numberField(value, fallback, field, minimum, maximum = Number.POSITIVE_INFINITY) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Speech worker configuration has an invalid ${field}`);
	return value;
}
/** Read one integer tuning field. */
function integerField(value, fallback, field, minimum) {
	if (value === void 0) return fallback;
	if (value !== void 0 && (!Number.isInteger(value) || value < minimum)) throw new Error(`Speech worker configuration has an invalid ${field}`);
	return value;
}
/**
 * Normalize the JSON configuration received from the Host.
 *
 * The Host already validated its configuration schema; this parser re-checks the fields the
 * native layer consumes so a malformed hand-started worker fails with a clear message instead
 * of an addon crash.
 *
 * @param raw - parsed `argv[2]` object, including the verified model paths.
 * @returns engine, model/VAD paths and bounded tuning values.
 */
function normalizeWorkerConfig(raw) {
	if (raw === null || typeof raw !== "object") throw new Error("Speech worker configuration must be an object");
	const engine = raw.engine;
	if (engine !== "gigaam-ctc" && engine !== "whisper") throw new Error(`Unsupported local speech engine: ${String(engine)}`);
	const config = {
		engine,
		threads: integerField(raw.threads, defaults.threads, "threads", 1),
		segmentSeconds: numberField(raw.segmentSeconds, defaults.segmentSeconds, "segmentSeconds", 1, 120),
		vadThreshold: numberField(raw.vadThreshold, defaults.vadThreshold, "vadThreshold", 0, 1),
		minSpeechSeconds: numberField(raw.minSpeechSeconds, defaults.minSpeechSeconds, "minSpeechSeconds", 0),
		minSilenceSeconds: numberField(raw.minSilenceSeconds, defaults.minSilenceSeconds, "minSilenceSeconds", .01),
		vadOnsetPaddingSeconds: numberField(raw.vadOnsetPaddingSeconds, defaults.vadOnsetPaddingSeconds, "vadOnsetPaddingSeconds", 0, 1),
		maxAudioBytes: integerField(raw.maxAudioBytes, defaults.maxAudioBytes, "maxAudioBytes", 46),
		tokens: pathField(raw.tokens, "tokens"),
		vad: pathField(raw.vad, "vad")
	};
	if (engine === "whisper") {
		config.encoder = pathField(raw.encoder, "encoder");
		config.decoder = pathField(raw.decoder, "decoder");
	} else config.model = pathField(raw.model, "model");
	return config;
}
//#endregion

//#region lib/types/inference.js
/**
 * sherpa-onnx aborts the whole process (SIGABRT, "Invalid input shape: {0}") when `decode()`
 * receives fewer than 160 samples; 160 samples (10 ms at 16 kHz) is the measured safe minimum.
 */
const MIN_DECODE_SAMPLES = 160;

/**
 * Predicate for the native decoder's minimum input length.
 * @param sampleCount - number of Float32 samples about to be decoded or flushed through VAD.
 * @returns whether sherpa-onnx can decode this waveform without aborting.
 */
function canDecode(sampleCount) {
	return Number.isInteger(sampleCount) && sampleCount >= MIN_DECODE_SAMPLES;
}
/**
 * Build the sherpa-onnx offline recognizer configuration for one engine.
 *
 * - `gigaam-ctc` loads the exported GigaAM-v3 model through the NeMo CTC slot. That model
 *   has no language option (it is Russian only), so no hint is forwarded.
 * - `whisper` loads the multilingual Whisper encoder/decoder; the language hint is `ru`,
 *   `en`, or `""` for auto-detect (sherpa-onnx aborts on the literal `"auto"`).
 *
 * @param config - normalized worker configuration.
 * @param languageHint - native language hint, applied by Whisper and ignored by NeMo CTC.
 * @returns the exact object passed to `new sherpa.OfflineRecognizer(...)`.
 * @throws {SpeechInputError} if the literal `"auto"` ever reaches the native configuration.
 */
function buildNativeConfig(config, languageHint = "") {
	if (languageHint === "auto") throw new SpeechInputError("The literal \"auto\" language must not reach sherpa-onnx");
	const modelConfig = config.engine === "whisper" ? {
		whisper: {
			encoder: config.encoder,
			decoder: config.decoder,
			language: languageHint,
			task: "transcribe",
			tailPaddings: -1
		},
		tokens: config.tokens,
		numThreads: config.threads,
		provider: "cpu",
		debug: 0
	} : {
		nemoCtc: { model: config.model },
		tokens: config.tokens,
		numThreads: config.threads,
		provider: "cpu",
		debug: 0
	};
	return {
		featConfig: {
			sampleRate: 16e3,
			featureDim: 80
		},
		modelConfig
	};
}
/**
 * Validate a recording before touching the native recognizer.
 * @param config - normalized worker configuration.
 * @param audio - untrusted WAV request bytes.
 * @param language - requested provider language hint.
 * @returns validated audio duration in seconds; invalid inputs throw SpeechInputError.
 */
function validateInput(config, audio, language) {
	mapLanguage(config.engine, language);
	if (audio.byteLength > config.maxAudioBytes) throw new SpeechInputError("Speech audio exceeds the worker byte limit");
	try {
		return validateWave(audio, config.maxAudioBytes / 32e3);
	} catch (error) {
		throw new SpeechInputError("Invalid speech WAV", { cause: error });
	}
}
/**
 * Load one native model set; every recording resets VAD and updates its language hint.
 *
 * Silero VAD segments the recording exactly like the shipped SenseVoice worker: audio is fed
 * in 512-sample chunks, completed segments are drained and decoded synchronously, and the
 * first segment regains the configured onset padding from the raw recording.
 *
 * @param config - verified ONNX paths and explicit CPU/VAD limits.
 * @returns synchronous inference confined to its dedicated process.
 */
function createTranscriber(config) {
	const sherpa = loadNativeModule();
	const nativeConfig = buildNativeConfig(config);
	const recognizer = new sherpa.OfflineRecognizer(nativeConfig);
	const detector = new sherpa.Vad({
		sileroVad: {
			model: config.vad,
			threshold: config.vadThreshold,
			minSilenceDuration: config.minSilenceSeconds,
			minSpeechDuration: config.minSpeechSeconds,
			maxSpeechDuration: config.segmentSeconds,
			windowSize: 512
		},
		sampleRate: 16e3,
		numThreads: config.threads,
		provider: "cpu",
		debug: 0
	}, config.segmentSeconds + config.minSilenceSeconds + 1);
	return (audio, language) => {
		const audioSeconds = validateInput(config, audio, language);
		const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
		const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);
		// A recording shorter than the native decoder minimum is safe to answer without decoding.
		if (!canDecode(samples.length)) return {
			text: "",
			audioSeconds,
			inferenceSeconds: 0
		};
		if (config.engine === "whisper") {
			const nativeLanguage = mapLanguage(config.engine, language);
			if (nativeLanguage === "auto") throw new SpeechInputError("The literal \"auto\" language must not reach sherpa-onnx");
			nativeConfig.modelConfig.whisper.language = nativeLanguage;
			recognizer.setConfig(nativeConfig);
		}
		detector.reset();
		const started = performance.now(), texts = [];
		const onsetPadding = Math.round(config.vadOnsetPaddingSeconds * 16e3);
		let isFirstSegment = true;
		const drain = () => {
			while (!detector.isEmpty()) {
				const segment = detector.front(false);
				let speech = segment.samples;
				if (isFirstSegment) {
					isFirstSegment = false;
					const from = Math.max(0, segment.start - onsetPadding);
					if (from < segment.start) {
						const restored = new Float32Array(segment.start - from + speech.length);
						restored.set(samples.subarray(from, segment.start));
						restored.set(speech, segment.start - from);
						speech = restored;
					}
				}
				// A decoded waveform shorter than 160 samples aborts sherpa-onnx; drop such fragments.
				if (!canDecode(speech.length)) {
					detector.pop();
					continue;
				}
				const stream = recognizer.createStream();
				stream.acceptWaveform({
					sampleRate: 16e3,
					samples: speech
				});
				recognizer.decode(stream);
				texts.push(recognizer.getResult(stream).text.trim());
				detector.pop();
			}
		};
		for (let offset = 0; offset < samples.length; offset += 512) {
			detector.acceptWaveform(samples.subarray(offset, offset + 512));
			drain();
		}
		detector.flush();
		drain();
		return {
			text: texts.filter(Boolean).join(" ").trim(),
			audioSeconds,
			inferenceSeconds: (performance.now() - started) / 1e3
		};
	};
}
//#endregion

//#region lib/types/process-server.js
/** Authenticated loopback transport for one serial native recognizer. */
/**
 * Bind an ephemeral loopback listener; model loading completes before readiness is published.
 * @param token - private per-process authentication secret.
 * @param maxAudioBytes - maximum retained request bytes.
 * @param transcribe - synchronous inference owned by this process.
 * @returns the listening server and its dynamically assigned port.
 */
async function startRecognitionServer(token, maxAudioBytes, transcribe) {
	const expected = Buffer.from(`Bearer ${token}`);
	const server = createServer((request, response) => {
		const reply = (status, value) => {
			response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
		};
		const authorization = Buffer.from(request.headers.authorization ?? "");
		if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
			request.resume();
			reply(401, { error: "Unauthorized" });
			return;
		}
		const url = new URL(request.url, "http://localhost");
		if (request.method !== "POST" || url.pathname !== "/transcribe") {
			request.resume();
			reply(404, { error: "Unknown endpoint" });
			return;
		}
		const length = Number(request.headers["content-length"]);
		if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
			request.resume();
			reply(413, {
				error: "Invalid speech audio size",
				code: "invalid-input"
			});
			return;
		}
		(async () => {
			try {
				const chunks = [];
				for await (const chunk of request) {
					const bytes = chunk;
					chunks.push(bytes);
				}
				reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get("language") ?? "auto"));
			} catch (error) {
				reply(error instanceof SpeechInputError ? 400 : 500, {
					error: error instanceof Error ? error.message : String(error),
					...error instanceof SpeechInputError ? { code: "invalid-input" } : {}
				});
			}
		})();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		server,
		port: server.address().port
	};
}
//#endregion

//#region lib/types/worker.js
/**
 * Worker entry: load the configured native recognizer, listen on loopback, then publish readiness.
 * @returns after `{"port":N}` was written to stdout; the loopback listener keeps the process alive.
 */
async function main() {
	const parsed = JSON.parse(process.argv[2] ?? "");
	const config = normalizeWorkerConfig(parsed);
	const token = typeof process.env.DSH_SPEECH_TOKEN === "string" ? process.env.DSH_SPEECH_TOKEN : "";
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid speech worker authentication token");
	delete process.env.DSH_SPEECH_TOKEN;
	const { port } = await startRecognitionServer(token, config.maxAudioBytes, createTranscriber(config));
	process.stdout.write(`${JSON.stringify({ port })}\n`);
}
//#endregion

/** Only run the server when this file is the process entry point, not when imported by tests. */
const entry = process.argv[1];
if (entry !== void 0 && pathToFileURL(resolve(entry)).href === import.meta.url) main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => {
		process.exit(1);
	});
});

export { MIN_DECODE_SAMPLES, buildNativeConfig, canDecode, createTranscriber, main, normalizeWorkerConfig, startRecognitionServer, validateInput };
