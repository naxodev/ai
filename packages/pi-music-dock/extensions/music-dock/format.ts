/** Clip text to at most `max` words so a title fits a one-line footer. */
export function clipWords(text: string, max = 6): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= max) return text.trim();
	return `${words.slice(0, max).join(" ")}…`;
}
