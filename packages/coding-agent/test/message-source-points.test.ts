import { createHash } from "node:crypto";
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

	it("keeps assistant block-start identities stable around an ordered list", () => {
		const source = [
			"Сделаю два атомарных коммита:",
			"",
			"1. VM toolchain provisioning + revision enforcement + tests/docs.",
			"2. Самодостаточный план JetPi resize-render fix, без реализации.",
			"",
			"Сначала проверю формат проектных планов и commit policy, затем закрою gates и VM cleanup.",
		].join("\n");
		const points: MessageRenderSourcePointV1[] = [];
		const component = new AssistantMessageComponent(
			assistant(source),
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
			[],
			{
				entryId: "assistant-list",
				decorators: [],
				sourcePointDecorators: [
					(point) => {
						points.push({ ...point });
						return CONTROL;
					},
				],
			},
		);
		const baseline80 = new AssistantMessageComponent(assistant(source)).render(80).map(stripAnsi);
		const rendered80 = component.render(80);
		const points80 = points.splice(0);
		const baseline120 = new AssistantMessageComponent(assistant(source)).render(120).map(stripAnsi);
		const rendered120 = component.render(120);
		const points120 = points.splice(0);

		expect(rendered80.map(stripAnsi)).toEqual(baseline80);
		expect(rendered120.map(stripAnsi)).toEqual(baseline120);
		expect(points120).toEqual(points80);
		expect(points80.map(({ pointKind, sourceOffset }) => [pointKind, sourceOffset])).toEqual([
			["block", Buffer.byteLength(source.slice(0, source.indexOf("1. VM")), "utf8")],
			["block", Buffer.byteLength(source.slice(0, source.indexOf("Сначала")), "utf8")],
		]);
		expect(points80.map(({ contentDigest }) => contentDigest)).toEqual([
			createHash("sha256").update(source, "utf8").digest("hex"),
			createHash("sha256").update(source, "utf8").digest("hex"),
		]);
	});

	it("keeps user block identities in normalized Markdown source", () => {
		const source = "Intro\ttext\n\n1. one\n2. two\n\nFinal";
		const normalizedSource = source.replace(/\t/g, "   ");
		const points: MessageRenderSourcePointV1[] = [];
		const component = new UserMessageComponent(source, getMarkdownTheme(), 1, [], {
			entryId: "user-blocks",
			decorators: [],
			sourcePointDecorators: [
				(point) => {
					points.push({ ...point });
					return CONTROL;
				},
			],
		});
		const baseline = new UserMessageComponent(source, getMarkdownTheme(), 1).render(40).map(stripAnsi);
		const rendered = component.render(40);

		expect(rendered.map(stripAnsi)).toEqual(baseline);
		expect(points).toEqual([
			expect.objectContaining({
				entryId: "user-blocks",
				pointKind: "block",
				sourceOffset: Buffer.byteLength("Intro   text\n\n", "utf8"),
				contentDigest: createHash("sha256").update(normalizedSource, "utf8").digest("hex"),
			}),
			expect.objectContaining({
				entryId: "user-blocks",
				pointKind: "block",
				sourceOffset: Buffer.byteLength("Intro   text\n\n1. one\n2. two\n\n", "utf8"),
				contentDigest: createHash("sha256").update(normalizedSource, "utf8").digest("hex"),
			}),
		]);
	});

	it("keeps block and display-line identities distinct at the same byte offset", () => {
		const source = "a\n\nb\n\nc\n\nd\n\ne";
		for (const width of [40, 80, 120]) {
			const points: MessageRenderSourcePointV1[] = [];
			const component = new AssistantMessageComponent(
				assistant(source),
				false,
				getMarkdownTheme(),
				"Thinking...",
				1,
				[],
				{
					entryId: "assistant-block-line",
					decorators: [],
					sourcePointDecorators: [
						(point) => {
							points.push({ ...point });
							return CONTROL;
						},
					],
				},
			);
			const baseline = new AssistantMessageComponent(assistant(source)).render(width).map(stripAnsi);
			const rendered = component.render(width);
			const tuples = points.map(({ pointKind, sourceOffset, contentDigest }) =>
				JSON.stringify({ pointKind, sourceOffset, contentDigest }),
			);

			expect(rendered.map(stripAnsi)).toEqual(baseline);
			expect(new Set(tuples).size).toBe(tuples.length);
			expect(points).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ pointKind: "block", sourceOffset: 12 }),
					expect.objectContaining({ pointKind: "line", sourceOffset: 12 }),
				]),
			);
			expect(rendered.join("\n").split(CONTROL)).toHaveLength(points.length + 1);
		}
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
