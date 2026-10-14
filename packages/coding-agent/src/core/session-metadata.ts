import type { Stats } from "fs";
import { type FileHandle, open, readdir, realpath, stat } from "fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { getSessionsDir, VERSION } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import {
	extractTextContent,
	type FileEntry,
	getMessageActivityTime,
	isMessageWithContent,
	mapWithConcurrency,
	parseSessionEntryLine,
	type SessionHeader,
	type SessionInfo,
} from "./session-manager.ts";

/** Catalog fields of a session. These are the SessionInfo fields without the full message text. */
export type SessionMetadata = Omit<SessionInfo, "allMessagesText">;

export interface SessionMetadataListOptions {
	/** Keep only the sessions whose real cwd is in one of these directories. */
	roots: readonly string[];
	/** Session storage. Default: the Pi sessions directory. */
	sessionDir?: string;
	/**
	 * True when sessionDir holds one directory of session files for each project.
	 * Default: true for the default storage, false for a given sessionDir.
	 */
	nested?: boolean;
	/** The reuse token of an earlier result for the same storage and roots. */
	reuse?: string;
	signal?: AbortSignal;
}

export interface SessionMetadataList {
	/** Sessions in the listAll() order. */
	sessions: SessionMetadata[];
	/** Opaque token. Give it to the next call to skip session files that did not change. */
	reuse: string;
}

/** A session file changed during each read attempt. */
export class SessionMetadataUnstableError extends Error {
	readonly path: string;

	constructor(path: string) {
		super(`Session file changed during ${MAX_READ_ATTEMPTS} read attempts: ${path}`);
		this.name = "SessionMetadataUnstableError";
		this.path = path;
	}
}

const REUSE_TOKEN_FORMAT = 1;
const MAX_READ_ATTEMPTS = 3;
const MAX_HEADER_SCAN_BYTES = 1024 * 1024;
const HEADER_CHUNK_BYTES = 64 * 1024;
const BODY_CHUNK_BYTES = 1024 * 1024;
const MAX_CONCURRENT_HEADER_READS = 64;
const MAX_CONCURRENT_BODY_READS = 10;
const NON_ASCII = /[^\x00-\x7f]/;
const LF = 0x0a;
const CR = 0x0d;

interface StoredMetadata {
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	/** Milliseconds. JSON keeps an invalid date as null. */
	created: number | null;
	modified: number;
	messageCount: number;
	firstMessage: string;
}

type StoredFile = [path: string, identity: string, metadata: StoredMetadata];

interface ReuseToken {
	format: number;
	sdk: string;
	scope: string;
	files: StoredFile[];
}

interface SessionFile {
	path: string;
	stats: Stats;
}

interface ListedSession {
	identity: string;
	metadata: SessionMetadata;
}

/**
 * List the catalog fields of the sessions that started inside the given roots.
 * The result is the same as listAll() without allMessagesText, filtered to the roots.
 * It reads only the header of a session outside the roots. With a reuse token, it does not read
 * a session file that has the same identity (device, inode, size, mtime and ctime) as before.
 * A token for other storage, other roots or another SDK version causes a full scan.
 * A cwd filesystem error other than ENOENT rejects the call.
 */
export async function listSessionMetadata(options: SessionMetadataListOptions): Promise<SessionMetadataList> {
	const { signal } = options;
	signal?.throwIfAborted();
	const sessionDir = options.sessionDir === undefined ? getSessionsDir() : normalizePath(options.sessionDir);
	const nested = options.nested ?? options.sessionDir === undefined;
	const roots = [...new Set(options.roots.map((root) => resolve(root)))].sort();
	const scope = JSON.stringify({ sessionDir, nested, roots });
	const known = readReuseToken(options.reuse, scope);
	const scopeCheck = new ProjectScope(roots);

	const files = await listSessionFiles(sessionDir, nested, signal);
	const selected = await mapWithConcurrency(
		files,
		MAX_CONCURRENT_HEADER_READS,
		async (file): Promise<SessionFile | ListedSession | null> => {
			const previous = known.get(file.path);
			if (previous && previous.identity === fileIdentity(file.stats)) {
				return (await scopeCheck.contains(previous.metadata.cwd)) ? previous : null;
			}
			const header = await readHeaderCwd(file.path);
			if (header === NOT_A_SESSION) return null;
			if (header !== HEADER_TOO_LARGE && !(await scopeCheck.contains(header))) return null;
			return file;
		},
		signal,
	);
	const listed = await mapWithConcurrency(
		selected,
		MAX_CONCURRENT_BODY_READS,
		async (candidate): Promise<ListedSession | null> => {
			if (candidate === null || "metadata" in candidate) return candidate;
			const read = await readSessionMetadata(candidate.path, signal);
			if (read === null || !(await scopeCheck.contains(read.metadata.cwd))) return null;
			return read;
		},
		signal,
	);

	const sessions = listed.filter((session): session is ListedSession => session !== null);
	sessions.sort((left, right) => right.metadata.modified.getTime() - left.metadata.modified.getTime());
	return {
		sessions: sessions.map((session) => session.metadata),
		reuse: writeReuseToken(scope, sessions),
	};
}

async function listSessionFiles(sessionDir: string, nested: boolean, signal?: AbortSignal): Promise<SessionFile[]> {
	let paths: string[];
	try {
		if (nested) {
			const entries = await readdir(sessionDir, { withFileTypes: true });
			const directories = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionDir, entry.name));
			paths = (
				await mapWithConcurrency(
					directories,
					MAX_CONCURRENT_HEADER_READS,
					async (directory) => {
						try {
							return (await readdir(directory)).filter(isSessionFileName).map((name) => join(directory, name));
						} catch {
							return [];
						}
					},
					signal,
				)
			).flat();
		} else {
			paths = (await readdir(sessionDir))
				.filter(isSessionFileName)
				.sort((left, right) => right.localeCompare(left))
				.map((name) => join(sessionDir, name));
		}
	} catch {
		signal?.throwIfAborted();
		return [];
	}

	const files = (
		await mapWithConcurrency(
			paths,
			MAX_CONCURRENT_HEADER_READS,
			async (path): Promise<SessionFile | null> => {
				try {
					return { path, stats: await stat(path) };
				} catch {
					return null;
				}
			},
			signal,
		)
	).filter((file): file is SessionFile => file !== null);
	// Same candidate order as listAll(), so equal modified times keep the listAll() order.
	if (nested) {
		files.sort(
			(left, right) =>
				right.stats.mtimeMs - left.stats.mtimeMs || basename(right.path).localeCompare(basename(left.path)),
		);
	}
	return files;
}

function isSessionFileName(name: string): boolean {
	return name.endsWith(".jsonl");
}

function fileIdentity(stats: Stats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

/** Containment of a real session cwd in the real roots. One realpath for each distinct cwd. */
class ProjectScope {
	private readonly realRoots: Promise<string[]>;
	private readonly realCwds = new Map<string, Promise<string | null>>();

	constructor(roots: string[]) {
		this.realRoots = Promise.all(roots.map(realpathOrNull)).then((paths) =>
			paths.filter((path): path is string => path !== null),
		);
	}

	async contains(cwd: string): Promise<boolean> {
		let realCwd = this.realCwds.get(cwd);
		if (!realCwd) {
			realCwd = realpathOrNull(cwd);
			this.realCwds.set(cwd, realCwd);
		}
		const [roots, path] = await Promise.all([this.realRoots, realCwd]);
		if (path === null) return false;
		return roots.some((root) => {
			const child = relative(root, path);
			return child === "" || (!child.startsWith("..") && !isAbsolute(child));
		});
	}
}

async function realpathOrNull(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

const NOT_A_SESSION = Symbol("not a session");
const HEADER_TOO_LARGE = Symbol("header too large");

/** Read the cwd of the first parsed entry, as buildSessionInfo() does. */
async function readHeaderCwd(path: string): Promise<string | typeof NOT_A_SESSION | typeof HEADER_TOO_LARGE> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r");
	} catch {
		return NOT_A_SESSION;
	}
	try {
		let header: FileEntry | null = null as FileEntry | null;
		const complete = await forEachLine(
			handle,
			HEADER_CHUNK_BYTES,
			(line) => {
				header = parseSessionEntryLine(line.toString("utf8"));
				return !header;
			},
			MAX_HEADER_SCAN_BYTES,
		);
		if (!complete) return HEADER_TOO_LARGE;
		if (!header || header.type !== "session") return NOT_A_SESSION;
		return typeof header.cwd === "string" ? header.cwd : "";
	} catch {
		return NOT_A_SESSION;
	} finally {
		await handle.close();
	}
}

async function readSessionMetadata(path: string, signal?: AbortSignal): Promise<ListedSession | null> {
	for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
		signal?.throwIfAborted();
		let handle: FileHandle;
		try {
			handle = await open(path, "r");
		} catch {
			return null;
		}
		try {
			const before = await handle.stat();
			const reducer = new SessionMetadataReducer();
			await forEachLine(handle, BODY_CHUNK_BYTES, (line) => reducer.add(line));
			const after = await handle.stat();
			if (fileIdentity(before) !== fileIdentity(after)) continue;
			const metadata = reducer.finish(path, after);
			return metadata ? { identity: fileIdentity(after), metadata } : null;
		} catch {
			// buildSessionInfo() also drops a session when its read or its reduction throws.
			signal?.throwIfAborted();
			return null;
		} finally {
			await handle.close();
		}
	}
	throw new SessionMetadataUnstableError(path);
}

/**
 * Give each line to onLine until it returns false. Split on LF, then on a lone CR, as readline
 * does with crlfDelay Infinity. Empty pieces are blank lines, which parseSessionEntryLine() skips.
 * Return false when maxBytes is read before onLine returns false or the file ends.
 */
async function forEachLine(
	handle: FileHandle,
	chunkBytes: number,
	onLine: (line: Buffer) => boolean,
	maxBytes = Number.POSITIVE_INFINITY,
): Promise<boolean> {
	const chunk = Buffer.allocUnsafe(chunkBytes);
	let carry: Buffer[] = [];
	let carryLength = 0;
	let scanned = 0;
	while (scanned < maxBytes) {
		const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - scanned), null);
		if (bytesRead === 0) {
			if (carryLength > 0) emitLine(Buffer.concat(carry, carryLength), onLine);
			return true;
		}
		scanned += bytesRead;
		let start = 0;
		let newline = chunk.indexOf(LF, 0);
		while (newline !== -1 && newline < bytesRead) {
			const piece = chunk.subarray(start, newline);
			const line = carryLength > 0 ? Buffer.concat([...carry, piece], carryLength + piece.length) : piece;
			carry = [];
			carryLength = 0;
			if (!emitLine(line, onLine)) return true;
			start = newline + 1;
			newline = chunk.indexOf(LF, start);
		}
		if (start < bytesRead) {
			carry.push(Buffer.from(chunk.subarray(start, bytesRead)));
			carryLength += bytesRead - start;
		}
	}
	const { bytesRead } = await handle.read(Buffer.allocUnsafe(1), 0, 1, null);
	if (bytesRead === 0) {
		if (carryLength > 0) emitLine(Buffer.concat(carry, carryLength), onLine);
		return true;
	}
	return false;
}

function emitLine(line: Buffer, onLine: (line: Buffer) => boolean): boolean {
	let start = 0;
	let carriageReturn = line.indexOf(CR, 0);
	while (carriageReturn !== -1) {
		if (!onLine(line.subarray(start, carriageReturn))) return false;
		start = carriageReturn + 1;
		carriageReturn = line.indexOf(CR, start);
	}
	return onLine(line.subarray(start));
}

/**
 * The buildSessionInfo() reduction without allMessagesText.
 * JSON syntax is ASCII, so latin1 and UTF-8 decoding give the same validity, keys, numbers and
 * ASCII strings. A line is decoded again as UTF-8 only when a catalog string of it has a
 * non-ASCII character. Each exception that buildSessionInfo() gets also occurs here.
 */
class SessionMetadataReducer {
	private header: SessionHeader | undefined;
	private rejected = false;
	private name: string | undefined;
	private messageCount = 0;
	private firstMessage = "";
	private lastActivityTime: number | undefined;

	add(line: Buffer): boolean {
		let entry = parseSessionEntryLine(line.toString("latin1"));
		if (entry && this.needsUtf8(entry)) entry = parseSessionEntryLine(line.toString("utf8"));
		if (entry) this.reduce(entry);
		return !this.rejected;
	}

	finish(path: string, stats: Stats): SessionMetadata | null {
		const header = this.header;
		if (!header || this.rejected) return null;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof this.lastActivityTime === "number" && this.lastActivityTime > 0
				? new Date(this.lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;
		return {
			path,
			id: header.id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			name: this.name,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp),
			modified,
			messageCount: this.messageCount,
			firstMessage: this.firstMessage || "(no messages)",
		};
	}

	private needsUtf8(entry: FileEntry): boolean {
		if (!this.header || entry.type === "session_info") return true;
		if (entry.type !== "message") return false;
		const message = entry.message;
		if (!isMessageWithContent(message)) return false;
		if (message.role !== "user" && message.role !== "assistant") return false;
		if (
			typeof (message as { timestamp?: unknown }).timestamp !== "number" &&
			NON_ASCII.test(String(entry.timestamp))
		) {
			return true;
		}
		if (this.firstMessage || message.role !== "user") return false;
		return NON_ASCII.test(extractTextContent(message));
	}

	private reduce(entry: FileEntry): void {
		if (!this.header) {
			if (entry.type !== "session") this.rejected = true;
			else this.header = entry;
			return;
		}
		if (entry.type === "session_info") this.name = entry.name?.trim() || undefined;
		if (entry.type !== "message") return;
		this.messageCount++;

		const activityTime = getMessageActivityTime(entry);
		if (typeof activityTime === "number") {
			this.lastActivityTime = Math.max(this.lastActivityTime ?? 0, activityTime);
		}

		const message = entry.message;
		if (!isMessageWithContent(message)) return;
		if (message.role !== "user" && message.role !== "assistant") return;
		const text = extractTextContent(message);
		if (text && !this.firstMessage && message.role === "user") this.firstMessage = text;
	}
}

function readReuseToken(reuse: string | undefined, scope: string): Map<string, ListedSession> {
	const known = new Map<string, ListedSession>();
	if (reuse === undefined) return known;
	let token: Partial<ReuseToken>;
	try {
		token = JSON.parse(reuse) as Partial<ReuseToken>;
	} catch {
		return known;
	}
	if (
		typeof token !== "object" ||
		token === null ||
		token.format !== REUSE_TOKEN_FORMAT ||
		token.sdk !== VERSION ||
		token.scope !== scope ||
		!Array.isArray(token.files)
	) {
		return known;
	}
	for (const file of token.files) {
		if (!Array.isArray(file) || typeof file[0] !== "string" || typeof file[1] !== "string") return new Map();
		const [path, identity, stored] = file;
		if (typeof stored !== "object" || stored === null) return new Map();
		known.set(path, {
			identity,
			metadata: {
				path,
				id: stored.id,
				cwd: stored.cwd,
				name: stored.name,
				parentSessionPath: stored.parentSessionPath,
				created: new Date(stored.created ?? Number.NaN),
				modified: new Date(stored.modified),
				messageCount: stored.messageCount,
				firstMessage: stored.firstMessage,
			},
		});
	}
	return known;
}

function writeReuseToken(scope: string, sessions: ListedSession[]): string {
	const token: ReuseToken = {
		format: REUSE_TOKEN_FORMAT,
		sdk: VERSION,
		scope,
		files: sessions.map(({ identity, metadata }) => [
			metadata.path,
			identity,
			{
				id: metadata.id,
				cwd: metadata.cwd,
				name: metadata.name,
				parentSessionPath: metadata.parentSessionPath,
				created: metadata.created.getTime(),
				modified: metadata.modified.getTime(),
				messageCount: metadata.messageCount,
				firstMessage: metadata.firstMessage,
			},
		]),
	};
	return JSON.stringify(token);
}
