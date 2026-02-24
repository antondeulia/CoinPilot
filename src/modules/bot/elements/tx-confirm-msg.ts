import { LlmTransaction } from '../../../modules/llm/schemas/transaction.schema'
import {
	formatByCurrencyPolicy,
	formatExactAmount,
	getCurrencySymbol,
	formatAccountName
} from '../../../utils/format'
import { formatTransactionDate } from '../../../utils/date'

function formatDirection(direction: LlmTransaction['direction']) {
	if (direction === 'expense') return '🔴 Расход'
	if (direction === 'income') return '🟢 Доход'
	if (direction === 'transfer') return '🔄 Перевод'
	return '—'
}

export function renderConfirmMessage(
	tx: LlmTransaction,
	index?: number,
	total?: number,
	defaultAccountId?: string,
	tagInfo?: { name: string; isNew: boolean },
	title: string = 'Предпросмотр операции'
) {
	const draft = tx as any
	const tagName = tagInfo?.name ?? draft?.tagName ?? ''
	const tagIsNew = tagInfo?.isNew ?? draft?.tagIsNew ?? false
	const tagLine =
		tagName.length > 0
			? `Тег:\n<blockquote>${tagName}${tagIsNew ? ' (новый)' : ''}</blockquote>`
			: 'Теги: —'
	const amountText =
		typeof tx.amount === 'number' && tx.currency
			? formatExactAmount(Math.abs(tx.amount), tx.currency, {
					maxFractionDigits: 18,
					trimTrailingZeros: true
				})
			: '—'
	const signPrefix =
		tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : ''
	const isDeletedCurrency = !!(draft as any).currencyDeleted

	const date = tx.transactionDate ? new Date(tx.transactionDate) : new Date()
	const timezone = (draft.userTimezone as string | undefined) ?? 'UTC+02:00'
	const dateText = formatTransactionDate(date, timezone)
	const headerIndex =
		typeof index === 'number' && typeof total === 'number'
			? ` ${index + 1}/${total}`
			: ''

	let amountLine = `Сумма: ${signPrefix}${amountText}`
	if (isDeletedCurrency) {
		amountLine = `Сумма: <s>${signPrefix}${amountText}</s> <code>deleted</code>`
	}
	if (
		typeof tx.amount === 'number' &&
		tx.currency &&
		tx.convertToCurrency &&
		tx.convertedAmount != null &&
		tx.currency !== tx.convertToCurrency &&
		!isDeletedCurrency
	) {
		const sym = getCurrencySymbol(tx.convertToCurrency)
		const convertedStr = formatByCurrencyPolicy(
			Math.abs(tx.convertedAmount),
			tx.convertToCurrency,
			undefined,
			{ withSymbol: false }
		)
		amountLine = `Сумма: ${signPrefix}${amountText} (🠒 ${convertedStr} ${sym})`
	}

	const isTransfer = tx.direction === 'transfer'
	const categoryLine = isTransfer ? '' : `Категория: ${tx.category ?? '—'}\n`
	const targetAccountName =
		(draft.toAccount as string) ??
		((draft.toAccountId as string | undefined) ? 'Вне Wallet' : '—')
	const targetAccountLine = isTransfer
		? `На счёт: ${formatAccountName(targetAccountName, false)}\n`
		: ''
	const balanceAfterLine = draft.balanceAfterText
		? `\n<code>После операции баланс счёта: ${draft.balanceAfterText}</code>`
		: ''

	return `
📄 <b>${title}${headerIndex}</b>

${formatDirection(tx.direction)}
${tx.description ?? '—'}

${amountLine}
Счёт: ${formatAccountName(tx.account ?? '—', tx.accountId === defaultAccountId)}
${targetAccountLine}Дата: ${dateText}
${categoryLine}${tagLine}
${balanceAfterLine}`.trim()
}
