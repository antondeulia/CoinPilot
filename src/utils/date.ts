function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	)
}

const MONTHS_RU: Record<string, number> = {
	янв: 0,
	январ: 0,
	фев: 1,
	феврал: 1,
	мар: 2,
	март: 2,
	апр: 3,
	апрел: 3,
	май: 4,
	мая: 4,
	июн: 5,
	июнья: 5,
	июл: 6,
	июль: 6,
	авг: 7,
	август: 7,
	сен: 8,
	сентябр: 8,
	окт: 9,
	октябр: 9,
	ноя: 10,
	ноябр: 10,
	дек: 11,
	декабр: 11
}

function fromParts(day: number, monthIndex: number, year: number): Date | null {
	const d = new Date(year, monthIndex, day, 12, 0, 0, 0)
	if (
		d.getFullYear() !== year ||
		d.getMonth() !== monthIndex ||
		d.getDate() !== day
	) {
		return null
	}
	return d
}

export function normalizeTxDate(input?: string | Date | null): Date | null {
	if (input == null) return null
	const d = input instanceof Date ? input : new Date(input)
	if (isNaN(d.getTime())) return null
	return d
}

export function extractExplicitDateFromText(
	text: string,
	now: Date = new Date()
): Date | null {
	const source = String(text ?? '').trim()
	if (!source) return null
	const lowered = source.toLowerCase()
	const yearNow = now.getFullYear()

	if (/\bсегодня\b/u.test(lowered)) {
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
	}
	if (/\bвчера\b/u.test(lowered)) {
		return new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() - 1,
			12,
			0,
			0,
			0
		)
	}

	const dmyMatch = lowered.match(
		/\b([0-3]?\d)([./-])([01]?\d)(?:\2(\d{2,4}))?\b/u
	)
	if (dmyMatch) {
		const day = Number(dmyMatch[1])
		const sep = dmyMatch[2]
		const monthRaw = dmyMatch[3]
		const month = Number(monthRaw) - 1
		const yearRaw = dmyMatch[4]
		// Защита от ложного срабатывания суммы вида "11.1 TON" как даты "11.01".
		if (!yearRaw && sep === '.' && monthRaw.length === 1) {
			const start = dmyMatch.index ?? 0
			const end = start + dmyMatch[0].length
			const prefix = lowered.slice(Math.max(0, start - 16), start)
			const tail = lowered.slice(end)
			const hasDateContext =
				/\b(?:дата|date|числа|число|от|за)\b/iu.test(prefix) ||
				/\b(?:дата|date)\b/iu.test(tail.slice(0, 24))
			const hasAmountTail =
				/^\s*[-+()]?\s*(?:[a-zа-я]{2,12}|[$€₴₽]|usdt|usdc|usd|eur|btc|eth|ton|sol|xrp|ada|doge)\b/iu.test(
					tail
				)
			if (hasAmountTail && !hasDateContext) {
				return null
			}
		}
		let year = yearNow
		if (yearRaw) {
			const y = Number(yearRaw)
			year = y < 100 ? 2000 + y : y
		}
		return fromParts(day, month, year)
	}

	const monthTextMatch = lowered.match(
		/\b([0-3]?\d)\s+([а-яa-z]+)(?:\s+(\d{4}))?\b/u
	)
	if (monthTextMatch) {
		const day = Number(monthTextMatch[1])
		const monthText = monthTextMatch[2]
		let monthIndex: number | undefined
		for (const [k, v] of Object.entries(MONTHS_RU)) {
			if (monthText.startsWith(k)) {
				monthIndex = v
				break
			}
		}
		if (monthIndex != null) {
			const year = monthTextMatch[3] ? Number(monthTextMatch[3]) : yearNow
			return fromParts(day, monthIndex, year)
		}
	}

	return null
}

export function pickTransactionDate(params: {
	userText?: string | null
	llmDate?: string | Date | null
	now?: Date
	preferLlmDate?: boolean
}): Date {
	const now = params.now ?? new Date()
	const fromLlm = normalizeTxDate(params.llmDate)
	if (params.preferLlmDate && fromLlm) return fromLlm
	const fromText = extractExplicitDateFromText(params.userText ?? '', now)
	if (fromText) return fromText
	if (fromLlm) return fromLlm
	return now
}

export function formatTransactionDate(date: Date): string {
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)

	if (isSameDay(date, today)) return 'Сегодня'
	if (isSameDay(date, yesterday)) return 'Вчера'

	return date.toLocaleDateString('ru-RU')
}
