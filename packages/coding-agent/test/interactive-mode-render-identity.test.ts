import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { SessionMessageEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode restored assistant identity", () => {
	it("keeps the persisted entry ID when it rebuilds render items", () => {
		const entry: SessionMessageEntry = {
			type: "message",
			id: "restored-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: fauxAssistantMessage("restored"),
		};
		const renderSessionItems = vi.fn();
		const fakeMode = { renderSessionItems };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeMode,
			entries: SessionMessageEntry[],
		) => void;

		renderSessionEntries.call(fakeMode, [entry]);

		expect(renderSessionItems).toHaveBeenCalledWith([{ message: entry.message, entryId: "restored-entry" }], {});
	});
});
