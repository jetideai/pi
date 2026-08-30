import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Image } from "../src/components/image.ts";
import type { Terminal } from "../src/terminal.ts";
import {
	deleteKittyImage,
	encodeKitty,
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

class WrappingCursorComponent implements Component {
	readonly text: string;
	readonly cursor: number;
	readonly history: string[];

	constructor(text: string, cursor: number, history: string[]) {
		this.text = text;
		this.cursor = cursor;
		this.history = history;
	}

	render(width: number): string[] {
		const lines = [...this.history];
		for (let offset = 0; offset < this.text.length; offset += width) {
			const chunk = this.text.slice(offset, offset + width);
			if (this.cursor >= offset && this.cursor < offset + width) {
				const column = this.cursor - offset;
				lines.push(chunk.slice(0, column) + CURSOR_MARKER + chunk.slice(column));
			} else {
				lines.push(chunk);
			}
		}
		return lines;
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

	getWriteChunks(): readonly string[] {
		return this.writes;
	}

	clearWrites(): void {
		this.writes = [];
	}
}

function expandedToolGroupLines(toolCount = 32): string[] {
	return ["Before", "Group expanded", ...Array.from({ length: toolCount }, (_, index) => `Tool ${index}`), "After"];
}

async function withKittyImageRendering(run: () => Promise<void>): Promise<void> {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	try {
		await run();
	} finally {
		resetCapabilitiesCache();
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	}
}

function imageLinesWithFoldEnds(): { lines: string[]; toolEnd: string; groupEnd: string } {
	const image = new Image(
		"AAAA",
		"image/png",
		{ fallbackColor: (value) => value },
		{ maxWidthCells: 3 },
		{ widthPx: 30, heightPx: 30 },
	);
	const lines = image.render(40);
	const toolEnd = "\x1b]777;tool-end\x07";
	const groupEnd = "\x1b]777;group-end\x07";
	lines[lines.length - 1] += toolEnd + groupEnd;
	return { lines, toolEnd, groupEnd };
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
	it("writes a running-to-settled Tool Call and all boundaries in one synchronized update", async () => {
		const terminal = new LoggingVirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const begin = "\x1b]777;tool-begin\x07";
		const body = "\x1b]777;tool-body\x07";
		const end = "\x1b]777;tool-end\x07";
		component.lines = ["stock running header"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		const runningWrites = terminal.getWrites();
		terminal.clearWrites();
		component.lines = [
			`${begin}stock settled header`,
			`${body}canonical-1`,
			...Array.from({ length: 198 }, (_, index) => `canonical-${index + 2}`),
			`canonical-200${end}`,
		];
		tui.requestRender();
		await terminal.waitForRender();

		const [settledUpdate] = terminal.getWriteChunks();
		assert.ok(!runningWrites.includes("canonical-1"));
		assert.strictEqual(terminal.getWriteChunks().length, 1);
		assert.ok(settledUpdate);
		const positions = ["\x1b[?2026h", begin, body, "canonical-200", end, "\x1b[?2026l"].map((value) =>
			settledUpdate.indexOf(value),
		);
		assert.ok(positions.every((position) => position >= 0));
		assert.deepStrictEqual(
			positions,
			[...positions].sort((left, right) => left - right),
		);
		tui.stop();
	});

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
			await withEnv({ PI_DEBUG_REDRAW: "1" }, async () => {
				const terminal = new VirtualTerminal(40, 10);
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);
				component.lines = ["test"];
				tui.start();
				await terminal.waitForRender();

				assert.match(readFileSync(join(logDir, "pi-debug.log"), "utf-8"), /fullRender: first render/);
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

describe("TUI Kitty image cleanup", () => {
	it("writes zero-width boundary controls after image rows during the first render", async () => {
		await withKittyImageRendering(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			const image = imageLinesWithFoldEnds();
			component.lines = ["before", ...image.lines, "after"];

			tui.start();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(image.toolEnd), "first render should write the Tool Call END control");
			assert.ok(writes.includes(image.groupEnd), "first render should write the Tool Group END control");
			assert.ok(writes.indexOf(image.toolEnd) < writes.indexOf(image.groupEnd));
			tui.stop();
		});
	});

	it("writes zero-width boundary controls after image rows during an update", async () => {
		await withKittyImageRendering(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = imageLinesWithFoldEnds();
			component.lines = ["before", ...image.lines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(image.toolEnd), "updated render should write the Tool Call END control");
			assert.ok(writes.includes(image.groupEnd), "updated render should write the Tool Group END control");
			assert.ok(writes.indexOf(image.toolEnd) < writes.indexOf(image.groupEnd));
			tui.stop();
		});
	});

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
				writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[2B`),
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

	it("replaces only active-tail image placements during resize", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const historicalImage = encodeKitty("AAAA", { columns: 2, rows: 1, imageId: 90, moveCursor: false });
		const activeImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 91, moveCursor: false });
		component.lines = [
			historicalImage,
			...Array.from({ length: 20 }, (_, index) => `History ${index}`),
			activeImage,
			"After",
		];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(35, 8);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes(deleteKittyImage(90)), "Resize must retain committed image history");
		const deleteIndex = writes.indexOf(deleteKittyImage(91));
		const drawIndex = writes.indexOf(activeImage);
		assert.ok(deleteIndex >= 0, "Resize should delete the previous active image placement");
		assert.ok(drawIndex > deleteIndex, "Resize should redraw the active image after clearing its rows");
		assert.ok(!writes.includes("\n"), "Image resize must not scroll at the bottom margin");

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
	it("repaints the active tail without a full redraw when terminal height changes", async () => {
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

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("preserves retained history and a scrolled viewport when width changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 8);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			component.lines = Array.from({ length: 30 }, (_, index) =>
				index === 14 ? "WIDTH-HISTORY-ANCHOR" : `History ${index.toString().padStart(2, "0")}`,
			);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			terminal.scrollLines(-8);
			await terminal.flush();
			assert.ok(terminal.getViewport().join("\n").includes("WIDTH-HISTORY-ANCHOR"));
			terminal.clearWrites();

			terminal.resize(30, 8);
			await terminal.waitForRender();

			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Width resize must not clear retained history");
			assert.ok(!terminal.getWrites().includes("\n"), "Width resize must not scroll at the bottom margin");
			assert.ok(!terminal.getWrites().includes("History 00"), "Width resize must not replay committed history");
			assert.ok(terminal.getViewportOffset() > 0, "Width resize must keep the viewport above the tail");
			assert.ok(terminal.getViewport().join("\n").includes("WIDTH-HISTORY-ANCHOR"));
			assert.strictEqual(
				terminal.getScrollBuffer().filter((line) => line.includes("WIDTH-HISTORY-ANCHOR")).length,
				1,
			);

			terminal.clearWrites();
			component.lines[component.lines.length - 1] = "UPDATED-WIDTH-TAIL";
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Update after width resize must stay bounded");
			assert.ok(terminal.getViewportOffset() > 0);
			assert.ok(terminal.getViewport().join("\n").includes("WIDTH-HISTORY-ANCHOR"));

			terminal.resize(40, 8);
			await terminal.waitForRender();
			assert.ok(terminal.getViewportOffset() > 0);
			assert.ok(terminal.getViewport().join("\n").includes("WIDTH-HISTORY-ANCHOR"));
			assert.strictEqual(
				terminal.getScrollBuffer().filter((line) => line.includes("WIDTH-HISTORY-ANCHOR")).length,
				1,
			);

			tui.stop();
		});
	});

	it("preserves retained history and a scrolled viewport when height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 8);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			component.lines = Array.from({ length: 30 }, (_, index) =>
				index === 14 ? "HEIGHT-HISTORY-ANCHOR" : `History ${index.toString().padStart(2, "0")}`,
			);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			terminal.scrollLines(-8);
			await terminal.flush();
			assert.ok(terminal.getViewport().join("\n").includes("HEIGHT-HISTORY-ANCHOR"));
			terminal.clearWrites();

			terminal.resize(40, 10);
			await terminal.waitForRender();

			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height resize must not clear retained history");
			assert.ok(!terminal.getWrites().includes("\n"), "Height resize must not scroll at the bottom margin");
			assert.ok(!terminal.getWrites().includes("History 00"), "Height resize must not replay committed history");
			assert.ok(terminal.getViewportOffset() > 0, "Height resize must keep the viewport above the tail");
			assert.ok(terminal.getViewport().join("\n").includes("HEIGHT-HISTORY-ANCHOR"));
			assert.strictEqual(
				terminal.getScrollBuffer().filter((line) => line.includes("HEIGHT-HISTORY-ANCHOR")).length,
				1,
			);
			assert.strictEqual(
				terminal.getScrollBuffer().filter((line) => line.includes("History 20")).length,
				1,
				"Height growth must not duplicate active-tail rows",
			);

			terminal.clearWrites();
			component.lines[component.lines.length - 1] = "UPDATED-HEIGHT-TAIL";
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Update after height resize must stay bounded");
			assert.ok(terminal.getViewportOffset() > 0);
			assert.ok(terminal.getViewport().join("\n").includes("HEIGHT-HISTORY-ANCHOR"));

			tui.stop();
		});
	});

	it("does not duplicate tail rows when a scrolled terminal shrinks and grows", async () => {
		const terminal = new LoggingVirtualTerminal(40, 29);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 60 }, (_, index) => `Resize ${index.toString().padStart(2, "0")}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.scrollLines(-16);
		await terminal.flush();
		assert.strictEqual(
			terminal.getViewport().findIndex((line) => line.includes("Resize 25")),
			10,
		);

		terminal.resize(40, 15);
		await terminal.waitForRender();
		assert.ok(terminal.getViewportOffset() > 0);
		terminal.scrollLines(-14);
		await terminal.flush();
		assert.strictEqual(
			terminal.getViewport().findIndex((line) => line.includes("Resize 25")),
			10,
		);

		terminal.clearWrites();
		terminal.resize(40, 29);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("Resize 25")));
		assert.strictEqual(terminal.getWrites(), "", "Unchanged height growth must use terminal-native reflow");
		for (let index = 0; index < 60; index++) {
			const marker = `Resize ${index.toString().padStart(2, "0")}`;
			assert.ok(
				terminal.getScrollBuffer().filter((line) => line.includes(marker)).length <= 1,
				`${marker} must not be duplicated`,
			);
		}

		tui.stop();
	});

	it("keeps following the active tail when width and height change", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = [...Array.from({ length: 29 }, (_, index) => `History ${index}`), "ACTIVE-TAIL"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewportOffset(), 0);
		terminal.clearWrites();

		terminal.resize(30, 10);
		await terminal.waitForRender();

		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Tail resize must not clear retained history");
		assert.strictEqual(terminal.getViewportOffset(), 0);
		assert.ok(terminal.getViewport().join("\n").includes("ACTIVE-TAIL"));

		tui.stop();
	});

	it("moves an active overlay without leaving stale rows after height changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = ["Line 0", "Line 1"];
		const overlay = new TestComponent();
		overlay.lines = ["RESIZE-OVERLAY"];
		tui.addChild(component);
		tui.showOverlay(overlay, { width: 16 });
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 10);
		await terminal.waitForRender();

		assert.strictEqual(terminal.getViewport().filter((line) => line.includes("RESIZE-OVERLAY")).length, 1);
		assert.ok(!terminal.getWrites().includes("\n"), "Overlay resize must not scroll at the bottom margin");

		tui.stop();
	});

	it("keeps the logical cursor position while input wraps in both directions", async () => {
		const terminal = new VirtualTerminal(12, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new WrappingCursorComponent("abcdefghijklmnopqrstuvwxyz1234", 20, [
			"History 0",
			"History 1",
			"History 2",
			"History 3",
		]);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 8, y: 3 });

		terminal.resize(8, 5);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: 3 });

		terminal.resize(16, 5);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: 4 });

		tui.stop();
	});

	it("keeps repeated height changes bounded", async () => {
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

	it("repaints the active tail without a full redraw when terminal width changes", async () => {
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

		assert.strictEqual(tui.fullRedraws, initialRedraws, "Width change should not trigger full redraw");

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
	it("clears one removed visible tail with one bounded erase", async () => {
		const terminal = new LoggingVirtualTerminal(80, 40);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = expandedToolGroupLines();
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["Before", "Group collapsed", "After"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[1B\r\x1b[J\x1b[1A"), "removed tail should use one bounded erase");
		assert.strictEqual(writes.match(/\x1b\[J/g)?.length, 1, "removed tail should be erased once");

		tui.stop();
	});

	it("preserves the viewport and cursor after a bounded tail erase", async () => {
		const terminal = new VirtualTerminal(80, 40);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = expandedToolGroupLines();
		tui.start();
		await terminal.waitForRender();

		component.lines = ["Before", "Group collapsed", "After"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), ["Before", "Group collapsed", "After", ""]);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 0, y: 2 });

		component.lines = ["Before", "Group updated", "After"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport().slice(0, 3), ["Before", "Group updated", "After"]);

		tui.stop();
	});

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
