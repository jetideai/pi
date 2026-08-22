import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("reserves distinct non-empty entry IDs before persistence", () => {
		const session = SessionManager.inMemory();
		const reserveEntryId = (session as SessionManager & { reserveEntryId?: () => string }).reserveEntryId;

		expect(reserveEntryId).toBeTypeOf("function");
		const firstId = reserveEntryId?.call(session);
		const secondId = reserveEntryId?.call(session);
		expect(firstId).not.toBe("");
		expect(secondId).not.toBe(firstId);
	});

	it("consumes each reserved entry ID exactly once", () => {
		const session = SessionManager.inMemory();
		const firstId = session.reserveEntryId();
		const appendReserved = session.appendMessage as unknown as (
			message: { role: "user"; content: string; timestamp: number },
			entryId: string,
		) => string;

		expect(appendReserved.call(session, { role: "user", content: "hello", timestamp: 1 }, firstId)).toBe(firstId);
		expect(() => appendReserved.call(session, { role: "user", content: "again", timestamp: 2 }, firstId)).toThrow(
			/reserved/i,
		);
	});

	it("consumes reserved IDs for persisted custom message lifecycles", () => {
		const session = SessionManager.inMemory();
		const entryId = session.reserveEntryId();
		const appendReserved = session.appendCustomMessageEntry as unknown as (
			customType: string,
			content: string,
			display: boolean,
			details: unknown,
			entryId: string,
		) => string;

		expect(appendReserved.call(session, "status", "ready", true, undefined, entryId)).toBe(entryId);
	});

	it("retires unfinished reservations without reusing them", () => {
		const session = SessionManager.inMemory();
		const unfinishedId = session.reserveEntryId();

		session.discardReservedEntryId(unfinishedId);

		expect(() => session.appendMessage({ role: "user", content: "late", timestamp: 1 }, unfinishedId)).toThrow(
			/reserved/i,
		);
		expect(session.reserveEntryId()).not.toBe(unfinishedId);
	});

	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});
