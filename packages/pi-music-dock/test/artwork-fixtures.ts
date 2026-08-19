/** Valid minimal images and abuse fixtures for artwork dimension tests. */

/** Real 1×1 PNG (IHDR width=1 height=1) — safe for getImageDimensions. */
export const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const PNG_1X1_BYTES = Buffer.from(PNG_1X1_BASE64, "base64");

/** Minimal JPEG with SOF0 declaring 1×1 — enough for getJpegDimensions. */
export function jpegWithDimensions(width: number, height: number): Buffer {
	// SOI + APP0(JFIF minimal) + SOF0(1x1 baseline) + EOI-ish padding
	const sof = Buffer.alloc(19);
	sof[0] = 0xff;
	sof[1] = 0xc0; // SOF0
	sof.writeUInt16BE(17, 2); // length
	sof[4] = 8; // precision
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	sof[9] = 3; // components
	// component specs (id, sampling, quant)
	sof[10] = 1;
	sof[11] = 0x11;
	sof[12] = 0;
	sof[13] = 2;
	sof[14] = 0x11;
	sof[15] = 0;
	sof[16] = 3;
	sof[17] = 0x11;
	sof[18] = 0;
	const app0 = Buffer.from([
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
		0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
	]);
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]), // SOI
		app0,
		sof,
		Buffer.from([0xff, 0xd9]), // EOI
	]);
}

export const JPEG_1X1_BYTES = jpegWithDimensions(1, 1);
export const JPEG_1X1_BASE64 = JPEG_1X1_BYTES.toString("base64");

/** PNG signature + IHDR declaring huge dimensions (decompression-bomb candidate). */
export function pngHeaderWithDimensions(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	buf.writeUInt32BE(13, 8); // IHDR length
	buf.write("IHDR", 12);
	buf.writeUInt32BE(width >>> 0, 16);
	buf.writeUInt32BE(height >>> 0, 20);
	return buf;
}

export const PNG_HUGE_BASE64 = pngHeaderWithDimensions(10_000, 10_000).toString(
	"base64",
);

/** Truncated PNG magic only — getImageDimensions returns null. */
export const PNG_TRUNCATED_BASE64 = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

export const BMP_BASE64 = Buffer.from("BM..............", "ascii").toString(
	"base64",
);
