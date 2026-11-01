/**
 * Language and engine policy shared by the Host provider and its worker process.
 *
 * This module is intentionally dependency-free so it can be imported by the recognition
 * subprocess as well as unit-tested with plain Node.
 */

/** Engine identifiers accepted by the provider configuration. */
export const engines = ["gigaam-ctc", "whisper"];

/** Every language hint the plugin understands, in selector order (`ru` first). */
export const languages = ["ru", "en", "auto"];

/** A request rejected before native inference; the loaded worker remains reusable. */
export class SpeechInputError extends Error {}

/**
 * Languages advertised for one engine.
 *
 * The registry validates the selected language against the provider's advertised list, so the
 * service default `auto` is always included. GigaAM-v3 advertises only `ru` and `auto` because
 * its English support is partial; Whisper additionally advertises `en`.
 *
 * @param engine - configured engine id.
 * @returns advertised language hints in selector order.
 */
export function languagesForEngine(engine) {
	if (engine === "gigaam-ctc") return ["ru", "auto"];
	if (engine === "whisper") return ["ru", "en", "auto"];
	throw new Error(`Unsupported local speech engine: ${engine}`);
}

/**
 * Map a provider language hint to the value the native engine expects.
 *
 * - `gigaam-ctc`: GigaAM-v3 is a Russian NeMo CTC model whose sherpa-onnx config has no language
 *   option; the hint is accepted but not forwarded (`""`).
 * - `whisper`: multilingual Whisper takes the language code directly, and auto-detection is
 *   requested with an empty string — the literal `"auto"` is fatal in sherpa-onnx
 *   ("Invalid language: auto"), so it must never reach the native layer.
 *
 * @param engine - configured engine id.
 * @param requested - provider-level language hint (`ru`, `en`, or `auto`).
 * @returns native language hint; `""` means "engine default / auto-detect".
 * @throws {SpeechInputError} when the provider does not understand the requested language.
 */
export function mapLanguage(engine, requested) {
	if (!languages.includes(requested)) throw new SpeechInputError(`Unsupported speech language: ${requested}`);
	if (engine === "gigaam-ctc") return "";
	if (engine === "whisper") return requested === "auto" ? "" : requested;
	throw new Error(`Unsupported local speech engine: ${engine}`);
}
