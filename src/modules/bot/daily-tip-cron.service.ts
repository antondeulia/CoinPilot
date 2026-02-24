import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'
import { AnalyticsService } from '../analytics/analytics.service'
import { LLMService } from '../llm/llm.service'

const BASIC_TX_LIMIT = 30

@Injectable()
export class DailyTipCronService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly exchange: ExchangeService,
		private readonly analytics: AnalyticsService,
		private readonly llm: LLMService
	) {}

	@Cron('0 0 * * *')
	async refreshDailyTips() {
		const users = await this.prisma.user.findMany({
			select: { id: true, mainCurrency: true, isPremium: true }
		})
		for (const user of users) {
			await this.refreshTipForUser(user.id, user.mainCurrency ?? 'USD', user.isPremium)
		}
	}

	private async refreshTipForUser(
		userId: string,
		mainCurrency: string,
		isPremium: boolean
	) {
		const accounts = await this.prisma.account.findMany({
			where: { userId, isHidden: false },
			include: { assets: true }
		})
		let totalCapital = 0
		let fiatTotal = 0
		let cryptoTotal = 0
		let largestAsset: { name: string; sharePct: number } | undefined
		let largestAssetAmount = 0

			for (const account of accounts) {
				for (const asset of account.assets) {
					const amount = Number(asset.amount)
					if (amount === 0) continue
					const converted = await this.exchange.convert(
						amount,
						asset.currency,
						mainCurrency
					)
				if (converted == null) continue
				totalCapital += converted
				const isCrypto = await this.exchange.isCryptoByCode(asset.currency)
				if (isCrypto) cryptoTotal += converted
				else fiatTotal += converted
				if (converted > largestAssetAmount) {
					largestAssetAmount = converted
					largestAsset = { name: `${asset.currency} (${account.name})`, sharePct: 0 }
				}
			}
		}
		if (largestAsset && totalCapital > 0) {
			largestAsset.sharePct = Number(((largestAssetAmount / totalCapital) * 100).toFixed(1))
		}

		const cashflow7 = await this.analytics.getCashflow(userId, '7d', mainCurrency)
		const cashflow30 = await this.analytics.getCashflow(userId, '30d', mainCurrency)
		const beginning7 = totalCapital - cashflow7
		const beginning30 = totalCapital - cashflow30
		const change7dPct = beginning7 > 0 ? (cashflow7 / beginning7) * 100 : 0
		const change30dPct = beginning30 > 0 ? (cashflow30 / beginning30) * 100 : 0

		const lastTx = await this.prisma.transaction.findFirst({
			where: { userId },
			orderBy: { transactionDate: 'desc' },
			select: { transactionDate: true }
		})
		const daysWithoutTransactions = lastTx
			? Math.floor(
					(Date.now() - new Date(lastTx.transactionDate).getTime()) /
						(24 * 60 * 60 * 1000)
				)
			: 999
		const monthStart = new Date()
		monthStart.setDate(1)
		monthStart.setHours(0, 0, 0, 0)
		const monthUsage = await this.prisma.transaction.count({
			where: { userId, transactionDate: { gte: monthStart } }
		})

		const tip = await this.llm.generateFinancialTip({
			mainCurrency,
			totalCapital: Number(totalCapital.toFixed(2)),
			fiatSharePct: totalCapital > 0 ? Number(((fiatTotal / totalCapital) * 100).toFixed(1)) : 0,
			cryptoSharePct:
				totalCapital > 0 ? Number(((cryptoTotal / totalCapital) * 100).toFixed(1)) : 0,
			change7dPct: Number(change7dPct.toFixed(1)),
			change30dPct: Number(change30dPct.toFixed(1)),
			accountsCount: accounts.length,
			daysWithoutTransactions,
			monthlyUsage: isPremium
				? undefined
				: { used: monthUsage, limit: BASIC_TX_LIMIT },
			largestAsset
		})

		await this.prisma.user.update({
			where: { id: userId },
			data: { lastTipText: tip, lastTipDate: new Date() }
		})
	}
}
