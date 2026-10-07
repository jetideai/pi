import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { buildMessageRenderProjection } from "../src/modes/interactive/components/transcript-projection.ts";

const usage =
	'{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,' +
	'"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}';
const assistant = `"api":"openai-completions","provider":"jetideai-proof","model":"assistant","usage":${usage}`;
const time = '"timestamp":"2026-01-01T00:00:00.001Z"';

/**
 * A branch root user whose tool-use assistant has an abandoned child branch. A branch summary of that branch leads to
 * a later settled user. The last line is the leaf.
 */
function unsettledBranchRootSession(cwd: string): string {
	const answer = JSON.stringify(Array.from({ length: 80 }, (_, line) => `- NEXT_ANSWER_LINE_${line}`).join("\n"));
	return [
		`{"type":"session","version":3,"id":"019ff2e7-5525-7389-b918-8f59e94b2b02",${time},"cwd":${JSON.stringify(cwd)}}`,
		`{"type":"message","id":"unsettled-root-user","parentId":null,${time},"message":{"role":"user",` +
			`"content":[{"type":"text","text":"UNSETTLED_BRANCH_ROOT_PROMPT"}],"timestamp":1}}`,
		`{"type":"message","id":"unsettled-root-tool-use","parentId":"unsettled-root-user",${time},` +
			`"message":{"role":"assistant","content":[{"type":"text","text":"Checking the file."},` +
			`{"type":"toolCall","id":"unsettled-root-call","name":"process","arguments":{"action":"list"}}],` +
			`${assistant},"stopReason":"toolUse","timestamp":2}}`,
		`{"type":"message","id":"unsettled-root-abandoned-result","parentId":"unsettled-root-tool-use",${time},` +
			`"message":{"role":"toolResult","toolCallId":"unsettled-root-call","toolName":"process",` +
			`"content":[{"type":"text","text":"ABANDONED_RESULT"}],"isError":false,"timestamp":3}}`,
		`{"type":"message","id":"unsettled-root-abandoned-answer","parentId":"unsettled-root-abandoned-result",${time},` +
			`"message":{"role":"assistant","content":[{"type":"text","text":"ABANDONED_ANSWER"}],` +
			`${assistant},"stopReason":"stop","timestamp":4}}`,
		`{"type":"branch_summary","id":"unsettled-root-summary","parentId":"unsettled-root-tool-use",${time},` +
			`"fromId":"unsettled-root-abandoned-answer","summary":"The user explored another branch."}`,
		`{"type":"message","id":"unsettled-next-user","parentId":"unsettled-root-summary",${time},` +
			`"message":{"role":"user","content":[{"type":"text","text":"UNSETTLED_BRANCH_NEXT_PROMPT"}],"timestamp":5}}`,
		`{"type":"message","id":"unsettled-next-answer","parentId":"unsettled-next-user",${time},` +
			`"message":{"role":"assistant","content":[{"type":"text","text":${answer}}],` +
			`${assistant},"stopReason":"stop","timestamp":6}}`,
	].join("\n");
}

describe("unsettled branch root session", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
	});

	function openSession(): SessionManager {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-unsettled-branch-root-"));
		tempDirs.push(tempDir);
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, `${unsettledBranchRootSession(tempDir)}\n`);
		return SessionManager.open(file, tempDir);
	}

	it("selects the branch through the summary and leaves the abandoned child out", () => {
		const branch = openSession().getBranch();

		expect(branch.map((entry) => entry.id)).toEqual([
			"unsettled-root-user",
			"unsettled-root-tool-use",
			"unsettled-root-summary",
			"unsettled-next-user",
			"unsettled-next-answer",
		]);
	});

	it("projects the root with its preview and no completed turn, and settles the later user", () => {
		const entries = new Map(
			openSession()
				.getBranch()
				.map((entry) => [entry.id, entry]),
		);

		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			mode: "replace",
			inferMissingTurns: true,
			members: [
				{ entryId: "unsettled-root-user", blockId: "unsettled-root-user", role: "user" },
				{ entryId: "unsettled-root-tool-use", blockId: "unsettled-root-tool-use", role: "assistant" },
				{ entryId: "unsettled-next-user", blockId: "unsettled-next-user", role: "user" },
				{ entryId: "unsettled-next-answer", blockId: "unsettled-next-answer", role: "assistant" },
			],
			readMessage: (entryId) => {
				const entry = entries.get(entryId);
				return entry?.type === "message" ? entry.message : undefined;
			},
		});

		expect(projection.members[0]).toEqual({
			entryId: "unsettled-root-user",
			blockId: "unsettled-root-user",
			role: "user",
			preview: "UNSETTLED_BRANCH_ROOT_PROMPT",
		});
		expect(projection.members[2]).toMatchObject({
			preview: "UNSETTLED_BRANCH_NEXT_PROMPT",
			completedTurn: { assistantEntryId: "unsettled-next-answer" },
		});
	});
});
