import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { MessageRenderProjectionMemberV1, MessageRenderProjectionV1 } from "../src/core/extensions/types.ts";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	selectTranscriptWindow,
	type TranscriptWindowItem,
	type TranscriptWindowSelection,
	type TranscriptWindowTarget,
} from "../src/modes/interactive/transcript-window.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function turns(count: number): TranscriptWindowItem[] {
	return Array.from({ length: count }, (_, index) => [
		{ kind: "user" as const, entryId: `user-${index}` },
		{ kind: "turn" as const, entryId: `assistant-${index}` },
	]).flat();
}

describe("selectTranscriptWindow", () => {
	it("selects the section of four complete turns that contains the target", () => {
		expect(selectTranscriptWindow(turns(9), { entryId: "assistant-5" })).toEqual({
			status: "selected",
			start: 8,
			end: 16,
			liveTail: false,
		});
	});

	it("marks the last section as the live tail", () => {
		expect(selectTranscriptWindow(turns(9), { entryId: "user-8" })).toEqual({
			status: "selected",
			start: 16,
			end: 18,
			liveTail: true,
		});
	});

	it("keeps tool calls and results in the turn of their user message", () => {
		const items: TranscriptWindowItem[] = [
			...turns(3),
			{ kind: "user", entryId: "user-3" },
			{ kind: "turn", entryId: "assistant-3" },
			{ kind: "turn", entryId: "result-3" },
			{ kind: "turn", entryId: "assistant-3b" },
			{ kind: "user", entryId: "user-4" },
		];

		expect(selectTranscriptWindow(items, { entryId: "result-3" })).toEqual({
			status: "selected",
			start: 0,
			end: 10,
			liveTail: false,
		});
	});

	it("attaches leading and between-turn items to the next turn and keeps trailing items in the last turn", () => {
		const items: TranscriptWindowItem[] = [
			{ kind: "attached" },
			...turns(4),
			{ kind: "attached", entryId: "compaction" },
			{ kind: "attached" },
			{ kind: "user", entryId: "user-4" },
			{ kind: "turn", entryId: "assistant-4" },
			{ kind: "attached", entryId: "trailing-notice" },
		];

		expect(selectTranscriptWindow(items, { entryId: "user-0" })).toMatchObject({ start: 0, end: 9 });
		expect(selectTranscriptWindow(items, { entryId: "compaction" })).toEqual({
			status: "selected",
			start: 9,
			end: 14,
			liveTail: true,
		});
		expect(selectTranscriptWindow(items, { entryId: "trailing-notice" })).toMatchObject({ start: 9, end: 14 });
	});

	it("adds the adjacent section in the requested direction", () => {
		expect(selectTranscriptWindow(turns(12), { entryId: "user-5", adjacent: "previous" })).toMatchObject({
			start: 0,
			end: 16,
		});
		expect(selectTranscriptWindow(turns(12), { entryId: "user-5", adjacent: "next" })).toEqual({
			status: "selected",
			start: 8,
			end: 24,
			liveTail: true,
		});
	});

	it("keeps one section when no adjacent section exists in the requested direction", () => {
		expect(selectTranscriptWindow(turns(8), { entryId: "user-1", adjacent: "previous" })).toMatchObject({
			start: 0,
			end: 8,
		});
		expect(selectTranscriptWindow(turns(8), { entryId: "user-6", adjacent: "next" })).toMatchObject({
			start: 8,
			end: 16,
		});
	});

	it("reports a missing target instead of selecting the tail", () => {
		expect(selectTranscriptWindow(turns(9), { entryId: "unknown" })).toEqual({ status: "missing" });
	});

	it("selects all items as one section when no user message exists", () => {
		const items: TranscriptWindowItem[] = [{ kind: "attached", entryId: "notice" }, { kind: "turn" }];

		expect(selectTranscriptWindow(items, { entryId: "notice" })).toEqual({
			status: "selected",
			start: 0,
			end: 2,
			liveTail: true,
		});
	});
});

interface WindowedMode {
	chatContainer: Container;
	renderTranscriptWindow(target: TranscriptWindowTarget): TranscriptWindowSelection;
}

function bashNotice(command: string): BashExecutionMessage {
	return { role: "bashExecution", command, output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 };
}

describe("InteractiveMode transcript window", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	/** Nine turns with a leading notice, a tool turn, a compaction and a trailing notice. */
	async function createWindowedMode() {
		initTheme("dark");
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			stdoutWrite.mockRestore();
		});
		const tempDir = join(tmpdir(), `pi-transcript-window-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const projections: Readonly<MessageRenderProjectionV1>[] = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				modelRuntime,
				cwd,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => pi.registerMessageRenderProjectionObserverV1((projection) => projections.push(projection)),
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});
		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		const sessionManager = runtimeHost.session.sessionManager;
		sessionManager.appendMessage(bashNotice("leading-notice"));
		const turnEntryIds: string[][] = [];
		for (let index = 0; index < 9; index++) {
			const userId = sessionManager.appendMessage({ role: "user", content: `Question ${index}`, timestamp: 1 });
			if (index === 6) sessionManager.appendCompaction("summary", userId, 100);
			if (index !== 2) {
				turnEntryIds.push([userId, sessionManager.appendMessage(fauxAssistantMessage(`Answer ${index}`))]);
				continue;
			}
			const toolCall: AssistantMessage = {
				...fauxAssistantMessage(""),
				content: [{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a" } }],
			};
			const toolCallId = sessionManager.appendMessage(toolCall);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "tool-a",
				toolName: "read",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 2,
			};
			turnEntryIds.push([
				userId,
				toolCallId,
				sessionManager.appendMessage(result),
				sessionManager.appendMessage(fauxAssistantMessage(`Answer ${index}`)),
			]);
		}
		sessionManager.appendMessage(bashNotice("trailing-notice"));
		const sessionFile = runtimeHost.session.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted session");

		await runtimeHost.newSession();
		const interactive = new InteractiveMode(runtimeHost);
		cleanups.push(() => {
			const renderer = (interactive as unknown as { renderer: { stop(options: { preserveScreen: boolean }): void } })
				.renderer;
			renderer.stop({ preserveScreen: true });
		});
		projections.length = 0;
		await runtimeHost.switchSession(sessionFile);
		const mode = interactive as unknown as WindowedMode;
		const turnOf = (member: Readonly<MessageRenderProjectionMemberV1>): number =>
			turnEntryIds.findIndex(
				(ids) => ids.includes(member.entryId) || ("ownerEntryId" in member && ids.includes(member.ownerEntryId)),
			);
		return {
			mode,
			projections,
			userId: (turn: number) => turnEntryIds[turn]![0]!,
			unwindowed: () => projections[0]!,
			latest: () => projections.at(-1)!,
			loadedTurns: (projection: Readonly<MessageRenderProjectionV1>) => [
				...new Set(projection.members.filter((member) => member.loaded !== false).map(turnOf)),
			],
			text: () => stripAnsi(mode.chatContainer.render(120).join("\n")),
		};
	}

	function withoutLoaded(projection: Readonly<MessageRenderProjectionV1>) {
		return projection.members.map(({ loaded: _loaded, ...member }) => member);
	}

	it("publishes the ordinary unwindowed projection without window facts", async () => {
		const { projections, unwindowed, text } = await createWindowedMode();

		expect(projections).toHaveLength(1);
		expect(unwindowed().liveTail).toBeUndefined();
		expect(unwindowed().members.some((member) => "loaded" in member)).toBe(false);
		expect(text()).toContain("Question 8");
	});

	it("publishes every member with its turn metadata while it renders only section A", async () => {
		const { mode, userId, unwindowed, latest, loadedTurns } = await createWindowedMode();

		expect(mode.renderTranscriptWindow({ entryId: userId(1) })).toMatchObject({
			status: "selected",
			liveTail: false,
		});

		expect(withoutLoaded(latest())).toEqual(unwindowed().members);
		expect(loadedTurns(latest())).toEqual([0, 1, 2, 3]);
		expect(latest()).toMatchObject({ mode: "replace", liveTail: false });
	});

	it("builds components only for the loaded section", async () => {
		const { mode, userId, text } = await createWindowedMode();

		mode.renderTranscriptWindow({ entryId: userId(1) });

		expect(text()).toContain("leading-notice");
		expect(text()).toContain("Question 3");
		expect(text()).toContain("read a");
		expect(text()).not.toContain("Question 4");
		expect(text()).not.toContain("trailing-notice");
	});

	it("renders section B without the turns of A or the tail", async () => {
		const { mode, userId, text, latest, loadedTurns } = await createWindowedMode();

		mode.renderTranscriptWindow({ entryId: userId(5) });

		expect(loadedTurns(latest())).toEqual([4, 5, 6, 7]);
		expect(text()).toContain("Question 4");
		expect(text()).toContain("Question 7");
		expect(text()).not.toContain("Question 3");
		expect(text()).not.toContain("Question 8");
	});

	it("loads A and B together for an overlap", async () => {
		const { mode, userId, latest, loadedTurns, text } = await createWindowedMode();

		mode.renderTranscriptWindow({ entryId: userId(3), adjacent: "next" });

		expect(loadedTurns(latest())).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(text()).toContain("Question 0");
		expect(text()).toContain("Question 7");
		expect(text()).not.toContain("Question 8");
	});

	it("marks the last section as the live tail and keeps the trailing notice", async () => {
		const { mode, userId, latest, loadedTurns, text } = await createWindowedMode();

		mode.renderTranscriptWindow({ entryId: userId(8) });

		expect(latest().liveTail).toBe(true);
		expect(loadedTurns(latest())).toEqual([8]);
		expect(text()).toContain("trailing-notice");
	});

	it("returns to A with the same projection and chat content after B", async () => {
		const { mode, userId, latest, text } = await createWindowedMode();
		mode.renderTranscriptWindow({ entryId: userId(1) });
		const first = { projection: latest(), text: text(), components: mode.chatContainer.children.length };

		mode.renderTranscriptWindow({ entryId: userId(5) });
		mode.renderTranscriptWindow({ entryId: userId(1) });

		expect(latest()).not.toBe(first.projection);
		expect(latest()).toEqual(first.projection);
		expect(text()).toBe(first.text);
		expect(mode.chatContainer.children.length).toBe(first.components);
	});

	it("leaves the chat and projection unchanged for a missing target", async () => {
		const { mode, userId, projections, text } = await createWindowedMode();
		mode.renderTranscriptWindow({ entryId: userId(1) });
		const before = { count: projections.length, text: text() };

		expect(mode.renderTranscriptWindow({ entryId: "unknown" })).toEqual({ status: "missing" });

		expect(projections).toHaveLength(before.count);
		expect(text()).toBe(before.text);
	});
});
