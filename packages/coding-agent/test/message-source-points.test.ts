import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageRenderSourcePointV1 } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const CONTROL = "\x1b]777;point\x07";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("message source points", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps final user display-source identities stable across width reflow", () => {
		const source = `**bold** ${"prose🙂 ".repeat(100)}`;
		const points: MessageRenderSourcePointV1[] = [];
		const component = new UserMessageComponent(source, getMarkdownTheme(), 1, [], {
			entryId: "user-a",
			decorators: [],
			sourcePointDecorators: [
				(point) => {
					points.push({ ...point });
					return CONTROL;
				},
			],
		});
		const baseline80 = new UserMessageComponent(source, getMarkdownTheme(), 1).render(80).map(stripAnsi);
		const rendered80 = component.render(80);
		const points80 = points.splice(0);
		const baseline120 = new UserMessageComponent(source, getMarkdownTheme(), 1).render(120).map(stripAnsi);
		const rendered120 = component.render(120);
		const points120 = points.splice(0);

		expect(rendered80.map(stripAnsi)).toEqual(baseline80);
		expect(rendered120.map(stripAnsi)).toEqual(baseline120);
		expect(points80.length).toBeGreaterThan(0);
		expect(points120).toEqual(points80);
		expect(points80[0]).toMatchObject({
			entryId: "user-a",
			role: "user",
			state: "final",
			contentIndex: 0,
			pointKind: "offset",
		});
	});

	it.each([
		["family ZWJ", "a".repeat(508), "👨‍👩‍👧‍👦"],
		["regional pair", "a".repeat(510), "🇺🇦"],
		["combining sequence", "a".repeat(511), "e\u0301"],
	])("places byte samples before the complete %s grapheme that crosses the threshold", (_name, prefix, grapheme) => {
		const source = `${prefix}${grapheme} tail`;
		const points: MessageRenderSourcePointV1[] = [];
		const component = new UserMessageComponent(source, getMarkdownTheme(), 0, [], {
			entryId: "user-grapheme",
			decorators: [],
			sourcePointDecorators: [
				(point) => {
					points.push({ ...point });
					return CONTROL;
				},
			],
		});
		for (const width of [4, 7]) {
			const baseline = new UserMessageComponent(source, getMarkdownTheme(), 0).render(width).map(stripAnsi);
			expect(component.render(width).map(stripAnsi)).toEqual(baseline);
		}
		expect(points[0]?.sourceOffset).toBe(Buffer.byteLength(prefix, "utf8"));
	});

	it("emits stable final assistant points and abstains while streaming", () => {
		const source = `\`\`\`text\n${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}\n\`\`\``;
		const points: MessageRenderSourcePointV1[] = [];
		const component = new AssistantMessageComponent(
			assistant(source),
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
			[],
			{
				entryId: "assistant-a",
				decorators: [],
				sourcePointDecorators: [
					(point) => {
						points.push({ ...point });
						return CONTROL;
					},
				],
			},
		);
		component.render(80);
		const points80 = points.splice(0);
		component.render(120);
		const points120 = points.splice(0);
		expect(points80.length).toBeGreaterThan(0);
		expect(points120).toEqual(points80);
		expect(points80[0]).toMatchObject({ entryId: "assistant-a", role: "assistant", state: "final" });

		component.updateContent(assistant(source), true);
		component.render(80);
		expect(points).toEqual([]);
	});

	it("abstains when a width-dependent Markdown transform changes the source", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = new UserMessageComponent(
			"source ".repeat(100),
			getMarkdownTheme(),
			1,
			[(markdown) => `${markdown} changed`],
			{
				entryId: "user-a",
				decorators: [],
				sourcePointDecorators: [
					(point) => {
						points.push({ ...point });
						return CONTROL;
					},
				],
			},
		);
		component.render(80);
		expect(points).toEqual([]);
	});
});
