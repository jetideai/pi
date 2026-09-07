import type * as Crypto from "node:crypto";
import { vi } from "vitest";

const randomIds = vi.hoisted(() => ["deadbeef-first", "deadbeef-second", "cafebabe-third"]);

vi.mock("node:crypto", async (importOriginal) => {
	const original = await importOriginal<typeof Crypto>();
	return {
		...original,
		randomUUID: () => randomIds.shift() ?? "feedface-fallback",
	};
});

import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager entry ID allocation", () => {
	it("keeps generated extension entries distinct from an in-flight reserved message", () => {
		const session = SessionManager.inMemory();
		const assistantId = session.reserveEntryId();

		const extensionEntryId = session.appendCustomEntry("progress", { phase: "running" });
		const persistedAssistantId = session.appendMessage(
			{ role: "user", content: "assistant lifecycle placeholder", timestamp: 1 },
			assistantId,
		);

		expect({ assistantId, extensionEntryId, persistedAssistantId }).toEqual({
			assistantId: "deadbeef",
			extensionEntryId: "cafebabe",
			persistedAssistantId: "deadbeef",
		});
		expect(session.getBranch().map((entry) => [entry.id, entry.parentId])).toEqual([
			["cafebabe", null],
			["deadbeef", "cafebabe"],
		]);
	});
});
