import { LlmTransaction } from 'src/modules/llm/schemas/transaction.schema'
import { formatAmount, getCurrencySymbol, formatAccountName } from 'src/utils/format'
import { formatTransactionDate } from 'src/utils/date'

function formatDirection(direction: LlmTransaction['direction']) {
	if (direction === 'expense') return '📉 Расход'
	if (direction === 'income') return '📈 Доход'
	if (direction === 'transfer') return '🔄 Перевод'
	return '—'
}

export function renderConfirmMessage(
	tx: LlmTransaction,
	index?: number,
	total?: number,
	defaultAccountId?: string,
	tagInfo?: { name: string; isNew: boolean }
) {
	const draft = tx as any
	const tagName = tagInfo?.name ?? draft?.tagName ?? ''
	const tagIsNew = tagInfo?.isNew ?? draft?.tagIsNew ?? false
	const tagLine =
		tagName.length > 0
			? `Тег:\n<blockquote>${tagName}${tagIsNew ? ' (новый)' : ''}</blockquote>`
			: 'Тег: —'
	const amountText =
		typeof tx.amount === 'number' && tx.currency
			? formatAmount(tx.amount, tx.currency)
			: '—'

	const date = tx.transactionDate ? new Date(tx.transactionDate) : new Date()
	const dateText = formatTransactionDate(date)
	const headerIndex =
		typeof index === 'number' && typeof total === 'number'
			? ` ${index + 1}/${total}`
			: ''

	let amountLine = `Сумма: ${amountText}`
	if (
		typeof tx.amount === 'number' &&
		tx.currency &&
		tx.convertToCurrency &&
		tx.convertedAmount != null &&
		tx.currency !== tx.convertToCurrency
	) {
		const sym = getCurrencySymbol(tx.convertToCurrency)
		const convertedStr = tx.convertedAmount.toLocaleString('ru-RU', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2
		})
		amountLine = `Сумма: ${amountText} (🠒 ${convertedStr} ${sym})`
	}

	const isTransfer = tx.direction === 'transfer'
	const categoryLine =
		isTransfer ? '' : `Категория: ${tx.category ?? '—'}\n`
	const targetAccountLine = isTransfer
		? `На счёт: ${formatAccountName((draft.toAccount as string) ?? '—', false)}\n`
		: ''

	return `
<b>Предпросмотр транзакции${headerIndex}</b>

Тип: ${formatDirection(tx.direction)}
Название: ${tx.description ?? '—'}
${amountLine}
Счёт: ${formatAccountName(tx.account ?? '—', tx.accountId === defaultAccountId)}
${targetAccountLine}Дата: ${dateText}
${categoryLine}${tagLine}
`
}
