import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, ReplayCapture, ReplayCause, ReplayTransactionProvider } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class Lines implements Component {
	lines: string[] = [];
	readonly events: string[];
	constructor(events: string[]) {
		this.events = events;
	}
	render(_width: number): string[] {
		this.events.push("render");
		return this.lines;
	}
	invalidate(): void {}
}

class RecordingProvider implements ReplayTransactionProvider {
	captures = 0;
	causes: ReplayCause[] = [];
	readonly events: string[];
	constructor(events: string[]) {
		this.events = events;
	}
	capture(): ReplayCapture {
		this.captures += 1;
		this.events.push("capture");
		const generation = this.captures;
		return {
			transaction: (cause, columns, rows) => {
				this.causes.push(cause);
				return {
					begin: `\x1b]777;begin-${generation}-${cause}-${columns}x${rows}\x07`,
					end: `\x1b]777;end-${generation}\x07`,
				};
			},
		};
	}
}

function fixture(columns = 40, rows = 10) {
	const events: string[] = [];
	const terminal = new RecordingTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	const provider = new RecordingProvider(events);
	const content = new Lines(events);
	content.lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
	tui.addChild(content);
	tui.setReplayTransactionProvider(provider);
	const render = (): string => {
		terminal.writes = [];
		tui.renderNow();
		return terminal.writes.join("");
	};
	return { tui, terminal, provider, content, events, render };
}

function assertTransaction(output: string, cause: string): void {
	const begin = output.indexOf("\x1b]777;begin-");
	assert.ok(begin === 0, `begin is the first byte: ${JSON.stringify(output.slice(0, 40))}`);
	assert.match(output.slice(0, output.indexOf("\x07") + 1), new RegExp(`-${cause}-`));
	assert.ok(begin < output.indexOf("\x1b[?2026h"));
	const clear = output.indexOf("\x1b[2J");
	if (clear >= 0) assert.ok(begin < clear);
	assert.match(output, /\x1b\]777;end-\d+\x07$/);
}

describe("TUI replay transactions", () => {
	it("captures once per render before the components render", () => {
		const f = fixture();
		f.render();
		f.content.lines[29] = "changed tail";
		f.render();

		assert.deepEqual(f.events, ["capture", "render", "capture", "render"]);
		assert.equal(f.provider.captures, 2);
	});

	it("wraps the first render as first load", () => {
		const f = fixture();
		assertTransaction(f.render(), "first-load");
		assert.deepEqual(f.provider.causes, ["first-load"]);
	});

	it("wraps width and height changes as resize without waiting for a redraw request", () => {
		const f = fixture();
		f.render();
		f.terminal.resize(50, 10);
		assertTransaction(f.render(), "resize");
		f.terminal.resize(50, 12);
		assertTransaction(f.render(), "resize");
		assert.deepEqual(f.provider.causes, ["first-load", "resize", "resize"]);
	});

	it("wraps a forced replay as rebuild unless a cause was marked", () => {
		const f = fixture();
		f.render();
		f.terminal.writes = [];
		f.tui.renderNow(true);
		assertTransaction(f.terminal.writes.join(""), "rebuild");
		for (const cause of ["reload", "compact", "theme"] as const) {
			f.tui.markReplayCause(cause);
			f.terminal.writes = [];
			f.tui.renderNow(true);
			assertTransaction(f.terminal.writes.join(""), cause);
		}
		assert.deepEqual(f.provider.causes, ["first-load", "rebuild", "reload", "compact", "theme"]);
	});

	it("wraps an above-viewport rewrite as rebuild or its marked cause", () => {
		const f = fixture();
		f.render();
		f.content.lines[0] = "rewritten history";
		assertTransaction(f.render(), "rebuild");
		f.tui.markReplayCause("theme");
		f.content.lines[1] = "theme history";
		assertTransaction(f.render(), "theme");
	});

	it("leaves differential output unwrapped and consumes a marked cause once", () => {
		const f = fixture();
		f.render();
		f.tui.markReplayCause("theme");
		f.content.lines[29] = "streamed tail";
		const output = f.render();
		assert.ok(!output.includes("\x1b]777;"));
		f.content.lines[0] = "rewritten history";
		assertTransaction(f.render(), "rebuild");
		assert.deepEqual(f.provider.causes, ["first-load", "rebuild"]);
	});

	it("keeps the stock replay when the provider has no capture", () => {
		const f = fixture();
		f.tui.setReplayTransactionProvider({ capture: () => undefined });
		const output = f.render();
		assert.ok(!output.includes("\x1b]777;"));
		assert.ok(output.startsWith("\x1b[?2026h"));
	});
});
