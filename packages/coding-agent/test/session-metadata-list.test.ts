import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { listSessionMetadata, SessionManager, type SessionMetadata } from "../src/index.ts";

const probe = vi.hoisted(() => ({
	opened: [] as string[],
	drift: undefined as { path: string; remaining: number; calls: number } | undefined,
}));

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const open = async (...args: Parameters<typeof actual.open>) => {
		const handle = await actual.open(...args);
		const path = String(args[0]);
		probe.opened.push(path);
		const drift = probe.drift;
		if (!drift || drift.path !== path) return handle;
		return new Proxy(handle, {
			get(target, property) {
				if (property === "stat") {
					return async () => {
						const stats = await target.stat();
						if (drift.remaining <= 0) return stats;
						drift.remaining--;
						drift.calls++;
						stats.mtimeMs += drift.calls;
						return stats;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	return { ...actual, open, default: { ...actual, open } };
});

let temporary: string;
let workspace: string;
let outside: string;
let sessions: string;

beforeEach(() => {
	temporary = mkdtempSync(join(tmpdir(), "pi-session-metadata-"));
	workspace = join(temporary, "workspace");
	outside = join(temporary, "outside");
	sessions = join(temporary, "sessions");
	for (const directory of [join(workspace, "nested"), outside, sessions]) mkdirSync(directory, { recursive: true });
	probe.opened.length = 0;
	probe.drift = undefined;
});

afterEach(() => {
	rmSync(temporary, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("listSessionMetadata", () => {
	it("matches listAll for every catalog field of in-project sessions", async () => {
		writeCatalogFixture(sessions);

		const listed = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });

		expect(catalogRows(listed.sessions)).toEqual(await listAllInProject(sessions, [workspace]));
		expect(listed.sessions.map((session) => session.id).sort()).toEqual(EXPECTED_CATALOG_IDS);
	});

	it("matches listAll over the nested default Pi session storage", async () => {
		const agentDir = join(temporary, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeCatalogFixture(join(agentDir, "sessions", "--workspace--"));
		writeSession(join(agentDir, "sessions", "--nested--", "nested.jsonl"), [
			header("nested", join(workspace, "nested")),
			userMessage("Nested start", 4_000),
		]);

		const listed = await listSessionMetadata({ roots: [workspace] });

		expect(catalogRows(listed.sessions)).toEqual(await listAllInProject(undefined, [workspace]));
	});

	it("returns sessions in listAll order", async () => {
		writeCatalogFixture(sessions);

		const listed = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });

		const expected = (await SessionManager.listAll(sessions)).filter((session) =>
			listed.sessions.some((row) => row.path === session.path),
		);
		expect(listed.sessions.map((session) => session.path)).toEqual(expected.map((session) => session.path));
	});

	it("omits allMessagesText from every row", async () => {
		writeCatalogFixture(sessions);

		const listed = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });

		expect(listed.sessions.some((session) => "allMessagesText" in session)).toBe(false);
	});

	it("rejects a session cwd filesystem error other than a missing directory", async () => {
		const loop = join(temporary, "loop");
		writeSession(join(sessions, "loop.jsonl"), [header("loop", loop), userMessage("Loop", 1_000)]);
		mkdirSync(loop);
		rmSync(loop, { recursive: true });
		const { symlinkSync } = await import("node:fs");
		symlinkSync(loop, loop);

		await expect(listSessionMetadata({ sessionDir: sessions, roots: [workspace] })).rejects.toMatchObject({
			code: "ELOOP",
		});
	});
});

describe("listSessionMetadata reuse token", () => {
	const mutations: Array<[string, () => void]> = [
		["an append", () => appendLine(sessionPath("alpha"), userMessage("Later", 9_000))],
		["a name clear", () => appendLine(sessionPath("alpha"), sessionInfo("   "))],
		[
			"a same-size rewrite with a new mtime",
			() => {
				const path = sessionPath("alpha");
				const before = readFileSync(path);
				const after = Buffer.from(before.toString("utf8").replace("Alpha start", "Alpha stop!"));
				expect(after.length).toBe(before.length);
				writeFileSync(path, after);
				const mtime = new Date(statSync(path).mtimeMs + 60_000);
				utimesSync(path, mtime, mtime);
			},
		],
		[
			"a replacement",
			() => {
				const replacement = join(sessions, "alpha.jsonl.tmp");
				writeSession(replacement, [header("alpha", workspace), userMessage("Replaced", 7_000)]);
				renameSync(replacement, sessionPath("alpha"));
			},
		],
		["a rename", () => renameSync(sessionPath("alpha"), join(sessions, "renamed.jsonl"))],
		["a deletion", () => rmSync(sessionPath("alpha"))],
		[
			"a new file",
			() => writeSession(join(sessions, "gamma.jsonl"), [header("gamma", workspace), userMessage("Gamma", 8_000)]),
		],
		["a cwd that leaves the project", () => rmSync(join(workspace, "nested"), { recursive: true })],
	];

	it.each(mutations)("sees %s", async (_name, mutate) => {
		writeReuseFixture();
		const first = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });

		mutate();
		const second = await listSessionMetadata({ sessionDir: sessions, roots: [workspace], reuse: first.reuse });

		expect(catalogRows(second.sessions)).toEqual(await listAllInProject(sessions, [workspace]));
	});

	it("sees an archive move between two storages", async () => {
		writeReuseFixture();
		const archive = join(temporary, "sessions-archive");
		mkdirSync(join(archive, "--workspace--"), { recursive: true });
		const firstActive = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });
		const firstArchive = await listSessionMetadata({ sessionDir: archive, nested: true, roots: [workspace] });

		renameSync(sessionPath("alpha"), join(archive, "--workspace--", "alpha.jsonl"));
		const active = await listSessionMetadata({ sessionDir: sessions, roots: [workspace], reuse: firstActive.reuse });
		const archived = await listSessionMetadata({
			sessionDir: archive,
			nested: true,
			roots: [workspace],
			reuse: firstArchive.reuse,
		});

		expect([active.sessions.map((row) => row.id).sort(), archived.sessions.map((row) => row.id)]).toEqual([
			["beta", "nested-beta"],
			["alpha"],
		]);
	});

	it("does not read in-project transcript bodies on an unchanged second pass", async () => {
		writeReuseFixture();
		const first = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });
		probe.opened.length = 0;

		const second = await listSessionMetadata({ sessionDir: sessions, roots: [workspace], reuse: first.reuse });

		expect(second.sessions).toEqual(first.sessions);
		expect(probe.opened.filter((path) => path === sessionPath("alpha") || path === sessionPath("beta"))).toEqual([]);
	});

	it.each([
		["an invalid token", () => "not a reuse token"],
		["a version-mismatched token", (token: string) => tamper(token, (value) => ({ ...value, sdk: "0.0.0" }))],
		["a token for other roots", (token: string) => token],
	])("makes a full scan with %s", async (name, token) => {
		writeReuseFixture();
		const first = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });
		const tampered = tamper(token(first.reuse), (value) => ({
			...value,
			files: value.files.map(([path, identity, row]) => [path, identity, { ...row, firstMessage: "tampered" }]),
		}));
		const roots = name === "a token for other roots" ? [workspace, outside] : [workspace];

		const second = await listSessionMetadata({ sessionDir: sessions, roots, reuse: tampered });

		expect(catalogRows(second.sessions)).toEqual(await listAllInProject(sessions, roots));
	});

	it("retries a file that changes during the read", async () => {
		writeReuseFixture();
		probe.drift = { path: sessionPath("alpha"), remaining: 2, calls: 0 };

		const listed = await listSessionMetadata({ sessionDir: sessions, roots: [workspace] });

		expect(catalogRows(listed.sessions)).toEqual(await listAllInProject(sessions, [workspace]));
	});

	it("fails explicitly when a file keeps changing during the read", async () => {
		writeReuseFixture();
		probe.drift = { path: sessionPath("alpha"), remaining: Number.POSITIVE_INFINITY, calls: 0 };

		await expect(listSessionMetadata({ sessionDir: sessions, roots: [workspace] })).rejects.toMatchObject({
			name: "SessionMetadataUnstableError",
			path: sessionPath("alpha"),
		});
	});
});

const EXPECTED_CATALOG_IDS = [
	"blank-lines",
	"cleared",
	"empty-first-user",
	"fork",
	"header-time",
	"invalid-utf8",
	"mtime",
	"nbsp-name",
	"nested-cwd",
	"string-timestamp",
	"unicode",
];

function writeCatalogFixture(directory: string): void {
	mkdirSync(directory, { recursive: true });
	writeSession(join(directory, "unicode.jsonl"), [
		header("unicode", workspace),
		sessionInfo(" Назва là"),
		userMessage("Привіт — naïve ✓ à", 1_000),
		assistantMessage("Відповідь", 3_000),
		userMessage("Пізніше", 2_000),
	]);
	writeSession(join(directory, "cleared.jsonl"), [
		header("cleared", workspace),
		sessionInfo("First name"),
		sessionInfo("   "),
		userMessage(
			[
				{ type: "image", data: "", mimeType: "image/png" },
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
			1_500,
		),
	]);
	writeSession(join(directory, "header-time.jsonl"), [header("header-time", workspace)]);
	writeSession(join(directory, "mtime.jsonl"), [header("mtime", workspace, { timestamp: "not a date" })]);
	writeSession(join(directory, "fork.jsonl"), [], {
		raw: Buffer.from(
			[
				`${header("fork", workspace, { parentSession: "/sessions/parent.jsonl" })}\r\n`,
				"{not json}\r\n",
				`${userMessage("Forked", 5_000)}\r`,
				`${assistantMessage("Fork answer", 6_000)}\n`,
				'{"type":"message","message":{"role":"user"',
			].join(""),
		),
	});
	writeSession(join(directory, "string-timestamp.jsonl"), [
		header("string-timestamp", workspace),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-02-02T00:00:00.000Z",
			message: { role: "user", content: "No numeric timestamp" },
		}),
	]);
	writeSession(join(directory, "invalid-utf8.jsonl"), [], {
		raw: Buffer.concat([
			Buffer.from(`${header("invalid-utf8", workspace)}\n`),
			Buffer.from('{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":'),
			Buffer.from('{"role":"user","content":"bad '),
			Buffer.from([0xff, 0xc3]),
			Buffer.from(' byte","timestamp":1200}}\n'),
		]),
	});
	writeSession(join(directory, "empty-first-user.jsonl"), [
		header("empty-first-user", workspace),
		assistantMessage("Assistant first", 1_000),
		userMessage("", 1_100),
		userMessage("Second user", 1_200),
	]);
	writeSession(join(directory, "nbsp-name.jsonl"), [
		header("nbsp-name", workspace),
		sessionInfo(" Spaced "),
		userMessage("Start", 1_000),
	]);
	writeSession(join(directory, "nested-cwd.jsonl"), [
		header("nested-cwd", join(workspace, "nested")),
		userMessage("Nested", 1_000),
	]);
	writeSession(join(directory, "blank-lines.jsonl"), [], {
		raw: Buffer.from(
			["", "   ", "{broken", header("blank-lines", workspace), userMessage("After blanks", 1_000), ""].join("\n"),
		),
	});
	writeSession(join(directory, "not-session.jsonl"), [userMessage("No header", 1_000), header("late", workspace)]);
	writeSession(join(directory, "throws.jsonl"), [
		header("throws", workspace),
		userMessage("Valid start", 1_000),
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "assistant", content: 5 },
		}),
	]);
	writeSession(join(directory, "outside.jsonl"), [header("outside", outside), userMessage("Outside", 1_000)]);
	writeSession(join(directory, "missing-cwd.jsonl"), [
		header("missing-cwd", join(temporary, "missing")),
		userMessage("Missing", 1_000),
	]);
	writeSession(join(directory, "empty-cwd.jsonl"), [header("empty-cwd", ""), userMessage("Empty cwd", 1_000)]);
}

function writeReuseFixture(): void {
	writeSession(sessionPath("alpha"), [
		header("alpha", workspace),
		sessionInfo("Alpha"),
		userMessage("Alpha start", 1_000),
	]);
	writeSession(sessionPath("beta"), [header("beta", workspace), userMessage("Beta start", 2_000)]);
	writeSession(sessionPath("nested-beta"), [
		header("nested-beta", join(workspace, "nested")),
		userMessage("Nested beta", 2_500),
	]);
	writeSession(sessionPath("outside"), [header("outside", outside), userMessage("Outside", 3_000)]);
}

function sessionPath(name: string): string {
	return join(sessions, `${name}.jsonl`);
}

function writeSession(path: string, lines: string[], options: { raw?: Buffer } = {}): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, options.raw ?? `${lines.join("\n")}\n`);
}

function appendLine(path: string, line: string): void {
	appendFileSync(path, `${line}\n`);
}

function header(id: string, cwd: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, ...extra });
}

function sessionInfo(name: string): string {
	return JSON.stringify({
		type: "session_info",
		id: `i-${name.length}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		name,
	});
}

function userMessage(content: unknown, timestamp: number): string {
	return JSON.stringify({
		type: "message",
		id: `u-${timestamp}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content, timestamp },
	});
}

function assistantMessage(text: string, timestamp: number): string {
	return JSON.stringify({
		type: "message",
		id: `a-${timestamp}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp },
	});
}

interface TokenValue {
	sdk: string;
	files: Array<[string, string, Record<string, unknown>]>;
}

function tamper(token: string, change: (value: TokenValue) => TokenValue): string {
	try {
		return JSON.stringify(change(JSON.parse(token) as TokenValue));
	} catch {
		return token;
	}
}

type CatalogRow = Omit<SessionMetadata, "created" | "modified"> & { created: number; modified: number };

function catalogRows(rows: ReadonlyArray<SessionMetadata | SessionInfo>): CatalogRow[] {
	return rows
		.map((row) => {
			const { allMessagesText: _ignored, ...metadata } = row as SessionInfo;
			return { ...metadata, created: metadata.created.getTime(), modified: metadata.modified.getTime() };
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

async function listAllInProject(sessionDir: string | undefined, roots: string[]): Promise<CatalogRow[]> {
	const all = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.listAll();
	const realRoots = roots.map((root) => realpathSync(root));
	return catalogRows(
		all.filter((session) => {
			let cwd: string;
			try {
				cwd = realpathSync(session.cwd);
			} catch {
				return false;
			}
			return realRoots.some((root) => {
				const child = relative(root, cwd);
				return child === "" || (!child.startsWith("..") && !isAbsolute(child));
			});
		}),
	);
}
