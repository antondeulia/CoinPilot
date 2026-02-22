import { InlineKeyboard } from 'grammy'
import {
	getCurrencySymbol,
	formatAccountName,
	formatAmount
} from '../../../utils/format'
import { formatTransactionDate } from '../../../utils/date'
import { ExchangeService } from '../../../modules/exchange/exchange.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { Account } from '../../../generated/prisma/client'

type AccountWithAssets = Account & {
	assets: { currency: string; amount: number }[]
}

export interface AccountLastTxRow {
	direction: string
	amount: number
	currency: string
	amountMain: number
	description: string | null
	transactionDate: Date
	category: string | null
	tagName: string | null
	toAccountName: string | null
}

export interface AccountAnalyticsData {
	beginningBalance: number
	expenses: number
	income: number
	transfersTotal: number
	balance: number
	cashflow: number
	burnRate: number
	topExpenses: { categoryName: string; sum: number; pct: number }[]
	topIncome: { categoryName: string; sum: number; pct: number }[]
	topTransfers: {
		fromAccountName: string
		toAccountName: string
		sum: number
		pct: number
		descriptions: string[]
	}[]
	anomalies: { description: string | null; amountMain: number }[]
	thresholdAnomaly: number
}

function fmt(amount: number): string {
	return amount.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
}

export async function viewAccountsListText(
	accounts: AccountWithAssets[],
	mainCurrency: string,
	exchange: ExchangeService,
	analytics: AnalyticsService,
	userId: string,
	tipText?: string | null
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let totalMain = 0
	let totalFiat = 0
	let totalCrypto = 0

	for (const acc of accounts) {
		let accountTotalMain = 0
		let accountFiat = 0
		let accountCrypto = 0
		for (const a of acc.assets) {
			const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
			if (converted == null) continue
			accountTotalMain += converted
			const isCrypto = await exchange.isCryptoByCode(a.currency)
			if (isCrypto) accountCrypto += converted
			else accountFiat += converted
		}
		totalMain += accountTotalMain
		totalFiat += accountFiat
		totalCrypto += accountCrypto
	}

	const totalStr = fmt(totalMain)
	const pctFiat = totalMain > 0 ? Math.round((totalFiat / totalMain) * 100) : 0
	const pctCrypto = totalMain > 0 ? Math.round((totalCrypto / totalMain) * 100) : 0
	const fiatStr = fmt(totalFiat)
	const cryptoStr = fmt(totalCrypto)
	let cashflow = 0
	try {
		cashflow = await analytics.getCashflow(userId, 'month', mainCurrency)
	} catch {}
	const beginning = totalMain - cashflow
	const growthPct =
		beginning > 0 ? (cashflow / beginning) * 100 : 0
	const growthStr =
		(growthPct >= 0 ? '+' : '') + growthPct.toFixed(1) + '%'
	const accountsCount = accounts.length

	const tipLine = tipText?.trim() || '💡 Совет: регулярно обновляйте транзакции для точной аналитики.'
	if (accountsCount === 0) {
		return `💼 Ваши счета

💰 Общий капитал:
<i>0,00 ${mainSym} (<b>0.0%</b>)</i>

📊 Структура портфеля
Фиат — <i>0,00 ${mainSym} (0%)</i>
Крипто — <i>0,00 ${mainSym} (0%)</i>

🏦 Всего счетов: 0
🌍 Основная валюта: ${mainCurrency}

<blockquote>${tipLine}</blockquote>`
	}

	return `💼 Ваши счета

💰 Общий капитал:
<i>${totalStr} ${mainSym} (<b>${growthStr}</b>)</i>

📊 Структура портфеля
Фиат — <i>${fiatStr} ${mainSym} (${pctFiat}%)</i>
Крипто — <i>${cryptoStr} ${mainSym} (${pctCrypto}%)</i>

🏦 Всего счетов: ${accountsCount}
🌍 Основная валюта: ${mainCurrency}

<blockquote>${tipLine}</blockquote>`
}

async function assetsBlock(
	assets: { currency: string; amount: number }[],
	mainCurrency: string,
	mainSym: string,
	exchange: ExchangeService
): Promise<string> {
	if (assets.length === 0) return 'Активы:\n— нет активов\n'
	const lines: string[] = ['Активы:']
	for (let i = 0; i < assets.length; i++) {
		const a = assets[i]
		const amountStr = formatAmount(a.amount, a.currency)
		if (a.currency === mainCurrency || a.amount === 0) {
			lines.push(`${i + 1}. ${a.currency} — ${amountStr}`)
		} else {
			const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
			lines.push(
				converted != null
					? `${i + 1}. ${a.currency} — ${amountStr} (~ ${fmt(converted)} ${mainSym})`
					: `${i + 1}. ${a.currency} — ${amountStr}`
			)
		}
	}
	return lines.join('\n') + '\n'
}

export async function accountDetailsText(
	account: AccountWithAssets,
	mainCurrency: string,
	exchange: ExchangeService,
	isDefault: boolean,
	isPremium: boolean,
	lastTransactions: AccountLastTxRow[],
	analyticsData?: AccountAnalyticsData
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let balanceMain = 0
	for (const a of account.assets) {
		const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
		if (converted != null) balanceMain += converted
	}
	const balanceStr = fmt(balanceMain)
	const nameHtml = escapeHtml(formatAccountName(account.name, isDefault))
	const assetsSection = await assetsBlock(
		account.assets,
		mainCurrency,
		mainSym,
		exchange
	)

	if (!isPremium || !analyticsData) {
		let body = `<b>${nameHtml}</b>
Обзор за текущий месяц

Начальный капитал: ${balanceStr} ${mainSym}
Текущий капитал: ${balanceStr} ${mainSym}

🔴 Расходы: −0,00 ${mainSym}
🟢 Доходы: +0,00 ${mainSym}
⚪️ Переводы: 0,00 ${mainSym}

<b>Денежный поток:</b> +0,00 ${mainSym}
<b>Средний расход в день:</b> 0,00 ${mainSym}

— — —

${assetsSection}Последние операции:
`
		if (lastTransactions.length === 0) body += 'Нет операций\n'
		else {
			lastTransactions.slice(0, 3).forEach((tx, i) => {
				body += formatDetailTxLine(tx, i, mainSym, mainCurrency) + '\n'
			})
		}
		return body.trim()
	}

	const a = analyticsData
	let body = `<b>${nameHtml}</b>
Обзор за текущий месяц

Начальный капитал: ${fmt(a.beginningBalance)} ${mainSym}
Текущий капитал: ${fmt(a.balance)} ${mainSym}

🔴 Расходы: −${fmt(a.expenses)} ${mainSym}
🟢 Доходы: +${fmt(a.income)} ${mainSym}
⚪️ Переводы: ${fmt(a.transfersTotal)} ${mainSym}

<b>Денежный поток:</b> ${a.cashflow >= 0 ? '+' : ''}${fmt(a.cashflow)} ${mainSym}
<b>Средний расход в день:</b> ${fmt(a.burnRate)} ${mainSym}

— — —

${assetsSection}Последние операции:
`
	if (lastTransactions.length === 0) body += 'Нет операций\n'
	else {
		lastTransactions.slice(0, 3).forEach((tx, i) => {
			body += formatDetailTxLine(tx, i, mainSym, mainCurrency) + '\n'
		})
	}
	return body.trim()
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function capitalize(s: string): string {
	if (!s?.trim()) return '—'
	const t = s.trim()
	return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

function formatDetailTxLine(
	tx: AccountLastTxRow,
	_i: number,
	mainSym: string,
	mainCurrency: string
): string {
	const label = capitalize(tx.description ?? tx.tagName ?? tx.category ?? '—')
	const dateStr = formatTransactionDate(tx.transactionDate)
	if (tx.direction === 'transfer') {
		const amountStr = `${fmt(tx.amountMain)} ${mainSym}`
		return `⚪️ ${amountStr}  | ${escapeHtml(label)} | ${dateStr}`
	}
	const sign = tx.direction === 'expense' ? '−' : '+'
	const isMain = tx.currency === mainCurrency
	const amountStr = isMain
		? `${sign}${fmt(Math.abs(tx.amount))} ${mainSym}`
		: `${sign}${formatAmount(Math.abs(tx.amount), tx.currency)} (${fmt(tx.amountMain)} ${mainSym})`
	const icon = tx.direction === 'expense' ? '🔴' : '🟢'
	return `${icon} ${amountStr}  | ${escapeHtml(label)} | ${dateStr}`
}

export async function viewAccountsText(
	accounts: AccountWithAssets[],
	mainCurrency: string,
	exchange: ExchangeService,
	defaultAccountId?: string
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let totalMain = 0
	const blocks: string[] = []

	for (const acc of accounts) {
		let accountTotalMain = 0
		const lines: string[] = []
		for (const a of acc.assets) {
			const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
			const amountStr = formatAmount(a.amount, a.currency)
			if (converted != null) {
				accountTotalMain += converted
				if (a.currency === mainCurrency) {
					lines.push(`• ${a.currency} — ${amountStr}`)
				} else {
					lines.push(
						`• ${a.currency} — ${amountStr} ≈ ${fmt(converted)} ${mainSym}`
					)
				}
			} else {
				lines.push(`• ${a.currency} — ${amountStr} (курс неизвестен)`)
			}
		}
		totalMain += accountTotalMain
		const accountTotalStr = fmt(accountTotalMain)
		const body = lines.length > 0 ? lines.join('\n') : '— нет активов'
		const accountLine =
			acc.assets.length > 0
				? `Итого: ${accountTotalStr} ${mainSym}`
				: `Итого: 0.00 ${mainSym}`
		const isDefault = acc.id === defaultAccountId
		blocks.push(
			`🏦 ${formatAccountName(acc.name, isDefault)}\n${accountLine}\n\n${body}`
		)
	}

	const totalStr = fmt(totalMain)
	const header = `📂 Список счетов

💼 Всего по всем счетам:
${totalStr} ${mainSym}

`

	const footer = `
ℹ️ Примечания

• Все суммы приведены к основной валюте (${mainCurrency})
• Курсы обновляются автоматически
`
	return header + blocks.join('\n\n') + footer
}

export function accountsKeyboard(
	accounts: Account[],
	activeId: string | null,
	defaultAccountId?: string
) {
	const kb = new InlineKeyboard()

	for (const acc of accounts) {
		const isDefault = acc.id === defaultAccountId
		kb.text(
			`${acc.id === activeId ? '👉 ' : ''}${formatAccountName(acc.name, isDefault)} (${acc.currency})`,
			`use_account:${acc.id}`
		).row()
	}

	kb.text('➕ Добавить счёт', 'add_account')

	return kb
}
