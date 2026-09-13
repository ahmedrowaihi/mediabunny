import { expect, test } from 'vitest';
import { FilePathSource } from '../../src/source.js';
import { Logging } from '../../src/logging.js';

const __dirname = new URL('.', import.meta.url).pathname;
const filePath = `${__dirname}../public/video.mp4`;

const collect = async () => {
	for (let i = 0; i < 5; i++) {
		(globalThis as unknown as { gc: () => void }).gc();
		await new Promise(resolve => setTimeout(resolve, 10));
	}
};

// The ref must be orphaned while its source stays alive. Creating the source inside the
// dropping function collects both together, and the registry callback never runs.
const orphanRef = (source: FilePathSource) => {
	source.ref();
};

const warningsWhileDroppingRefTo = async (source: FilePathSource) => {
	const warnings: unknown[][] = [];
	const off = Logging.on('warn', args => void warnings.push(args));

	orphanRef(source);
	await collect();

	off();
	return warnings.filter(args => String(args[0]).includes('SourceRef'));
};

test('dropping a SourceRef without freeing it warns', async () => {
	const source = new FilePathSource(filePath);
	expect(await warningsWhileDroppingRefTo(source)).toHaveLength(1);
});

test('freeing a SourceRef does not warn', async () => {
	const source = new FilePathSource(filePath);
	const warnings: unknown[][] = [];
	const off = Logging.on('warn', args => void warnings.push(args));

	source.ref().free();
	await collect();
	off();

	expect(warnings.filter(args => String(args[0]).includes('SourceRef'))).toHaveLength(0);
});

test('HLS and DASH sources suppress the unfreed-ref warning', async () => {
	const hlsSource = new FilePathSource(filePath);
	hlsSource._usedForHls = true;
	expect(await warningsWhileDroppingRefTo(hlsSource)).toHaveLength(0);

	const dashSource = new FilePathSource(filePath);
	dashSource._usedForDash = true;
	expect(await warningsWhileDroppingRefTo(dashSource)).toHaveLength(0);
});
