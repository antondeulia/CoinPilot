export function toMoneyNumber(value: unknown, fallback = 0): number {
	if (value == null) return fallback
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : fallback
	}
	if (typeof value === 'string') {
		const n = Number(value)
		return Number.isFinite(n) ? n : fallback
	}
	if (typeof value === 'object' && value !== null) {
		const maybeToNumber = (value as { toNumber?: () => number }).toNumber
		if (typeof maybeToNumber === 'function') {
			const n = maybeToNumber.call(value)
			return Number.isFinite(n) ? n : fallback
		}
		const n = Number((value as { toString: () => string }).toString?.())
		return Number.isFinite(n) ? n : fallback
	}
	return fallback
}

export function pickMoneyNumber(
	decimalValue: unknown,
	floatValue: unknown,
	fallback = 0
): number {
	if (decimalValue != null) return toMoneyNumber(decimalValue, fallback)
	return toMoneyNumber(floatValue, fallback)
}

export function toDbMoney(value: number | null | undefined): string | null {
	if (value == null || !Number.isFinite(value)) return null
	return value.toFixed(18)
}
