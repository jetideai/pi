import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { MessageRenderBoundaryDecoratorV1 } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders a hidden Thinking placeholder only while thinking streams alone", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, true);
		const thinking = createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]);
		component.updateContent(thinking, true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Thinking...");

		component.updateContent(thinking, false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Thinking...");
	});

	test("removes the hidden Thinking placeholder when text or a Tool Call becomes visible", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Thinking...");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer");

		component.updateContent(
			createAssistantMessage([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
			]),
			true,
		);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Thinking...");
	});

	test.each([
		{
			stopReason: "stop" as const,
			text: "",
		},
		{
			stopReason: "aborted" as const,
			text: "Operation aborted",
		},
		{
			stopReason: "error" as const,
			text: "Error: Provider disconnected",
		},
		{
			stopReason: "length" as const,
			text: "Response was truncated before completion.",
		},
	])("does not render hidden thinking after a $stopReason assistant message", ({ stopReason, text }) => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], {
				stopReason,
				errorMessage: stopReason === "error" ? "Provider disconnected" : undefined,
			}),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).not.toContain("Thinking...");
		if (text) expect(rendered).toContain(text);
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const message = createAssistantMessage([
			{ type: "thinking", thinking: "first thought" },
			{ type: "thinking", thinking: "" },
			{ type: "thinking", thinking: "second thought" },
		]);
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message, true);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("composes assistant boundary controls around stock rows in registration order", () => {
		initTheme("dark");
		const firstPrefix = "\x1b[31m";
		const secondPrefix = "\x1b[32m";
		const firstSuffix = "\x1b[39m";
		const secondSuffix = "\x1b[0m";
		const message = createAssistantMessage([{ type: "text", text: "stock text" }]);
		const stock = new AssistantMessageComponent(message).render(40);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], {
			entryId: "persisted-entry",
			decorators: [
				() => ({ prefix: firstPrefix, suffix: firstSuffix }),
				() => ({ prefix: secondPrefix, suffix: secondSuffix }),
			],
		});

		component.updateContent(message, true);
		const rendered = component.render(40);

		expect(rendered).toHaveLength(stock.length);
		expect(rendered).toEqual(
			stock.map((line, index) => {
				const prefix = index === 0 ? firstPrefix + secondPrefix : "";
				const suffix = index === stock.length - 1 ? secondSuffix + firstSuffix : "";
				return prefix + line + suffix;
			}),
		);
	});

	test("reports persisted identity and streaming extent to the assistant decorator", () => {
		initTheme("dark");
		const contexts: Parameters<MessageRenderBoundaryDecoratorV1>[0][] = [];
		const message = createAssistantMessage([{ type: "text", text: "stock text" }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], {
			entryId: "persisted-entry",
			decorators: [
				(context) => {
					contexts.push(context);
					return {};
				},
			],
		});

		component.updateContent(message, true);
		const rendered = component.render(40);

		expect(contexts).toEqual([
			{
				entryId: "persisted-entry",
				role: "assistant",
				state: "streaming",
				allocatedColumns: { start: 0, end: 40 },
				stockRows: { start: 0, end: rendered.length },
			},
		]);
	});

	test("reports current assistant extent after resize", () => {
		initTheme("dark");
		const contexts: Parameters<MessageRenderBoundaryDecoratorV1>[0][] = [];
		const message = createAssistantMessage([{ type: "text", text: "stock text" }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], {
			entryId: "persisted-entry",
			decorators: [
				(context) => {
					contexts.push(context);
					return {};
				},
			],
		});

		component.updateContent(message, true);
		component.render(40);
		const resized = component.render(24);

		expect(contexts.at(-1)).toEqual({
			entryId: "persisted-entry",
			role: "assistant",
			state: "streaming",
			allocatedColumns: { start: 0, end: 24 },
			stockRows: { start: 0, end: resized.length },
		});
	});

	test("reports final assistant state after streaming completes", () => {
		initTheme("dark");
		const contexts: Parameters<MessageRenderBoundaryDecoratorV1>[0][] = [];
		const message = createAssistantMessage([{ type: "text", text: "stock text" }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], {
			entryId: "persisted-entry",
			decorators: [
				(context) => {
					contexts.push(context);
					return {};
				},
			],
		});

		component.updateContent(message, true);
		component.render(40);
		component.updateContent(message, false);
		const final = component.render(40);

		expect(contexts.at(-1)).toEqual({
			entryId: "persisted-entry",
			role: "assistant",
			state: "final",
			allocatedColumns: { start: 0, end: 40 },
			stockRows: { start: 0, end: final.length },
		});
	});

	test("isolates a throwing assistant render decorator", () => {
		initTheme("dark");
		const validPrefix = "\x1b[35m";
		const validSuffix = "\x1b[0m";
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "stock survives" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[],
			{
				entryId: "entry-1",
				decorators: [
					() => {
						throw new Error("broken decorator");
					},
					() => ({ prefix: validPrefix, suffix: validSuffix }),
				],
			},
		);

		const rendered = component.render(40);
		expect(rendered[0].startsWith(validPrefix)).toBe(true);
		expect(rendered.at(-1)?.endsWith(validSuffix)).toBe(true);
		expect(stripAnsi(rendered.join("\n"))).toContain("stock survives");
	});

	test("isolates assistant decorator context mutations", () => {
		initTheme("dark");
		let observedWidth = 0;
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "stock survives" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[],
			{
				entryId: "entry-1",
				decorators: [
					(context) => {
						(context.allocatedColumns as { start: 0; end: number }).end = 1;
						return {};
					},
					(context) => {
						observedWidth = context.allocatedColumns.end;
						return {};
					},
				],
			},
		);

		component.render(40);

		expect(observedWidth).toBe(40);
	});

	test("rejects assistant render controls that occupy terminal cells", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "stock survives" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[],
			{
				entryId: "entry-1",
				decorators: [
					() => ({ prefix: "invalid\ncontrol", suffix: "\x1b[31m" }),
					() => ({ prefix: "visible", suffix: "\x1b[31m" }),
					() => ({ prefix: "\u0301", suffix: "\u200d" }),
				],
			},
		);

		const rendered = component.render(40).join("\n");

		expect(rendered).not.toContain("invalid");
		expect(rendered).not.toContain("visible");
		expect(rendered).not.toContain("\u0301");
		expect(rendered).not.toContain("\u200d");
	});

	test("does not decorate empty tool-only stock output", () => {
		initTheme("dark");
		let calls = 0;
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]),
			false,
			undefined,
			"Thinking...",
			1,
			[],
			{
				entryId: "entry-1",
				decorators: [
					() => {
						calls++;
						return { prefix: "\x1b[31m" };
					},
				],
			},
		);

		expect(component.render(40)).toEqual([]);
		expect(calls).toBe(0);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
