/**
 * Native `sherpa-onnx-node` resolution for both the Host plugin and its subprocess worker.
 *
 * A profile-installed copy of this plugin has no local `node_modules`, while the running
 * application already ships `sherpa-onnx-node` plus its platform addon inside the app
 * bundle. Resolution therefore tries the normal Node lookup first and then falls back to a
 * `createRequire` rooted at the application's `package.json`. In Electron the `app.asar`
 * path is transparently readable, so no npm install of the native runtime is needed.
 *
 * Importing this module has no side effects; the native addon is only loaded when
 * {@link loadNativeModule} is called from the worker's transcriber factory.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Require root for the copy of the native runtime shipped inside the application bundle.
 * @returns a `require` function, or undefined when not running inside a packaged app.
 */
function bundledRequire() {
	const resourcesPath = process.resourcesPath;
	if (typeof resourcesPath !== "string" || resourcesPath === "") return void 0;
	try {
		return createRequire(join(resourcesPath, "app.asar", "dsh", "package.json"));
	} catch {
		return void 0;
	}
}

/**
 * Resolve a native package from this package or, failing that, from the app bundle.
 * @param specifier - package name, e.g. `sherpa-onnx-node`.
 * @returns the resolved filesystem path.
 * @throws the original Node resolution error when neither location provides the package.
 */
export function resolveNativeModule(specifier = "sherpa-onnx-node") {
	try {
		return createRequire(import.meta.url).resolve(specifier);
	} catch (localError) {
		const bundled = bundledRequire();
		if (bundled === void 0) throw localError;
		try {
			return bundled.resolve(specifier);
		} catch {
			throw localError;
		}
	}
}

/**
 * Load a native package from this package or, failing that, from the app bundle.
 * @param specifier - package name, e.g. `sherpa-onnx-node`.
 * @returns the loaded CommonJS module.
 * @throws the original Node resolution error when neither location provides the package.
 */
export function loadNativeModule(specifier = "sherpa-onnx-node") {
	try {
		return createRequire(import.meta.url)(specifier);
	} catch (localError) {
		const bundled = bundledRequire();
		if (bundled === void 0) throw localError;
		try {
			return bundled(specifier);
		} catch {
			throw localError;
		}
	}
}
