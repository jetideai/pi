import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type {
	ExtensionUIContext,
	MessageRenderProjectionMemberV1,
	MessageRenderProjectionV1,
	TranscriptWindowRequestV1,
	TranscriptWindowResultV1,
} from "../src/core/extensions/types.ts";
import type { BashExecutionMessage } from "../src/core/messages.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { selectTranscriptWindow, type TranscriptWindowItem } from "../src/modes/interactive/transcript-window.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** One item per entry; each size is one compaction interval, and 0 is an empty interval. */
function intervals(...sizes: number[]): TranscriptWindowItem[] {
	return sizes.flatMap((size, section) =>
		Array.from({ length: size }, (_, index) => ({ section, entryId: `s${section}-${index}` })),
	);
}

describe("selectTranscriptWindow", () => {
	it("selects every item as one section without a compaction", () => {
		expect(selectTranscriptWindow(intervals(3), { entryId: "s0-1" })).toEqual({
			status: "selected",
			start: 0,
			end: 3,
			liveTail: true,
		});
	});

	it("selects the exact compaction interval that contains the target", () => {
		expect(selectTranscriptWindow(intervals(2, 3, 2), { entryId: "s1-0" })).toEqual({
			status: "selected",
			start: 2,
			end: 5,
			liveTail: false,
		});
	});

	it("selects a short open tail as the live tail", () => {
		expect(selectTranscriptWindow(intervals(4, 1), { entryId: "s1-0" })).toEqual({
			status: "selected",
			start: 4,
			end: 5,
			liveTail: true,
		});
	});

	it("adds the adjacent interval in the requested direction", () => {
		expect(selectTranscriptWindow(intervals(2, 3, 2), { entryId: "s1-1", adjacent: "previous" })).toEqual({
			status: "selected",
			start: 0,
			end: 5,
			liveTail: false,
		});
		expect(selectTranscriptWindow(intervals(2, 3, 2), { entryId: "s1-1", adjacent: "next" })).toEqual({
			status: "selected",
			start: 2,
			end: 7,
			liveTail: true,
		});
	});

	it("keeps one interval when no interval exists in the requested direction", () => {
		expect(selectTranscriptWindow(intervals(2, 3, 2), { entryId: "s0-0", adjacent: "previous" })).toMatchObject({
			start: 0,
			end: 2,
		});
		expect(selectTranscriptWindow(intervals(2, 3, 2), { entryId: "s2-0", adjacent: "next" })).toMatchObject({
			start: 5,
			end: 7,
		});
	});

	it("passes over an empty interval to the adjacent interval that has items", () => {
		expect(selectTranscriptWindow(intervals(2, 0, 3), { entryId: "s2-0", adjacent: "previous" })).toEqual({
			status: "selected",
			start: 0,
			end: 5,
			liveTail: true,
		});
		expect(selectTranscriptWindow(intervals(2, 0), { entryId: "s0-0", adjacent: "next" })).toEqual({
			status: "selected",
			start: 0,
			end: 2,
			liveTail: true,
		});
	});

	it("reports a missing target instead of selecting the tail", () => {
		expect(selectTranscriptWindow(intervals(2, 2), { entryId: "unknown" })).toEqual({ status: "missing" });
	});
});

function toolResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `${id} output` }],
		isError: false,
		timestamp: 2,
	};
}

function toolCalls(...ids: string[]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `path-${id}` } })),
	};
}

function nineTurns(sessionManager: SessionManager): string[][] {
	sessionManager.appendMessage(bashNotice("leading-notice"));
	const turnEntryIds: string[][] = [];
	for (let index = 0; index < 9; index++) {
		if (index === 4 || index === 8) sessionManager.appendCompaction("summary", turnEntryIds.at(-1)![0]!, 100);
		const userId = sessionManager.appendMessage({ role: "user", content: `Question ${index}`, timestamp: 1 });
		if (index !== 2) {
			turnEntryIds.push([userId, sessionManager.appendMessage(fauxAssistantMessage(`Answer ${index}`))]);
			continue;
		}
		const toolCall: AssistantMessage = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "tool-b", name: "read", arguments: { path: "b" } },
			],
		};
		const toolCallId = sessionManager.appendMessage(toolCall);
		turnEntryIds.push([
			userId,
			toolCallId,
			sessionManager.appendMessage(toolResult("tool-a")),
			sessionManager.appendMessage(toolResult("tool-b")),
			sessionManager.appendMessage(fauxAssistantMessage(`Answer ${index}`)),
		]);
	}
	sessionManager.appendMessage(bashNotice("trailing-notice"));
	return turnEntryIds;
}

/** One turn with a compaction after each of its first two tool steps; the open tail is short. */
function oneTurnWithTwoCompactions(sessionManager: SessionManager) {
	const user = sessionManager.appendMessage({ role: "user", content: "Question one", timestamp: 1 });
	sessionManager.appendMessage(toolCalls("t1"));
	sessionManager.appendMessage(toolResult("t1"));
	sessionManager.appendCompaction("summary 1", user, 100);
	const second = sessionManager.appendMessage(toolCalls("t2", "t3"));
	sessionManager.appendMessage(toolResult("t2"));
	sessionManager.appendMessage(toolResult("t3"));
	sessionManager.appendCompaction("summary 2", second, 100);
	sessionManager.appendMessage(toolCalls("t4"));
	sessionManager.appendMessage(toolResult("t4"));
	const final = sessionManager.appendMessage(fauxAssistantMessage("Final answer"));
	return { user, second, final };
}

interface WindowedMode {
	chatContainer: Container;
	pendingTools: Map<string, unknown>;
	documentContainer: Container;
	renderer: {
		addChild(component: Container): void;
		renderNow(): void;
		stop(options: { preserveScreen: boolean }): void;
	};
}

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
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

	async function openWindowedSession<T>(
		journal: (sessionManager: SessionManager) => T,
		options: { faux?: (faux: ReturnType<typeof registerFauxProvider>) => void } = {},
	) {
		initTheme("dark");
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			stdoutWrite.mockRestore();
		});
		const tempDir = join(tmpdir(), `pi-transcript-window-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		options.faux?.(faux);
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
		let ui: ExtensionUIContext | undefined;
		let generation = 0;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				modelRuntime,
				cwd,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.registerMessageRenderProjectionObserverV1((projection) => {
								projections.push(projection);
								if (projection.mode === "replace") generation += 1;
							});
							pi.registerReplayTransactionProviderV1({
								capture: () => {
									const scope = `scope-${generation}`;
									return {
										generation: scope,
										transaction: (cause) => ({
											begin: `\x1b]777;begin-${scope}-${cause}\x07`,
											end: `\x1b]777;end-${scope}\x07`,
										}),
									};
								},
							});
							pi.on("session_start", (_event, ctx) => {
								ui = ctx.ui;
							});
						},
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

		const journalIds = journal(runtimeHost.session.sessionManager);
		const sessionFile = runtimeHost.session.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted session");

		await runtimeHost.newSession();
		const terminal = new RecordingTerminal(120, 40);
		const mode = new InteractiveMode(runtimeHost, { terminal, tuiMode: "regular" }) as unknown as WindowedMode;
		cleanups.push(() => mode.renderer.stop({ preserveScreen: true }));
		// init() mounts the document the same way; it also starts terminal input, which this test does not need.
		mode.renderer.addChild(mode.documentContainer);
		projections.length = 0;
		await runtimeHost.switchSession(sessionFile);
		const requestWindow = (request: TranscriptWindowRequestV1): TranscriptWindowResultV1 => {
			if (!ui?.requestTranscriptWindow) throw new Error("Expected the transcript window request of the UI context");
			return ui.requestTranscriptWindow(request);
		};
		return {
			mode,
			runtimeHost,
			requestWindow,
			journal: journalIds,
			render: () => {
				terminal.writes = [];
				mode.renderer.renderNow();
				return stripAnsi(terminal.writes.join(""));
			},
			rawRender: () => {
				terminal.writes = [];
				mode.renderer.renderNow();
				return terminal.writes.join("");
			},
			projections,
			unwindowed: () => projections[0]!,
			latest: () => projections.at(-1)!,
			text: () => stripAnsi(mode.chatContainer.render(120).join("\n")),
			pendingTools: () => [...mode.pendingTools.keys()],
		};
	}

	/** Nine turns with a leading notice, a tool turn, compactions before turns 4 and 8 and a trailing notice. */
	async function createWindowedMode(options: { faux?: (faux: ReturnType<typeof registerFauxProvider>) => void } = {}) {
		const session = await openWindowedSession(nineTurns, options);
		const turnEntryIds = session.journal;
		const turnOf = (member: Readonly<MessageRenderProjectionMemberV1>): number =>
			turnEntryIds.findIndex(
				(ids) => ids.includes(member.entryId) || ("ownerEntryId" in member && ids.includes(member.ownerEntryId)),
			);
		return {
			...session,
			window: (turn: number, adjacent?: "previous" | "next") =>
				session.requestWindow({
					entryId: turnEntryIds[turn]![0]!,
					role: "user",
					...(adjacent ? { adjacent } : {}),
				}),
			userId: (turn: number) => turnEntryIds[turn]![0]!,
			toolCallEntryId: turnEntryIds[2]![1]!,
			loadedTurns: (projection: Readonly<MessageRenderProjectionV1>) => [
				...new Set(projection.members.filter((member) => member.loaded !== false).map(turnOf)),
			],
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
		const { window, unwindowed, latest, loadedTurns } = await createWindowedMode();

		expect(window(1)).toEqual({ status: "applied" });

		expect(withoutLoaded(latest())).toEqual(unwindowed().members);
		expect(loadedTurns(latest())).toEqual([0, 1, 2, 3]);
		expect(latest()).toMatchObject({ mode: "replace", liveTail: false });
	});

	it("keeps the tool group, its ownership and the completed turn while the tool turn is unloaded and after return", async () => {
		const { window, userId, toolCallEntryId, unwindowed, latest } = await createWindowedMode();
		const toolTurn = (projection: Readonly<MessageRenderProjectionV1>) =>
			projection.members
				.filter(
					(member) =>
						member.entryId === userId(2) || ("ownerEntryId" in member && member.ownerEntryId === toolCallEntryId),
				)
				.map(({ loaded: _loaded, ...member }) => member);
		const expected = toolTurn(unwindowed());

		window(5);
		const unloaded = latest();
		window(1);

		expect(expected).toContainEqual(
			expect.objectContaining({ role: "tool-group", ownerEntryId: toolCallEntryId, groupClosed: true }),
		);
		expect(expected.filter((member) => member.role === "tool")).toEqual([
			expect.objectContaining({ entryId: "tool-a", ownerEntryId: toolCallEntryId, groupId: expect.any(String) }),
			expect.objectContaining({ entryId: "tool-b", ownerEntryId: toolCallEntryId, groupId: expect.any(String) }),
		]);
		expect(expected[0]).toMatchObject({ role: "user", completedTurn: expect.any(Object) });
		expect(toolTurn(unloaded)).toEqual(expected);
		expect(toolTurn(latest())).toEqual(expected);
	});

	it("builds components only for the loaded section", async () => {
		const { window, text } = await createWindowedMode();

		window(1);

		expect(text()).toContain("leading-notice");
		expect(text()).toContain("Question 3");
		expect(text()).toContain("read a");
		expect(text()).not.toContain("Question 4");
		expect(text()).not.toContain("trailing-notice");
	});

	it("renders section B without the turns of A or the tail", async () => {
		const { window, text, latest, loadedTurns } = await createWindowedMode();

		window(5);

		expect(loadedTurns(latest())).toEqual([4, 5, 6, 7]);
		expect(text()).toContain("Question 4");
		expect(text()).toContain("Question 7");
		expect(text()).not.toContain("Question 3");
		expect(text()).not.toContain("Question 8");
	});

	it("loads A and B together for an overlap", async () => {
		const { window, latest, loadedTurns, text } = await createWindowedMode();

		window(3, "next");

		expect(loadedTurns(latest())).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(text()).toContain("Question 0");
		expect(text()).toContain("Question 7");
		expect(text()).not.toContain("Question 8");
	});

	it("marks the last section as the live tail and keeps the trailing notice", async () => {
		const { window, latest, loadedTurns, text } = await createWindowedMode();

		window(8);

		expect(latest().liveTail).toBe(true);
		expect(loadedTurns(latest())).toEqual([8]);
		expect(text()).toContain("trailing-notice");
	});

	it("returns to A with the same projection and chat content after B", async () => {
		const { mode, window, latest, text } = await createWindowedMode();
		window(1);
		const first = { projection: latest(), text: text(), components: mode.chatContainer.children.length };

		window(5);
		window(1);

		expect(latest()).not.toBe(first.projection);
		expect(latest()).toEqual(first.projection);
		expect(text()).toBe(first.text);
		expect(mode.chatContainer.children.length).toBe(first.components);
	});

	it("leaves the chat and projection unchanged for a missing target", async () => {
		const { window, requestWindow, projections, text } = await createWindowedMode();
		window(1);
		const before = { count: projections.length, text: text() };

		expect(requestWindow({ entryId: "unknown", role: "user" })).toEqual({ status: "missing" });

		expect(projections).toHaveLength(before.count);
		expect(text()).toBe(before.text);
	});
	it("rejects a target whose role differs without changing the chat", async () => {
		const { requestWindow, userId, projections, text } = await createWindowedMode();
		const before = { count: projections.length, text: text() };

		expect(requestWindow({ entryId: userId(1), role: "assistant" })).toEqual({ status: "missing" });

		expect(projections).toHaveLength(before.count);
		expect(text()).toBe(before.text);
	});

	it("rejects a window while the session streams without changing the chat", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { runtimeHost, window, projections, text } = await createWindowedMode({
			faux: (faux) =>
				faux.setResponses([
					async () => {
						await gate;
						return fauxAssistantMessage("late answer");
					},
				]),
		});
		const prompt = runtimeHost.session.prompt("Stream now");
		await vi.waitFor(() => expect(runtimeHost.session.isIdle).toBe(false));
		const before = { count: projections.length, text: text() };

		expect(window(1)).toEqual({ status: "streaming" });

		expect(projections).toHaveLength(before.count);
		expect(text()).toBe(before.text);
		release();
		await prompt;
	});

	it("replays the applied window completely in the next render with a new capture generation", async () => {
		const { window, rawRender } = await createWindowedMode();
		rawRender();

		window(1);
		const output = rawRender();

		const begin = output.indexOf("\x1b]777;begin-scope-2-");
		const end = output.indexOf("\x1b]777;end-scope-2\x07");
		expect(begin).toBe(0);
		expect(end).toBe(output.length - "\x1b]777;end-scope-2\x07".length);
		const replayed = stripAnsi(output.slice(begin, end));
		expect(replayed).toContain("Question 3");
		expect(replayed).not.toContain("Question 4");
	});
	describe("with two compactions inside one turn", () => {
		const markers = ["Question one", "path-t1", "path-t2", "path-t3", "path-t4", "Final answer"];
		const counts = (text: string) => markers.map((marker) => text.split(marker).length - 1);
		const loadedKeys = (projection: Readonly<MessageRenderProjectionV1>) =>
			projection.members
				.filter((member) => member.loaded !== false)
				.map((member) => `${member.role}:${member.entryId}`);

		it("renders each compaction interval of the turn as its own window with the full metadata", async () => {
			const { requestWindow, journal, text, unwindowed, latest, pendingTools } =
				await openWindowedSession(oneTurnWithTwoCompactions);
			const requests: TranscriptWindowRequestV1[] = [
				{ entryId: journal.user, role: "user" },
				{ entryId: journal.second, role: "assistant" },
				{ entryId: journal.final, role: "assistant" },
			];

			const windows = requests.map((request) => ({
				status: requestWindow(request).status,
				counts: counts(text()),
				liveTail: latest().liveTail,
				loaded: loadedKeys(latest()),
				metadata: withoutLoaded(latest()),
				pending: pendingTools(),
			}));

			expect(windows.map((window) => window.status)).toEqual(["applied", "applied", "applied"]);
			expect(windows.map((window) => window.counts)).toEqual([
				[1, 1, 0, 0, 0, 0],
				[0, 0, 1, 1, 0, 0],
				[0, 0, 0, 0, 1, 1],
			]);
			expect(windows.map((window) => window.liveTail)).toEqual([false, false, true]);
			expect(windows.flatMap((window) => window.loaded)).toEqual(
				unwindowed().members.map((member) => `${member.role}:${member.entryId}`),
			);
			for (const window of windows) expect(window.metadata).toEqual(unwindowed().members);
			expect(windows.map((window) => window.pending)).toEqual([[], [], []]);
		});

		it("adds the previous or the next interval of the turn once and keeps the full metadata", async () => {
			const { requestWindow, journal, text, unwindowed, latest } =
				await openWindowedSession(oneTurnWithTwoCompactions);

			requestWindow({ entryId: journal.second, role: "assistant", adjacent: "previous" });
			const previous = { counts: counts(text()), liveTail: latest().liveTail, metadata: withoutLoaded(latest()) };
			requestWindow({ entryId: journal.second, role: "assistant", adjacent: "next" });
			const next = { counts: counts(text()), liveTail: latest().liveTail, metadata: withoutLoaded(latest()) };

			expect(previous).toEqual({ counts: [1, 1, 1, 1, 0, 0], liveTail: false, metadata: unwindowed().members });
			expect(next).toEqual({ counts: [0, 0, 1, 1, 1, 1], liveTail: true, metadata: unwindowed().members });
		});
	});
});
