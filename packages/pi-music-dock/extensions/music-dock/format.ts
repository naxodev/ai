/** Clip text to at most `max` words so a title fits a one-line footer. */
export function clipWords(text: string, max = 6): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= max) return text.trim();
	return `${words.slice(0, max).join(" ")}…`;
}

/** Format milliseconds as m:ss, clamping negatives to 0:00. */
export function formatMs(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}
