import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm, type ExternalAgentOriginV1 } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

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
		session.appendSemanticTurnSettlements();
		const reopened = SessionManager.open(session.getSessionFile()!, directory);

		expect(reopened.getEntry(entryId)).toMatchObject({
			type: "message",
			message: { role: "user", content: "Question", initiator },
		});
		expect(reopened.getSemanticTurnSettlements()).toEqual([{ userEntryId: entryId, assistantEntryId }]);
	});

	it("excludes origin metadata from provider messages", () => {
		expect(convertToLlm([userMessage])).toEqual([{ role: "user", content: "Question", timestamp: 1 }]);
	});
});
