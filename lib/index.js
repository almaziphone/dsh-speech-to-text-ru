/**
 * Local Russian speech-to-text provider for DeepSeek Harness.
 *
 * Registers a second `speechToText` provider (`gigaam-ru` by default) that runs entirely on
 * the Host machine. The architecture mirrors the shipped SenseVoice provider:
 *
 * - activation inspects the model cache but performs no downloads and no model loading;
 * - explicit preparation downloads revision-pinned ONNX assets, verifies size/SHA-256 and
 *   starts one managed Node subprocess worker;
 * - the worker owns the native `sherpa-onnx-node` recognizer, Silero VAD segmentation and
 *   an authenticated loopback HTTP endpoint; the Host owns the request queue, deadlines,
 *   cancellation and idle reclamation.
 *
 * Engines: GigaAM-v3 e2e CTC (NeMo CTC, Russian) by default, Whisper Small (multilingual) as
 * a fallback. Model files are pinned in `runtime/assets.json`.
 *
 * This package is plain, self-contained ESM: it is loaded from an arbitrary directory by a
 * profile patch (a `file://` module URL) and imports only Node builtins and its own files. The
 * native runtime is resolved from the plugin's own `node_modules` first, then from the app
 * bundle (see `lib/native.js`).
 */

import { isAbsolute, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { TimeoutReason, deadline, timeoutOf } from "./deadline.js";
import { normalizeConfig } from "./config.js";
import { SpeechInputError, languagesForEngine } from "./language.js";
import { resolveNativeModule } from "./native.js";

//#region lib/types/download-error.js
const codes = [
	["dns", /^(ENOTFOUND|EAI_AGAIN)$/],
	["timeout", /^(ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/],
	["certificate", /^(CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/],
	["storage", /^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/],
	["network", /^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/]
];
/**
 * Inspect native fetch causes, including aggregate connection attempts, without publishing their messages.
 * @param failure - error received from the network or filesystem.
 * @returns an actionable category and recognized diagnostic code, or a generic failure.
 */
function classifyDownloadFailure(failure) {
	const pending = [failure], visited = /* @__PURE__ */ new Set();
	let reason = "unknown";
	while (pending.length > 0) {
		const error = pending.shift();
		if (!(error instanceof Error) || visited.has(error)) continue;
		visited.add(error);
		if (error instanceof TimeoutReason || error.name === "TimeoutError") return { reason: "timeout" };
		if ("code" in error && typeof error.code === "string") {
			for (const [kind, pattern] of codes) if (pattern.test(error.code)) return {
				reason: kind,
				code: error.code
			};
		}
		if (error instanceof TypeError && error.message === "fetch failed") reason = "network";
		pending.push(error.cause);
		if (error instanceof AggregateError) {
			const causes = error.errors;
			pending.push(...causes);
		}
	}
	return { reason };
}
/** A preparation error whose public details exclude raw causes, credentials, signed URLs and local paths. */
var SpeechDownloadError = class extends Error {
	download;
	constructor(download, options) {
		super(`Unable to prepare ${download.resource} from ${download.source}: ${download.reason}${download.code ? ` (${download.code})` : ""}${download.status === void 0 ? "" : ` (HTTP ${download.status})`}`, options);
		this.download = download;
	}
};
//#endregion

//#region lib/types/model-sources.js
/**
 * Prefer the first successful HEAD response while retaining other sources for download fallback.
 * All probes settle before returning; if every probe fails, the configured order is preserved.
 * @param assetUrl - revision-pinned upstream file URL.
 * @param origins - nonempty configured origins, or one explicit deployment origin.
 * @param timeoutMs - maximum probe duration, including redirects.
 * @param signal - preparation cancellation or deadline.
 * @returns deduplicated download URLs with the first responding source first; a single source needs no probe.
 */
async function orderModelSources(assetUrl, origins, timeoutMs, signal) {
	signal.throwIfAborted();
	const path = new URL(assetUrl).pathname;
	const urls = [...new Set(origins.map((origin) => new URL(path, origin).href))];
	if (urls.length === 1) return urls;
	const finished = new AbortController();
	const timeout = deadline(signal, timeoutMs, "SPEECH_SOURCE_PROBE_TIMEOUT");
	try {
		const probing = AbortSignal.any([timeout.signal, finished.signal]);
		const requests = urls.map(async (url) => ({
			url,
			response: await fetch(url, {
				method: "HEAD",
				signal: probing
			})
		}));
		let preferred;
		try {
			preferred = await Promise.any(requests.map(async (request) => {
				const { url, response } = await request;
				if (!response.ok) throw new Error(`Model source probe returned HTTP ${response.status}`);
				return url;
			}));
		} catch (_unavailableSources) {} finally {
			finished.abort();
			const settled = await Promise.allSettled(requests);
			await Promise.allSettled(settled.map(async (result) => {
				if (result.status === "fulfilled") await result.value.response.body?.cancel();
			}));
		}
		signal.throwIfAborted();
		return preferred === void 0 ? urls : [preferred, ...urls.filter((url) => url !== preferred)];
	} finally {
		timeout.dispose();
	}
}
//#endregion

//#region lib/types/runtime.js
/** Verified runtime assets and managed model preparation for local Russian transcription. */
const platforms = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-x64"
];
/** Read the pinned asset manifest shipped with this package (works from any install directory). */
function readAssets() {
	return JSON.parse(readFileSync(new URL("../runtime/assets.json", import.meta.url), "utf8"));
}
/**
 * Select the pinned asset set for one engine/precision pair.
 * @param engine - engine manifest from `runtime/assets.json`.
 * @param precision - requested numeric precision.
 * @returns asset records keyed by file role (`model`, `encoder`, `decoder`, `tokens`).
 * @throws when the manifest carries no verified assets for that precision.
 */
function engineAssets(engine, precision) {
	const assets = engine.precisions[precision];
	if (assets === void 0) throw new Error(`Local speech engine ${engine.kind} has no pinned ${precision} model assets`);
	return assets;
}
/**
 * Resolve the pinned native runtime and model paths for the configured engine.
 * @param config - model paths, engine, precision and data root.
 * @returns asset manifest, engine manifest, selected assets, cache root and absolute paths.
 */
function resolveRuntime(config) {
	if (!platforms.includes(`${process.platform}-${process.arch}`)) throw new Error(`Local speech is unavailable for ${process.platform}-${process.arch}`);
	const lock = readAssets();
	const engine = lock.providers[config.engine];
	if (engine === void 0) throw new Error(`Unknown local speech engine: ${config.engine}`);
	const assets = engineAssets(engine, config.precision);
	const modelRoot = config.modelDirectory ?? join(config.dataRoot, "models", engine.directory);
	const paths = {
		vad: config.vadModelPath ?? join(config.dataRoot, "models", "silero", lock.vad.name),
		worker: fileURLToPath(new URL("./worker.js", import.meta.url))
	};
	for (const [kind, asset] of Object.entries(assets)) paths[kind] = join(modelRoot, asset.name);
	return { lock, engine, assets, modelRoot, paths };
}
async function matchesAsset(path, asset, signal) {
	signal.throwIfAborted();
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`Speech asset is not a regular file: ${path}`);
		if (info.size !== asset.bytes) return false;
		const digest = createHash("sha256");
		for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
		return digest.digest("hex") === asset.sha256;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
}
/**
 * Verify every engine file plus the VAD model; explicit user paths are trusted and skipped.
 * @param config - model paths and selected engine.
 * @param runtime - resolved manifest and paths.
 * @param signal - preparation cancellation or deadline.
 * @returns whether all managed assets exist and match their pinned identity.
 */
async function verifyRuntime(config, runtime, signal) {
	signal.throwIfAborted();
	const managed = Object.keys(runtime.assets).map((kind) => runtime.paths[kind]);
	try {
		await Promise.all([...managed, runtime.paths.vad].map((path) => access(path)));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
	const verified = [
		...config.modelDirectory === void 0 ? Object.entries(runtime.assets).map(([kind, asset]) => [runtime.paths[kind], asset]) : [],
		...config.vadModelPath === void 0 ? [[runtime.paths.vad, runtime.lock.vad]] : []
	];
	for (const [path, asset] of verified) if (!await matchesAsset(path, asset, signal)) return false;
	signal.throwIfAborted();
	return true;
}
/**
* Inspect existing models without downloading, writing files or starting the worker.
* @param config - model paths and selected engine.
* @param signal - provider cancellation or inspection deadline.
* @returns cached paths when all files exist and managed assets match their pinned size and hash; otherwise undefined.
*/
async function inspectRuntime(config, signal) {
	const runtime = resolveRuntime(config);
	return await verifyRuntime(config, runtime, signal) ? runtime.paths : void 0;
}
/**
 * Download into a unique partial file, verify, then publish it atomically.
 * @param asset - pinned release identity.
 * @param root - provider-owned cache directory.
 * @param signal - preparation cancellation.
 * @param report - Host-owned progress publisher.
 * @returns verified local file path; failures carry localized-UI diagnostics through SpeechDownloadError.
 */
async function downloadAsset(asset, root, signal, report = () => {}) {
	signal.throwIfAborted();
	const destination = join(root, asset.name);
	const partial = `${destination}.${randomUUID()}.part`;
	let source = new URL(asset.url).origin;
	try {
		await mkdir(root, { recursive: true });
		if (await matchesAsset(destination, asset, signal)) return destination;
		try {
			const response = await fetch(asset.url, { signal });
			source = new URL(response.url || asset.url).origin;
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new SpeechDownloadError({
					resource: asset.name,
					source,
					reason: "http",
					status: response.status
				});
			}
			const digest = createHash("sha256");
			let completedBytes = 0;
			const publish = () => {
				report({
					phase: "downloading",
					resource: asset.name,
					completedBytes,
					totalBytes: asset.bytes
				});
			};
			publish();
			const hashing = new Transform({ transform(chunk, _encoding, callback) {
				completedBytes += chunk.length;
				if (completedBytes > asset.bytes) {
					callback(new SpeechDownloadError({
						resource: asset.name,
						source,
						reason: "integrity"
					}));
					return;
				}
				digest.update(chunk);
				publish();
				callback(null, chunk);
			} });
			await pipeline(response.body, hashing, createWriteStream(partial, {
				flags: "wx",
				mode: 384
			}), { signal });
			if (completedBytes !== asset.bytes || digest.digest("hex") !== asset.sha256) throw new SpeechDownloadError({
				resource: asset.name,
				source,
				reason: "integrity"
			});
			signal.throwIfAborted();
			await rename(partial, destination);
			return destination;
		} finally {
			await rm(partial, { force: true });
		}
	} catch (error) {
		const timedOut = timeoutOf(signal);
		if (signal.aborted && !timedOut || error instanceof SpeechDownloadError) throw error;
		throw new SpeechDownloadError({
			resource: asset.name,
			source,
			...timedOut ? { reason: "timeout" } : classifyDownloadFailure(error)
		}, { cause: error });
	}
}
/**
 * Resolve the bundled native runtime and prepare verified ONNX models on demand.
 * @param _ctx - Host context owning the preparation task.
 * @param config - engine, model paths, precision, and download source policy.
 * @param signal - preparation cancellation or deadline.
 * @param report - Host-owned progress publisher.
 * @returns verified model, VAD and worker paths.
 */
async function prepareRuntime(_ctx, config, signal, report = () => {}) {
	const runtime = resolveRuntime(config);
	const { assets, lock, modelRoot, paths } = runtime;
	const origins = config.modelOrigin === void 0 ? config.modelOrigins : [config.modelOrigin];
	const download = async (asset, root, step) => {
		if (await matchesAsset(join(root, asset.name), asset, signal)) return;
		const urls = await orderModelSources(asset.url, origins, config.modelProbeTimeoutMs, signal);
		for (const [index, url] of urls.entries()) try {
			await downloadAsset({
				...asset,
				url
			}, root, signal, (state) => {
				report({
					...state,
					step
				});
			});
			return;
		} catch (error) {
			if (signal.aborted || !(error instanceof SpeechDownloadError) || error.download.reason === "storage" || error.download.reason === "unknown" || index === urls.length - 1) throw error;
		}
	};
	if (config.modelDirectory === void 0) {
		report({
			phase: "checking",
			step: "model",
			startedAt: Date.now()
		});
		for (const asset of Object.values(assets)) await download(asset, modelRoot, "model");
	}
	if (config.vadModelPath === void 0) {
		report({
			phase: "checking",
			step: "vad",
			startedAt: Date.now()
		});
		await download(lock.vad, join(config.dataRoot, "models", "silero"), "vad");
	}
	report({
		phase: "checking",
		step: "verify",
		startedAt: Date.now()
	});
	if (!await verifyRuntime(config, runtime, signal)) throw new Error("Speech model verification failed: missing or corrupted model files");
	return paths;
}
//#endregion

//#region lib/types/recognizer.js
/** Wait for a cancellable operation without losing ownership of its eventual settlement. */
function waitFor(pending, signal) {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("Speech operation cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}
/**
* Read one bounded worker readiness frame and reject exit before readiness.
* @param handle - newly spawned worker with piped stdout.
* @param limit - maximum readiness bytes.
* @param signal - startup deadline or caller cancellation.
* @returns dynamically allocated loopback port.
*/
async function readReady(handle, limit, signal) {
	if (!handle.stdout) throw new Error("Speech worker stdout is unavailable");
	signal.throwIfAborted();
	const stdout = handle.stdout;
	let text = "";
	const pending = Promise.withResolvers();
	const data = (chunk) => {
		text += chunk.toString("utf8");
		if (Buffer.byteLength(text) > limit) {
			pending.reject(/* @__PURE__ */ new Error("Speech worker readiness exceeded its byte limit"));
			return;
		}
		const end = text.indexOf("\n");
		if (end < 0) return;
		let value;
		try {
			value = JSON.parse(text.slice(0, end));
		} catch (error) {
			pending.reject(new Error("Invalid speech worker readiness", { cause: error }));
			return;
		}
		if (value === null || typeof value !== "object" || Object.keys(value).length !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
			pending.reject(/* @__PURE__ */ new Error("Invalid speech worker readiness"));
			return;
		}
		pending.resolve(value.port);
	};
	stdout.on("data", data);
	stdout.on("error", pending.reject);
	handle.done.then(() => {
		pending.reject(/* @__PURE__ */ new Error(`Speech worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text}`));
	}, pending.reject);
	try {
		return await waitFor(pending.promise, signal);
	} finally {
		stdout.off("data", data);
		stdout.off("error", pending.reject);
		stdout.resume();
	}
}
/**
* Decode a bounded worker HTTP response; malformed worker output fails the request.
* @param response - private authenticated worker response.
* @param limit - maximum bytes retained before JSON parsing.
* @returns validated final transcript; marked input rejections throw SpeechInputError.
*/
async function readTranscript(response, limit) {
	if (!response.body) throw new Error("Speech worker returned no response");
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > limit) throw new Error("Speech transcript exceeded its byte limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!response.ok) {
		if (value === null || typeof value !== "object" || typeof value.error !== "string") throw new Error("Speech worker returned an invalid error response");
		if ((response.status === 400 || response.status === 413) && value.code === "invalid-input") throw new SpeechInputError(value.error);
		throw new Error(value.error);
	}
	if (value === null || typeof value !== "object" || typeof value.text !== "string" || typeof value.audioSeconds !== "number" || !Number.isFinite(value.audioSeconds) || value.audioSeconds < 0 || typeof value.inferenceSeconds !== "number" || !Number.isFinite(value.inferenceSeconds) || value.inferenceSeconds < 0) throw new Error("Speech worker returned an invalid transcript");
	return {
		text: value.text,
		audioSeconds: value.audioSeconds,
		inferenceSeconds: value.inferenceSeconds
	};
}
/** Own one managed Russian recognizer worker across recordings, and join every accepted job on disposal. */
var RuSpeechWorker = class {
	ctx;
	config;
	worker;
	tail = Promise.resolve();
	pending = 0;
	lifetime = new AbortController();
	idle;
	runtime;
	state;
	listeners = /* @__PURE__ */ new Set();
	lastProgressAt = 0;
	/** Configured origins available for explicit downloads; offline deployments expose no choices. */
	downloadSources;
	preparing;
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.downloadSources = config.modelDirectory !== void 0 && config.vadModelPath !== void 0 ? [] : [...new Set((config.modelOrigin === void 0 ? config.modelOrigins : [config.modelOrigin]).map((origin) => new URL(origin).origin))];
		const kinds = ["check"];
		if (config.modelDirectory === void 0) kinds.push("model");
		if (config.vadModelPath === void 0) kinds.push("vad");
		kinds.push("verify", "load");
		this.state = {
			phase: "unprepared",
			steps: kinds.map((kind) => ({
				kind,
				status: "pending"
			}))
		};
	}
	/**
	* Read preparation readiness.
	* @returns the current Host-owned state.
	*/
	snapshot() {
		return this.state;
	}
	/**
	* Observe readiness.
	* @param listener - invalidation callback.
	* @returns subscription disposer.
	*/
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	publish(state) {
		if (this.preparing && [
			"ready",
			"standby",
			"unprepared",
			"failed",
			"cancelled"
		].includes(state.phase)) this.preparing.completed = true;
		const previous = this.state;
		const steps = state.steps ?? previous.steps.map((item) => {
			if (state.phase === "ready") return {
				...item,
				status: "complete"
			};
			if (state.step === "check" && item.kind !== "check") return {
				kind: item.kind,
				status: "pending"
			};
			if (state.step === item.kind) return item.status === "running" ? item : {
				kind: item.kind,
				status: "running",
				startedAt: Date.now()
			};
			if (item.status !== "running") return item;
			if (state.phase === "standby") return {
				...item,
				status: "cancelled"
			};
			if (state.phase === "failed" || state.phase === "cancelled") return {
				...item,
				status: state.phase
			};
			return state.step === void 0 ? item : {
				...item,
				status: "complete"
			};
		});
		this.state = {
			...state,
			steps
		};
		const now = performance.now();
		if (state.phase === "downloading" && previous.phase === "downloading" && state.resource === previous.resource && state.completedBytes !== state.totalBytes && now - this.lastProgressAt < this.config.progressIntervalMs) return;
		this.lastProgressAt = now;
		for (const listener of this.listeners) listener();
	}
	/** Inspect disk caches on activation; valid resources enter standby without starting a worker. */
	inspect() {
		this.runPreparation(async (signal) => {
			const inspection = deadline(signal, this.config.prepareTimeoutMs, "SPEECH_PREPARE_TIMEOUT");
			try {
				this.publish({
					phase: "checking",
					step: "check",
					startedAt: Date.now()
				});
				const runtime = await inspectRuntime(this.config, inspection.signal);
				inspection.signal.throwIfAborted();
				this.runtime = runtime;
				this.publish({
					phase: runtime ? "standby" : "unprepared",
					steps: this.state.steps.map(({ kind }) => ({
						kind,
						status: kind === "check" || runtime && kind !== "load" ? "complete" : "pending"
					}))
				});
			} finally {
				inspection.dispose();
			}
		});
	}
	/**
	* Start or join one Host-owned preparation task with a fixed download source.
	* @param options - omitted source uses deployment policy; a manual source must be advertised and disables fallback.
	*/
	prepare(options = {}) {
		const source = options.downloadSource;
		if (source !== void 0 && !this.downloadSources.includes(source)) throw new Error("Speech download source is unavailable");
		const config = source === void 0 ? this.config : Object.assign({}, this.config, { modelOrigin: source });
		this.runPreparation(async (signal) => {
			await this.start(signal, config);
		}, source);
	}
	runPreparation(run, downloadSource) {
		if (this.preparing && this.preparing.downloadSource !== downloadSource) throw new Error("Cancel preparation before changing its download source");
		if (this.preparing || this.worker) return;
		this.lifetime.signal.throwIfAborted();
		const abort = new AbortController();
		const task = {
			abort,
			settled: Promise.resolve(),
			completed: false,
			downloadSource
		};
		this.preparing = task;
		task.settled = this.enqueue(run, abort.signal).catch((error) => {
			if (this.lifetime.signal.aborted) return;
			this.publish(abort.signal.aborted ? { phase: "cancelled" } : {
				phase: "failed",
				message: error instanceof Error ? error.message : String(error),
				...error instanceof SpeechDownloadError ? { download: error.download } : {}
			});
		}).finally(() => {
			this.preparing = void 0;
		});
	}
	/** Cancel unfinished preparation; completed readiness is retained. @returns after its queued or active work settles. */
	async cancel() {
		const task = this.preparing;
		if (!task) return;
		if (!task.completed) {
			this.publish({
				phase: "cancelling",
				startedAt: Date.now()
			});
			task.abort.abort(/* @__PURE__ */ new Error("Speech preparation cancelled"));
		}
		await task.settled;
	}
	/**
	* Queue one bounded recording; cancellation never leaves inference running after settlement.
	* Verified resources accept recordings while the worker wakes; other preparation states reject without downloading.
	* @param input - complete WAV and language hint.
	* @param signal - caller cancellation.
	* @returns recognized text; cancelled waiting jobs never acquire the worker.
	*/
	async transcribe(input, signal) {
		return await this.enqueue(async (combined) => await this.execute(input, combined), signal);
	}
	async enqueue(run, signal) {
		const combined = AbortSignal.any([signal, this.lifetime.signal]);
		combined.throwIfAborted();
		if (this.pending >= this.config.maxPending) throw new Error("Speech transcription queue is full");
		clearTimeout(this.idle);
		this.pending++;
		const job = this.tail.then(async () => {
			combined.throwIfAborted();
			return await run(combined);
		});
		this.tail = job.then(() => void 0, () => void 0).finally(() => {
			this.pending--;
			if (this.pending === 0 && !this.lifetime.signal.aborted && this.config.idleTimeoutMs > 0) this.idle = setTimeout(() => {
				this.tail = this.tail.then(async () => {
					await this.stop();
				});
				this.tail.catch((error) => {
					this.ctx.logger.warn("Speech worker idle cleanup failed", error);
				});
			}, this.config.idleTimeoutMs);
		});
		return await job;
	}
	async start(signal, preparationConfig = this.config) {
		if (this.worker?.closed) await this.stop();
		if (this.worker) return this.worker;
		const setup = deadline(signal, this.config.prepareTimeoutMs, "SPEECH_PREPARE_TIMEOUT");
		try {
			const cached = this.runtime !== void 0;
			if (!cached) this.publish({
				phase: "checking",
				step: "check",
				startedAt: Date.now()
			});
			const runtime = this.runtime ?? await prepareRuntime(this.ctx, preparationConfig, setup.signal, (state) => {
				this.publish(state);
			});
			this.runtime = runtime;
			setup.signal.throwIfAborted();
			// Fail with an actionable message before spawning when the native runtime is absent.
			resolveNativeModule();
			this.publish({
				phase: cached ? "waking" : "loading",
				step: "load",
				startedAt: Date.now()
			});
			await mkdir(this.config.dataRoot, { recursive: true });
			const token = randomBytes(32).toString("hex");
			const handle = this.ctx.subprocess.spawn({
				argv: [
					process.execPath,
					runtime.worker,
					JSON.stringify(Object.assign({}, this.config, runtime))
				],
				cwd: this.config.dataRoot,
				graceMs: this.config.graceMs,
				env: {
					DSH_SPEECH_TOKEN: token,
					ELECTRON_RUN_AS_NODE: "1"
				},
				stdio: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: { maxBytes: this.config.maxLogBytes }
				}
			});
			try {
				const worker = {
					handle,
					url: `http://127.0.0.1:${await readReady(handle, this.config.maxLogBytes, setup.signal)}`,
					token,
					closed: false
				};
				this.worker = worker;
				this.publish({ phase: "ready" });
				const exited = () => {
					if (!worker.closed) {
						worker.closed = true;
						this.publish({ phase: "standby" });
					}
				};
				handle.done.then(exited, exited);
				return worker;
			} catch (error) {
				handle.terminate();
				await handle.waitForExit();
				throw error;
			}
		} finally {
			setup.dispose();
		}
	}
	async execute(input, signal) {
		const phase = this.state.phase;
		if (phase !== "ready" && phase !== "standby") throw new Error("Prepare the local speech provider before recording");
		try {
			const worker = await this.start(signal);
			const call = deadline(signal, this.config.inferenceTimeoutMs, "SPEECH_INFERENCE_TIMEOUT");
			try {
				const result = await readTranscript(await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(input.language)}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${worker.token}`,
						"content-type": "audio/wav"
					},
					body: Buffer.from(input.audio),
					signal: call.signal
				}), this.config.maxResponseBytes).catch((error) => {
					call.signal.throwIfAborted();
					throw error;
				});
				call.signal.throwIfAborted();
				return result;
			} finally {
				call.dispose();
			}
		} catch (error) {
			if (error instanceof SpeechInputError) throw error;
			await this.stop();
			this.publish({ phase: "standby" });
			throw error;
		}
	}
	async stop() {
		const worker = this.worker;
		if (!worker) return;
		worker.closed = true;
		worker.handle.terminate();
		await worker.handle.waitForExit();
		this.worker = void 0;
		this.publish({ phase: "standby" });
	}
	/** Stop the local recognizer. @returns after admission closes, queued jobs settle, and the managed worker exits. */
	async dispose() {
		this.listeners.clear();
		this.lifetime.abort(/* @__PURE__ */ new Error("Russian speech provider disposed"));
		clearTimeout(this.idle);
		try {
			await this.tail;
		} finally {
			await this.stop();
		}
		await this.preparing?.settled;
	}
};
//#endregion

//#region lib/types/index.js
/** Optional local Russian provider; activation performs no downloads or model loading. */
const name = "speech-to-text-ru";
const inject = ["speechToText", "subprocess"];
/**
 * Public display name for the configured engine.
 * @param config - normalized provider configuration.
 * @returns provider label shown in the voice input selector.
 */
function providerName(config) {
	return `${config.engine === "whisper" ? "Whisper Small" : "GigaAM-v3"} · RU (${config.precision})`;
}
/**
 * Estimated one-time download and resident memory for the configured engine.
 * Values follow the measured GigaAM-v3 INT8 runtime on the reference platform.
 * @returns provider setup estimate shown in the setup dialog.
 */
function setupEstimate() {
	return {
		recommendedDiskBytes: 800 * 1024 * 1024,
		expectedMemoryBytes: 1200 * 1024 * 1024,
		minimumMinutes: 1,
		maximumMinutes: 10
	};
}
/**
 * Register the local Russian recognizer and inspect disk caches without downloading or loading models.
 * @param ctx - Host registry and subprocess owner.
 * @param raw - profile configuration; normalized here because the plugin is loaded from a file path.
 */
function apply(ctx, raw) {
	const config = normalizeConfig(raw);
	const worker = new RuSpeechWorker(ctx, config);
	ctx.effect(() => {
		const unregister = ctx.speechToText.register({
			info: {
				id: config.providerId,
				name: providerName(config),
				location: "host-local",
				languages: languagesForEngine(config.engine),
				downloadSources: worker.downloadSources,
				setupEstimate: setupEstimate()
			},
			preparation: worker,
			transcribe: async (input, signal) => await worker.transcribe(input, signal)
		});
		worker.inspect();
		return async () => {
			const removing = unregister();
			await worker.dispose();
			await removing;
		};
	});
}
//#endregion

export { apply, inject, name };
