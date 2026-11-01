/**
 * Hand-written configuration schema for the Russian speech provider.
 *
 * This package is loaded from an arbitrary directory as a plain ESM module and must not import
 * the application's configuration libraries (`@deepseek-ai/schemastery`, `zod`). This module
 * therefore applies the same defaults, bounds and absolute-path requirements as the shipped
 * SenseVoice provider and throws a descriptive error for every invalid value.
 */

import { isAbsolute } from "node:path";
import { MAX_TIMER_DELAY_MS } from "./deadline.js";

/** Accepted engine identifiers, in selection order. */
export const engines = ["gigaam-ctc", "whisper"];
/** Accepted weight precisions; only verified INT8 assets are pinned in `runtime/assets.json`. */
export const precisions = ["int8", "fp32"];

/** Defaults mirroring the shipped SenseVoice provider, plus the engine choice. */
export const defaults = Object.freeze({
	providerId: "gigaam-ru",
	engine: "gigaam-ctc",
	precision: "int8",
	modelOrigins: Object.freeze(["https://huggingface.co", "https://hf-mirror.com"]),
	modelProbeTimeoutMs: 3e3,
	threads: 2,
	segmentSeconds: 30,
	vadThreshold: .5,
	minSpeechSeconds: .25,
	minSilenceSeconds: .5,
	vadOnsetPaddingSeconds: .4,
	maxAudioBytes: 4 * 1024 * 1024,
	prepareTimeoutMs: 36e5,
	inferenceTimeoutMs: 12e4,
	idleTimeoutMs: 3e5,
	maxPending: 4,
	graceMs: 1e3,
	maxLogBytes: 64 * 1024,
	maxResponseBytes: 128 * 1024,
	progressIntervalMs: 100
});

/** Origin accepted by the model download policy: `http(s)://host` with no path/query/fragment. */
const originPattern = /^https?:\/\/[^/\s?#@]+\/?$/;

function plainObject(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Russian speech configuration must be an object");
	return raw;
}

function stringValue(value, field, fallback) {
	if (value === void 0) {
		if (fallback === void 0) throw new Error(`Russian speech configuration requires ${field}`);
		return fallback;
	}
	if (typeof value !== "string" || value.length === 0) throw new Error(`Russian speech configuration has an invalid ${field}`);
	return value;
}

function enumValue(value, field, allowed, fallback) {
	if (value === void 0) return fallback;
	if (!allowed.includes(value)) throw new Error(`Russian speech configuration has an invalid ${field}: ${String(value)} (expected ${allowed.join(" | ")})`);
	return value;
}

function absolutePath(value, field, fallback) {
	if (value === void 0) {
		if (fallback === void 0) throw new Error(`Russian speech configuration requires ${field}`);
		return fallback;
	}
	if (typeof value !== "string" || value.length === 0) throw new Error(`Russian speech configuration has an invalid ${field}`);
	if (!isAbsolute(value)) throw new Error(`Russian speech paths must be absolute: ${value}`);
	return value;
}

function optionalAbsolutePath(value, field) {
	if (value === void 0) return void 0;
	if (typeof value !== "string" || value.length === 0) throw new Error(`Russian speech configuration has an invalid ${field}`);
	if (!isAbsolute(value)) throw new Error(`Russian speech paths must be absolute: ${value}`);
	return value;
}

function originValue(value, field) {
	if (typeof value !== "string" || !originPattern.test(value)) throw new Error(`Russian speech configuration has an invalid ${field}`);
	return value;
}

function originsValue(value, field) {
	if (value === void 0) return [...defaults.modelOrigins];
	if (!Array.isArray(value) || value.length === 0) throw new Error(`Russian speech configuration has an invalid ${field}`);
	return value.map((origin) => originValue(origin, field));
}

function numberValue(value, field, fallback, minimum, maximum = Number.POSITIVE_INFINITY, integer = false) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Russian speech configuration has an invalid ${field}`);
	if (integer && !Number.isInteger(value)) throw new Error(`Russian speech configuration has an invalid ${field}`);
	if (value < minimum || value > maximum) throw new Error(`Russian speech configuration has an invalid ${field}`);
	return value;
}

/**
 * Validate and normalize the raw plugin configuration.
 *
 * @param raw - configuration object supplied by the profile (may contain `!!js` expansions already evaluated).
 * @returns a complete configuration with defaults applied.
 * @throws {Error} for missing required fields, non-absolute paths, invalid origins or out-of-range values.
 */
export function normalizeConfig(raw) {
	const input = plainObject(raw);
	return {
		providerId: stringValue(input.providerId, "providerId", defaults.providerId),
		engine: enumValue(input.engine, "engine", engines, defaults.engine),
		dataRoot: absolutePath(input.dataRoot, "dataRoot"),
		modelDirectory: optionalAbsolutePath(input.modelDirectory, "modelDirectory"),
		vadModelPath: optionalAbsolutePath(input.vadModelPath, "vadModelPath"),
		precision: enumValue(input.precision, "precision", precisions, defaults.precision),
		modelOrigin: input.modelOrigin === void 0 ? void 0 : originValue(input.modelOrigin, "modelOrigin"),
		modelOrigins: originsValue(input.modelOrigins, "modelOrigins"),
		modelProbeTimeoutMs: numberValue(input.modelProbeTimeoutMs, "modelProbeTimeoutMs", defaults.modelProbeTimeoutMs, 1, MAX_TIMER_DELAY_MS, true),
		threads: numberValue(input.threads, "threads", defaults.threads, 1, Number.POSITIVE_INFINITY, true),
		segmentSeconds: numberValue(input.segmentSeconds, "segmentSeconds", defaults.segmentSeconds, 1, 120),
		vadThreshold: numberValue(input.vadThreshold, "vadThreshold", defaults.vadThreshold, 0, 1),
		minSpeechSeconds: numberValue(input.minSpeechSeconds, "minSpeechSeconds", defaults.minSpeechSeconds, 0),
		minSilenceSeconds: numberValue(input.minSilenceSeconds, "minSilenceSeconds", defaults.minSilenceSeconds, .01),
		vadOnsetPaddingSeconds: numberValue(input.vadOnsetPaddingSeconds, "vadOnsetPaddingSeconds", defaults.vadOnsetPaddingSeconds, 0, 1),
		maxAudioBytes: numberValue(input.maxAudioBytes, "maxAudioBytes", defaults.maxAudioBytes, 46, Number.POSITIVE_INFINITY, true),
		prepareTimeoutMs: numberValue(input.prepareTimeoutMs, "prepareTimeoutMs", defaults.prepareTimeoutMs, 1, MAX_TIMER_DELAY_MS, true),
		inferenceTimeoutMs: numberValue(input.inferenceTimeoutMs, "inferenceTimeoutMs", defaults.inferenceTimeoutMs, 1, MAX_TIMER_DELAY_MS, true),
		idleTimeoutMs: numberValue(input.idleTimeoutMs, "idleTimeoutMs", defaults.idleTimeoutMs, 0, MAX_TIMER_DELAY_MS, true),
		maxPending: numberValue(input.maxPending, "maxPending", defaults.maxPending, 1, Number.POSITIVE_INFINITY, true),
		graceMs: numberValue(input.graceMs, "graceMs", defaults.graceMs, 1, MAX_TIMER_DELAY_MS, true),
		maxLogBytes: numberValue(input.maxLogBytes, "maxLogBytes", defaults.maxLogBytes, 1, Number.POSITIVE_INFINITY, true),
		maxResponseBytes: numberValue(input.maxResponseBytes, "maxResponseBytes", defaults.maxResponseBytes, 1, Number.POSITIVE_INFINITY, true),
		progressIntervalMs: numberValue(input.progressIntervalMs, "progressIntervalMs", defaults.progressIntervalMs, 1, MAX_TIMER_DELAY_MS, true)
	};
}
