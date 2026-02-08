function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	)
}

export function formatTransactionDate(date: Date): string {
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)

	if (isSameDay(date, today)) return 'Сегодня'
	if (isSameDay(date, yesterday)) return 'Вчера'

	return date.toLocaleDateString('ru-RU')
}
