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

export function parseTimezoneOffsetMinutes(timezone: string): number {
	const raw = String(timezone || '').trim().toUpperCase()
	if (!raw) return 120

	const parseSigned = (sign: string, hoursRaw: string, minsRaw?: string): number => {
		const hours = Number(hoursRaw || 0)
		const mins = Number(minsRaw || 0)
		if (
			!Number.isFinite(hours) ||
			!Number.isFinite(mins) ||
			hours > 14 ||
			mins > 59
		) {
			return 120
		}
		const signed = sign === '-' ? -1 : 1
		return signed * (hours * 60 + mins)
	}

	const compact = raw.replace(/\s+/g, '')
	if (compact === '0' || compact === '+0' || compact === '-0') return 0

	const utcFull = compact.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/)
	if (utcFull) return parseSigned(utcFull[1], utcFull[2], utcFull[3])

	const plainFull = compact.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/)
	if (plainFull) return parseSigned(plainFull[1], plainFull[2], plainFull[3])

	const plainHours = compact.match(/^([+-]?)(\d{1,2})$/)
	if (plainHours) {
		const sign = plainHours[1] || '+'
		return parseSigned(sign, plainHours[2], '0')
	}

	return 120
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
		const hasYear = Boolean(dmyMatch[3])
		if (!hasYear && typeof dmyMatch.index === 'number') {
			const matched = dmyMatch[0]
			const tail = lowered
				.slice(dmyMatch.index + matched.length)
				.replace(/^\s+/, '')
			// Prevent false date extraction from decimal amounts like "11.10 TON".
			if (
				/^(?:[a-z]{2,10}|usd|usdt|usdc|eur|uah|rub|btc|eth|ton|sol|bnb|xrp|ada|doge|link)\b/u.test(
					tail
				)
			) {
				return null
			}
		}
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
