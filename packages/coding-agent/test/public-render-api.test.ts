import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AssistantRenderBoundaryDecoratorV1,
	type AssistantRenderProjectionObserverV1,
	type AssistantRenderProjectionV1,
	buildTranscriptEntries,
	type MessageRenderBoundariesV1,
	type MessageRenderBoundariesV2,
	type MessageRenderBoundaryCandidateV2,
	type MessageRenderBoundaryCandidateV3,
	type MessageRenderBoundaryContextV1,
	type MessageRenderBoundaryDecoratorV1,
	type MessageRenderBoundaryDecoratorV2,
	type MessageRenderBoundarySelectorV2,
	type MessageRenderBoundarySelectorV3,
	type MessageRenderCompletedTurnV1,
	type MessageRenderFinalizedEntryV1,
	type MessageRenderProjectionMemberV1,
	type MessageRenderProjectionObserverV1,
	type MessageRenderProjectionV1,
	type MessageRenderRangeV1,
	type MessageRenderRoleV1,
	type ToolExecutionPresentationCandidateV1,
	type ToolExecutionPresentationSelectorV1,
	type ToolExecutionPresentationV1,
	type ToolGroupMemberV1,
	type ToolPresentationOverrideV1,
	type ToolPresentationResultV1,
	type ToolPresentationV1,
} from "../src/index.ts";

type PublicRenderAPI = {
	assistantBoundary: AssistantRenderBoundaryDecoratorV1;
	assistantObserver: AssistantRenderProjectionObserverV1;
	assistantProjection: AssistantRenderProjectionV1;
	boundariesV1: MessageRenderBoundariesV1;
	boundariesV2: MessageRenderBoundariesV2;
	candidateV2: MessageRenderBoundaryCandidateV2;
	candidateV3: MessageRenderBoundaryCandidateV3;
	context: MessageRenderBoundaryContextV1;
	decoratorV1: MessageRenderBoundaryDecoratorV1;
	decoratorV2: MessageRenderBoundaryDecoratorV2;
	selectorV2: MessageRenderBoundarySelectorV2;
	selectorV3: MessageRenderBoundarySelectorV3;
	completedTurn: MessageRenderCompletedTurnV1;
	finalized: MessageRenderFinalizedEntryV1;
	member: MessageRenderProjectionMemberV1;
	observer: MessageRenderProjectionObserverV1;
	projection: MessageRenderProjectionV1;
	range: MessageRenderRangeV1;
	role: MessageRenderRoleV1;
	toolCandidate: ToolExecutionPresentationCandidateV1;
	toolSelector: ToolExecutionPresentationSelectorV1;
	toolPresentation: ToolExecutionPresentationV1;
	toolGroupMember: ToolGroupMemberV1;
	toolOverride: ToolPresentationOverrideV1;
	toolResult: ToolPresentationResultV1;
	toolState: ToolPresentationV1;
};

describe("public render API", () => {
	it("exports transcript projection types and helpers from the package root", () => {
		expectTypeOf<PublicRenderAPI>().toBeObject();
		expect(buildTranscriptEntries([])).toEqual([]);
	});
});
