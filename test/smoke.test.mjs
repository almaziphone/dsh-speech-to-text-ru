/**
 * Dependency-free smoke test for dsh-speech-to-text-ru.
 *
 * Runs with the bundled Node (no npm install, no native addon, no model files):
 *   <bundled-node> --test test/smoke.test.mjs
 *
 * It checks the package/distribution contract (packed files, publishing metadata, icon and
 * locale dictionaries, packaged bundle patch), the pinned asset manifest, the pure language and
 * configuration policy, the provider registration against a mock Host context, the worker's
 * configuration parsing and native config shapes, and the authenticated loopback transport.
 * Native inference itself is exercised separately with real model files.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { apply, inject, name } from "../lib/index.js";
import { defaults, normalizeConfig } from "../lib/config.js";
import { SpeechInputError, languages, languagesForEngine, mapLanguage } from "../lib/language.js";
import { validateWave } from "../lib/wave.js";
import {
	MIN_DECODE_SAMPLES,
	buildNativeConfig,
	canDecode,
	createTranscriber,
	normalizeWorkerConfig,
	startRecognitionServer,
	validateInput
} from "../lib/worker.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

/** Build a canonical 16 kHz mono PCM16 WAV buffer with `seconds` of silence. */
function canonicalWav(seconds) {
	const samples = Math.round(seconds * 16000);
	const dataBytes = samples * 2;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(16000, 24);
	buffer.writeUInt32LE(32000, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataBytes, 40);
	return buffer;
}

/** Poll a predicate until it holds, so inspection settles without a fixed sleep. */
async function waitFor(predicate, timeoutMs = 5000) {
	const started = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("condition was not met in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const gigaamConfig = {
	engine: "gigaam-ctc",
	model: "/models/model.onnx",
	tokens: "/models/tokens.txt",
	vad: "/models/silero_vad.onnx"
};

test("package contract", async () => {
	const manifest = await readJson("package.json");
	assert.equal(manifest.name, "dsh-speech-to-text-ru");
	assert.equal(manifest.version, "0.1.0");
	assert.equal(manifest.type, "module");
	assert.equal(manifest.main, "lib/index.js");
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.sideEffects, false);
	assert.equal(manifest.icon, "./icon.svg");
	assert.equal(manifest.publishConfig.access, "public");
	assert.deepEqual(manifest.repository, {
		type: "git",
		url: "git+https://github.com/almaziphone/dsh-speech-to-text-ru.git"
	});
	assert.deepEqual(manifest.exports, {
		".": "./lib/index.js",
		"./worker": "./lib/worker.js",
		"./package.json": "./package.json",
		"./icon.svg": "./icon.svg",
		"./locale/*.json": "./locale/*.json"
	});
	assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
	// The only npm dependency is the pinned native runtime; everything else is Node builtins.
	assert.deepEqual(manifest.dependencies, { "sherpa-onnx-node": "1.13.8" });
	assert.deepEqual(manifest.peerDependencies ?? {}, {});
	assert.match(manifest.description, /Russian/);
	assert.ok(manifest.keywords.includes("russian"));
	assert.ok(manifest.keywords.includes("speech-to-text"));
	assert.ok(manifest.keywords.includes("dsh-bundle"));
	// Every runtime file must be packed, including the two modules that used to be missing.
	for (const file of [
		"icon.svg",
		"locale/*.json",
		"lib/index.js",
		"lib/worker.js",
		"lib/config.js",
		"lib/deadline.js",
		"lib/language.js",
		"lib/native.js",
		"lib/wave.js",
		"runtime/assets.json",
		"cordis.patch.yml",
		"README.md"
	]) assert.ok(manifest.files.includes(file), `files must publish ${file}`);
	assert.ok(!manifest.files.some((file) => file.includes("node_modules")), "node_modules must never be packed");
	const runtimeFiles = [
		"icon.svg",
		"locale/en.json",
		"locale/ru.json",
		"lib/index.js",
		"lib/worker.js",
		"lib/config.js",
		"lib/deadline.js",
		"lib/language.js",
		"lib/native.js",
		"lib/wave.js",
		"runtime/assets.json",
		"cordis.patch.yml",
		"README.md"
	];
	for (const file of runtimeFiles) await readFile(join(root, file));
	// Only Node builtins and package-local modules may be imported by plugin code.
	for (const file of await readdir(join(root, "lib"))) {
		const source = await readFile(join(root, "lib", file), "utf8");
		assert.doesNotMatch(source, /from\s+["'](?!\.\/|node:)/, `${file} must not import external packages`);
		assert.doesNotMatch(source, /import\s+["'](?!\.\/|node:)/, `${file} must not import external packages`);
	}
});

test("bundle display metadata", async () => {
	const icon = await readFile(join(root, "icon.svg"), "utf8");
	assert.match(icon, /<svg[^>]*viewBox="0 0 24 24"/);
	assert.match(icon, />RU</);
	const en = await readJson("locale/en.json");
	const ru = await readJson("locale/ru.json");
	assert.deepEqual(Object.keys(en), ["meta"]);
	assert.deepEqual(Object.keys(ru), ["meta"]);
	for (const dictionary of [en, ru]) {
		assert.equal(typeof dictionary.meta.title, "string");
		assert.ok(dictionary.meta.title.length > 0);
		assert.equal(typeof dictionary.meta.description, "string");
		assert.ok(dictionary.meta.description.length > 0);
	}
	assert.match(en.meta.title, /Russian/);
	assert.match(ru.meta.title, /Распознавание речи/);
	assert.match(ru.meta.description, /GigaAM/);
});

test("packaged bundle patch selects the Russian provider", async () => {
	const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
	assert.match(patch, /- insert:/);
	assert.match(patch, /id: speech-to-text-gigaam/);
	// Packaged installs resolve the package by name, never by an absolute/file URL.
	assert.match(patch, /name: 'dsh-speech-to-text-ru'/);
	assert.doesNotMatch(patch, /name:\s+\S*\//);
	assert.match(patch, /dataRoot: !!js dshHomePath\('speech-to-text', 'gigaam-ru'\)/);
	assert.match(patch, /- id: speech-to-text\n  config:\n    defaultProvider: gigaam-ru\n    language: ru/);
});

test("README documents distribution", async () => {
	const readme = await readFile(join(root, "README.md"), "utf8");
	for (const needle of [
		"## Distribution",
		"npm publish --access public",
		"dsh plugin --profile desktop add",
		"github:almaziphone/dsh-speech-to-text-ru",
		"0.2.1-rc.5",
		"322 MB",
		"not** bundled"
	]) assert.ok(readme.includes(needle), `README must document ${needle}`);
});

test("provider module keeps the expected plugin contract", () => {
	assert.equal(name, "speech-to-text-ru");
	assert.deepEqual(inject, ["speechToText", "subprocess"]);
	assert.equal(typeof apply, "function");
});

test("configuration normalization", () => {
	const config = normalizeConfig({ dataRoot: "/tmp/dsh-ru" });
	assert.equal(config.providerId, "gigaam-ru");
	assert.equal(config.engine, "gigaam-ctc");
	assert.equal(config.precision, "int8");
	assert.deepEqual(config.modelOrigins, ["https://huggingface.co", "https://hf-mirror.com"]);
	assert.equal(config.modelOrigin, void 0);
	assert.equal(config.modelDirectory, void 0);
	assert.equal(config.vadModelPath, void 0);
	assert.equal(config.threads, defaults.threads);
	assert.equal(config.segmentSeconds, defaults.segmentSeconds);
	assert.equal(config.vadThreshold, defaults.vadThreshold);
	assert.equal(config.minSpeechSeconds, defaults.minSpeechSeconds);
	assert.equal(config.minSilenceSeconds, defaults.minSilenceSeconds);
	assert.equal(config.vadOnsetPaddingSeconds, defaults.vadOnsetPaddingSeconds);
	assert.equal(config.maxAudioBytes, defaults.maxAudioBytes);
	assert.equal(config.prepareTimeoutMs, defaults.prepareTimeoutMs);
	assert.equal(config.inferenceTimeoutMs, defaults.inferenceTimeoutMs);
	assert.equal(config.idleTimeoutMs, defaults.idleTimeoutMs);
	assert.equal(config.maxPending, defaults.maxPending);
	assert.equal(config.graceMs, defaults.graceMs);
	assert.equal(config.maxLogBytes, defaults.maxLogBytes);
	assert.equal(config.maxResponseBytes, defaults.maxResponseBytes);
	assert.equal(config.progressIntervalMs, defaults.progressIntervalMs);

	const custom = normalizeConfig({
		providerId: "gigaam-ru-test",
		engine: "whisper",
		dataRoot: "/tmp/dsh-ru",
		modelDirectory: "/models",
		vadModelPath: "/vad/silero.onnx",
		precision: "fp32",
		modelOrigin: "https://example.com/",
		modelOrigins: ["https://example.com"],
		threads: 4,
		segmentSeconds: 12,
		vadThreshold: .7,
		maxPending: 2
	});
	assert.equal(custom.providerId, "gigaam-ru-test");
	assert.equal(custom.engine, "whisper");
	assert.equal(custom.modelDirectory, "/models");
	assert.equal(custom.vadModelPath, "/vad/silero.onnx");
	assert.equal(custom.precision, "fp32");
	assert.equal(custom.modelOrigin, "https://example.com/");
	assert.equal(custom.threads, 4);
	assert.equal(custom.segmentSeconds, 12);
	assert.equal(custom.vadThreshold, .7);
	assert.equal(custom.maxPending, 2);

	assert.throws(() => normalizeConfig({}), /requires dataRoot/);
	assert.throws(() => normalizeConfig({ dataRoot: "relative" }), /paths must be absolute/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", modelDirectory: "rel" }), /paths must be absolute/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", engine: "sensevoice" }), /invalid engine/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", precision: "int4" }), /invalid precision/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", modelOrigins: [] }), /invalid modelOrigins/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", modelOrigin: "ftp://example.com" }), /invalid modelOrigin/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", threads: 0 }), /invalid threads/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", segmentSeconds: 500 }), /invalid segmentSeconds/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", vadThreshold: 2 }), /invalid vadThreshold/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", minSilenceSeconds: 0 }), /invalid minSilenceSeconds/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", maxAudioBytes: 10 }), /invalid maxAudioBytes/);
	assert.throws(() => normalizeConfig({ dataRoot: "/tmp/x", idleTimeoutMs: -1 }), /invalid idleTimeoutMs/);
	assert.throws(() => normalizeConfig(null), /must be an object/);
});

test("provider registration against a mock Host context", async (t) => {
	const dataRoot = await mkdtemp(join(tmpdir(), "dsh-ru-"));
	t.after(() => rm(dataRoot, { recursive: true, force: true }));
	const registrations = [];
	const disposers = [];
	const makeContext = () => ({
		speechToText: {
			register(entry) {
				registrations.push(entry);
				return async () => {};
			}
		},
		effect(callback) {
			disposers.push(callback());
		},
		logger: { warn() {} }
	});
	apply(makeContext(), { dataRoot });
	assert.equal(registrations.length, 1);
	const entry = registrations[0];
	assert.equal(entry.info.id, "gigaam-ru");
	assert.equal(entry.info.name, "GigaAM-v3 · RU (int8)");
	assert.equal(entry.info.location, "host-local");
	assert.deepEqual(entry.info.languages, ["ru", "auto"]);
	assert.deepEqual(entry.info.downloadSources, ["https://huggingface.co", "https://hf-mirror.com"]);
	assert.deepEqual(entry.info.setupEstimate, {
		recommendedDiskBytes: 800 * 1024 * 1024,
		expectedMemoryBytes: 1200 * 1024 * 1024,
		minimumMinutes: 1,
		maximumMinutes: 10
	});
	assert.equal(typeof entry.preparation.prepare, "function");
	assert.equal(typeof entry.preparation.cancel, "function");
	assert.equal(typeof entry.transcribe, "function");
	await waitFor(() => entry.preparation.snapshot().steps[0].status === "complete");
	assert.equal(entry.preparation.snapshot().phase, "unprepared");
	await disposers[0]();

	apply(makeContext(), { dataRoot, engine: "whisper" });
	const whisper = registrations.at(-1);
	assert.equal(whisper.info.name, "Whisper Small · RU (int8)");
	assert.deepEqual(whisper.info.languages, ["ru", "en", "auto"]);
	await waitFor(() => whisper.preparation.snapshot().steps[0].status === "complete");
	await disposers.at(-1)();

	assert.throws(() => apply(makeContext(), { dataRoot: "relative" }), /paths must be absolute/);
});

test("pinned assets manifest", async () => {
	const assets = await readJson("runtime/assets.json");
	const hex = /^[a-f0-9]{64}$/;
	const pinned = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/.+$/;
	for (const kind of ["gigaam-ctc", "whisper"]) {
		const engine = assets.providers[kind];
		assert.ok(engine, `missing engine ${kind}`);
		assert.ok(engine.directory.length > 0);
		for (const [role, asset] of Object.entries(engine.precisions.int8)) {
			// GigaAM files are renamed to model.onnx/tokens.txt in the cache; Whisper keeps upstream names.
			if (kind === "whisper") assert.equal(asset.name, asset.url.split("/").at(-1), `${kind}.${role} name must match URL`);
			assert.match(asset.url, pinned, `${kind}.${role} must be revision-pinned`);
			assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
			assert.match(asset.sha256, hex);
		}
	}
	assert.deepEqual(Object.keys(assets.providers["gigaam-ctc"].precisions.int8), ["model", "tokens"]);
	assert.equal(assets.providers["gigaam-ctc"].precisions.int8.model.name, "model.onnx");
	assert.equal(assets.providers["gigaam-ctc"].precisions.int8.tokens.name, "tokens.txt");
	assert.equal(assets.providers["gigaam-ctc"].precisions.int8.model.bytes, 319869121);
	assert.equal(assets.providers["gigaam-ctc"].precisions.int8.tokens.bytes, 2006);
	assert.equal(assets.providers.whisper.precisions.int8.encoder.bytes, 112442483);
	assert.equal(assets.providers.whisper.precisions.int8.decoder.bytes, 262226114);
	assert.equal(assets.providers.whisper.precisions.int8.tokens.bytes, 816730);
	assert.equal(assets.vad.bytes, 1807522);
	assert.equal(assets.vad.sha256, "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28");
	assert.doesNotMatch(JSON.stringify(assets), /TODO|REPLACE|PLACEHOLDER/i);
});

test("language policy is Russian-first and engine aware", () => {
	assert.deepEqual(languages, ["ru", "en", "auto"]);
	assert.deepEqual(languagesForEngine("gigaam-ctc"), ["ru", "auto"]);
	assert.deepEqual(languagesForEngine("whisper"), ["ru", "en", "auto"]);
	assert.throws(() => languagesForEngine("sensevoice"), /Unsupported local speech engine/);
	// GigaAM NeMo CTC has no language option; every advertised hint is accepted and ignored.
	for (const language of languages) assert.equal(mapLanguage("gigaam-ctc", language), "");
	// Whisper auto-detection is the empty language; the literal "auto" is fatal in sherpa-onnx.
	assert.equal(mapLanguage("whisper", "auto"), "");
	assert.equal(mapLanguage("whisper", "ru"), "ru");
	assert.equal(mapLanguage("whisper", "en"), "en");
	assert.throws(() => mapLanguage("gigaam-ctc", "zh"), SpeechInputError);
	assert.throws(() => mapLanguage("whisper", "zh"), SpeechInputError);
	assert.throws(() => mapLanguage("sensevoice", "ru"), /Unsupported local speech engine/);
});

test("worker config parsing", () => {
	const config = normalizeWorkerConfig(gigaamConfig);
	assert.deepEqual(config, {
		engine: "gigaam-ctc",
		threads: 2,
		segmentSeconds: 30,
		vadThreshold: .5,
		minSpeechSeconds: .25,
		minSilenceSeconds: .5,
		vadOnsetPaddingSeconds: .4,
		maxAudioBytes: 4 * 1024 * 1024,
		tokens: "/models/tokens.txt",
		vad: "/models/silero_vad.onnx",
		model: "/models/model.onnx"
	});
	const whisper = normalizeWorkerConfig({
		...gigaamConfig,
		engine: "whisper",
		threads: 4,
		segmentSeconds: 12,
		vadThreshold: .7,
		encoder: "/models/encoder.onnx",
		decoder: "/models/decoder.onnx"
	});
	assert.equal(whisper.threads, 4);
	assert.equal(whisper.segmentSeconds, 12);
	assert.equal(whisper.vadThreshold, .7);
	assert.equal(whisper.encoder, "/models/encoder.onnx");
	assert.equal(whisper.decoder, "/models/decoder.onnx");
	assert.equal(whisper.model, void 0);
	assert.throws(() => normalizeWorkerConfig({ ...gigaamConfig, engine: "sensevoice" }), /Unsupported local speech engine/);
	assert.throws(() => normalizeWorkerConfig({ ...gigaamConfig, model: "" }), /missing model/);
	assert.throws(() => normalizeWorkerConfig({ engine: "whisper", tokens: "t", vad: "v" }), /missing encoder/);
	assert.throws(() => normalizeWorkerConfig({ ...gigaamConfig, threads: 0 }), /invalid threads/);
	assert.throws(() => normalizeWorkerConfig({ ...gigaamConfig, vadThreshold: 2 }), /invalid vadThreshold/);
	assert.throws(() => normalizeWorkerConfig({ ...gigaamConfig, segmentSeconds: 0 }), /invalid segmentSeconds/);
	assert.throws(() => normalizeWorkerConfig(null), /must be an object/);
});

test("native recognizer configuration", () => {
	const gigaam = buildNativeConfig(normalizeWorkerConfig(gigaamConfig));
	assert.deepEqual(gigaam.featConfig, { sampleRate: 16000, featureDim: 80 });
	assert.deepEqual(gigaam.modelConfig.nemoCtc, { model: "/models/model.onnx" });
	assert.equal(gigaam.modelConfig.tokens, "/models/tokens.txt");
	assert.equal(gigaam.modelConfig.numThreads, 2);
	assert.equal(gigaam.modelConfig.provider, "cpu");
	assert.equal(gigaam.modelConfig.debug, 0);
	assert.equal(gigaam.modelConfig.whisper, void 0);
	const whisper = buildNativeConfig(normalizeWorkerConfig({
		...gigaamConfig,
		engine: "whisper",
		encoder: "/models/encoder.onnx",
		decoder: "/models/decoder.onnx"
	}), "ru");
	assert.deepEqual(whisper.modelConfig.whisper, {
		encoder: "/models/encoder.onnx",
		decoder: "/models/decoder.onnx",
		language: "ru",
		task: "transcribe",
		tailPaddings: -1
	});
	assert.equal(whisper.modelConfig.nemoCtc, void 0);
	assert.equal(buildNativeConfig(normalizeWorkerConfig({
		...gigaamConfig,
		engine: "whisper",
		encoder: "e",
		decoder: "d"
	})).modelConfig.whisper.language, "");
	// Defensive: the literal "auto" is fatal in sherpa-onnx and must never be forwarded.
	assert.throws(() => buildNativeConfig(normalizeWorkerConfig(gigaamConfig), "auto"), SpeechInputError);
	assert.throws(() => buildNativeConfig(normalizeWorkerConfig({
		...gigaamConfig,
		engine: "whisper",
		encoder: "e",
		decoder: "d"
	}), "auto"), SpeechInputError);
});

test("decode length guard protects the native process", () => {
	assert.equal(MIN_DECODE_SAMPLES, 160);
	assert.equal(canDecode(160), true);
	assert.equal(canDecode(161), true);
	assert.equal(canDecode(0), false);
	assert.equal(canDecode(1), false);
	assert.equal(canDecode(16), false);
	assert.equal(canDecode(159), false);
	assert.equal(canDecode(15.5), false);
	assert.equal(canDecode(Number.NaN), false);
});

test("WAV validation and language gating", () => {
	const config = normalizeWorkerConfig(gigaamConfig);
	const audio = canonicalWav(1.5);
	assert.equal(validateWave(audio, 120), 1.5);
	assert.equal(validateInput(config, audio, "ru"), 1.5);
	assert.equal(validateInput(config, audio, "auto"), 1.5);
	assert.throws(() => validateInput(config, audio, "zh"), SpeechInputError);
	assert.throws(() => validateInput(config, audio.subarray(0, 44), "ru"), SpeechInputError);
	assert.throws(() => validateInput({ ...config, maxAudioBytes: 100 }, canonicalWav(1.5), "ru"), SpeechInputError);
	assert.throws(() => validateWave(Buffer.from("not a wav"), 10), /canonical 16 kHz mono PCM16 WAV/);
});

test("worker module exports do not require a model or native addon", () => {
	assert.equal(typeof createTranscriber, "function");
	for (const fn of [buildNativeConfig, normalizeWorkerConfig, startRecognitionServer, validateInput]) {
		assert.equal(typeof fn, "function");
	}
	// Importing the worker must not start the HTTP server or run its entry point.
	assert.equal(typeof process.argv[1], "string");
	assert.doesNotMatch(process.argv[1], /lib\/worker\.js$/);
});

test("authenticated loopback transport", async (t) => {
	const token = "a".repeat(64);
	const { server, port } = await startRecognitionServer(token, 20000, (audio, language) => ({
		text: `ok:${language}:${Math.round(validateInput(normalizeWorkerConfig({ ...gigaamConfig, maxAudioBytes: 4 * 1024 * 1024 }), audio, language) * 1000)}`,
		audioSeconds: 1,
		inferenceSeconds: .01
	}));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `http://127.0.0.1:${port}/transcribe?language=ru`;
	const headers = { authorization: `Bearer ${token}`, "content-type": "audio/wav" };

	const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: canonicalWav(.5) });
	assert.equal(unauthorized.status, 401);
	assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });

	const accepted = await fetch(url, { method: "POST", headers, body: canonicalWav(.5) });
	assert.equal(accepted.status, 200);
	assert.equal((await accepted.json()).text, "ok:ru:500");

	const invalidLanguage = await fetch(`http://127.0.0.1:${port}/transcribe?language=zh`, {
		method: "POST",
		headers,
		body: canonicalWav(.5)
	});
	assert.equal(invalidLanguage.status, 400);
	assert.equal((await invalidLanguage.json()).code, "invalid-input");

	const tooLarge = await fetch(url, { method: "POST", headers, body: Buffer.alloc(20001) });
	assert.equal(tooLarge.status, 413);

	const wrongMethod = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
	assert.equal(wrongMethod.status, 404);
});
