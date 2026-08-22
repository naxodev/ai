/** Remove terminal controls from untrusted metadata while preserving Unicode. */
export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Clip text to at most `max` words so a title fits a one-line footer. */
export function clipWords(text: string, max = 6): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= max) return text.trim();
	return `${words.slice(0, max).join(" ")}…`;
}
