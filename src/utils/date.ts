function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getUTCFullYear() === b.getUTCFullYear() &&
		a.getUTCMonth() === b.getUTCMonth() &&
		a.getUTCDate() === b.getUTCDate()
	)
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
