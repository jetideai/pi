import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, MessageRenderSourcePointV1 } from "../src/core/extensions/index.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import type { ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "./utilities.ts";

async function runnerWith(legacy: MessageRenderSourcePointV1[], optedIn: MessageRenderSourcePointV1[]) {
	const result = await createTestExtensionsResult([
		{
			name: "legacy",
			factory: (pi: ExtensionAPI) =>
				pi.registerMessageRenderSourcePointDecoratorV1((point) => {
					legacy.push({ ...point });
					return undefined;
				}),
		},
		{
			name: "opted-in",
			factory: (pi: ExtensionAPI) =>
				pi.registerMessageRenderSourcePointDecoratorV1(
					(point) => {
						optedIn.push({ ...point });
						return undefined;
					},
					{ callSourcePoints: true },
				),
		},
	]);
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner(
		result.extensions,
		result.runtime,
		process.cwd(),
		SessionManager.inMemory(),
		modelRegistry,
	);
}

function renderBash(decorators: ReturnType<ExtensionRunner["getMessageRenderSourcePointDecoratorsV1"]>, text: string) {
	const component = new ToolExecutionComponent(
		"bash",
		"tool-bash",
		{ command: text },
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			sourcePointDecoratorsV1: decorators,
		},
		withBuiltInRenderers("bash", createBashToolDefinition(process.cwd()) as unknown as ToolRenderers),
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.setExpanded(true);
	component.updateResult({ content: [{ type: "text", text }], isError: false });
	component.render(80);
}

describe("source point decorator registration", () => {
	beforeAll(() => initTheme("dark"));

	it("gives a legacy registration only untagged points and an opted-in registration both sources", async () => {
		const legacy: MessageRenderSourcePointV1[] = [];
		const optedIn: MessageRenderSourcePointV1[] = [];
		const runner = await runnerWith(legacy, optedIn);

		renderBash(runner.getMessageRenderSourcePointDecoratorsV1(), "echo same");

		expect(legacy.length).toBeGreaterThan(0);
		expect(legacy.every((point) => point.sourcePart === undefined)).toBe(true);
		expect(optedIn.some((point) => point.sourcePart === "call")).toBe(true);
		expect(optedIn.filter((point) => point.sourcePart === undefined)).toEqual(legacy);
	});

	it("returns the same registered decorators in extension order on every read", async () => {
		const runner = await runnerWith([], []);

		const first = runner.getMessageRenderSourcePointDecoratorsV1();
		const second = runner.getMessageRenderSourcePointDecoratorsV1();

		expect(first).toHaveLength(2);
		expect(second).toEqual(first);
		expect(second.every((decorator, index) => decorator === first[index])).toBe(true);
	});
});
