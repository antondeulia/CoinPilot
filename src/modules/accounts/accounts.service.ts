import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'
import { LlmAccount } from '../llm/schemas/account.schema'
import { pickMoneyNumber, toDbMoney } from '../../utils/money'

@Injectable()
export class AccountsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly exchangeService: ExchangeService
	) {}

	private async ensureCurrenciesSupported(currencies: string[]) {
		const normalized = Array.from(
			new Set(currencies.map(c => (c || '').toUpperCase().trim()).filter(Boolean))
		)
		if (!normalized.length) return
		const rows = await this.prisma.currency.findMany({
			where: { code: { in: normalized } },
			select: { code: true }
		})
		const existing = new Set(rows.map(r => r.code.toUpperCase()))
		const unsupported = normalized.filter(c => !existing.has(c))
		if (unsupported.length > 0) {
			throw new Error(
				`Валюта ${unsupported[0]} не поддерживается, свяжитесь с разработчиком.`
			)
		}
	}

	async createAccount(userId: string, name: string, currency: string) {
		return this.prisma.account.create({
			data: {
				userId,
				name,
				currency,
				type: 'cash'
			}
		})
	}

	async setActive(userId: string, accountId: string) {
		return this.prisma.user.update({
			where: { id: userId },
			data: { activeAccountId: accountId }
		})
	}

	async getAllByUserId(userId: string) {
		return this.prisma.account.findMany({
			where: { userId, isHidden: false },
			orderBy: { createdAt: 'asc' }
		})
	}

	async getAllByUserIdIncludingHidden(userId: string) {
		return this.prisma.account.findMany({
			where: { userId },
			orderBy: { createdAt: 'asc' }
		})
	}

	async getAllWithAssets(userId: string) {
		return this.prisma.account.findMany({
			where: { userId, isHidden: false },
			include: { assets: true },
			orderBy: { createdAt: 'asc' }
		})
	}

	async getOneWithAssets(accountId: string, userId: string) {
		return this.prisma.account.findFirst({
			where: { id: accountId, userId },
			include: { assets: true }
		})
	}

	private extractEmojiPrefix(value: string): string {
		const m = String(value ?? '')
			.trim()
			.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+)/u)
		return m?.[1] ?? ''
	}

	private stripLeadingEmoji(value: string): string {
		return String(value ?? '')
			.replace(
				/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u,
				''
			)
			.trim()
	}

	private normalizeAccountNameBase(value: string): string {
		const base = String(value ?? '').trim()
		if (!base) return 'Счёт'
		const letters = base.replace(/[^A-Za-zА-Яа-яЁё]/g, '')
		if (letters.length > 0 && letters === letters.toUpperCase()) {
			return base
		}
		const chars = Array.from(base)
		if (!chars.length) return 'Счёт'
		return `${chars[0].toUpperCase()}${chars.slice(1).join('')}`
	}

	private normalizeAssetCurrency(value: string): string {
		const raw = String(value ?? '').trim()
		if (!raw) return ''
		const upper = raw.toUpperCase()
		const aliases: Record<string, string> = {
			'$': 'USD',
			ДОЛЛАР: 'USD',
			ДОЛЛАРЫ: 'USD',
			ДОЛЛАРОВ: 'USD',
			'€': 'EUR',
			ЕВРО: 'EUR',
			'₴': 'UAH',
			ГРН: 'UAH',
			ГРИВНА: 'UAH',
			ГРИВНЫ: 'UAH',
			'₽': 'RUB',
			РУБ: 'RUB',
			РУБЛЬ: 'RUB',
			РУБЛЯ: 'RUB',
			РУБЛЕЙ: 'RUB',
			'£': 'GBP',
			ФУНТ: 'GBP',
			BYP: 'BYN',
			BYR: 'BYN',
			БЕЛРУБ: 'BYN',
			БЕЛОРУБЛЬ: 'BYN',
			БЕЛОРУССКИЙРУБЛЬ: 'BYN'
		}
		return aliases[upper] ?? upper
	}

	private buildAccountNameFromRawText(
		rawText: string | undefined,
		assets: { currency: string; amount: number }[]
	): string {
		let cleaned = String(rawText ?? '').trim()
		if (!cleaned) return ''
		for (const asset of assets) {
			const code = (asset.currency ?? '').trim()
			if (!code) continue
			const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			cleaned = cleaned.replace(
				new RegExp(
					`(?:^|\\s)${escaped}\\s*[:=\\-–—]?\\s*[-+]?\\d[\\d\\s.,]*`,
					'ig'
				),
				' '
			)
			cleaned = cleaned.replace(
				new RegExp(
					`(?:^|\\s)[-+]?\\d[\\d\\s.,]*\\s*${escaped}(?:\\s|$)`,
					'ig'
				),
				' '
			)
		}
		cleaned = cleaned
			.replace(/[;,]+/g, ' ')
			.replace(/\s{2,}/g, ' ')
			.trim()
		return this.stripLeadingEmoji(cleaned)
	}

	private resolvePreferredName(draft: LlmAccount): {
		emoji: string
		baseName: string
	} {
		const rawName = String(draft.name ?? '').trim()
		const draftEmoji = this.extractEmojiPrefix(rawName) || draft.emoji || '💼'
		const stripped = this.stripLeadingEmoji(rawName)
		const fallbackByRaw = this.buildAccountNameFromRawText(
			draft.rawText,
			draft.assets ?? []
		)
		const genericNames = new Set([
			'банк',
			'счёт',
			'счет',
			'кошелёк',
			'кошелек',
			'аккаунт',
			'exchange',
			'wallet'
		])
		const strippedLower = stripped.toLowerCase()
		const shouldUseRawFallback =
			!stripped ||
			genericNames.has(strippedLower) ||
			(/^банк\s*\d*$/i.test(stripped) && fallbackByRaw.length > 0)
		const baseName = (
			shouldUseRawFallback ? fallbackByRaw || stripped : stripped
		).trim()
		return {
			emoji: draftEmoji,
			baseName: this.normalizeAccountNameBase(baseName || 'Счёт')
		}
	}

	/**
	 * Обновляет название и текущий баланс счёта (активы).
	 * Баланс — всегда текущий: хранится только в AccountAsset, без отдельного «начального».
	 * Пользователь может в любой момент задать актуальный баланс через Jarvis-редактирование.
	 */
	async updateAccountWithAssets(
		accountId: string,
		userId: string,
		draft: { name: string; assets: { currency: string; amount: number }[] }
	) {
		const normalizedAssets = draft.assets
			.map(a => ({
				currency: this.normalizeAssetCurrency(a.currency),
				amount: Number(a.amount ?? 0)
			}))
			.filter(a => !!a.currency && Number.isFinite(a.amount))
		if (!normalizedAssets.length) {
			throw new Error('Счёт должен содержать хотя бы один актив.')
		}
		await this.ensureCurrenciesSupported(normalizedAssets.map(a => a.currency))
		await this.prisma.$transaction(async tx => {
			await tx.accountAsset.deleteMany({ where: { accountId } })
			for (const a of normalizedAssets) {
				await tx.accountAsset.create({
					data: {
						accountId,
						currency: a.currency,
						amount: a.amount,
						amountDecimal: toDbMoney(a.amount) ?? undefined
					}
				})
			}
		})
	}

	async renameAccount(accountId: string, userId: string, requestedName: string) {
		const account = await this.prisma.account.findFirst({
			where: { id: accountId, userId, isHidden: false },
			select: { id: true, name: true }
		})
		if (!account) return null
		const input = String(requestedName ?? '').trim()
		const currentEmoji = this.extractEmojiPrefix(account.name)
		const newEmoji = this.extractEmojiPrefix(input) || currentEmoji || '💼'
		const base =
			this.normalizeAccountNameBase(
				this.stripLeadingEmoji(input) || this.stripLeadingEmoji(account.name)
			) || 'Счёт'
		if (!base) return null
		let candidate = `${newEmoji} ${base}`.trim()
		if (candidate === account.name) return account
		let suffix = 1
		while (
			await this.prisma.account.findFirst({
				where: { userId, name: candidate, NOT: { id: accountId } },
				select: { id: true }
			})
		) {
			suffix += 1
			candidate = `${newEmoji} ${base} ${suffix}`.trim()
		}
		return this.prisma.account.update({
			where: { id: accountId, userId },
			data: { name: candidate }
		})
	}

	async findByName(userId: string, name: string) {
		return this.prisma.account.findFirst({
			where: {
				userId,
				name
			}
		})
	}

	async deleteAccount(accountId: string, userId: string): Promise<boolean> {
		const account = await this.prisma.account.findFirst({
			where: { id: accountId, userId }
		})
		if (!account) return false
		await this.prisma.$transaction(async tx => {
			await tx.transaction.deleteMany({
				where: {
					OR: [
						{ accountId },
						{ fromAccountId: accountId },
						{ toAccountId: accountId }
					]
				}
			})
			await tx.account.delete({ where: { id: accountId, userId } })
			const user = await tx.user.findUnique({
				where: { id: userId },
				select: { activeAccountId: true, defaultAccountId: true }
			})
				if (user && (user.activeAccountId === accountId || user.defaultAccountId === accountId)) {
					const other = await tx.account.findFirst({
						where: { userId, isHidden: false }
					})
					await tx.user.update({
						where: { id: userId },
					data: {
						activeAccountId: other?.id ?? null,
						defaultAccountId: other?.id ?? null
					}
				})
			}
		})
		return true
	}

	/**
	 * Cashflow за текущий календарный месяц: с 1-го числа месяца по сегодня включительно
	 * (локальное время сервера). Учитываются income/expense и переводы на/с «Вне Wallet».
	 * Валюта приводится к mainCurrency.
	 */
	async getBalance({
		userId,
		mainCurrency
	}: {
		userId: string
		mainCurrency?: string
	}): Promise<number> {
		const main =
			mainCurrency ??
			(
				await this.prisma.user.findUnique({
					where: { id: userId },
					select: { mainCurrency: true }
				})
			)?.mainCurrency ??
			'USD'

		const now = new Date()
		const startOfMonth = new Date(
			now.getFullYear(),
			now.getMonth(),
			1,
			0,
			0,
			0,
			0
		)
		const endOfToday = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			23,
			59,
			59,
			999
		)

		const [txs, transferTxs] = await Promise.all([
				this.prisma.transaction.findMany({
				where: {
					userId,
					direction: { in: ['income', 'expense'] },
					account: { userId, isHidden: false },
					transactionDate: { gte: startOfMonth, lte: endOfToday }
				},
					select: {
						direction: true,
						amount: true,
						amountDecimal: true,
						currency: true,
						convertedAmount: true,
						convertedAmountDecimal: true,
						convertToCurrency: true
					}
				}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'transfer',
					toAccountId: { not: null },
					transactionDate: { gte: startOfMonth, lte: endOfToday },
					OR: [
						{ account: { userId, isHidden: false }, toAccount: { isHidden: true } },
						{ account: { userId, isHidden: true }, toAccount: { isHidden: false } }
					]
				},
					select: {
						amount: true,
						amountDecimal: true,
						currency: true,
						convertedAmount: true,
						convertedAmountDecimal: true,
						convertToCurrency: true,
						account: { select: { isHidden: true } },
						toAccount: { select: { isHidden: true } }
				}
			})
		])

		let inflowsMain = 0
		let outflowsMain = 0
		for (const tx of txs) {
			const useConverted =
				tx.convertedAmount != null &&
				tx.convertToCurrency != null &&
				tx.convertToCurrency === main
			const converted = useConverted
				? pickMoneyNumber(tx.convertedAmountDecimal, tx.convertedAmount, 0)
				: await this.exchangeService.convert(
						pickMoneyNumber(tx.amountDecimal, tx.amount, 0),
						tx.currency,
						main
					)
			const amountMain = converted ?? 0
			if (tx.direction === 'income') inflowsMain += amountMain
			else outflowsMain += amountMain
		}
		for (const tx of transferTxs) {
			const useConverted =
				tx.convertedAmount != null &&
				tx.convertToCurrency != null &&
				tx.convertToCurrency === main
			const converted = useConverted
				? pickMoneyNumber(tx.convertedAmountDecimal, tx.convertedAmount, 0)
				: await this.exchangeService.convert(
						pickMoneyNumber(tx.amountDecimal, tx.amount, 0),
						tx.currency,
						main
					)
			const amountMain = converted ?? 0
			const toExternal = tx.toAccount?.isHidden === true
			if (toExternal) outflowsMain += amountMain
			else inflowsMain += amountMain
		}
		return inflowsMain - outflowsMain
	}

	async createAccountWithAssets(userId: string, draft: LlmAccount) {
		const { emoji, baseName } = this.resolvePreferredName(draft)
		const accountTypeMap: Record<string, 'bank' | 'cash' | 'crypto'> = {
			bank: 'bank',
			exchange: 'bank',
			crypto_wallet: 'crypto',
			cash: 'cash',
			online_service: 'bank',
			other: 'bank'
		}
		const type = accountTypeMap[draft.accountType ?? 'bank'] ?? 'bank'
		const mergedAssets = new Map<string, number>()
		for (const asset of draft.assets) {
			const currency = this.normalizeAssetCurrency(asset.currency)
			if (!currency) continue
			const amount = Number(asset.amount ?? 0)
			if (!Number.isFinite(amount)) continue
			const prev = mergedAssets.get(currency) ?? 0
			mergedAssets.set(currency, prev + amount)
		}
		const assets = Array.from(mergedAssets.entries()).map(([currency, amount]) => ({
			currency,
			amount
		}))
		if (!assets.length) {
			throw new Error(
				'Для создания счёта укажите хотя бы одну валюту (например: "USD" или "100 USD").'
			)
		}
		await this.ensureCurrenciesSupported(assets.map(a => a.currency))

			return this.prisma.$transaction(async tx => {
				let name = `${emoji} ${baseName}`.trim()
				let suffix = 1
				while (await tx.account.findFirst({ where: { userId, name } })) {
					suffix++
					name = `${emoji} ${baseName} ${suffix}`.trim()
				}
			const existingCount = await tx.account.count({
				where: { userId, isHidden: false }
			})
			const account = await tx.account.create({
				data: {
					userId,
					name,
					type,
					currency: assets[0].currency
				}
			})

			for (const asset of assets) {
					await tx.accountAsset.create({
						data: {
							accountId: account.id,
							currency: asset.currency,
							amount: asset.amount,
							amountDecimal: toDbMoney(asset.amount) ?? undefined
						}
					})
				}

			if (existingCount === 0) {
				await tx.user.update({
					where: { id: userId },
					data: { defaultAccountId: account.id, activeAccountId: account.id }
				})
			}

			return account
		})
	}
}
