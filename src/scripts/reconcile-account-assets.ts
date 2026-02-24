import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'
import { canonicalizeTradePayload } from '../modules/transactions/utils/canonicalize-trade'

type AssetMap = Map<string, number>

type CanonicalTx = {
	id: string
	direction: string
	accountId: string
	fromAccountId: string | null
	toAccountId: string | null
	amount: number
	currency: string
	convertedAmount: number | null
	convertToCurrency: string | null
	tradeType: 'buy' | 'sell' | null
	tradeBaseCurrency: string | null
	tradeBaseAmount: number | null
	tradeQuoteCurrency: string | null
	tradeQuoteAmount: number | null
	executionPrice: number | null
	tradeFeeCurrency: string | null
	tradeFeeAmount: number | null
}

const toNum = (value: unknown): number => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0
	if (typeof value === 'string') {
		const n = Number(value)
		return Number.isFinite(n) ? n : 0
	}
	if (value && typeof value === 'object') {
		const anyValue = value as { toNumber?: () => number; valueOf?: () => unknown }
		if (typeof anyValue.toNumber === 'function') {
			const n = anyValue.toNumber()
			return Number.isFinite(n) ? n : 0
		}
		const primitive = anyValue.valueOf?.()
		if (typeof primitive === 'number') return Number.isFinite(primitive) ? primitive : 0
		if (typeof primitive === 'string') {
			const n = Number(primitive)
			return Number.isFinite(n) ? n : 0
		}
	}
	return 0
}

const usage = () => {
	console.error(
		'Usage: npm run reconcile:assets -- --user-id <uuid> [--dry-run] [--apply]'
	)
	process.exit(1)
}

const args = process.argv.slice(2)
const getArg = (name: string): string | undefined => {
	const idx = args.findIndex(arg => arg === name)
	if (idx < 0) return undefined
	const value = args[idx + 1]
	if (!value || value.startsWith('--')) return undefined
	return value
}

const userId = getArg('--user-id')
if (!userId) usage()

const apply = args.includes('--apply')
const dryRun = !apply || args.includes('--dry-run')

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	console.error('DATABASE_URL is required')
	process.exit(1)
}

const prisma = new PrismaClient({
	adapter: new PrismaPg({ connectionString: databaseUrl })
})

const keyOf = (accountId: string, currency: string): string =>
	`${accountId}|${currency.toUpperCase()}`

const addDelta = (
	map: AssetMap,
	accountId: string | null | undefined,
	currency: string | null | undefined,
	delta: number
) => {
	if (!accountId) return
	const code = String(currency ?? '').toUpperCase().trim()
	if (!code || !Number.isFinite(delta) || delta === 0) return
	const key = keyOf(accountId, code)
	map.set(key, (map.get(key) ?? 0) + delta)
}

const applyEffect = (target: AssetMap, tx: CanonicalTx) => {
	const useConverted = tx.convertedAmount != null && !!tx.convertToCurrency
	const amountToUse = useConverted ? Math.abs(tx.convertedAmount ?? 0) : Math.abs(tx.amount)
	const currencyToUse = useConverted
		? String(tx.convertToCurrency ?? '').toUpperCase()
		: String(tx.currency ?? '').toUpperCase()
	if (tx.direction === 'expense') {
		addDelta(target, tx.accountId, currencyToUse, -amountToUse)
		return
	}
	if (tx.direction === 'income') {
		addDelta(target, tx.accountId, currencyToUse, amountToUse)
		return
	}
	if (tx.direction !== 'transfer' || !tx.toAccountId) return
	const fromId = tx.fromAccountId ?? tx.accountId
	addDelta(target, fromId, tx.currency, -Math.abs(tx.amount))
	addDelta(target, tx.toAccountId, currencyToUse, amountToUse)
	if ((tx.tradeFeeAmount ?? 0) > 0 && tx.tradeFeeCurrency) {
		addDelta(target, fromId, tx.tradeFeeCurrency, -Math.abs(tx.tradeFeeAmount ?? 0))
	}
}

const toCanonicalTx = (tx: any): CanonicalTx => {
	const merged = {
		tradeType: (tx.tradeType as 'buy' | 'sell' | null) ?? null,
		amount: toNum(tx.amount),
		currency: String(tx.currency ?? '').toUpperCase(),
		convertedAmount: tx.convertedAmount != null ? toNum(tx.convertedAmount) : null,
		convertToCurrency:
			tx.convertToCurrency != null ? String(tx.convertToCurrency).toUpperCase() : null,
		tradeBaseCurrency:
			tx.tradeBaseCurrency != null ? String(tx.tradeBaseCurrency).toUpperCase() : null,
		tradeBaseAmount: tx.tradeBaseAmount != null ? toNum(tx.tradeBaseAmount) : null,
		tradeQuoteCurrency:
			tx.tradeQuoteCurrency != null
				? String(tx.tradeQuoteCurrency).toUpperCase()
				: null,
		tradeQuoteAmount:
			tx.tradeQuoteAmount != null ? toNum(tx.tradeQuoteAmount) : null,
		executionPrice: tx.executionPrice != null ? toNum(tx.executionPrice) : null,
		tradeFeeCurrency:
			tx.tradeFeeCurrency != null ? String(tx.tradeFeeCurrency).toUpperCase() : null,
		tradeFeeAmount: tx.tradeFeeAmount != null ? toNum(tx.tradeFeeAmount) : null
	}
	const canonical = canonicalizeTradePayload(merged)
	return {
		id: tx.id,
		direction: String(tx.direction),
		accountId: tx.accountId,
		fromAccountId: tx.fromAccountId ?? null,
		toAccountId: tx.toAccountId ?? null,
		amount: canonical?.amount ?? merged.amount,
		currency: canonical?.currency ?? merged.currency,
		convertedAmount: canonical?.convertedAmount ?? merged.convertedAmount,
		convertToCurrency: canonical?.convertToCurrency ?? merged.convertToCurrency,
		tradeType: canonical?.tradeType ?? merged.tradeType,
		tradeBaseCurrency: canonical?.tradeBaseCurrency ?? merged.tradeBaseCurrency,
		tradeBaseAmount: canonical?.tradeBaseAmount ?? merged.tradeBaseAmount,
		tradeQuoteCurrency: canonical?.tradeQuoteCurrency ?? merged.tradeQuoteCurrency,
		tradeQuoteAmount: canonical?.tradeQuoteAmount ?? merged.tradeQuoteAmount,
		executionPrice: canonical?.executionPrice ?? merged.executionPrice,
		tradeFeeCurrency: canonical?.tradeFeeCurrency ?? merged.tradeFeeCurrency,
		tradeFeeAmount: canonical?.tradeFeeAmount ?? merged.tradeFeeAmount
	}
}

const hasTxDiff = (current: any, canonical: CanonicalTx): boolean => {
	const eqNum = (a: unknown, b: unknown) => Math.abs(toNum(a) - toNum(b)) <= 1e-12
	const eqStr = (a: unknown, b: unknown) =>
		String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()
	return !(
		eqNum(current.amount, canonical.amount) &&
		eqStr(current.currency, canonical.currency) &&
		eqNum(current.convertedAmount, canonical.convertedAmount) &&
		eqStr(current.convertToCurrency, canonical.convertToCurrency) &&
		eqStr(current.tradeType, canonical.tradeType) &&
		eqStr(current.tradeBaseCurrency, canonical.tradeBaseCurrency) &&
		eqNum(current.tradeBaseAmount, canonical.tradeBaseAmount) &&
		eqStr(current.tradeQuoteCurrency, canonical.tradeQuoteCurrency) &&
		eqNum(current.tradeQuoteAmount, canonical.tradeQuoteAmount) &&
		eqNum(current.executionPrice, canonical.executionPrice) &&
		eqStr(current.tradeFeeCurrency, canonical.tradeFeeCurrency) &&
		eqNum(current.tradeFeeAmount, canonical.tradeFeeAmount)
	)
}

async function main() {
	const accounts = await prisma.account.findMany({
		where: { userId },
		include: { assets: true },
		orderBy: { createdAt: 'asc' }
	})
	if (!accounts.length) {
		console.log('No accounts found for this user')
		return
	}

	const transactions = await prisma.transaction.findMany({
		where: { userId },
		orderBy: { transactionDate: 'asc' }
	})
	if (!transactions.length) {
		console.log('No transactions found for this user')
		return
	}

	const currentAssets: AssetMap = new Map()
	for (const acc of accounts) {
		for (const asset of acc.assets) {
			currentAssets.set(keyOf(acc.id, String(asset.currency)), toNum(asset.amount))
		}
	}

	const oldDelta: AssetMap = new Map()
	const newDelta: AssetMap = new Map()
	const changedTransactions: Array<{ id: string; summary: string; canonical: CanonicalTx }> =
		[]

	for (const tx of transactions) {
		const oldTx: CanonicalTx = {
			id: tx.id,
			direction: String(tx.direction),
			accountId: tx.accountId,
			fromAccountId: tx.fromAccountId ?? null,
			toAccountId: tx.toAccountId ?? null,
			amount: toNum(tx.amount),
			currency: String(tx.currency ?? '').toUpperCase(),
			convertedAmount: tx.convertedAmount != null ? toNum(tx.convertedAmount) : null,
			convertToCurrency:
				tx.convertToCurrency != null ? String(tx.convertToCurrency).toUpperCase() : null,
			tradeType: (tx.tradeType as 'buy' | 'sell' | null) ?? null,
			tradeBaseCurrency:
				tx.tradeBaseCurrency != null ? String(tx.tradeBaseCurrency).toUpperCase() : null,
			tradeBaseAmount: tx.tradeBaseAmount != null ? toNum(tx.tradeBaseAmount) : null,
			tradeQuoteCurrency:
				tx.tradeQuoteCurrency != null
					? String(tx.tradeQuoteCurrency).toUpperCase()
					: null,
			tradeQuoteAmount:
				tx.tradeQuoteAmount != null ? toNum(tx.tradeQuoteAmount) : null,
			executionPrice: tx.executionPrice != null ? toNum(tx.executionPrice) : null,
			tradeFeeCurrency:
				tx.tradeFeeCurrency != null ? String(tx.tradeFeeCurrency).toUpperCase() : null,
			tradeFeeAmount: tx.tradeFeeAmount != null ? toNum(tx.tradeFeeAmount) : null
		}
		const canonicalTx = toCanonicalTx(tx)
		applyEffect(oldDelta, oldTx)
		applyEffect(newDelta, canonicalTx)
		if ((tx.tradeType === 'buy' || tx.tradeType === 'sell') && hasTxDiff(tx, canonicalTx)) {
			changedTransactions.push({
				id: tx.id,
				summary: `${tx.tradeType} ${String(tx.tradeBaseCurrency ?? tx.currency).toUpperCase()}`,
				canonical: canonicalTx
			})
		}
	}

	const baseline: AssetMap = new Map()
	for (const [key, current] of currentAssets.entries()) {
		baseline.set(key, current - (oldDelta.get(key) ?? 0))
	}
	for (const [key, delta] of oldDelta.entries()) {
		if (!baseline.has(key)) baseline.set(key, 0 - delta)
	}

	const targetAssets: AssetMap = new Map()
	for (const [key, base] of baseline.entries()) {
		targetAssets.set(key, base + (newDelta.get(key) ?? 0))
	}
	for (const [key, delta] of newDelta.entries()) {
		if (!targetAssets.has(key)) targetAssets.set(key, delta)
	}

	console.log(`User: ${userId}`)
	console.log(`Transactions total: ${transactions.length}`)
	console.log(`Trade transactions to canonicalize: ${changedTransactions.length}`)
	console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`)
	console.log('')

	const accountNameById = new Map<string, string>(
		accounts.map(acc => [acc.id, String(acc.name ?? acc.id)])
	)
	const targetRows = Array.from(targetAssets.entries())
		.map(([key, amount]) => {
			const [accountId, currency] = key.split('|')
			const current = currentAssets.get(key) ?? 0
			return {
				accountId,
				accountName: accountNameById.get(accountId) ?? accountId,
				currency,
				current,
				target: amount,
				diff: amount - current
			}
		})
		.filter(row => Math.abs(row.diff) > 1e-12)
		.sort((a, b) =>
			a.accountName === b.accountName
				? a.currency.localeCompare(b.currency)
				: a.accountName.localeCompare(b.accountName)
		)

	if (!targetRows.length) {
		console.log('Asset diff: no changes needed.')
	} else {
		console.log('Asset diff:')
		for (const row of targetRows) {
			console.log(
				`- ${row.accountName} ${row.currency}: ${row.current.toFixed(8)} -> ${row.target.toFixed(8)} (delta ${row.diff.toFixed(8)})`
			)
		}
	}

	if (changedTransactions.length) {
		console.log('')
		console.log('Changed trade transactions:')
		for (const tx of changedTransactions.slice(0, 30)) {
			console.log(
				`- ${tx.id}: ${tx.summary} | amount=${tx.canonical.amount} ${tx.canonical.currency}, converted=${tx.canonical.convertedAmount} ${tx.canonical.convertToCurrency}`
			)
		}
		if (changedTransactions.length > 30) {
			console.log(`... and ${changedTransactions.length - 30} more`)
		}
	}

	if (!apply || dryRun) {
		if (!apply) {
			console.log('')
			console.log('Dry-run complete. Use --apply to persist changes.')
		}
		return
	}

	await prisma.$transaction(async tx => {
		for (const changed of changedTransactions) {
			await tx.transaction.update({
				where: { id: changed.id },
				data: {
					amount: changed.canonical.amount ?? undefined,
					currency: changed.canonical.currency ?? undefined,
					convertedAmount: changed.canonical.convertedAmount,
					convertToCurrency: changed.canonical.convertToCurrency,
					tradeType: changed.canonical.tradeType,
					tradeBaseCurrency: changed.canonical.tradeBaseCurrency,
					tradeBaseAmount: changed.canonical.tradeBaseAmount,
					tradeQuoteCurrency: changed.canonical.tradeQuoteCurrency,
					tradeQuoteAmount: changed.canonical.tradeQuoteAmount,
					executionPrice: changed.canonical.executionPrice,
					tradeFeeCurrency: changed.canonical.tradeFeeCurrency,
					tradeFeeAmount: changed.canonical.tradeFeeAmount
				}
			})
		}

		for (const account of accounts) {
			const existingCurrencies = new Set<string>(
				account.assets.map(asset => String(asset.currency).toUpperCase())
			)
			const targetCurrencies = new Set<string>(
				Array.from(targetAssets.keys())
					.filter(key => key.startsWith(`${account.id}|`))
					.map(key => key.split('|')[1] ?? '')
					.filter(Boolean)
			)
			const currencies = new Set<string>([
				...Array.from(existingCurrencies),
				...Array.from(targetCurrencies)
			])
			for (const currency of currencies) {
				const target = targetAssets.get(keyOf(account.id, currency)) ?? 0
				await tx.accountAsset.upsert({
					where: {
						accountId_currency: { accountId: account.id, currency }
					},
					update: { amount: target },
					create: { accountId: account.id, currency, amount: target }
				})
			}
		}
	})

	console.log('')
	console.log('Apply complete.')
}

main()
	.catch(err => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(async () => {
		await prisma.$disconnect()
	})
