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
		const messageId = session.reserveEntryId();

		const extensionEntryId = session.appendCustomEntry("progress", { phase: "running" });
		const persistedMessageId = session.appendMessage(
			{ role: "user", content: "message lifecycle placeholder", timestamp: 1 },
			messageId,
		);

		expect({ messageId, extensionEntryId, persistedMessageId }).toEqual({
			messageId: "deadbeef",
			extensionEntryId: "cafebabe",
			persistedMessageId: "deadbeef",
		});
		expect(session.getBranch().map((entry) => [entry.id, entry.parentId])).toEqual([
			["cafebabe", null],
			["deadbeef", "cafebabe"],
		]);
	});
});
