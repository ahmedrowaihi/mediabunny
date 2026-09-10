/*!
 * Walks the top-level box structure of an ISOBMFF file. Shared by the tests that assert on the
 * shape of muxer output rather than on its decoded contents.
 */

export type TopLevelBox = {
	/** Four-character box type, e.g. `moof`. */
	name: string;
	/** Byte offset of the box header within the file. */
	start: number;
	/** Total size of the box in bytes, header included. */
	size: number;
};

export const readTopLevelBoxes = (bytes: Uint8Array): TopLevelBox[] => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const boxes: TopLevelBox[] = [];

	let pos = 0;
	while (pos + 8 <= bytes.length) {
		let size = view.getUint32(pos);
		const name = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		if (size === 1) {
			size = Number(view.getBigUint64(pos + 8));
		}
		if (size <= 0) {
			break;
		}

		boxes.push({ name, start: pos, size });
		pos += size;
	}

	return boxes;
};
