/**
 * Local timeout helper for the Russian speech provider.
 *
 * The plugin is loaded from an arbitrary directory as a plain ESM module and must not import
 * anything from the application's `node_modules`, so this file reproduces the small slice of
 * `@deepseek-ai/dsh-timeout` semantics the provider needs: fuse upstream cancellation with a
 * deadline, abort with an identifiable reason, and let callers distinguish a real timeout from
 * caller cancellation.
 */

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2147483647;

/** Internal abort reason carrying a capability-owned code and elapsed deadline. */
export class TimeoutReason extends Error {
	code;
	timeoutMs;
	name = "TimeoutReason";

	/**
	 * @param code - capability-owned timeout code (e.g. `SPEECH_PREPARE_TIMEOUT`).
	 * @param timeoutMs - the deadline that elapsed, in milliseconds.
	 */
	constructor(code, timeoutMs) {
		super(`${code} after ${timeoutMs}ms`);
		this.code = code;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Fuse upstream cancellation with an identifiable timeout.
 *
 * `timeoutMs <= 0` is the internal no-timer sentinel. The returned signal only notifies;
 * callers must stop their own work. The returned disposer clears the timer and is idempotent.
 *
 * @param upstream - caller cancellation signal, if any.
 * @param timeoutMs - deadline in milliseconds; `<= 0` arms no timer.
 * @param code - capability-owned code stamped onto the timeout reason.
 * @returns fused signal and its timer disposer.
 */
export function deadline(upstream, timeoutMs, code) {
	if (timeoutMs <= 0) return {
		signal: upstream ?? new AbortController().signal,
		dispose() {}
	};
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`deadline timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const timer = new AbortController();
	const id = setTimeout(() => {
		timer.abort(new TimeoutReason(code, timeoutMs));
	}, timeoutMs);
	return {
		signal: upstream !== void 0 ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
		dispose() {
			clearTimeout(id);
		}
	};
}

/**
 * Classify an aborted signal.
 * @param signal - possibly-aborted signal.
 * @returns the timeout reason when the abort was a deadline, otherwise undefined.
 */
export function timeoutOf(signal) {
	const reason = signal?.reason;
	return reason instanceof TimeoutReason ? reason : void 0;
}
