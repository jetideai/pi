import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	convertToLlm,
	copyExternalAgentOriginV1,
	type ExternalAgentOriginV1,
	requireExternalAgentOriginV1,
} from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";

const initiator = {
	namespace: "agent-hub",
	agentId: "agent-a",
	registrationGeneration: 2,
} satisfies ExternalAgentOriginV1;

const userMessage = {
	role: "user",
	content: "Question",
	timestamp: 1,
	initiator,
} satisfies AgentMessage;

describe("external agent origin", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const directory = tempDirs.pop();
			if (directory) rmSync(directory, { recursive: true, force: true });
		}
	});

	it("persists the origin on the exact visible user entry", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-origin-"));
		tempDirs.push(directory);
		const session = SessionManager.create(directory, directory);
		const entryId = session.appendMessage(userMessage);
		const assistantEntryId = session.appendMessage(fauxAssistantMessage("Answer"));
		session.appendSemanticTurnSettlements(null);
		const reopened = SessionManager.open(session.getSessionFile()!, directory);

		expect(reopened.getEntry(entryId)).toMatchObject({
			type: "message",
			message: { role: "user", content: "Question", initiator },
		});
		expect(reopened.getSemanticTurnSettlements()).toEqual([{ userEntryId: entryId, assistantEntryId }]);
	});

	it("keeps a trimmed display name in the copy", () => {
		expect(copyExternalAgentOriginV1({ ...initiator, displayName: "  Lead agent  " })).toEqual({
			...initiator,
			displayName: "Lead agent",
		});
	});

	it("keeps an origin without a display name valid", () => {
		expect(copyExternalAgentOriginV1(initiator)).toEqual(initiator);
	});

	it.each(["", "   ", "x".repeat(129), 7])("rejects the display name %j", (displayName) => {
		expect(() => requireExternalAgentOriginV1({ ...initiator, displayName })).toThrow(
			"Invalid external agent initiator",
		);
	});

	it("persists the origin on the exact custom message entry and settles its turn", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-origin-"));
		tempDirs.push(directory);
		const session = SessionManager.create(directory, directory);
		const origin = { ...initiator, displayName: "Lead agent" };
		const entryId = session.appendCustomMessageEntry("hub", "Question", true, undefined, undefined, origin);
		const assistantEntryId = session.appendMessage(fauxAssistantMessage("Answer"));
		session.appendSemanticTurnSettlements(null);
		const reopened = SessionManager.open(session.getSessionFile()!, directory);
		const entry = reopened.getEntry(entryId)!;

		expect(entry).toMatchObject({ type: "custom_message", initiator: origin });
		expect(sessionEntryToContextMessages(entry)).toMatchObject([{ role: "custom", initiator: origin }]);
		expect(reopened.getSemanticTurnSettlements()).toEqual([{ userEntryId: entryId, assistantEntryId }]);
	});

	it("does not settle a turn for a custom message entry without an origin", () => {
		const session = SessionManager.inMemory();
		session.appendCustomMessageEntry("hub", "Note", true);
		session.appendMessage(fauxAssistantMessage("Answer"));

		expect(session.appendSemanticTurnSettlements(null)).toEqual([]);
	});

	it("excludes origin metadata from provider messages", () => {
		expect(convertToLlm([userMessage])).toEqual([{ role: "user", content: "Question", timestamp: 1 }]);
	});
});
