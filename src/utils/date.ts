function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getUTCFullYear() === b.getUTCFullYear() &&
		a.getUTCMonth() === b.getUTCMonth() &&
		a.getUTCDate() === b.getUTCDate()
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
	const d = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0, 0))
	if (
		d.getUTCFullYear() !== year ||
		d.getUTCMonth() !== monthIndex ||
		d.getUTCDate() !== day
	) {
		return null
	}
	return d
}

function parseTimezoneOffsetMinutes(timezone: string): number {
	const t = String(timezone || '').trim().toUpperCase()
	const m = t.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/)
	if (!m) return 120
	const sign = m[1] === '-' ? -1 : 1
	const hours = Number(m[2] || 0)
	const mins = Number(m[3] || 0)
	return sign * (hours * 60 + mins)
}

function shiftToTimezone(date: Date, offsetMinutes: number): Date {
	return new Date(date.getTime() + offsetMinutes * 60_000)
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
		return new Date(
			Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
		)
	}
	if (/\bвчера\b/u.test(lowered)) {
		return new Date(
			Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0, 0)
		)
	}

	const dmyMatch = lowered.match(
		/\b([0-3]?\d)[./-]([01]?\d)(?:[./-](\d{2,4}))?\b/u
	)
	if (dmyMatch) {
		const day = Number(dmyMatch[1])
		const month = Number(dmyMatch[2]) - 1
		let year = yearNow
		if (dmyMatch[3]) {
			const y = Number(dmyMatch[3])
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
}): Date {
	const now = params.now ?? new Date()
	const fromText = extractExplicitDateFromText(params.userText ?? '', now)
	if (fromText) return fromText
	const fromLlm = normalizeTxDate(params.llmDate)
	if (fromLlm) return fromLlm
	return now
}

export function formatTransactionDate(
	date: Date,
	timezone: string = 'UTC+02:00'
): string {
	const offset = parseTimezoneOffsetMinutes(timezone)
	const today = shiftToTimezone(new Date(), offset)
	const yesterday = new Date(today)
	yesterday.setUTCDate(today.getUTCDate() - 1)
	const target = shiftToTimezone(date, offset)

	if (isSameDay(target, today)) return 'Сегодня'
	if (isSameDay(target, yesterday)) return 'Вчера'

	return target.toLocaleDateString('ru-RU', { timeZone: 'UTC' })
}
