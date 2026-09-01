import { type Component, Container, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type {
	ExactUIPromptEndEvent,
	ExactUIPromptStartEvent,
	ExtensionUIContext,
	UIPromptResponse,
} from "../src/core/extensions/types.ts";
import { createUIPromptId } from "../src/core/extensions/ui-prompt-contract.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ExactPromptEvent = ExactUIPromptStartEvent | ExactUIPromptEndEvent;

interface StandardPromptModePrototype {
	createExtensionUIContext(this: StandardPromptModeState): ExtensionUIContext;
	connectExtensionStandardPromptEvents(
		this: StandardPromptModeState,
		sink: (event: ExactPromptEvent) => Promise<void>,
	): () => void;
	invalidateExtensionStandardPrompt(this: StandardPromptModeState): Promise<void>;
}

interface StandardPromptModeState {
	ui: TUI;
	editor: TestEditor;
	editorContainer: Container;
	keybindings: KeybindingsManager;
	runtimeHost: { session: { settingsManager: { getExternalEditorCommand(): string | undefined } } };
	extensionSelector?: Component;
	extensionInput?: Component;
	extensionEditor?: Component;
	activeExtensionStandardPrompt?: unknown;
	extensionStandardPromptEventSink?: (event: ExactPromptEvent) => Promise<void>;
	disposeActiveSelector(): void;
	toggleToolOutputExpansion(): void;
}

class TestEditor implements Component, Focusable {
	focused = false;
	private text = "";

	handleInput(): void {}
	render(): string[] {
		return ["EDITOR"];
	}
	invalidate(): void {}
	setText(text: string): void {
		this.text = text;
	}
	getText(): string {
		return this.text;
	}
}

function createStandardPromptHarness(
	onEvent?: (event: ExactPromptEvent) => Promise<void> | void,
	disposeActiveSelector: () => void = vi.fn(),
): {
	context: ExtensionUIContext;
	events: ExactPromptEvent[];
	editor: TestEditor;
	getPromptInput: () => { handleInput(data: string): void };
	invalidate: () => Promise<void>;
	close: () => void;
} {
	const terminal = new VirtualTerminal(80, 24);
	const ui: TUI = new TuiMainScreen(terminal);
	const editor = new TestEditor();
	const editorContainer = new Container();
	const state = Object.assign(Object.create(InteractiveMode.prototype), {
		ui,
		editor,
		editorContainer,
		keybindings: new KeybindingsManager(),
		runtimeHost: { session: { settingsManager: { getExternalEditorCommand: () => undefined } } },
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		activeExtensionStandardPrompt: undefined,
		extensionStandardPromptEventSink: undefined,
		disposeActiveSelector,
		toggleToolOutputExpansion: vi.fn(),
	}) as StandardPromptModeState;
	const prototype = InteractiveMode.prototype as unknown as StandardPromptModePrototype;
	const events: ExactPromptEvent[] = [];
	const disconnect = prototype.connectExtensionStandardPromptEvents.call(state, async (event) => {
		events.push(event);
		await onEvent?.(event);
	});

	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	ui.start();

	return {
		context: prototype.createExtensionUIContext.call(state),
		events,
		editor,
		getPromptInput: () => editorContainer.children[0] as { handleInput(data: string): void },
		invalidate: () => prototype.invalidateExtensionStandardPrompt.call(state),
		close: () => {
			disconnect();
			ui.stop();
		},
	};
}

function openStandardPrompt(
	context: ExtensionUIContext,
	kind: "confirm" | "select" | "input" | "editor",
	controller: AbortController,
): Promise<boolean | string | undefined> {
	if (kind === "confirm") return context.confirm("Confirm", "Continue?", { signal: controller.signal, timeout: 1000 });
	if (kind === "select") return context.select("Choose", ["First"], { signal: controller.signal, timeout: 1000 });
	if (kind === "input") return context.input("Value", undefined, { signal: controller.signal, timeout: 1000 });
	return context.editor("Edit");
}

describe("InteractiveMode exact standard prompts", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	it("settles a local select response with exact options", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.select("Choose", ["First", "Second"]);
			harness.getPromptInput().handleInput("j");
			harness.getPromptInput().handleInput("\n");

			expect(await result).toBe("Second");
			expect(harness.events[0]).toMatchObject({
				type: "ui_prompt_start",
				kind: "select",
				response: { status: "supported", schema: { kind: "select", options: ["First", "Second"] } },
			});
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("lets an external select response win before a late local response", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.select("Choose", ["First", "Second"]);
			const start = harness.events[0] as ExactUIPromptStartEvent;
			const promptInput = harness.getPromptInput();

			expect(harness.context.respond(start.promptId, { kind: "select", value: "Second" })).toBe("accepted");
			promptInput.handleInput("\n");

			expect(await result).toBe("Second");
			expect(harness.events).toHaveLength(2);
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "external" });
			expect(harness.editor.focused).toBe(true);
		} finally {
			harness.close();
		}
	});

	it("keeps an invalid or unavailable select prompt active", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.select("Choose", ["Same", "Same"]);
			const start = harness.events[0] as ExactUIPromptStartEvent;

			expect(start.response).toEqual({ status: "unavailable", reason: "invalidOptions" });
			expect(harness.context.respond(start.promptId, { kind: "select", value: "Same" })).toBe("unsupported");
			expect(harness.context.respond(start.promptId, { kind: "input", value: "Same" })).toBe("kindMismatch");
			expect(harness.context.respond(createUIPromptId(), { kind: "select", value: "Same" })).toBe("notFound");
			harness.getPromptInput().handleInput("\n");

			expect(await result).toBe("Same");
		} finally {
			harness.close();
		}
	});

	it("reports a local select cancellation", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.select("Choose", ["First"]);
			harness.getPromptInput().handleInput("\x1b");

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("reports select timeout provenance", async () => {
		vi.useFakeTimers();
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.select("Choose", ["First"], { timeout: 1000 });
			vi.advanceTimersByTime(1000);

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "timeout" });
		} finally {
			harness.close();
		}
	});

	it("reports select signal provenance", async () => {
		const harness = createStandardPromptHarness();
		try {
			const controller = new AbortController();
			const result = harness.context.select("Choose", ["First"], { signal: controller.signal });
			controller.abort();

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "signal" });
		} finally {
			harness.close();
		}
	});

	it("settles a local input response", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.input("Value");
			harness.getPromptInput().handleInput("local value");
			harness.getPromptInput().handleInput("\n");

			expect(await result).toBe("local value");
			expect(harness.events[0]).toMatchObject({ kind: "input", response: { status: "supported" } });
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("lets an external input response win before a late local response", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.input("Value");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			const promptInput = harness.getPromptInput();

			expect(harness.context.respond(start.promptId, { kind: "input", value: "external value" })).toBe("accepted");
			promptInput.handleInput("late");
			promptInput.handleInput("\n");

			expect(await result).toBe("external value");
			expect(harness.events).toHaveLength(2);
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "external" });
			expect(harness.editor.focused).toBe(true);
		} finally {
			harness.close();
		}
	});

	it("rejects invalid external input without settling", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.input("Value");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			const invalid = { kind: "input", value: "\0" } as UIPromptResponse;

			expect(harness.context.respond(start.promptId, { kind: "input", value: " " })).toBe("invalidValue");
			expect(harness.context.respond(start.promptId, invalid)).toBe("invalidValue");
			expect(harness.events).toHaveLength(1);
			expect(harness.context.dismiss(start.promptId)).toBe("accepted");

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "external" });
		} finally {
			harness.close();
		}
	});

	it("reports a local input cancellation", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.input("Value");
			harness.getPromptInput().handleInput("\x1b");

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("reports input timeout provenance", async () => {
		vi.useFakeTimers();
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.input("Value", undefined, { timeout: 1000 });
			vi.advanceTimersByTime(1000);

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "timeout" });
		} finally {
			harness.close();
		}
	});

	it("reports input signal provenance", async () => {
		const harness = createStandardPromptHarness();
		try {
			const controller = new AbortController();
			const result = harness.context.input("Value", undefined, { signal: controller.signal });
			controller.abort();

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "signal" });
		} finally {
			harness.close();
		}
	});

	it("settles a local editor response", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.editor("Edit");
			harness.getPromptInput().handleInput("local draft");
			harness.getPromptInput().handleInput("\r");

			expect(await result).toBe("local draft");
			expect(harness.events[0]).toMatchObject({ kind: "editor", response: { status: "supported" } });
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("lets an external editor response win before a late local response", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.editor("Edit");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			const promptInput = harness.getPromptInput();

			expect(harness.context.respond(start.promptId, { kind: "editor", value: "external draft" })).toBe("accepted");
			promptInput.handleInput("late");
			promptInput.handleInput("\n");

			expect(await result).toBe("external draft");
			expect(harness.events).toHaveLength(2);
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "external" });
			expect(harness.editor.focused).toBe(true);
		} finally {
			harness.close();
		}
	});

	it("lets local editor response win before a late external response", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.editor("Edit");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			harness.getPromptInput().handleInput("local draft");
			harness.getPromptInput().handleInput("\r");

			expect(await result).toBe("local draft");
			expect(harness.context.respond(start.promptId, { kind: "editor", value: "late" })).toBe("notFound");
			expect(harness.events).toHaveLength(2);
		} finally {
			harness.close();
		}
	});

	it("reports a local editor cancellation", async () => {
		const harness = createStandardPromptHarness();
		try {
			const result = harness.context.editor("Edit");
			harness.getPromptInput().handleInput("\x1b");

			expect(await result).toBeUndefined();
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("rejects an overlapping standard prompt instead of queueing it", async () => {
		const harness = createStandardPromptHarness();
		try {
			const select = harness.context.select("Choose", ["First"]);

			expect(() => harness.context.input("Value")).toThrow("An extension standard prompt is already active");
			expect(harness.events).toHaveLength(1);
			expect(harness.context.dismiss((harness.events[0] as ExactUIPromptStartEvent).promptId)).toBe("accepted");
			expect(await select).toBeUndefined();
		} finally {
			harness.close();
		}
	});

	it("lets an already-aborted select resolve while another prompt is active", async () => {
		const harness = createStandardPromptHarness();
		try {
			const active = harness.context.select("Active", ["First"]);
			const controller = new AbortController();
			controller.abort();

			await expect(
				harness.context.select("Aborted", ["Second"], { signal: controller.signal }),
			).resolves.toBeUndefined();
			expect(harness.events).toHaveLength(1);
			expect(harness.context.dismiss((harness.events[0] as ExactUIPromptStartEvent).promptId)).toBe("accepted");
			await active;
		} finally {
			harness.close();
		}
	});

	it("lets an already-aborted input resolve while another prompt is active", async () => {
		const harness = createStandardPromptHarness();
		try {
			const active = harness.context.select("Active", ["First"]);
			const controller = new AbortController();
			controller.abort();

			await expect(
				harness.context.input("Aborted", undefined, { signal: controller.signal }),
			).resolves.toBeUndefined();
			expect(harness.events).toHaveLength(1);
			expect(harness.context.dismiss((harness.events[0] as ExactUIPromptStartEvent).promptId)).toBe("accepted");
			await active;
		} finally {
			harness.close();
		}
	});

	it("disposes a live generic selector before synchronous external settlement", async () => {
		let context: ExtensionUIContext;
		let selectorTokenActive = true;
		let lateMutationCount = 0;
		const disposeActiveSelector = vi.fn(() => {
			selectorTokenActive = false;
		});
		const harness = createStandardPromptHarness((event) => {
			if (event.type === "ui_prompt_start") {
				expect(context.respond(event.promptId, { kind: "select", value: "First" })).toBe("accepted");
			}
		}, disposeActiveSelector);
		context = harness.context;
		try {
			expect(await context.select("Choose", ["First"])).toBe("First");
			if (selectorTokenActive) lateMutationCount += 1;

			expect(disposeActiveSelector).toHaveBeenCalledOnce();
			expect(lateMutationCount).toBe(0);
		} finally {
			harness.close();
		}
	});

	it("disposes a live generic selector once on normal settlement", async () => {
		const disposeActiveSelector = vi.fn();
		const harness = createStandardPromptHarness(undefined, disposeActiveSelector);
		try {
			const result = harness.context.select("Choose", ["First"]);
			harness.getPromptInput().handleInput("\n");

			expect(await result).toBe("First");
			expect(disposeActiveSelector).toHaveBeenCalledOnce();
		} finally {
			harness.close();
		}
	});

	it.each(["confirm", "select", "input", "editor"] as const)(
		"invalidates an active %s prompt with one exact terminal event",
		async (kind) => {
			vi.useFakeTimers();
			const harness = createStandardPromptHarness();
			try {
				const controller = new AbortController();
				const result = openStandardPrompt(harness.context, kind, controller);
				const start = harness.events[0] as ExactUIPromptStartEvent;
				const stalePromptInput = harness.getPromptInput();

				await harness.invalidate();

				expect(await result).toBe(kind === "confirm" ? false : undefined);
				expect(harness.editor.focused).toBe(true);
				expect(harness.events).toHaveLength(2);
				expect(harness.events[1]).toMatchObject({
					type: "ui_prompt_end",
					promptId: start.promptId,
					kind,
					resolution: "dismissed",
					source: "sessionInvalidated",
				});
				expect(harness.context.respond(start.promptId, { kind: "confirm", value: true })).toBe("notFound");
				expect(harness.context.dismiss(start.promptId)).toBe("notFound");

				controller.abort();
				vi.advanceTimersByTime(2000);
				stalePromptInput.handleInput("\x1b");
				expect(harness.events).toHaveLength(2);
			} finally {
				harness.close();
			}
		},
	);

	it("waits for the invalidation end event before lifecycle teardown continues", async () => {
		let releaseEnd: () => void = () => {};
		const endGate = new Promise<void>((resolve) => {
			releaseEnd = resolve;
		});
		const harness = createStandardPromptHarness(async (event) => {
			if (event.type === "ui_prompt_end") await endGate;
		});
		try {
			const result = harness.context.input("Value");
			let invalidated = false;
			const invalidation = harness.invalidate().then(() => {
				invalidated = true;
			});
			await Promise.resolve();

			expect(invalidated).toBe(false);
			releaseEnd();
			await invalidation;
			expect(await result).toBeUndefined();
		} finally {
			harness.close();
		}
	});

	it("avoids stale select, input, and editor modals after synchronous external settlement", async () => {
		let context: ExtensionUIContext;
		const harness = createStandardPromptHarness((event) => {
			if (event.type !== "ui_prompt_start") return;
			const response: UIPromptResponse =
				event.kind === "select"
					? { kind: "select", value: "First" }
					: event.kind === "input"
						? { kind: "input", value: "input" }
						: { kind: "editor", value: "editor" };
			expect(context.respond(event.promptId, response)).toBe("accepted");
		});
		context = harness.context;
		try {
			expect(await context.select("Choose", ["First"])).toBe("First");
			expect(await context.input("Value")).toBe("input");
			expect(await context.editor("Edit")).toBe("editor");
			expect(harness.events.map((event) => event.type)).toEqual([
				"ui_prompt_start",
				"ui_prompt_end",
				"ui_prompt_start",
				"ui_prompt_end",
				"ui_prompt_start",
				"ui_prompt_end",
			]);
			expect(harness.editor.focused).toBe(true);
		} finally {
			harness.close();
		}
	});
});
