import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'
import { LlmAccount } from '../llm/schemas/account.schema'

@Injectable()
export class AccountsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly exchangeService: ExchangeService
	) {}

	private static readonly LEADING_EMOJI_RE =
		/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+)/u

	private static readonly STRIP_LEADING_EMOJI_RE =
		/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u

	private extractLeadingEmoji(value?: string | null): string | null {
		const raw = String(value ?? '').trim()
		if (!raw) return null
		const m = raw.match(AccountsService.LEADING_EMOJI_RE)
		return m?.[1] ?? null
	}

	private normalizeAccountText(value?: string | null): string {
		const raw = String(value ?? '')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[.,;:!?]+$/g, '')
		const noLeadingEmoji = raw
			.replace(AccountsService.STRIP_LEADING_EMOJI_RE, '')
			.trim()
		const safe = noLeadingEmoji || 'Счёт'
		return safe.charAt(0).toUpperCase() + safe.slice(1)
	}

	private fallbackEmojiByType(type?: string | null): string {
		const normalized = String(type ?? '').toLowerCase()
		if (normalized === 'cash') return '💵'
		if (normalized === 'crypto') return '🪙'
		if (normalized === 'bank') return '🏦'
		return '💼'
	}

	private normalizeAccountDisplayName(params: {
		nextName?: string | null
		existingName?: string | null
		accountType?: string | null
	}): string {
		const explicitEmoji = this.extractLeadingEmoji(params.nextName)
		const existingEmoji = this.extractLeadingEmoji(params.existingName)
		const emoji =
			explicitEmoji ??
			existingEmoji ??
			this.fallbackEmojiByType(params.accountType)
		const text = this.normalizeAccountText(params.nextName)
		return `${emoji} ${text}`.trim()
	}

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
		return this.prisma.$transaction(async tx => {
			const existingVisible = await tx.account.count({
				where: { userId, isHidden: false, name: { not: 'Вне Wallet' } }
			})
			const account = await tx.account.create({
				data: {
					userId,
					name,
					currency,
					type: 'cash'
				}
			})
			if (existingVisible === 0) {
				await tx.user.update({
					where: { id: userId },
					data: { defaultAccountId: account.id, activeAccountId: account.id }
				})
			}
			return account
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

	async getHomeSnapshot(userId: string) {
		const [user, visibleAccounts] = await Promise.all([
			this.prisma.user.findUnique({
				where: { id: userId },
				select: { id: true, mainCurrency: true }
			}),
			this.prisma.account.count({
				where: { userId, isHidden: false }
			})
		])
		return {
			mainCurrency: user?.mainCurrency ?? 'USD',
			accountsCount: visibleAccounts
		}
	}

	async getOneWithAssets(accountId: string, userId: string) {
		return this.prisma.account.findFirst({
			where: { id: accountId, userId },
			include: { assets: true }
		})
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
		await this.ensureCurrenciesSupported(draft.assets.map(a => a.currency))
		await this.prisma.$transaction(async tx => {
			const existing = await tx.account.findFirst({
				where: { id: accountId, userId },
				select: { name: true, type: true }
			})
			if (!existing) {
				throw new Error('Счёт не найден')
			}
			const normalizedName = this.normalizeAccountDisplayName({
				nextName: draft.name,
				existingName: existing.name,
				accountType: existing.type
			})
			await tx.account.update({
				where: { id: accountId, userId },
				data: { name: normalizedName }
			})
			await tx.accountAsset.deleteMany({ where: { accountId } })
			for (const a of draft.assets) {
				await tx.accountAsset.create({
					data: { accountId, currency: a.currency, amount: a.amount }
				})
			}
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
					where: { userId, isHidden: false, name: { not: 'Вне Wallet' } },
					orderBy: { createdAt: 'asc' }
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
					currency: true,
					convertedAmount: true,
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
					currency: true,
					convertedAmount: true,
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
					? Number(tx.convertedAmount!)
					: await this.exchangeService.convert(Number(tx.amount), tx.currency, main)
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
					? Number(tx.convertedAmount!)
					: await this.exchangeService.convert(Number(tx.amount), tx.currency, main)
			const amountMain = converted ?? 0
			const toExternal = tx.toAccount?.isHidden === true
			if (toExternal) outflowsMain += amountMain
			else inflowsMain += amountMain
		}
		return inflowsMain - outflowsMain
	}

	async createAccountWithAssets(userId: string, draft: LlmAccount) {
		const rawName = draft.name.trim()
		const userEmojiMatch = rawName.match(
			/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+)/u
		)
		const userEmoji = userEmojiMatch?.[1]
		const emoji = userEmoji ?? draft.emoji ?? '💼'
		const nameWithoutLeadingEmoji = rawName
			.replace(
				/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u,
				''
			)
			.trim()
		const safeName = nameWithoutLeadingEmoji || 'Счёт'
		const cleanedName = safeName.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '').trim()
		const formattedName = cleanedName
			? cleanedName.charAt(0).toUpperCase() + cleanedName.slice(1)
			: 'Счёт'
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
			const currency = (asset.currency ?? '').toUpperCase().trim()
			if (!currency) continue
			const prev = mergedAssets.get(currency) ?? 0
			mergedAssets.set(currency, prev + Number(asset.amount ?? 0))
		}
		const assets = Array.from(mergedAssets.entries()).map(([currency, amount]) => ({
			currency,
			amount
		}))
		if (!assets.length) {
			assets.push({ currency: 'USD', amount: 0 })
		}
		await this.ensureCurrenciesSupported(assets.map(a => a.currency))

		return this.prisma.$transaction(async tx => {
			let name = `${emoji} ${formattedName}`.trim()
			let suffix = 1
			while (await tx.account.findFirst({ where: { userId, name } })) {
				suffix++
				name = `${emoji} ${formattedName} ${suffix}`.trim()
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
						amount: asset.amount
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
