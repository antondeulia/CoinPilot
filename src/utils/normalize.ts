export function normalizeTag(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
}

export function levenshtein(a: string, b: string): number {
	const m = a.length
	const n = b.length
	const d: number[][] = Array(m + 1)
		.fill(null)
		.map(() => Array(n + 1).fill(0))
	for (let i = 0; i <= m; i++) d[i][0] = i
	for (let j = 0; j <= n; j++) d[0][j] = j
	for (let j = 1; j <= n; j++) {
		for (let i = 1; i <= m; i++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
		}
	}
	return d[m][n]
}

export function tagSimilarity(a: string, b: string): number {
	if (a === b) return 1
	const maxLen = Math.max(a.length, b.length)
	if (maxLen === 0) return 1
	return 1 - levenshtein(a, b) / maxLen
}
