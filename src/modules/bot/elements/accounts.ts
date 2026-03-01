import { InlineKeyboard } from 'grammy'
import {
	getCurrencySymbol,
	formatAccountName,
	formatByCurrencyPolicy,
	formatExactAmount
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

function fmt(amount: number, currency?: string): string {
	if (currency) {
		return formatByCurrencyPolicy(amount, currency, undefined, {
			withSymbol: false
		})
	}
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
	_tipText?: string | null,
	expanded = true
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	const visibleAccounts = accounts.filter(
		acc => String(acc.name ?? '').trim().toLowerCase() !== 'вне wallet'
	)
	let totalMain = 0
	let totalFiat = 0
	let totalCrypto = 0
	const accountBlocks: string[] = []

	for (const acc of visibleAccounts) {
		let accountTotalMain = 0
		const assetLines: string[] = []
		for (const a of acc.assets) {
			const amountRaw = Number(a.amount ?? 0)
			const normalizedCurrency = String(a.currency ?? '').toUpperCase()
			const amountStr = formatExactAmount(amountRaw, normalizedCurrency, {
				maxFractionDigits: 18
			})
			const amountWithoutCurrency = amountStr.replace(/\s+[^\s]+$/u, '')
			const converted = await exchange.convert(amountRaw, a.currency, mainCurrency)
			if (converted == null) {
				assetLines.push(`• ${normalizedCurrency}: ${amountWithoutCurrency} (курс недоступен)`)
				continue
			}
			accountTotalMain += converted
			const isCrypto = await exchange.isCryptoByCode(normalizedCurrency)
			if (isCrypto) totalCrypto += converted
			else totalFiat += converted
			assetLines.push(
				`• ${normalizedCurrency}: ${amountWithoutCurrency} (${fmt(converted, mainCurrency)} ${mainSym})`
			)
		}
		totalMain += accountTotalMain
		const blockquoteOpen = assetLines.length > 3 ? '<blockquote expandable>' : '<blockquote>'
		accountBlocks.push(
			`🏦 ${formatAccountName(acc.name, false)}
Сумма: ${fmt(accountTotalMain, mainCurrency)} ${mainSym}
Активы:
${blockquoteOpen}${assetLines.length ? assetLines.join('\n') : '• нет активов'}</blockquote>`
		)
	}

	const totalStr = fmt(totalMain, mainCurrency)
	const pctFiat = totalMain > 0 ? Math.round((totalFiat / totalMain) * 100) : 0
	const pctCrypto = totalMain > 0 ? Math.round((totalCrypto / totalMain) * 100) : 0
	const fiatStr = fmt(totalFiat, mainCurrency)
	const cryptoStr = fmt(totalCrypto, mainCurrency)
	let cashflow = 0
	try {
		cashflow = await analytics.getCashflow(userId, 'month', mainCurrency)
	} catch {}
	const beginning = totalMain - cashflow
	const growthPct = beginning > 0 ? (cashflow / beginning) * 100 : Number.NaN
	const growthStr =
		Number.isFinite(growthPct) && Math.abs(growthPct) <= 10000
			? `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%`
			: '—'
	const accountsCount = visibleAccounts.length
	if (accountsCount === 0) {
		return `💼 Ваши счета

🏦 Список счетов пуст.

💰 Общий капитал:
0,00 ${mainSym} (—)

📊 Структура портфеля
Фиат — 0,00 ${mainSym} (0%)
Крипто — 0,00 ${mainSym} (0%)

🏦 Всего счетов: 0
🌍 Основная валюта: ${mainCurrency}`
	}

	const summaryBlock = `💼 Ваши счета

💰 Общий капитал:
${totalStr} ${mainSym} (${growthStr})

📊 Структура портфеля
Фиат — ${fiatStr} ${mainSym} (${pctFiat}%)
Крипто — ${cryptoStr} ${mainSym} (${pctCrypto}%)

🏦 Всего счетов: ${accountsCount}
🌍 Основная валюта: ${mainCurrency}`
	if (!expanded) return summaryBlock

	return `💼 Ваши счета

${accountBlocks.join('\n\n')}

💰 Общий капитал:
${totalStr} ${mainSym} (${growthStr})

📊 Структура портфеля
Фиат — ${fiatStr} ${mainSym} (${pctFiat}%)
Крипто — ${cryptoStr} ${mainSym} (${pctCrypto}%)

🏦 Всего счетов: ${accountsCount}
🌍 Основная валюта: ${mainCurrency}`
}

async function assetsBlock(
	assets: { currency: string; amount: number }[],
	mainCurrency: string,
	mainSym: string,
	exchange: ExchangeService
): Promise<string> {
	if (assets.length === 0) return '<b>📊 Активы:</b>\n— <i>нет активов</i>\n'
	const lines: string[] = ['<b>📊 Активы:</b>']
	for (let i = 0; i < assets.length; i++) {
		const a = assets[i]
		const amountStr = formatExactAmount(a.amount, a.currency, {
			maxFractionDigits: 18
		})
		if (a.currency === mainCurrency || a.amount === 0) {
			lines.push(`${i + 1}. ${a.currency} — <i>${amountStr}</i>`)
		} else {
			const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
			lines.push(
				converted != null
					? `${i + 1}. ${a.currency} — <i>${amountStr} (~ ${fmt(converted, mainCurrency)} ${mainSym})</i>`
					: `${i + 1}. ${a.currency} — <i>${amountStr}</i>`
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
	analyticsData?: AccountAnalyticsData,
	timezone: string = 'UTC+02:00'
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let balanceMain = 0
	for (const a of account.assets) {
		const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
		if (converted != null) balanceMain += converted
	}
	const balanceStr = fmt(balanceMain, mainCurrency)
	const nameHtml = escapeHtml(formatAccountName(account.name, isDefault))
	const assetsSection = await assetsBlock(
		account.assets,
		mainCurrency,
		mainSym,
		exchange
	)

	if (!isPremium || !analyticsData) {
		const title = new Date().toLocaleString('ru-RU', { month: 'long' })
		let body = `<b>${nameHtml}</b> – Обзор за ${title}

💰 Капитал в начале месяца: <i>${balanceStr} ${mainSym}</i>
💰 Текущий капитал: <i>${balanceStr} ${mainSym}</i>

🔴 Расходы: <i>−0,00 ${mainSym}</i>
🟢 Доходы: <i>+0,00 ${mainSym}</i>
⚪️ Переводы: <i>0,00 ${mainSym}</i>

💸 Денежный поток: <i>+0,00 ${mainSym}</i>
➖ Средний расход в день: <i>0,00 ${mainSym}</i>

— — —

${assetsSection}
<b>🧾 Последние операции:</b>
`
		if (lastTransactions.length === 0) body += 'Нет операций\n'
		else {
			lastTransactions.slice(0, 3).forEach((tx, i) => {
				body +=
					formatDetailTxLine(tx, i, mainSym, mainCurrency, timezone) + '\n'
			})
		}
		return body.trim()
	}

	const a = analyticsData
	const title = new Date().toLocaleString('ru-RU', { month: 'long' })
	let body = `<b>${nameHtml}</b> – Обзор за ${title}

💰 Капитал в начале месяца: <i>${fmt(a.beginningBalance, mainCurrency)} ${mainSym}</i>
💰 Текущий капитал: <i>${fmt(a.balance, mainCurrency)} ${mainSym}</i>

🔴 Расходы: <i>−${fmt(a.expenses, mainCurrency)} ${mainSym}</i>
🟢 Доходы: <i>+${fmt(a.income, mainCurrency)} ${mainSym}</i>
⚪️ Переводы: <i>${fmt(a.transfersTotal, mainCurrency)} ${mainSym}</i>

💸 Денежный поток: <i>${a.cashflow >= 0 ? '+' : ''}${fmt(a.cashflow, mainCurrency)} ${mainSym}</i>
➖ Средний расход в день: <i>${fmt(a.burnRate, mainCurrency)} ${mainSym}</i>

— — —

${assetsSection}
<b>🧾 Последние операции:</b>
`
	if (lastTransactions.length === 0) body += 'Нет операций\n'
	else {
		lastTransactions.slice(0, 3).forEach((tx, i) => {
			body += formatDetailTxLine(tx, i, mainSym, mainCurrency, timezone) + '\n'
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
	mainCurrency: string,
	timezone: string
): string {
	const label = capitalize(tx.description ?? tx.tagName ?? tx.category ?? '—')
	const dateStr = formatTransactionDate(tx.transactionDate, timezone)
	if (tx.direction === 'transfer') {
		const sourceAmount = formatExactAmount(Math.abs(tx.amount), tx.currency, {
			maxFractionDigits: 18
		})
		const amountStr = `${sourceAmount} (~ ${fmt(tx.amountMain, mainCurrency)} ${mainSym})`
		return `<blockquote>⚪️ ${amountStr}  | ${escapeHtml(label)} | ${dateStr}</blockquote>`
	}
	const sign = tx.direction === 'expense' ? '−' : '+'
	const isMain = tx.currency === mainCurrency
	const amountStr = isMain
		? `${sign}${fmt(Math.abs(tx.amount), mainCurrency)} ${mainSym}`
		: `${sign}${formatExactAmount(Math.abs(tx.amount), tx.currency, {
				maxFractionDigits: 18
			})} (${fmt(tx.amountMain, mainCurrency)} ${mainSym})`
	const icon = tx.direction === 'expense' ? '🔴' : '🟢'
	return `<blockquote>${icon} ${amountStr}  | ${escapeHtml(label)} | ${dateStr}</blockquote>`
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
			const amountStr = formatExactAmount(a.amount, a.currency, {
				maxFractionDigits: 18
			})
			if (converted != null) {
				accountTotalMain += converted
				if (a.currency === mainCurrency) {
					lines.push(`• ${a.currency} — ${amountStr}`)
				} else {
					lines.push(
						`• ${a.currency} — ${amountStr} ≈ ${fmt(converted, mainCurrency)} ${mainSym}`
					)
				}
			} else {
				lines.push(`• ${a.currency} — ${amountStr} (курс неизвестен)`)
			}
		}
		totalMain += accountTotalMain
		const accountTotalStr = fmt(accountTotalMain, mainCurrency)
		const body = lines.length > 0 ? lines.join('\n') : '— нет активов'
		const accountLine =
			acc.assets.length > 0
				? `Итого: ${accountTotalStr} ${mainSym}`
				: `Итого: 0.00 ${mainSym}`
		const isDefault = acc.id === defaultAccountId
		blocks.push(
			`${formatAccountName(acc.name, isDefault)}\n${accountLine}\n\n${body}`
		)
	}

	const totalStr = fmt(totalMain, mainCurrency)
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
