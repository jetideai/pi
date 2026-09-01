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
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ExactPromptEvent = ExactUIPromptStartEvent | ExactUIPromptEndEvent;

interface ConfirmModePrototype {
	createExtensionUIContext(this: ConfirmModeState): ExtensionUIContext;
	connectExtensionConfirmPromptEvents(this: ConfirmModeState, sink: (event: ExactPromptEvent) => void): () => void;
}

interface ConfirmModeState {
	ui: TUI;
	editor: TestEditor;
	editorContainer: Container;
	extensionSelector?: Component;
	activeExtensionConfirmPrompt?: unknown;
	extensionConfirmPromptEventSink?: (event: ExactPromptEvent) => void;
	disposeActiveSelector(): void;
	toggleToolOutputExpansion(): void;
}

class TestEditor implements Component, Focusable {
	focused = false;

	handleInput(): void {}
	render(): string[] {
		return ["EDITOR"];
	}
	invalidate(): void {}
	setText(): void {}
	getText(): string {
		return "";
	}
}

function createConfirmHarness(onEvent?: (event: ExactPromptEvent) => void): {
	context: ExtensionUIContext;
	events: ExactPromptEvent[];
	editor: TestEditor;
	getPromptInput: () => { handleInput(data: string): void };
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
		extensionSelector: undefined,
		activeExtensionConfirmPrompt: undefined,
		extensionConfirmPromptEventSink: undefined,
		disposeActiveSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
	}) as ConfirmModeState;
	const prototype = InteractiveMode.prototype as unknown as ConfirmModePrototype;
	const events: ExactPromptEvent[] = [];
	const disconnect = prototype.connectExtensionConfirmPromptEvents.call(state, (event) => {
		events.push(event);
		onEvent?.(event);
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
		close: () => {
			disconnect();
			ui.stop();
		},
	};
}

describe("InteractiveMode extension confirmation prompts", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	it("settles a local true response with exact local provenance", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			harness.getPromptInput().handleInput("\n");
			expect(await result).toBe(true);
			expect(harness.events.map((event) => [event.type, "source" in event ? event.source : undefined])).toEqual([
				["ui_prompt_start", undefined],
				["ui_prompt_end", "local"],
			]);
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("settles a local false response as a response", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			harness.getPromptInput().handleInput("j");
			harness.getPromptInput().handleInput("\n");
			expect(await result).toBe(false);
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("settles local cancel as a local dismissal", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			harness.getPromptInput().handleInput("\u001b");
			expect(await result).toBe(false);
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "local" });
		} finally {
			harness.close();
		}
	});

	it("settles timeout as a timeout dismissal", async () => {
		vi.useFakeTimers();
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?", { timeout: 1000 });
			vi.advanceTimersByTime(1000);
			expect(await result).toBe(false);
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "timeout" });
		} finally {
			harness.close();
		}
	});

	it("settles an abort signal as a signal dismissal", async () => {
		const harness = createConfirmHarness();
		try {
			const controller = new AbortController();
			const result = harness.context.confirm("Confirm", "Continue?", { signal: controller.signal });
			controller.abort();
			expect(await result).toBe(false);
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "signal" });
		} finally {
			harness.close();
		}
	});

	it("accepts an external response after start and closes the real modal", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			const start = harness.events[0] as ExactUIPromptStartEvent;

			expect(harness.context.respond(start.promptId, { kind: "confirm", value: false })).toBe("accepted");
			expect(await result).toBe(false);
			expect(harness.editor.focused).toBe(true);
			expect(harness.events[1]).toMatchObject({
				promptId: start.promptId,
				resolution: "responded",
				source: "external",
			});
			expect("value" in harness.events[1]).toBe(false);
		} finally {
			harness.close();
		}
	});

	it("enqueues start before a synchronous external response can settle", async () => {
		let context: ExtensionUIContext;
		const harness = createConfirmHarness((event) => {
			if (event.type === "ui_prompt_start") {
				expect(context.respond(event.promptId, { kind: "confirm", value: true })).toBe("accepted");
			}
		});
		context = harness.context;
		try {
			expect(await context.confirm("Confirm", "Continue?")).toBe(true);
			expect(harness.events.map((event) => event.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
			expect(harness.events[1]).toMatchObject({ resolution: "responded", source: "external" });
			expect(harness.editor.focused).toBe(true);
		} finally {
			harness.close();
		}
	});

	it("lets an external response win before a late local callback", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			const promptInput = harness.getPromptInput();

			expect(harness.context.respond(start.promptId, { kind: "confirm", value: true })).toBe("accepted");
			promptInput.handleInput("j");
			promptInput.handleInput("\n");

			expect(await result).toBe(true);
			expect(harness.events).toHaveLength(2);
			expect(harness.context.respond(start.promptId, { kind: "confirm", value: false })).toBe("notFound");
		} finally {
			harness.close();
		}
	});

	it("lets a local response win before a late external response", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			harness.getPromptInput().handleInput("\n");

			expect(await result).toBe(true);
			expect(harness.context.respond(start.promptId, { kind: "confirm", value: false })).toBe("notFound");
			expect(harness.events).toHaveLength(2);
		} finally {
			harness.close();
		}
	});

	it("rejects stale IDs, wrong kinds, and invalid values without settling", async () => {
		const harness = createConfirmHarness();
		try {
			const result = harness.context.confirm("Confirm", "Continue?");
			const start = harness.events[0] as ExactUIPromptStartEvent;
			const invalid = { kind: "confirm", value: "yes" } as unknown as UIPromptResponse;

			expect(harness.context.respond(createUIPromptId(), { kind: "confirm", value: true })).toBe("notFound");
			expect(harness.context.respond(start.promptId, { kind: "select", value: "Yes" })).toBe("kindMismatch");
			expect(harness.context.respond(start.promptId, invalid)).toBe("invalidValue");
			expect(harness.events).toHaveLength(1);

			expect(harness.context.dismiss(start.promptId)).toBe("accepted");
			expect(await result).toBe(false);
			expect(harness.events[1]).toMatchObject({ resolution: "dismissed", source: "external" });
		} finally {
			harness.close();
		}
	});
});
