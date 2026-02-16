import { InlineKeyboard } from 'grammy'
import { getCurrencySymbol } from '../../utils/format'

const PAGE_SIZE = 9

function capitalize(s: string): string {
	if (!s?.trim()) return '—'
	const t = s.trim()
	return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

function stripLeadingEmoji(value?: string | null): string {
	if (!value) return ''
	return value
		.replace(
			/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u,
			''
		)
		.trim()
}

const DIR_EMOJI: Record<string, string> = {
	expense: '🔴',
	income: '🟢',
	transfer: '⚪️'
}

function txLabel(tx: {
	direction: string
	amount: number
	currency: string
	transactionDate: Date
	description?: string | null
	category?: string | null
	account?: { name?: string } | null
	toAccount?: { name?: string; isHidden?: boolean } | null
	tag?: { name: string } | null
}) {
	const emoji = DIR_EMOJI[tx.direction] ?? '⚪️'
	const sym = getCurrencySymbol(tx.currency)
	const amountStr = Math.abs(tx.amount).toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
	const d = new Date(tx.transactionDate)
	const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(
		d.getMonth() + 1
	).padStart(2, '0')}`
	const accountName = capitalize(
		stripLeadingEmoji(
			tx.account?.name ??
				tx.toAccount?.name ??
				tx.description ??
				tx.tag?.name ??
				tx.category ??
				'—'
		)
	)
	const label = `${emoji} ${amountStr} ${sym} · ${accountName} · ${dateStr}`
	return label.slice(0, 64)
}

export function transactionsListKeyboard(
	txs: Array<{
		id: string
		direction: string
		amount: number
		currency: string
		transactionDate: Date
		description?: string | null
		category?: string | null
		account?: { name?: string } | null
		toAccount?: { name?: string; isHidden?: boolean } | null
		tag?: { name: string } | null
	}>,
	page: number,
	totalCount: number
) {
	const kb = new InlineKeyboard()
	for (let i = 0; i < txs.length; i += 3) {
		const row = txs.slice(i, i + 3)
		for (const tx of row) {
			kb.text(txLabel(tx), `tx:${tx.id}`)
		}
		kb.row()
	}
	const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
	kb.text('« Назад', 'transactions_page:prev')
		.text(`${page + 1}/${totalPages}`, 'transactions_page:noop')
		.text('Вперёд »', 'transactions_page:next')
		.row()
		.text('← Назад', 'go_home')
	return kb
}

export function transactionDetailKeyboard() {
	return new InlineKeyboard().text('← Назад к списку', 'back_to_transactions')
}
