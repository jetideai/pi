import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	createUIPromptId,
	createUIPromptResponseAvailability,
	type StandardPromptLifecycleSource,
} from "../src/core/extensions/ui-prompt-contract.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

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

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
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
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("keeps one persisted ID for each message lifecycle", async () => {
		type MessageLifecycleEvent = MessageStartEvent | MessageUpdateEvent | MessageEndEvent;
		const extensionEvents: MessageLifecycleEvent[] = [];
		const deliveryOrder: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("message_start", (event) => {
				extensionEvents.push(event);
				deliveryOrder.push(`extension:${event.type}:${event.entryId}`);
			});
			pi.on("message_update", (event) => {
				extensionEvents.push(event);
				deliveryOrder.push(`extension:${event.type}:${event.entryId}`);
			});
			pi.on("message_end", (event) => {
				extensionEvents.push(event);
				deliveryOrder.push(`extension:${event.type}:${event.entryId}`);
			});
		});
		const sessionEvents: MessageLifecycleEvent[] = [];
		const unsubscribe = runtimeHost.session.subscribe((event) => {
			if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
				sessionEvents.push(event);
				deliveryOrder.push(`listener:${event.type}:${event.entryId}`);
			}
		});

		await runtimeHost.session.prompt("same prompt");
		await runtimeHost.session.prompt("same prompt");
		unsubscribe();

		const branchMessages = runtimeHost.session.sessionManager.getBranch().filter((entry) => entry.type === "message");
		const userStarts = extensionEvents.filter(
			(event): event is MessageStartEvent => event.type === "message_start" && event.message.role === "user",
		);
		const assistantStarts = extensionEvents.filter(
			(event): event is MessageStartEvent => event.type === "message_start" && event.message.role === "assistant",
		);

		expect(userStarts.map((event) => event.entryId)).toHaveLength(2);
		expect(new Set(userStarts.map((event) => event.entryId)).size).toBe(2);
		expect(branchMessages.map((entry) => entry.id)).toEqual([
			userStarts[0]!.entryId,
			assistantStarts[0]!.entryId,
			userStarts[1]!.entryId,
			assistantStarts[1]!.entryId,
		]);

		for (const assistant of assistantStarts) {
			const lifecycle = extensionEvents.filter((event) => event.entryId === assistant.entryId);
			expect(lifecycle[0]?.type).toBe("message_start");
			expect(lifecycle.some((event) => event.type === "message_update")).toBe(true);
			expect(lifecycle.at(-1)?.type).toBe("message_end");
		}
		expect(sessionEvents.map((event) => [event.type, event.entryId])).toEqual(
			extensionEvents.map((event) => [event.type, event.entryId]),
		);
		for (let index = 0; index < deliveryOrder.length; index += 2) {
			expect(deliveryOrder[index]?.replace("extension:", "")).toBe(
				deliveryOrder[index + 1]?.replace("listener:", ""),
			);
		}
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("publishes the full resumed Tool Call projection before session_start", async () => {
		initTheme("dark");
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		cleanups.push(async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			stdoutWrite.mockRestore();
		});
		const observations: Array<
			| { type: "projection"; members: Array<[string, string]> }
			| { type: "session_start"; reason: SessionStartEvent["reason"] }
		> = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.registerMessageRenderProjectionObserverV1((projection) => {
				observations.push({
					type: "projection",
					members: projection.members.map((member) => [member.entryId, member.role]),
				});
			});
			pi.on("session_start", (event) => {
				observations.push({ type: "session_start", reason: event.reason });
			});
		});
		const sessionManager = runtimeHost.session.sessionManager;
		const rootUserId = sessionManager.appendMessage({ role: "user", content: "Run tools", timestamp: 1 });
		const assistantMessage: AssistantMessage = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "tool-b", name: "read", arguments: { path: "b" } },
			],
		};
		const assistantId = sessionManager.appendMessage(assistantMessage);
		const toolResult = (toolCallId: string): ToolResultMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: toolCallId }],
			isError: false,
			timestamp: 2,
		});
		sessionManager.appendMessage(toolResult("tool-a"));
		sessionManager.appendMessage(toolResult("tool-b"));
		const keptUserId = sessionManager.appendMessage({ role: "user", content: "Keep", timestamp: 3 });
		sessionManager.appendCompaction("summary", keptUserId, 100);
		const postUserId = sessionManager.appendMessage({ role: "user", content: "After", timestamp: 4 });
		const originalSessionFile = runtimeHost.session.sessionFile;
		if (!originalSessionFile) throw new Error("Expected a persisted session");

		await runtimeHost.newSession();
		observations.length = 0;
		const mode = new InteractiveMode(runtimeHost);
		cleanups.push(() => {
			const renderer = (mode as unknown as { renderer: { stop(options: { preserveScreen: boolean }): void } })
				.renderer;
			renderer.stop({ preserveScreen: true });
		});
		await runtimeHost.switchSession(originalSessionFile);

		expect(observations).toEqual([
			{
				type: "projection",
				members: [
					[rootUserId, "user"],
					[assistantId, "assistant"],
					[`tool-group:${assistantId}:tool-a`, "tool-group"],
					["tool-a", "tool"],
					["tool-b", "tool"],
					[keptUserId, "user"],
					[postUserId, "user"],
				],
			},
			{ type: "session_start", reason: "resume" },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("waits for asynchronous UI invalidation before disposing the old session", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		let invalidateStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			invalidateStarted = resolve;
		});
		let releaseInvalidation: () => void = () => {};
		const invalidationGate = new Promise<void>((resolve) => {
			releaseInvalidation = resolve;
		});
		runtimeHost.setBeforeSessionInvalidate(async () => {
			phases.push("beforeSessionInvalidate:start");
			invalidateStarted();
			await invalidationGate;
			phases.push("beforeSessionInvalidate:end");
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		const replacement = runtimeHost.newSession();
		await started;
		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate:start"]);
		expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());

		releaseInvalidation();
		await replacement;
		expect(phases).toEqual([
			"session_shutdown",
			"beforeSessionInvalidate:start",
			"beforeSessionInvalidate:end",
			"rebindSession",
		]);
	});

	it("delivers prompt invalidation before old-session disposal and replacement start", async () => {
		const phases: string[] = [];
		let releaseEnd: () => void = () => {};
		const endGate = new Promise<void>((resolve) => {
			releaseEnd = resolve;
		});
		let endStarted: () => void = () => {};
		const observedEnd = new Promise<void>((resolve) => {
			endStarted = resolve;
		});
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("ui_prompt_start", () => {
				phases.push("prompt:start");
			});
			pi.on("ui_prompt_end", async () => {
				phases.push("prompt:end:start");
				endStarted();
				await endGate;
				phases.push("prompt:end:done");
			});
			pi.on("session_start", (event) => {
				if (event.reason === "new") phases.push("session_start:new");
			});
		});
		let sink: Parameters<StandardPromptLifecycleSource["connect"]>[0] = async () => {};
		const source: StandardPromptLifecycleSource = {
			connect: (listener) => {
				sink = listener;
				return () => {};
			},
		};
		await runtimeHost.session.bindExtensions({ standardPromptLifecycleSource: source });
		const oldSession = runtimeHost.session;
		const promptId = createUIPromptId();
		await sink({
			type: "ui_prompt_start",
			reason: "ui_prompt",
			promptId,
			kind: "confirm",
			response: createUIPromptResponseAvailability("confirm"),
		});
		runtimeHost.setBeforeSessionInvalidate(() =>
			sink({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				promptId,
				kind: "confirm",
				resolution: "dismissed",
				source: "sessionInvalidated",
			}),
		);
		runtimeHost.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});

		const replacement = runtimeHost.newSession();
		await observedEnd;
		expect(phases).toEqual(["prompt:start", "prompt:end:start"]);
		expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());

		releaseEnd();
		await replacement;
		expect(phases).toEqual(["prompt:start", "prompt:end:start", "prompt:end:done", "session_start:new"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload.",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("waits for asynchronous UI invalidation during shutdown", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const oldSession = runtimeHost.session;
		let invalidateStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			invalidateStarted = resolve;
		});
		let releaseInvalidation: () => void = () => {};
		const invalidationGate = new Promise<void>((resolve) => {
			releaseInvalidation = resolve;
		});
		runtimeHost.setBeforeSessionInvalidate(async () => {
			invalidateStarted();
			await invalidationGate;
		});

		const shutdown = runtimeHost.dispose();
		await started;
		expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());

		releaseInvalidation();
		await shutdown;
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload.",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
