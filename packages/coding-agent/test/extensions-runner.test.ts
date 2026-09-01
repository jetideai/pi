import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime, discoverAndLoadExtensions, loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner, emitProjectTrustEvent } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
	ProviderConfig,
	UIPromptEndEvent,
	UIPromptStartEvent,
} from "../src/core/extensions/types.ts";
import {
	createUIPromptId,
	createUIPromptResponseAvailability,
	type StandardPromptLifecycleSource,
} from "../src/core/extensions/ui-prompt-contract.ts";
import { KeybindingsManager, type KeyId } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestExtensionsResult } from "./utilities.ts";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 1,
					output: 2,
					cacheRead: 0.1,
					cacheWrite: 1.25,
					tiers: [
						{
							inputTokensAbove: 272000,
							input: 2,
							output: 3,
							cacheRead: 0.2,
							cacheWrite: 2.5,
						},
					],
				},
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getScopedModels: () => [],
	};

	describe("scopedModels", () => {
		it("reflects the getScopedModels context action on ctx.scopedModels", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			// Before bindCore the default is an empty list (never undefined).
			expect(runner.createContext().scopedModels).toEqual([]);

			// After bindCore wires a getScopedModels action, ctx.scopedModels
			// returns it live (same reference, lazy getter).
			const scoped = [{ model: { id: "scoped-test" }, thinkingLevel: "high" }] as unknown as ScopedModel[];
			runner.bindCore(extensionActions, { ...extensionContextActions, getScopedModels: () => scoped });
			expect(runner.createContext().scopedModels).toBe(scoped);
		});
	});

	describe("project_trust", () => {
		it("continues past undecided handlers and returns the first yes/no decision", async () => {
			const undecidedPath = path.join(extensionsDir, "undecided.ts");
			const decidedPath = path.join(extensionsDir, "decided.ts");
			fs.writeFileSync(
				undecidedPath,
				`export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "undecided", remember: true }));
}`,
			);
			fs.writeFileSync(
				decidedPath,
				`export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "no", remember: true }));
}`,
			);

			const extensionsResult = await loadExtensions([undecidedPath, decidedPath], tempDir);
			const result = await emitProjectTrustEvent(
				extensionsResult,
				{ type: "project_trust", cwd: tempDir },
				{
					cwd: tempDir,
					mode: "tui",
					hasUI: false,
					ui: {
						select: async () => undefined,
						confirm: async () => false,
						input: async () => undefined,
						notify: () => {},
					},
				},
			);

			expect(result.result).toEqual({ trusted: "no", remember: true });
			expect(result.errors).toEqual([]);
		});
	});

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("allows a shortcut when the reserved set no longer contains the default key", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Uses freed default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebinding.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.model.cycleForward": "ctrl+n" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(shortcuts.has("ctrl+p")).toBe(true);
			expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));

			warnSpy.mockRestore();
		});

		it("warns but allows when extension uses non-reserved built-in shortcut", async () => {
			const pasteImageKey = Array.isArray(defaultKeybindings["app.clipboard.pasteImage"])
				? (defaultKeybindings["app.clipboard.pasteImage"][0] ?? "")
				: defaultKeybindings["app.clipboard.pasteImage"];
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("${pasteImageKey}", {
						description: "Overrides non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has(pasteImageKey as KeyId)).toBe(true);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts for reserved actions even when rebound", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+x", {
						description: "Conflicts with rebound reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebound-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.interrupt": "ctrl+x" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+x")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved key is also bound to non-reserved actions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Conflicts with shared reserved default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "shared-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+p")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Conflicts with multi-key reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clear": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+y")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns but allows when non-reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Overrides multi-key non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has("ctrl+y")).toBe(true);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map((t) => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});

		it("keeps first tool when two extensions register the same name", async () => {
			const first = `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "shared",
						label: "shared",
						description: "first",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			const second = `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "shared",
						label: "shared",
						description: "second",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools).toHaveLength(1);
			expect(tools[0]?.definition.description).toBe("first");
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map((c) => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
			expect(commands.map((c) => c.invocationName).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by invocation name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.invocationName).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("suffixes duplicate extension commands in insertion order", async () => {
			const cmdCode = (description: string) => `
				export default function(pi) {
					pi.registerCommand("shared-cmd", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("First command"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("Second command"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();
			const diagnostics = runner.getCommandDiagnostics();

			expect(commands).toHaveLength(2);
			expect(commands.map((command) => command.name)).toEqual(["shared-cmd", "shared-cmd"]);
			expect(commands.map((command) => command.invocationName)).toEqual(["shared-cmd:1", "shared-cmd:2"]);
			expect(commands.map((command) => command.description)).toEqual(["First command", "Second command"]);
			expect(diagnostics).toEqual([]);
			expect(runner.getCommand("shared-cmd:1")?.description).toBe("First command");
			expect(runner.getCommand("shared-cmd:2")?.description).toBe("Second command");
		});
	});

	describe("context creation", () => {
		it("exposes the current abort signal on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const controller = new AbortController();

			runner.bindCore(extensionActions, {
				...extensionContextActions,
				getSignal: () => controller.signal,
			});

			const ctx = runner.createContext();
			expect(ctx.signal).toBe(controller.signal);
			expect(ctx.signal?.aborted).toBe(false);

			controller.abort();
			expect(ctx.signal?.aborted).toBe(true);
		});

		it("exposes print mode and hasUI false by default", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("print");
			expect(ctx.hasUI).toBe(false);
		});

		it("exposes project trust state on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, {
				...extensionContextActions,
				isProjectTrusted: () => false,
			});

			const ctx = runner.createContext();
			expect(ctx.isProjectTrusted()).toBe(false);
		});

		it("exposes rpc mode with hasUI true when an RPC UI context is provided", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);
			runner.setUIContext({} as ExtensionUIContext, "rpc");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("rpc");
			expect(ctx.hasUI).toBe(true);
		});

		it("exposes tui mode with hasUI true when a TUI UI context is provided", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);
			runner.setUIContext({} as ExtensionUIContext, "tui");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("tui");
			expect(ctx.hasUI).toBe(true);
		});
	});

	describe("UI prompt notifications", () => {
		it("forwards exact standard prompt lifecycle events without legacy duplicates", async () => {
			const observed: Array<UIPromptStartEvent | UIPromptEndEvent> = [];
			let resolveObserved: () => void = () => {};
			const allObserved = new Promise<void>((resolve) => {
				resolveObserved = resolve;
			});
			const result = await createTestExtensionsResult([
				(pi) => {
					pi.on("ui_prompt_start", (event) => {
						observed.push(event);
					});
					pi.on("ui_prompt_end", (event) => {
						observed.push(event);
						if (observed.length === 8) resolveObserved();
					});
				},
			]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			let sink: Parameters<StandardPromptLifecycleSource["connect"]>[0] = async () => {};
			const source: StandardPromptLifecycleSource = {
				connect: (listener) => {
					sink = listener;
					return () => {};
				},
			};
			const promptIds = {
				confirm: createUIPromptId(),
				select: createUIPromptId(),
				input: createUIPromptId(),
				editor: createUIPromptId(),
			};
			runner.setUIContext(
				{
					confirm: async () => {
						sink({
							type: "ui_prompt_start",
							reason: "ui_prompt",
							promptId: promptIds.confirm,
							kind: "confirm",
							response: createUIPromptResponseAvailability("confirm"),
						});
						sink({
							type: "ui_prompt_end",
							reason: "ui_prompt",
							promptId: promptIds.confirm,
							kind: "confirm",
							resolution: "responded",
							source: "local",
						});
						return true;
					},
					select: async () => {
						sink({
							type: "ui_prompt_start",
							reason: "ui_prompt",
							promptId: promptIds.select,
							kind: "select",
							response: createUIPromptResponseAvailability("select", ["First"]),
						});
						sink({
							type: "ui_prompt_end",
							reason: "ui_prompt",
							promptId: promptIds.select,
							kind: "select",
							resolution: "responded",
							source: "local",
						});
						return "First";
					},
					input: async () => {
						sink({
							type: "ui_prompt_start",
							reason: "ui_prompt",
							promptId: promptIds.input,
							kind: "input",
							response: createUIPromptResponseAvailability("input"),
						});
						sink({
							type: "ui_prompt_end",
							reason: "ui_prompt",
							promptId: promptIds.input,
							kind: "input",
							resolution: "responded",
							source: "local",
						});
						return "input";
					},
					editor: async () => {
						sink({
							type: "ui_prompt_start",
							reason: "ui_prompt",
							promptId: promptIds.editor,
							kind: "editor",
							response: createUIPromptResponseAvailability("editor"),
						});
						sink({
							type: "ui_prompt_end",
							reason: "ui_prompt",
							promptId: promptIds.editor,
							kind: "editor",
							resolution: "responded",
							source: "local",
						});
						return "editor";
					},
					respond: () => "unsupported",
					dismiss: () => "unsupported",
				} as unknown as ExtensionUIContext,
				"tui",
				source,
			);

			await runner.getUIContext().confirm("Confirm", "Continue?");
			await runner.getUIContext().select("Select", ["First"]);
			await runner.getUIContext().input("Input");
			await runner.getUIContext().editor("Editor");
			await allObserved;

			expect(observed.map((event) => [event.type, event.kind, event.promptId])).toEqual([
				["ui_prompt_start", "confirm", promptIds.confirm],
				["ui_prompt_end", "confirm", promptIds.confirm],
				["ui_prompt_start", "select", promptIds.select],
				["ui_prompt_end", "select", promptIds.select],
				["ui_prompt_start", "input", promptIds.input],
				["ui_prompt_end", "input", promptIds.input],
				["ui_prompt_start", "editor", promptIds.editor],
				["ui_prompt_end", "editor", promptIds.editor],
			]);
		});

		it("resolves exact prompt delivery after ordered handlers finish", async () => {
			let releaseEnd: () => void = () => {};
			const endGate = new Promise<void>((resolve) => {
				releaseEnd = resolve;
			});
			const observed: string[] = [];
			const result = await createTestExtensionsResult([
				(pi) => {
					pi.on("ui_prompt_start", () => {
						observed.push("start");
					});
					pi.on("ui_prompt_end", async () => {
						await endGate;
						observed.push("end");
					});
				},
			]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			let sink: Parameters<StandardPromptLifecycleSource["connect"]>[0] = async () => {};
			const source: StandardPromptLifecycleSource = {
				connect: (listener) => {
					sink = listener;
					return () => {};
				},
			};
			runner.setUIContext({} as ExtensionUIContext, "tui", source);
			const promptId = createUIPromptId();

			await sink({
				type: "ui_prompt_start",
				reason: "ui_prompt",
				promptId,
				kind: "input",
				response: createUIPromptResponseAvailability("input"),
			});
			let endDelivered = false;
			const endDelivery = sink({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				promptId,
				kind: "input",
				resolution: "dismissed",
				source: "sessionInvalidated",
			}).then(() => {
				endDelivered = true;
			});
			await Promise.resolve();

			expect(observed).toEqual(["start"]);
			expect(endDelivered).toBe(false);
			releaseEnd();
			await endDelivery;
			expect(observed).toEqual(["start", "end"]);
		});

		it("keeps retained prompt controls unavailable and rejects them after context invalidation", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.setUIContext(
				{ respond: () => "unsupported", dismiss: () => "unsupported" } as unknown as ExtensionUIContext,
				"tui",
			);
			const ui = runner.createContext().ui;
			const promptId = createUIPromptId();

			expect(ui.respond(promptId, { kind: "confirm", value: true })).toBe("unsupported");
			expect(ui.dismiss(promptId)).toBe("unsupported");

			runner.invalidate("Expired context");

			expect(() => ui.respond(promptId, { kind: "confirm", value: true })).toThrow("Expired context");
			expect(() => ui.dismiss(promptId)).toThrow("Expired context");
		});

		it("coalesces nested UI prompts into the outer prompt lifecycle", async () => {
			const observed: Array<{ type: string; reason: string; kind: string; title?: string }> = [];
			let resolveObserved: () => void = () => {};
			const allObserved = new Promise<void>((resolve) => {
				resolveObserved = resolve;
			});
			const result = await createTestExtensionsResult([
				(pi) => {
					pi.on("ui_prompt_start", (event) => {
						observed.push(event);
					});
					pi.on("ui_prompt_end", (event) => {
						observed.push(event);
						resolveObserved();
					});
				},
			]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.setUIContext(
				{
					confirm: async () => {
						await runner.getUIContext().input("Inner input", "Value");
						return true;
					},
					input: async () => "value",
				} as unknown as ExtensionUIContext,
				"tui",
			);

			await runner.getUIContext().confirm("Outer confirmation", "Continue?");
			await allObserved;

			expect(observed).toEqual([
				{ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Outer confirmation" },
				{ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Outer confirmation" },
			]);
		});

		it("preserves prompt notification order when an earlier observer is delayed", async () => {
			let releaseStart: () => void = () => {};
			const startGate = new Promise<void>((resolve) => {
				releaseStart = resolve;
			});
			const observed: string[] = [];
			let resolveObserved: () => void = () => {};
			const allObserved = new Promise<void>((resolve) => {
				resolveObserved = resolve;
			});
			const result = await createTestExtensionsResult([
				(pi) => {
					pi.on("ui_prompt_start", async () => startGate);
				},
				(pi) => {
					pi.on("ui_prompt_start", () => {
						observed.push("ui_prompt_start");
						if (observed.length === 2) resolveObserved();
					});
					pi.on("ui_prompt_end", () => {
						observed.push("ui_prompt_end");
						if (observed.length === 2) resolveObserved();
					});
				},
			]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.setUIContext({ confirm: async () => true } as unknown as ExtensionUIContext, "tui");

			await runner.getUIContext().confirm("Confirm", "Continue?");
			releaseStart();
			await allObserved;

			expect(observed).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		});

		it("continues prompt notification delivery after an observer rejects", async () => {
			const observed: string[] = [];
			let resolveObserved: () => void = () => {};
			const allObserved = new Promise<void>((resolve) => {
				resolveObserved = resolve;
			});
			const result = await createTestExtensionsResult([
				(pi) => {
					pi.on("ui_prompt_start", async () => {
						throw new Error("Rejected prompt observer");
					});
				},
				(pi) => {
					pi.on("ui_prompt_start", () => {
						observed.push("ui_prompt_start");
					});
					pi.on("ui_prompt_end", () => {
						observed.push("ui_prompt_end");
						resolveObserved();
					});
				},
			]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.setUIContext({ confirm: async () => true } as unknown as ExtensionUIContext, "tui");

			await runner.getUIContext().confirm("Confirm", "Continue?");
			await allObserved;

			expect(observed).toEqual(["ui_prompt_start", "ui_prompt_end"]);
			expect(errors).toEqual(["Rejected prompt observer"]);
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError((err) => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("message and entry renderers", () => {
		it("gets message render projection observers in extension load order", async () => {
			const extCode = (entryId: string) => `
				export default function(pi) {
					pi.registerMessageRenderProjectionObserverV1(() => "${entryId}");
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "projection-a.ts"), extCode("a"));
			fs.writeFileSync(path.join(extensionsDir, "projection-b.ts"), extCode("b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const observers = runner.getMessageRenderProjectionObserversV1();

			expect(observers.map((observe) => (observe as unknown as () => string)())).toEqual(["a", "b"]);
		});

		it("gets message render boundary decorators in extension load order", async () => {
			const extCode = (prefix: string) => `
				export default function(pi) {
					pi.registerMessageRenderBoundaryDecoratorV1(() => ({ prefix: "${prefix}" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "boundary-a.ts"), extCode("a"));
			fs.writeFileSync(path.join(extensionsDir, "boundary-b.ts"), extCode("b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const decorators = runner.getMessageRenderBoundaryDecoratorsV1();

			expect(decorators.map((decorate) => decorate({} as never)?.prefix)).toEqual(["a", "b"]);
		});

		it("gets message render boundary selectors in extension load order", async () => {
			const extCode = (begin: string) => `
				export default function(pi) {
					pi.registerMessageRenderBoundarySelectorV2(() => () => ({ begin: "${begin}" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "boundary-selector-a.ts"), extCode("a"));
			fs.writeFileSync(path.join(extensionsDir, "boundary-selector-b.ts"), extCode("b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const selectors = runner.getMessageRenderBoundarySelectorsV2();
			const decorators = selectors.map((select) => select({} as never));

			expect(decorators.map((decorate) => decorate?.({} as never).begin)).toEqual(["a", "b"]);
		});

		it("gets Tool Execution presentation selectors in extension load order", async () => {
			const extCode = (liveToolCall: string) => `
				export default function(pi) {
					pi.registerToolExecutionPresentationSelectorV1(() => ({ liveToolCall: "${liveToolCall}" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-execution-a.ts"), extCode("stock"));
			fs.writeFileSync(path.join(extensionsDir, "tool-execution-b.ts"), extCode("compact-stock-header"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const selectors = runner.getToolExecutionPresentationSelectorsV1();

			expect(selectors.map((select) => select({} as never)?.liveToolCall)).toEqual([
				"stock",
				"compact-stock-header",
			]);
		});

		it("returns no Tool Execution presentation selectors without extensions", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.getToolExecutionPresentationSelectorsV1()).toEqual([]);
		});

		it("gets Tool Call presentation overrides in extension load order", async () => {
			const extCode = (state: string) => `
				export default function(pi) {
					pi.registerToolPresentationOverrideV1(() => ({ state: "${state}" }));
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-presentation-a.ts"), extCode("expanded"));
			fs.writeFileSync(path.join(extensionsDir, "tool-presentation-b.ts"), extCode("collapsed"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const overrides = runner.getToolPresentationOverridesV1();

			expect(overrides.map((override) => override({} as never)?.state)).toEqual(["expanded", "collapsed"]);
		});

		it("gets Markdown transformers in extension load order", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMarkdownTransformer((markdown) => markdown);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "markdown-renderer-a.ts"), extCode);
			fs.writeFileSync(path.join(extensionsDir, "markdown-renderer-b.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.getMarkdownTransformers()).toHaveLength(2);
		});

		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});

		it("gets entry renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerEntryRenderer("my-entry", (entry, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "entry-renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.getEntryRenderer("my-entry")).toBeDefined();
			expect(runner.getEntryRenderer("not-exists")).toBeUndefined();
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.has("my-flag")).toBe(true);
		});

		it("keeps first flag when two extensions register the same name", async () => {
			const first = `
				export default function(pi) {
					pi.registerFlag("shared-flag", {
						description: "first",
						type: "boolean",
						default: true,
					});
				}
			`;
			const second = `
				export default function(pi) {
					pi.registerFlag("shared-flag", {
						description: "second",
						type: "boolean",
						default: false,
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.get("shared-flag")?.description).toBe("first");
			expect(result.runtime.flagValues.get("shared-flag")).toBe(true);
		});

		it("rejects default values that do not match the flag type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("safe-mode", {
						type: "boolean",
						default: "false",
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "bad-flag-default.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.extensions).toHaveLength(0);
			expect(result.errors[0]?.error).toContain(
				'Invalid default for flag "safe-mode": expected boolean, got string',
			);
			expect(result.runtime.flagValues.has("safe-mode")).toBe(false);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_agent_start", () => {
		it("keeps ctx.getSystemPrompt() in sync with chained system prompt updates", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nfirst",
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nsecond",
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.bindCore(extensionActions, extensionContextActions);

			const chained = await runner.emitBeforeAgentStart("hello", undefined, "base", {
				cwd: tempDir,
			});

			expect(errors).toEqual([]);

			expect(chained).toEqual({
				messages: undefined,
				systemPrompt: "base\nfirst\nsecond",
			});
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("provider registration", () => {
		it("bindCore ignores invalid queued registrations and reports extension error", async () => {
			const runtime = createExtensionRuntime();
			runtime.registerProvider(
				"broken-provider",
				{
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				},
				"/tmp/broken-extension.ts",
			);

			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));

			expect(() => runner.bindCore(extensionActions, extensionContextActions)).not.toThrow();
			expect(errors).toEqual([
				'/tmp/broken-extension.ts: Provider broken-provider: "api" is required when registering streamSimple.',
			]);
			await expect(modelRegistry.refresh()).resolves.toMatchObject({ aborted: false });
		});

		it("pre-bind unregister removes all queued registrations for a provider", () => {
			const runtime = createExtensionRuntime();

			runtime.registerProvider("queued-provider", providerModelConfig);
			runtime.registerProvider("queued-provider", {
				...providerModelConfig,
				models: [
					{
						id: "instant-model-2",
						name: "Instant Model 2",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(runtime.pendingProviderRegistrations).toHaveLength(2);

			runtime.unregisterProvider("queued-provider");
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
		});

		it("post-bind register and unregister take effect immediately", () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			runner.bindCore(extensionActions, extensionContextActions);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);

			runtime.registerProvider("instant-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
			expect(modelRegistry.find("instant-provider", "instant-model")?.cost.tiers).toEqual([
				{
					inputTokensAbove: 272000,
					input: 2,
					output: 3,
					cacheRead: 0.2,
					cacheWrite: 2.5,
				},
			]);

			runtime.unregisterProvider("instant-provider");
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeUndefined();
		});
	});

	describe("command context", () => {
		it("passes fork options through to the bound handler", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const fork = vi.fn(async () => ({ cancelled: false }));

			runner.bindCommandContext({
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork,
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			});

			const commandContext = runner.createCommandContext();
			await commandContext.fork("entry-1");
			expect(fork).toHaveBeenCalledWith("entry-1", undefined);

			await commandContext.fork("entry-2", { position: "at" });
			expect(fork).toHaveBeenLastCalledWith("entry-2", { position: "at" });
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});

	describe("before_provider_headers", () => {
		it("lets a handler mutate headers in place and preserves existing headers", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("before_provider_headers", (event) => {
						event.headers["X-Turn-Index"] = "3";
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "headers.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("before_provider_headers")).toBe(true);

			const headers = await runner.emitBeforeProviderHeaders({ "User-Agent": "kimchi/1.0" });
			expect(headers["X-Turn-Index"]).toBe("3");
			expect(headers["User-Agent"]).toBe("kimchi/1.0");
		});

		it("isolates a throwing handler and still applies the others", async () => {
			const throwing = `
				export default function(pi) {
					pi.on("before_provider_headers", () => {
						throw new Error("header handler boom");
					});
				}
			`;
			const good = `
				export default function(pi) {
					pi.on("before_provider_headers", (event) => {
						event.headers["X-Good"] = "yes";
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-throwing.ts"), throwing);
			fs.writeFileSync(path.join(extensionsDir, "b-good.ts"), good);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ event: string; error: string }> = [];
			runner.onError((err) => errors.push(err));

			const headers = await runner.emitBeforeProviderHeaders({ "User-Agent": "x" });

			expect(headers["X-Good"]).toBe("yes");
			expect(headers["User-Agent"]).toBe("x");
			expect(errors).toHaveLength(1);
			expect(errors[0].event).toBe("before_provider_headers");
			expect(errors[0].error).toContain("header handler boom");
		});
	});
});
