import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "./utilities.ts";

async function runnerWith(factory: (pi: ExtensionAPI) => void) {
	const result = await createTestExtensionsResult([{ name: "observer", factory }]);
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner(
		result.extensions,
		result.runtime,
		process.cwd(),
		SessionManager.inMemory(),
		modelRegistry,
	);
}

describe("transcript window observer registration", () => {
	it("accepts transcript windows only when the observer registration declares them", async () => {
		const legacy = await runnerWith((pi) => pi.registerMessageRenderProjectionObserverV1(() => {}));
		const declared = await runnerWith((pi) =>
			pi.registerMessageRenderProjectionObserverV1(() => {}, { transcriptWindows: true }),
		);

		expect([legacy.acceptsTranscriptWindowsV1(), declared.acceptsTranscriptWindowsV1()]).toEqual([false, true]);
		expect(legacy.getMessageRenderProjectionObserversV1()).toHaveLength(1);
	});

	it("removes the declaration with its invalidated runner", async () => {
		const runner = await runnerWith((pi) =>
			pi.registerMessageRenderProjectionObserverV1(() => {}, { transcriptWindows: true }),
		);

		runner.invalidate();

		expect(runner.acceptsTranscriptWindowsV1()).toBe(false);
	});
});
