import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Image } from "../src/components/image.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { Terminal } from "../src/terminal.ts";
import {
	deleteKittyImage,
	encodeKitty,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class InputComponent extends TestComponent {
	renderCount = 0;

	override render(width: number): string[] {
		this.renderCount += 1;
		return super.render(width);
	}

	handleInput(data: string): void {
		this.lines = [data];
	}
}

const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

class BoundedWriteTerminal implements Terminal {
	readonly writes: string[] = [];
	columns = 80;
	rows = 24;
	readonly kittyProtocolActive = false;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

describe("TUI render scheduling", () => {
	it("renders keyboard input without waiting for a throttled frame", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputComponent();
		component.lines = ["initial"];
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		tui.renderNow();
		const renderCountBeforeInput = component.renderCount;

		// Queue a normal throttled render first. Keyboard input should preempt it.
		component.lines = ["pending"];
		tui.requestRender();
		terminal.sendInput("first");
		terminal.sendInput("second");
		terminal.sendInput("typed");
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.strictEqual(component.renderCount, renderCountBeforeInput + 1);
		assert.deepStrictEqual(component.lines, ["typed"]);
		tui.stop();
	});
});

describe("TUI debug logging", () => {
	it("writes redraw logs to the provided directory", async () => {
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-log-"));
		try {
			await withEnv({ PI_TUI_DEBUG_REDRAW: "1" }, async () => {
				const terminal = new VirtualTerminal(40, 10);
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);
				component.lines = ["test"];
				tui.start();
				await terminal.waitForRender();

				assert.match(readFileSync(join(logDir, "pi-tui-debug.log"), "utf-8"), /fullRender: first render/);
				tui.stop();
			});
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});
});

describe("TUI bounded render output", () => {
	it("splits a large full render without changing its output", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		component.lines = [kittyLine, kittyLine];
		tui.addChild(component);

		tui.renderNow();

		assert.ok(terminal.writes.length > 2, "large output should be split across terminal writes");
		assert.ok(
			terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS),
			"each terminal write should stay below the configured limit",
		);
		assert.strictEqual(
			terminal.writes.join(""),
			`\x1b[?2026h${kittyLine}\r\n${kittyLine}\x1b[?2026l`,
			"chunking must preserve the synchronized render output",
		);
	});

	it("splits large differential updates without a full redraw", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = ["before"];
		tui.renderNow();
		terminal.writes.length = 0;

		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		component.lines = ["before", kittyLine, kittyLine];
		tui.renderNow();

		assert.ok(terminal.writes.length > 2, "large output should be split across terminal writes");
		assert.ok(terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS));
		const output = terminal.writes.join("");
		assert.ok(output.startsWith("\x1b[?2026h"));
		assert.ok(output.endsWith("\x1b[?2026l"));
		assert.ok(!output.includes("\x1b[2J"), "the update should stay on the differential render path");
	});
});

/** Set each environment variable to `value`, returning a function that restores the previous state. */
function overrideEnv(names: readonly string[], value: string): () => void {
	const previousValues = names.map((name) => [name, process.env[name]] as const);
	for (const name of names) {
		process.env[name] = value;
	}
	return () => {
		for (const [name, previousValue] of previousValues) {
			if (previousValue === undefined) delete process.env[name];
			else process.env[name] = previousValue;
		}
	};
}

describe("TUI crash dump without configured log directory", () => {
	it("writes the crash dump to the OS temp directory instead of a home-directory default", async () => {
		// The TUI falls back to os.tmpdir() when no log directory is configured, so
		// isolate the test by pointing the temp directory at a fresh directory rather
		// than sharing the real one with concurrent test runs. os.tmpdir() reads
		// TMPDIR on POSIX and TEMP/TMP on Windows, so override all three.
		const crashDir = mkdtempSync(join(tmpdir(), "pi-tui-crash-"));
		const crashLogPath = join(crashDir, "pi-tui-crash.log");
		const restoreTmpdirEnv = overrideEnv(["TMPDIR", "TEMP", "TMP"], crashDir);
		try {
			const terminal = new VirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			component.lines = ["ok"];
			tui.start();
			await terminal.waitForRender();

			// Width overflow is detected in the differential render path
			component.lines = ["ok", "x".repeat(60)];
			assert.throws(
				() => tui.renderNow(),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.includes(crashLogPath), `error message should reference ${crashLogPath}`);
					return true;
				},
			);
			assert.match(readFileSync(crashLogPath, "utf-8"), /Terminal width: 40/);
		} finally {
			restoreTmpdirEnv();
			rmSync(crashDir, { recursive: true, force: true });
		}
	});
});

/** A range BEGIN on the header row, BODY before the image, a mark and END on two reserved image rows. */
function reservedRowMarkerLines(image: string): string[] {
	return [`${osc("begin")}header`, `${osc("body")}${image}`, osc("mark"), osc("end"), "after"];
}

const RESERVED_ROW_MARKS: Array<[string, number]> = [
	["begin", 0],
	["body", 1],
	["mark", 2],
	["end", 3],
];

function osc(mark: string): string {
	return `\x1b]7799;${mark}\x1b\\`;
}

/** The OSC 7799 payloads in parser order, each with the buffer row of the cursor when xterm parsed it. */
function recordOscRows(terminal: VirtualTerminal): Array<[string, number]> {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const marks: Array<[string, number]> = [];
	xterm.parser.registerOscHandler(7799, (data) => {
		marks.push([data, xterm.buffer.active.baseY + xterm.buffer.active.cursorY]);
		return true;
	});
	return marks;
}

/** The buffer row of the cursor at each end of a synchronized block. */
function recordSyncEndRows(terminal: VirtualTerminal): { ends: number[]; row: () => number } {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const row = () => xterm.buffer.active.baseY + xterm.buffer.active.cursorY;
	const ends: number[] = [];
	xterm.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
		if (params.includes(2026)) ends.push(row());
		return false;
	});
	return { ends, row };
}

describe("TUI final cursor inside the synchronized block", () => {
	// The production layout: the transcript, then the editor and the footer below it.
	const transcript = (output: string) => ["header", output, "tail"];
	for (const [name, editor, finalRow] of [
		["the cursor of the focused component", `editor${CURSOR_MARKER}`, 3],
		["the last content row without a cursor", "editor", 4],
	] as const) {
		for (const [path, before, after] of [
			["a full render", undefined, [...transcript("output 1"), editor, "footer"]],
			[
				"a differential render",
				[...transcript("output 1"), editor, "footer"],
				[...transcript("output 2"), editor, "footer"],
			],
			[
				"a render of deleted lines",
				[...transcript("output 1"), editor, "footer", "status"],
				[...transcript("output 1"), editor, "footer"],
			],
		] as const) {
			it(`ends ${path} at ${name}`, async () => {
				const terminal = new VirtualTerminal(40, 10);
				const component = new TestComponent();
				const tui: TUI = new TuiMainScreen(terminal);
				tui.addChild(component);
				if (before) {
					component.lines = [...before];
					tui.start();
					await terminal.waitForRender();
					await terminal.flush();
				}
				const rows = recordSyncEndRows(terminal);

				component.lines = [...after];
				if (before) tui.requestRender();
				else tui.start();
				await terminal.waitForRender();
				await terminal.flush();

				assert.deepEqual({ ends: rows.ends, final: rows.row() }, { ends: [finalRow], final: finalRow });
				tui.stop();
			});
		}
	}
});

describe("TUI Kitty image cleanup", () => {
	it("clears reserved Kitty image rows before drawing appended image placements", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(
				writes.includes(`\x1b[2K\r\n\x1b[2K\x1b[1A${imageSequence}\x1b[1B`),
				"reserved rows should be cleared before the image placement is drawn",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[2K`),
				"reserved row clears must not run after the image placement is drawn",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back to full redraw when Kitty image pre-clear would scroll", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 2);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			component.lines = ["before", ...image.render(40), "after"];
			tui.requestRender();
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > redrawsBeforeImage, "unsafe image pre-clear should force a full redraw");
			assert.ok(terminal.getWrites().includes("\x1b[2J"), "fallback should clear and fully redraw");

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("reserves Kitty image rows before drawing during full redraw fallbacks", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["l0", "l1", "l2", "l3", "l4"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["l0", "l1", "l2", "l3", "l4", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(tui.fullRedraws > redrawsBeforeImage, "scrolling image append should force a full redraw");
			assert.ok(
				writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[1B`),
				"full redraw should reserve visible image rows before drawing the placement",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[0m`),
				"full redraw must not write reserved padding rows after drawing the placement",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("writes the zero-width content of reserved Kitty image rows at their rows during a full render", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const marks = recordOscRows(terminal);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			const image = encodeKitty("AAAA", { columns: 2, rows: 3, imageId: 51, moveCursor: false });
			component.lines = reservedRowMarkerLines(image);

			tui.start();
			await terminal.waitForRender();
			await terminal.flush();

			assert.deepEqual(marks, RESERVED_ROW_MARKS);
			assert.equal(terminal.getWrites().split(image).length - 1, 1, "the image placement is written once");
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("writes the zero-width content of reserved Kitty image rows at their rows during a differential render", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const marks = recordOscRows(terminal);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			const redraws = tui.fullRedraws;
			terminal.clearWrites();
			const image = encodeKitty("AAAA", { columns: 2, rows: 3, imageId: 52, moveCursor: false });

			component.lines = ["before", ...reservedRowMarkerLines(image)];
			tui.requestRender();
			await terminal.waitForRender();
			await terminal.flush();

			assert.equal(tui.fullRedraws, redraws, "the append stays a differential render");
			assert.deepEqual(
				marks,
				RESERVED_ROW_MARKS.map(([mark, row]) => [mark, row + 1]),
			);
			assert.equal(terminal.getWrites().split(image).length - 1, 1, "the image placement is written once");
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("does not use cursor-up placement for Kitty images taller than the viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 6 },
				{ widthPx: 60, heightPx: 60 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			assert.ok(imageLines.length > terminal.rows, "test image should exceed the viewport height");

			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender(true);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(imageSequence), "image placement should be drawn");
			assert.ok(
				!writes.includes(`\x1b[${imageLines.length - 1}A${imageSequence}`),
				"taller-than-viewport images must keep the #4461 first-row placement path",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("deletes changed image ids before drawing moved placements", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(newImage);
		assert.ok(deleteIndex >= 0, "changed old image should be deleted");
		assert.ok(drawIndex >= 0, "new image should be drawn");
		assert.ok(deleteIndex < drawIndex, "old image must be deleted before the new placement is drawn");

		tui.stop();
	});

	it("redraws image lines when an earlier reserved image row changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		component.lines = ["", image];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["covered", image];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		assert.ok(drawIndex >= 0, "unchanged image line should be redrawn after deleting the placement");
		assert.ok(deleteIndex < drawIndex, "old placement must be deleted before the image line is redrawn");
		assert.ok(!writes.includes("\x1b[2J"), "reserved row changes should not force a full redraw");

		tui.stop();
	});

	it("deletes previously rendered image ids during full redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "previous image should be deleted during full redraw");
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		assert.ok(deleteIndex < clearIndex, "old image should be deleted before the screen is cleared");

		tui.stop();
	});
});

describe("TUI resize handling", () => {
	it("lets a queued semantic redraw tag the width-change replay", async () => {
		await withEnv({ JETIDEAI_SEMANTIC_LAYERS_ENABLED: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			component.lines = ["A long transcript line", "The final line"];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();
			const initialRedraws = tui.fullRedraws;

			terminal.resize(50, 10);
			tui.renderNow();
			assert.equal(tui.fullRedraws, initialRedraws, "the resize must leave the replay available for its request");
			assert.equal(tui.requestSemanticRedraw({ requestId: "resize-1", columns: 50, rows: 10 }), true);
			tui.renderNow();

			assert.equal(tui.fullRedraws, initialRedraws + 1);
			assert.match(terminal.getWrites(), /8:resize-1;6:resize;/);
			assert.equal(terminal.getWrites().split("\x1b[2J").length - 1, 1);
			tui.stop();
		});
	});

	it("replays an ordinary resize if no semantic redraw request arrives", async () => {
		await withEnv({ JETIDEAI_SEMANTIC_LAYERS_ENABLED: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			component.lines = ["Original content"];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();
			const initialRedraws = tui.fullRedraws;

			terminal.resize(50, 10);
			await terminal.waitForRender();
			assert.equal(tui.fullRedraws, initialRedraws + 1);
			assert.match(terminal.getWrites(), /Original content/);
			assert.ok(!terminal.getWrites().includes("jetideai.redraw.v1"));
			tui.stop();
		});
	});

	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.waitForRender();

			const initialRedraws = tui.fullRedraws;

			// Resize height
			terminal.resize(40, 15);
			await terminal.waitForRender();

			// Should have triggered a full redraw
			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("waits for the requested grid before reporting one correlated semantic redraw", async () => {
		await withEnv({ JETIDEAI_SEMANTIC_LAYERS_ENABLED: "1", TERMUX_VERSION: undefined }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			component.lines = ["Line 0", "Line 1", `Line 2${CURSOR_MARKER}`];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			assert.equal(tui.requestSemanticRedraw({ requestId: "redraw-request-1", columns: 40, rows: 15 }), true);
			await terminal.waitForRender();
			assert.ok(!terminal.getWrites().includes("jetideai.redraw.v1"));
			terminal.clearWrites();

			terminal.resize(40, 15);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			const begin = writes.indexOf("\x1b]7799;1;begin;18:jetideai.redraw.v1;");
			const clear = writes.indexOf("\x1b[2J\x1b[H\x1b[3J");
			const replay = writes.indexOf("Line 2");
			const finalCursor = writes.lastIndexOf("G");
			const end = writes.indexOf("\x1b]7799;1;end;18:jetideai.redraw.v1;");
			assert.ok(begin >= 0, "resize redraw should have a begin marker");
			assert.ok(begin < clear, "begin should precede the destructive clear");
			assert.ok(clear < replay, "clear should preserve the ordinary transcript replay");
			assert.ok(replay < finalCursor, "the replay should precede final cursor placement");
			assert.ok(finalCursor < end, "end should follow all output in the redraw");
			assert.match(writes, /16:redraw-request-1;6:resize;/);
			assert.match(writes, /24:\{"columns":40,"rows":15\}/);

			tui.stop();
		});
	});

	it("reports a requested redraw when the terminal already has the requested grid", async () => {
		await withEnv({ JETIDEAI_SEMANTIC_LAYERS_ENABLED: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			component.lines = ["Line 0", `Line 1${CURSOR_MARKER}`];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();
			const initialRedraws = tui.fullRedraws;

			assert.equal(tui.requestSemanticRedraw({ requestId: "obsolete-grid", columns: 80, rows: 24 }), true);
			assert.equal(tui.requestSemanticRedraw({ requestId: "matching-grid", columns: 40, rows: 10 }), true);
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > initialRedraws);
			assert.match(terminal.getWrites(), /13:matching-grid;6:resize;/);
			assert.ok(!terminal.getWrites().includes("obsolete-grid"));
			tui.stop();
		});
	});

	it("does not report resize redraws outside the JetIDEAI semantic integration", async () => {
		for (const capability of ["0", undefined]) {
			await withEnv({ JETIDEAI_SEMANTIC_LAYERS_ENABLED: capability, TERMUX_VERSION: undefined }, async () => {
				const terminal = new LoggingVirtualTerminal(40, 10);
				const tui: TUI = new TuiMainScreen(terminal);
				const component = new TestComponent();
				component.lines = ["Line 0"];
				tui.addChild(component);
				tui.start();
				await terminal.waitForRender();
				terminal.clearWrites();

				terminal.resize(50, 10);
				await terminal.waitForRender();

				assert.ok(!terminal.getWrites().includes("jetideai.redraw.v1"));
				tui.stop();
			});
		}
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.waitForRender();
			}

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			const viewport = terminal.getViewport();
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Resize width
		terminal.resize(60, 10);
		await terminal.waitForRender();

		// Should have triggered a full redraw
		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks significantly", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		// Start with many lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Shrink to fewer lines
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		// Should have triggered a full redraw to clear empty rows
		assert.ok(tui.fullRedraws > initialRedraws, "Content shrinkage should trigger full redraw");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		// Lines below should be empty (cleared)
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to single line
		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// All lines should be empty
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 5 identical lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render
		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Simulate spinner animation - only middle line changes
		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only first line
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only last line
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		// Clear to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		// Add content back - this should work correctly even after empty state
		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);

		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		chat.lines = longChat;
		editor.lines = editorLines;
		tui.start();
		await terminal.waitForRender();

		editor.lines = selectorLines;
		tui.requestRender();
		await terminal.waitForRender();

		editor.lines = editorLines;
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeSwitch = tui.fullRedraws;
		chat.lines = shortChat;
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > redrawsBeforeSwitch, "Branch switch should trigger a full redraw");

		const viewport = terminal.getViewport();
		for (let i = 0; i < 10; i++) {
			const line = viewport[i] ?? "";
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		assert.deepStrictEqual(viewport, [
			"Chat 5",
			"Chat 6",
			"Chat 7",
			"Chat 8",
			"Chat 9",
			"Chat 10",
			"Chat 11",
			"Editor 0",
			"Editor 1",
			"Editor 2",
		]);

		tui.stop();
	});
});

/** A Kitty image line of [imageId] whose payload has transmission [generation], 2 columns x 3 rows. */
function registeredImage(imageId: number, generation: number): string {
	registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 20, heightPx: 30 }, generation);
	return encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
}

/** A main screen terminal whose written output can wait in a queue until the test drains it. */
class QueuedLoggingTerminal extends LoggingVirtualTerminal {
	queued = false;
	private drainListeners: (() => void)[] = [];

	outputQueued(): boolean {
		return this.queued;
	}

	onceOutputDrained(listener: () => void): void {
		this.drainListeners.push(listener);
	}

	drain(): void {
		this.queued = false;
		for (const listener of this.drainListeners.splice(0)) listener();
	}
}

/** The terminal replies of [replies], split once in the middle and parsed by the production input buffer. */
function replyThroughInputBuffer(terminal: VirtualTerminal, replies: string): void {
	const buffer = new StdinBuffer();
	buffer.on("data", (sequence) => terminal.sendInput(sequence));
	const middle = Math.floor(replies.length / 2);
	buffer.process(replies.slice(0, middle));
	buffer.process(replies.slice(middle));
}

const enoent = (imageId: number) => `\x1b_Gi=${imageId};ENOENT:image not found\x1b\\`;

/** A focused component that records its input and keeps its lines. */
class RecordingInputComponent extends TestComponent {
	received: string[] = [];

	handleInput(data: string): void {
		this.received.push(data);
	}
}

/** A main screen with [lines] after its first render, with no semantic resize deferral. */
async function startedScreen(lines: string[], terminal = new QueuedLoggingTerminal(40, 10)) {
	const tui = new TuiMainScreen(terminal);
	const component = new RecordingInputComponent();
	component.lines = lines;
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await terminal.waitForRender();
	terminal.clearWrites();
	return { terminal, tui, component };
}

describe("TUI image reuse in a full replay", () => {
	const fresh = (output: string) => output.includes("a=T") && output.includes("\x1b[2J");
	const reused = (output: string) =>
		!output.includes("a=T") &&
		output.includes("\x1b_Ga=d,d=a,q=2\x1b\\\x1b[H\x1b[0J\x1b[3J") &&
		!output.includes("\x1b[2J");
	const withKitty = (run: () => Promise<void>) =>
		withEnv({ JETIDEAI_SEMANTIC_LAYERS_ENABLED: undefined }, async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			setCellDimensions({ widthPx: 10, heightPx: 10 });
			try {
				await run();
			} finally {
				resetCapabilitiesCache();
				setCellDimensions({ widthPx: 9, heightPx: 18 });
			}
		});

	it("replays an unchanged image as a placement of its new size with no image data after a resize", () =>
		withKitty(async () => {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (text) => text },
				{ imageId: 91 },
				{
					widthPx: 100,
					heightPx: 100,
				},
			);
			const terminal = new QueuedLoggingTerminal(40, 10);
			const tui = new TuiMainScreen(terminal);
			tui.addChild(image);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			terminal.resize(20, 10);
			await terminal.waitForRender();
			const output = terminal.getWrites();
			tui.stop();

			assert.deepEqual([reused(output), /\x1b_Ga=p,q=1,[^\x1b]*c=18,/.test(output)], [true, true]);
		}));

	it("transmits every image again after a differential render added an image and removed it", () =>
		withKitty(async () => {
			const first = registeredImage(92, 9201);
			const { terminal, tui, component } = await startedScreen(["header", first, "", "", "after"]);
			component.lines = ["header", first, "", "", "after", registeredImage(93, 9301), "", ""];
			tui.requestRender();
			await terminal.waitForRender();
			component.lines = ["header", first, "", "", "after"];
			tui.requestRender();
			await terminal.waitForRender();
			terminal.clearWrites();

			terminal.resize(30, 10);
			await terminal.waitForRender();
			const output = terminal.getWrites();
			tui.stop();

			assert.equal(fresh(output), true);
		}));

	it("keeps the zero-width content of reserved image rows at their rows in a reuse replay", () =>
		withKitty(async () => {
			const terminal = new QueuedLoggingTerminal(40, 10);
			const marks = recordOscRows(terminal);
			await startedScreen(reservedRowMarkerLines(registeredImage(94, 9401)), terminal);
			marks.length = 0;

			terminal.resize(30, 10);
			await terminal.waitForRender();
			await terminal.flush();

			assert.deepEqual([reused(terminal.getWrites()), marks], [true, RESERVED_ROW_MARKS]);
		}));

	it("transmits once for a batch of missing image replies and delivers none of them as input", () =>
		withKitty(async () => {
			const { terminal, tui, component } = await startedScreen(["header", registeredImage(95, 9501), "", ""]);
			terminal.resize(30, 10);
			await terminal.waitForRender();
			terminal.clearWrites();

			replyThroughInputBuffer(terminal, enoent(95) + enoent(95));
			await terminal.waitForRender();
			const output = terminal.getWrites();
			tui.stop();

			assert.deepEqual(
				[output.split("a=T").length - 1, output.split("\x1b[2J").length - 1, component.received],
				[1, 1, []],
			);
		}));

	it("schedules nothing for a missing image reply after a fresh replay or for an image it did not place", () =>
		withKitty(async () => {
			const { terminal, tui } = await startedScreen(["header", registeredImage(96, 9601), "", ""]);
			replyThroughInputBuffer(terminal, enoent(96));
			await terminal.waitForRender();
			const afterFresh = terminal.getWrites();
			terminal.resize(30, 10);
			await terminal.waitForRender();
			terminal.clearWrites();

			replyThroughInputBuffer(terminal, enoent(999));
			await terminal.waitForRender();
			const afterReuse = terminal.getWrites();
			tui.stop();

			assert.deepEqual([afterFresh, afterReuse], ["", ""]);
		}));

	it("transmits after the queued output drains and still delivers the input that arrived meanwhile", () =>
		withKitty(async () => {
			const { terminal, tui, component } = await startedScreen(["header", registeredImage(97, 9701), "", ""]);
			terminal.resize(30, 10);
			await terminal.waitForRender();
			terminal.clearWrites();
			terminal.queued = true;

			replyThroughInputBuffer(terminal, enoent(97));
			terminal.sendInput("x");
			await terminal.waitForRender();
			const whileQueued = terminal.getWrites();
			terminal.drain();
			await terminal.waitForRender();
			const afterDrain = terminal.getWrites();
			tui.stop();

			assert.deepEqual([whileQueued, component.received, fresh(afterDrain)], ["", ["x"], true]);
		}));
});
