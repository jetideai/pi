import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import {
	getKittyImageMetadata,
	getKittyImagePlacement,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";

const theme = { fallbackColor: (text: string) => text };
const dimensions = { widthPx: 100, heightPx: 100 };

function placementOf(image: Image, width: number) {
	const placement = getKittyImagePlacement(image.render(width)[0] ?? "");
	assert.ok(placement, "the image line has a registered Kitty placement");
	return placement;
}

describe("Kitty image transmission generation", () => {
	beforeEach(() => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
	});

	afterEach(() => {
		resetCapabilitiesCache();
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});

	it("keeps the generation of an image across a width change while its cell size follows the width", () => {
		const image = new Image("AAAA", "image/png", theme, { imageId: 71 }, dimensions);
		const wide = placementOf(image, 40);
		const wideColumns = getKittyImageMetadata(image.render(40)[0] ?? "")?.columns;
		image.invalidate();
		const narrow = placementOf(image, 6);
		const narrowColumns = getKittyImageMetadata(image.render(6)[0] ?? "")?.columns;

		assert.strictEqual(narrow.transmissionGeneration, wide.transmissionGeneration);
		assert.deepStrictEqual([wideColumns, narrowColumns], [38, 4]);
	});

	it("gives a new image with the same image id and another payload a new generation", () => {
		const first = placementOf(new Image("AAAA", "image/png", theme, { imageId: 72 }, dimensions), 40);
		const second = placementOf(new Image("BBBB", "image/png", theme, { imageId: 72 }, dimensions), 40);

		assert.notStrictEqual(second.transmissionGeneration, first.transmissionGeneration);
	});

	it("gives each direct render without a content generation a fresh generation", () => {
		const options = { maxWidthCells: 4, imageId: 73, moveCursor: false };
		const first = getKittyImagePlacement(renderImage("AAAA", dimensions, options)?.sequence ?? "");
		const second = getKittyImagePlacement(renderImage("AAAA", dimensions, options)?.sequence ?? "");

		assert.notStrictEqual(second?.transmissionGeneration, first?.transmissionGeneration);
	});
});
