import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type Container, Text } from "@earendil-works/pi-tui";
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
	const third = sessionManager.appendMessage(toolCalls("t4"));
	sessionManager.appendMessage(toolResult("t4"));
	const final = sessionManager.appendMessage(fauxAssistantMessage("Final answer"));
	return { user, second, third, final };
}

const BRANCH_COMMAND = "transcript-window-test-branch";

/** Three turns without a compaction entry. */
function threeTurns(sessionManager: SessionManager): string[] {
	return [0, 1, 2].map((index) => {
		const userId = sessionManager.appendMessage({ role: "user", content: `Question ${index}`, timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage(`Answer ${index}`));
		return userId;
	});
}

/** Two sections of two turns; the last entry is a compaction, so the last interval is empty. */
function emptyLastInterval(sessionManager: SessionManager): string[] {
	const users: string[] = [];
	for (let index = 0; index < 4; index++) {
		if (index === 2) sessionManager.appendCompaction("summary", users.at(-1)!, 100);
		users.push(sessionManager.appendMessage({ role: "user", content: `Question ${index}`, timestamp: 1 }));
		sessionManager.appendMessage(fauxAssistantMessage(`Answer ${index}`));
	}
	sessionManager.appendCompaction("summary", users.at(-1)!, 100);
	return users;
}

interface WindowedMode {
	chatContainer: Container;
	pendingTools: Map<string, unknown>;
	documentContainer: Container;
	headerContainer: Container;
	loadedResourcesContainer: Container;
	resourceDiagnosticsContainer: Container;
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
		options: {
			faux?: (faux: ReturnType<typeof registerFauxProvider>) => void;
			transcriptWindows?: boolean;
			settings?: Record<string, unknown>;
			turnEndCompaction?: boolean;
		} = {},
	) {
		initTheme("dark");
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			stdoutWrite.mockRestore();
		});
		const tempDir = join(tmpdir(), `pi-transcript-window-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		if (options.settings) writeFileSync(join(tempDir, "settings.json"), JSON.stringify(options.settings));
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
							pi.registerMessageRenderProjectionObserverV1(
								(projection) => {
									projections.push(projection);
									if (projection.mode === "replace") generation += 1;
								},
								options.transcriptWindows ? { transcriptWindows: true } : undefined,
							);
							let compactedAtTurnEnd = false;
							if (options.turnEndCompaction) {
								pi.on("turn_end", () => {
									if (compactedAtTurnEnd) return;
									compactedAtTurnEnd = true;
									return { entries: [{ type: "compaction", summary: "SUMMARY-T", firstKeptEntryId: null }] };
								});
							}
							// The interactive command context navigates the session tree the same way as /tree.
							pi.registerCommand(BRANCH_COMMAND, {
								description: "Navigate the session tree",
								handler: async (entryId, ctx) => {
									await ctx.navigateTree(entryId);
								},
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
		// Session events run init() on an uninitialized mode; the mounted document is the part that these tests need.
		(mode as unknown as { isInitialized: boolean }).isInitialized = true;
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
			branch: (entryId: string) => runtimeHost.session.prompt(`/${BRANCH_COMMAND} ${entryId}`),
			/** All terminal output since the session was opened, without a new render. */
			written: () => stripAnsi(terminal.writes.join("")),
			history: () => [...(mode as unknown as { editor: { history: string[] } }).editor.history],
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
	async function createWindowedMode(
		options: { faux?: (faux: ReturnType<typeof registerFauxProvider>) => void; transcriptWindows?: boolean } = {},
	) {
		const session = await openWindowedSession(nineTurns, options);
		const turnEntryIds = session.journal;
		// A Tool Group has no owner; it is in the turn of its first call.
		const turnOf = (
			member: Readonly<MessageRenderProjectionMemberV1>,
			members: readonly Readonly<MessageRenderProjectionMemberV1>[],
		): number => {
			const owned =
				member.role === "tool-group"
					? members.find(
							(call) => call.role === "tool" && call.groupId === member.groupId && call.groupOrder === 0,
						)
					: member;
			return turnEntryIds.findIndex(
				(ids) =>
					ids.includes(member.entryId) || (owned && "ownerEntryId" in owned && ids.includes(owned.ownerEntryId)),
			);
		};
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
				...new Set(
					projection.members
						.filter((member) => member.loaded !== false)
						.map((member) => turnOf(member, projection.members)),
				),
			],
		};
	}

	/** The member metadata without the window facts: the loaded flag and the section. */
	function withoutLoaded(projection: Readonly<MessageRenderProjectionV1>) {
		return projection.members.map(({ loaded: _loaded, section: _section, ...member }) => member);
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

	it("keeps the tool group, the owners of its calls and the completed turn while the tool turn is unloaded and after return", async () => {
		const { window, userId, toolCallEntryId, unwindowed, latest } = await createWindowedMode();
		const toolTurn = (projection: Readonly<MessageRenderProjectionV1>) => {
			const calls = projection.members.filter(
				(member) => "ownerEntryId" in member && member.ownerEntryId === toolCallEntryId,
			);
			const groupIds = new Set(calls.map((call) => ("groupId" in call ? call.groupId : undefined)));
			return projection.members
				.filter(
					(member) =>
						member.entryId === userId(2) ||
						calls.includes(member) ||
						(member.role === "tool-group" && groupIds.has(member.groupId)),
				)
				.map(({ loaded: _loaded, section: _section, ...member }) => member);
		};
		const expected = toolTurn(unwindowed());

		window(5);
		const unloaded = latest();
		window(1);

		expect(expected).toContainEqual(expect.objectContaining({ role: "tool-group", groupClosed: true }));
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

	describe("history continuation", () => {
		const EARLIER = "Earlier messages are not loaded — scroll up to load";
		const LATER = "Later messages are not loaded — scroll down to load";

		/** The rows of the mounted document with fixture markers in the startup chrome and the resource warnings. */
		async function documentWithChrome(options: { transcriptWindows?: boolean } = {}) {
			const session = await createWindowedMode(options);
			session.mode.headerContainer.addChild(new Text("FIXTURE-BANNER", 0, 0));
			session.mode.loadedResourcesContainer.addChild(new Text("FIXTURE-RESOURCES", 0, 0));
			session.mode.resourceDiagnosticsContainer.addChild(new Text("FIXTURE-WARNING", 0, 0));
			const rows = (width = 120) =>
				session.mode.documentContainer
					.render(width)
					.map((row) => stripAnsi(row).trim())
					.filter((row) => row.length > 0);
			return { ...session, rows };
		}

		it("puts an earlier-messages indicator, and no startup banner or resource list, above a later window", async () => {
			const { window, rows } = await documentWithChrome();

			window(5);

			const shown = rows();
			expect(shown.slice(0, 2)).toEqual(["FIXTURE-WARNING", EARLIER]);
			expect(shown).not.toContain("FIXTURE-BANNER");
			expect(shown).not.toContain("FIXTURE-RESOURCES");
		});

		it("keeps the startup banner and the resource list without an indicator above the first section", async () => {
			const { window, rows } = await documentWithChrome();

			window(1);

			const shown = rows();
			const order = ["FIXTURE-BANNER", "FIXTURE-RESOURCES", "FIXTURE-WARNING"].map((row) => shown.indexOf(row));
			expect({
				order: order.every((index, at) => index >= 0 && (at === 0 || index > order[at - 1]!)),
				earlier: shown.includes(EARLIER),
			}).toEqual({
				order: true,
				earlier: false,
			});
		});

		it("ends a window before the live tail with a later-messages indicator and the live tail without one", async () => {
			const { window, rows } = await documentWithChrome();

			window(5);
			const older = rows();
			window(8);
			const tail = rows();

			expect({
				olderEnd: older.at(-1),
				tailLater: tail.includes(LATER),
				tailNotice: tail.some((row) => row.includes("trailing-notice")),
			}).toEqual({ olderEnd: LATER, tailLater: false, tailNotice: true });
		});

		it("keeps the notice at the start of a section whole after the earlier-messages indicator", async () => {
			const { window, rows, text } = await documentWithChrome();

			window(5);
			const chat = text()
				.split("\n")
				.map((row) => row.trim())
				.filter((row) => row.length > 0);

			const shown = rows();
			expect(shown.slice(2, 2 + chat.length)).toEqual(chat);
		});

		it("shows one indicator of each kind after repeated windows and a refused window", async () => {
			const { window, requestWindow, rows } = await documentWithChrome();

			window(5);
			window(1);
			window(5);
			requestWindow({ entryId: "missing-entry", role: "user" });

			const shown = rows();
			expect([shown.filter((row) => row === EARLIER).length, shown.filter((row) => row === LATER).length]).toEqual([
				1, 1,
			]);
		});

		it("sets the indicators from the current window through a reload and a new session", async () => {
			const { mode, window, runtimeHost, rows } = await documentWithChrome({ transcriptWindows: true });
			const facts = () => {
				const shown = rows();
				return {
					earlier: shown.includes(EARLIER),
					later: shown.includes(LATER),
					warnings: mode.documentContainer.children.includes(mode.resourceDiagnosticsContainer),
				};
			};

			window(5);
			const older = facts();
			await (mode as unknown as { handleReloadCommand(): Promise<void> }).handleReloadCommand();
			const reloaded = facts();
			await runtimeHost.newSession();
			const fresh = facts();

			expect({ older, reloaded, fresh }).toEqual({
				older: { earlier: true, later: true, warnings: true },
				reloaded: { earlier: true, later: true, warnings: true },
				fresh: { earlier: false, later: false, warnings: true },
			});
		});

		it("wraps both indicators at a narrow width and keeps their words", async () => {
			const { window, rows } = await documentWithChrome();

			window(5);
			const narrow = rows(24).join(" ");

			for (const word of [...EARLIER.split(" "), ...LATER.split(" ")]) expect(narrow).toContain(word);
			expect(rows(24).every((row) => row.length <= 24)).toBe(true);
		});
	});

	it("loads the live tail before a message that the user submits from an older section", async () => {
		const { mode, window, latest, text } = await createWindowedMode();
		window(1);
		Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler").call(mode);
		const editor = (mode as unknown as { defaultEditor: { onSubmit: (text: string) => Promise<void> } })
			.defaultEditor;

		await editor.onSubmit("Question new");

		expect({ liveTail: latest().liveTail, tail: text().includes("trailing-notice") }).toEqual({
			liveTail: true,
			tail: true,
		});
	});

	it("publishes the turn of an unsolicited run while an older section stays loaded", async () => {
		const { runtimeHost, window, latest, text } = await createWindowedMode({
			faux: (faux) => faux.setResponses([fauxAssistantMessage("background answer")]),
		});
		window(1);
		const rows = () =>
			latest()
				.members.filter((member) => member.loaded !== false)
				.map((member) => [member.entryId, member.role, member.section]);
		const before = { text: text(), loaded: rows() };
		const tailSection = Math.max(...latest().members.map((member) => member.section ?? -1));
		const known = new Set(runtimeHost.session.sessionManager.getEntries().map((entry) => entry.id));

		await runtimeHost.session.prompt("Background question");
		const runIds = runtimeHost.session.sessionManager
			.getEntries()
			.filter((entry) => !known.has(entry.id) && entry.type === "message")
			.map((entry) => entry.id);
		await vi.waitFor(() => expect(latest().members.some((member) => member.entryId === runIds.at(-1))).toBe(true));

		expect({
			text: text(),
			loaded: rows(),
			run: latest()
				.members.filter((member) => runIds.includes(member.entryId))
				.map((member) => [member.role, member.loaded, member.section]),
		}).toEqual({
			...before,
			run: [
				["user", false, tailSection],
				["assistant", false, tailSection],
			],
		});
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
	describe("section facts and interval requests", () => {
		/** The section of each turn: compactions come before turns 4 and 8. */
		const turnSection = (turn: number) => (turn < 4 ? 0 : turn < 8 ? 1 : 2);
		const sectionsOf = (projection: Readonly<MessageRenderProjectionV1>) =>
			projection.members.map((member) => member.section);

		it("gives every windowed member, also an unloaded one, the section of its item", async () => {
			const { window, unwindowed, latest, journal } = await createWindowedMode();
			const turnOf = (entryId: string) => journal.findIndex((ids) => ids.includes(entryId));
			// A Tool Group has no owner; it is in the section of its first call.
			const ownerOf = (member: Readonly<MessageRenderProjectionMemberV1>): string => {
				const owned =
					member.role === "tool-group"
						? latest().members.find(
								(call) => call.role === "tool" && call.groupId === member.groupId && call.groupOrder === 0,
							)
						: member;
				return owned && "ownerEntryId" in owned ? owned.ownerEntryId : member.entryId;
			};

			window(5);

			expect(sectionsOf(unwindowed()).every((section) => section === undefined)).toBe(true);
			expect(sectionsOf(latest())).toEqual(latest().members.map((member) => turnSection(turnOf(ownerOf(member)))));
		});

		it("selects the inclusive section interval from one member through another", async () => {
			const { requestWindow, userId, latest, loadedTurns } = await createWindowedMode();

			const result = requestWindow({
				entryId: userId(2),
				role: "user",
				through: { entryId: userId(5), role: "user" },
			});

			expect(result).toEqual({ status: "applied" });
			expect(loadedTurns(latest())).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			expect(latest().liveTail).toBe(false);
		});

		it("addresses a section without a user message by its assistant member", async () => {
			const { requestWindow, journal, latest, text } = await openWindowedSession(oneTurnWithTwoCompactions);
			const markers = ["Question one", "path-t1", "path-t2", "path-t3", "path-t4", "Final answer"];

			requestWindow({
				entryId: journal.second,
				role: "assistant",
				through: { entryId: journal.final, role: "assistant" },
			});

			expect(markers.map((marker) => text().split(marker).length - 1)).toEqual([0, 0, 1, 1, 1, 1]);
			expect([...new Set(latest().members.map((member) => member.section))]).toEqual([0, 1, 2]);
		});

		it("refuses a reversed interval, an interval with an adjacent section and a missing or other-role end", async () => {
			const { requestWindow, userId, window, projections, text } = await createWindowedMode();
			window(5);
			const published = projections.length;
			const before = text();

			const results = [
				requestWindow({ entryId: userId(5), role: "user", through: { entryId: userId(1), role: "user" } }),
				requestWindow({
					entryId: userId(1),
					role: "user",
					adjacent: "next",
					through: { entryId: userId(5), role: "user" },
				}),
				requestWindow({ entryId: userId(1), role: "user", through: { entryId: "unknown", role: "user" } }),
				requestWindow({ entryId: userId(1), role: "user", through: { entryId: userId(5), role: "assistant" } }),
				requestWindow({ entryId: userId(1), role: "assistant", through: { entryId: userId(5), role: "user" } }),
			];

			expect(results.map((result) => result.status)).toEqual([
				"missing",
				"missing",
				"missing",
				"missing",
				"missing",
			]);
			expect(projections).toHaveLength(published);
			expect(text()).toBe(before);
		});

		it("keeps only the requested interval through repeated forward and backward transitions", async () => {
			const { requestWindow, userId, latest, loadedTurns, window } = await createWindowedMode();
			const interval = (from: number, through: number) =>
				requestWindow({ entryId: userId(from), role: "user", through: { entryId: userId(through), role: "user" } });

			window(5);
			const loaded: number[][] = [];
			for (const [from, through] of [
				[5, 8],
				[2, 5],
				[5, 8],
				[2, 5],
			] as const) {
				interval(from, through);
				loaded.push(loadedTurns(latest()));
			}

			expect(loaded).toEqual([
				[4, 5, 6, 7, 8],
				[0, 1, 2, 3, 4, 5, 6, 7],
				[4, 5, 6, 7, 8],
				[0, 1, 2, 3, 4, 5, 6, 7],
			]);
		});
	});

	describe("with an observer that accepts transcript windows", () => {
		const declared = { transcriptWindows: true };
		const loadedEntries = (projection: Readonly<MessageRenderProjectionV1>) => [
			...new Set(projection.members.filter((member) => member.loaded !== false).map((member) => member.entryId)),
		];

		it("opens a compacted session with only its last section and publishes every member", async () => {
			const { projections, journal, written, mode } = await openWindowedSession(nineTurns, declared);
			mode.renderer.renderNow();

			expect(projections).toHaveLength(1);
			expect(projections[0]).toMatchObject({ mode: "replace", liveTail: true });
			expect(
				projections[0]!.members.filter((member) => member.role === "user").map((member) => member.entryId),
			).toEqual(journal.map((turn) => turn[0]));
			expect(loadedEntries(projections[0]!)).toEqual(journal[8]);
			expect(written()).toContain("Question 8");
			expect(written()).not.toContain("Question 7");
			expect(written()).not.toContain("leading-notice");
		});

		it("opens a path without a compaction entry as one whole section", async () => {
			const { latest, journal, text } = await openWindowedSession(threeTurns, declared);

			expect(latest()).toMatchObject({ liveTail: true });
			expect(latest().members.every((member) => member.loaded !== false)).toBe(true);
			expect(
				latest()
					.members.filter((member) => member.role === "user")
					.map((member) => member.entryId),
			).toEqual(journal);
			expect(text()).toContain("Question 0");
		});

		it("opens the last section that has items when the path ends with a compaction entry", async () => {
			const { latest, journal, text } = await openWindowedSession(emptyLastInterval, declared);

			expect(latest()).toMatchObject({ liveTail: true });
			expect(
				latest()
					.members.filter((member) => member.role === "user" && member.loaded !== false)
					.map((member) => member.entryId),
			).toEqual(journal.slice(2));
			expect(text()).not.toContain("Question 1");
		});

		it("opens one turn with two compactions at its last cut", async () => {
			const { latest, journal, text } = await openWindowedSession(oneTurnWithTwoCompactions, declared);

			expect(loadedEntries(latest())).toEqual([journal.third, "tool-group:t4", "t4", journal.final]);
			expect(latest()).toMatchObject({ liveTail: true });
			expect(text()).toContain("path-t4");
			expect(text()).toContain("Final answer");
			expect(text()).not.toContain("path-t2");
			expect(text()).not.toContain("Question one");
		});

		it("adds every user message of the session to the editor history as a full render does", async () => {
			const windowed = await openWindowedSession(nineTurns, declared);
			const full = await openWindowedSession(nineTurns);

			expect(windowed.history()).toEqual(full.history());
			expect(windowed.history()).toEqual(Array.from({ length: 9 }, (_, index) => `Question ${8 - index}`));
		});

		it("opens the last section of the new path after a branch change", async () => {
			const { branch, latest, journal, text } = await openWindowedSession(nineTurns, declared);

			await branch(journal[6]![0]!);

			expect(latest()).toMatchObject({ mode: "replace", liveTail: true });
			expect(
				latest()
					.members.filter((member) => member.role === "user" && member.loaded !== false)
					.map((member) => member.entryId),
			).toEqual([journal[4]![0], journal[5]![0]]);
			expect(text()).toContain("Question 5");
			expect(text()).not.toContain("Question 3");
		});
	});
	describe("rebuilds of the same source with an observer that accepts transcript windows", () => {
		const declared = { transcriptWindows: true };
		const loadedUsers = (projection: Readonly<MessageRenderProjectionV1>) =>
			projection.members
				.filter((member) => member.role === "user" && member.loaded !== false)
				.map((member) => member.entryId);
		const reload = (mode: WindowedMode) =>
			(mode as unknown as { handleReloadCommand(): Promise<void> }).handleReloadCommand();

		it("keeps an older section with every member through both rebuilds of /reload", async () => {
			const { mode, window, userId, projections, latest, text } = await createWindowedMode(declared);
			window(1);
			const before = latest();
			const published = projections.length;

			await reload(mode);

			const rebuilt = projections.slice(published);
			const section = [0, 1, 2, 3].map(userId);
			expect(rebuilt.length).toBeGreaterThan(0);
			expect(rebuilt.map((projection) => [loadedUsers(projection), projection.liveTail])).toEqual(
				rebuilt.map(() => [section, false]),
			);
			expect(withoutLoaded(latest())).toEqual(withoutLoaded(before));
			expect(text()).toContain("Question 1");
			expect(text()).not.toContain("Question 8");
		});

		it("keeps an adjacent pair of sections through /reload", async () => {
			const { mode, window, userId, latest } = await createWindowedMode(declared);
			window(3, "next");

			await reload(mode);

			expect(loadedUsers(latest())).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(userId));
			expect(latest().liveTail).toBe(false);
		});

		it("opens the latest section on /reload after the selected path changed", async () => {
			const { mode, runtimeHost, window, userId, latest } = await createWindowedMode(declared);
			window(1);
			const appended = runtimeHost.session.sessionManager.appendMessage({
				role: "user",
				content: "Question 9",
				timestamp: 1,
			});

			await reload(mode);

			expect(loadedUsers(latest())).toEqual([userId(8), appended]);
			expect(latest().liveTail).toBe(true);
		});

		it("keeps the loaded section in a settings rebuild", async () => {
			const { mode, window, userId, latest } = await createWindowedMode(declared);
			window(5);
			const before = latest();

			(mode as unknown as { rebuildChatFromMessages(): void }).rebuildChatFromMessages();

			expect(loadedUsers(latest())).toEqual([4, 5, 6, 7].map(userId));
			expect(withoutLoaded(latest())).toEqual(withoutLoaded(before));
		});

		it("keeps the full render on /reload for an observer without the declaration", async () => {
			const { mode, window, latest } = await createWindowedMode();
			window(1);

			await reload(mode);

			expect(latest().liveTail).toBeUndefined();
			expect(latest().members.every((member) => member.loaded !== false)).toBe(true);
		});
	});
	describe("live compaction with an observer that accepts transcript windows", () => {
		const compactable = { transcriptWindows: true, settings: { compaction: { keepRecentTokens: 1 } } };
		const loadedUsers = (projection: Readonly<MessageRenderProjectionV1>) =>
			projection.members
				.filter((member) => member.role === "user" && member.loaded !== false)
				.map((member) => member.entryId);
		const summaries = (mode: WindowedMode) =>
			mode.chatContainer.children.filter(
				(component) => component.constructor.name === "CompactionSummaryMessageComponent",
			).length;
		/** Interactive mode handles session events through a promise chain; drain it, bounded, without timers. */
		const drainEvents = async () => {
			for (let turn = 0; turn < 50; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
		};
		const compact = async (mode: WindowedMode) => {
			await (mode as unknown as { handleCompactCommand(): Promise<void> }).handleCompactCommand();
			await drainEvents();
		};
		const reload = (mode: WindowedMode) =>
			(mode as unknown as { handleReloadCommand(): Promise<void> }).handleReloadCommand();
		/** "Question N" gets "Answer N"; any other request, such as a compaction summary, gets a summary. */
		const answering = (faux: ReturnType<typeof registerFauxProvider>) =>
			faux.setResponses(
				Array.from({ length: 20 }, () => (context: { messages: unknown[] }) => {
					const question = /Question (\d+)/.exec(JSON.stringify(context.messages.at(-1)))?.[1];
					return fauxAssistantMessage(question ? `Answer ${question}` : "SUMMARY");
				}),
			);

		it("renders the closed section and one summary after a manual compaction", async () => {
			const { mode, journal, latest, text } = await openWindowedSession(nineTurns, {
				...compactable,
				faux: answering,
			});

			await compact(mode);

			expect(summaries(mode)).toBe(1);
			expect(loadedUsers(latest())).toEqual([journal[8]![0]]);
			expect(latest().liveTail).toBe(true);
			expect(latest().members.filter((member) => member.role === "user")).toHaveLength(9);
			expect(text()).not.toContain("Question 7");
		});

		it("keeps the closed section and the reply after it on /reload", async () => {
			const { mode, runtimeHost, journal, latest } = await openWindowedSession(nineTurns, {
				...compactable,
				faux: answering,
			});
			await compact(mode);
			await runtimeHost.session.prompt("Question 9");
			await drainEvents();
			const reply = runtimeHost.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.at(-1)!.id;

			await reload(mode);

			expect(loadedUsers(latest())).toEqual([journal[8]![0], reply]);
			expect(latest().liveTail).toBe(true);
		});

		it("loads only the latest closed section after a second compaction", async () => {
			const { mode, runtimeHost, latest } = await openWindowedSession(nineTurns, {
				...compactable,
				faux: answering,
			});
			await compact(mode);
			await runtimeHost.session.prompt("Question 9");
			await runtimeHost.session.prompt("Question 10");
			await drainEvents();
			const users = runtimeHost.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map((entry) => entry.id);

			await compact(mode);

			expect(
				runtimeHost.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
			).toHaveLength(4);
			expect(summaries(mode)).toBe(1);
			expect(loadedUsers(latest())).toEqual(users.slice(-2));
			expect(latest().liveTail).toBe(true);
		});

		it("keeps the window facts in the projection of a live reply after the open", async () => {
			const { runtimeHost, journal, latest } = await openWindowedSession(nineTurns, {
				transcriptWindows: true,
				faux: answering,
			});

			await runtimeHost.session.prompt("Question 9");
			await drainEvents();
			const reply = runtimeHost.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.at(-1)!.id;

			expect(latest()).toMatchObject({ mode: "append", liveTail: true });
			expect(loadedUsers(latest())).toEqual([journal[8]![0], reply]);
		});

		it("keeps the published sections in a live reply and gives the reply the live tail section", async () => {
			const { runtimeHost, latest } = await openWindowedSession(nineTurns, {
				transcriptWindows: true,
				faux: answering,
			});
			const opened = latest().members.map((member) => member.section);

			await runtimeHost.session.prompt("Question 9");
			await drainEvents();

			const replied = latest().members.map((member) => member.section);
			expect(latest().mode).toBe("append");
			expect(replied.slice(0, opened.length)).toEqual(opened);
			expect(new Set(replied.slice(opened.length))).toEqual(new Set([2]));
		});

		it("renders the closed section and one summary after a boundary compaction at turn end", async () => {
			const { mode, runtimeHost, journal, latest, text } = await openWindowedSession(nineTurns, {
				transcriptWindows: true,
				turnEndCompaction: true,
				faux: answering,
			});

			await runtimeHost.session.prompt("Question 9");
			await drainEvents();
			const reply = runtimeHost.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.at(-1)!.id;

			expect(summaries(mode)).toBe(1);
			expect(loadedUsers(latest())).toEqual([journal[8]![0], reply]);
			expect(latest().liveTail).toBe(true);
			expect(text()).not.toContain("Question 7");
		});

		it("keeps an older loaded section through an unsolicited boundary compaction at turn end", async () => {
			const { mode, runtimeHost, journal, requestWindow, latest, text } = await openWindowedSession(nineTurns, {
				transcriptWindows: true,
				turnEndCompaction: true,
				faux: answering,
			});
			requestWindow({ entryId: journal[1]![0]!, role: "user" });
			const before = { users: loadedUsers(latest()), text: text() };

			await runtimeHost.session.prompt("Question 9");
			await drainEvents();
			const reply = runtimeHost.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.at(-1)!.id;

			expect({
				users: loadedUsers(latest()),
				text: text(),
				liveTail: latest().liveTail,
				summaries: summaries(mode),
				replyKnown: latest().members.some((member) => member.entryId === reply),
			}).toEqual({ ...before, liveTail: false, summaries: 0, replyKnown: true });
		});

		it("opens the latest section of the new path on /reload after a branch change", async () => {
			const { mode, branch, journal, requestWindow, latest } = await openWindowedSession(nineTurns, compactable);
			requestWindow({ entryId: journal[1]![0]!, role: "user" });

			await branch(journal[6]![0]!);
			await reload(mode);

			expect(loadedUsers(latest())).toEqual([journal[4]![0], journal[5]![0]]);
			expect(latest().liveTail).toBe(true);
		});

		it("keeps the full render after a compaction for an observer without the declaration", async () => {
			const { mode, latest } = await openWindowedSession(nineTurns, {
				settings: compactable.settings,
				faux: answering,
			});

			await compact(mode);

			expect(latest().liveTail).toBeUndefined();
			expect(latest().members.every((member) => member.loaded !== false)).toBe(true);
		});
	});
});
