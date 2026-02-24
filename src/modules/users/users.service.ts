import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CategoriesService } from '../categories/categories.service'
import { TagsService } from '../tags/tags.service'

@Injectable()
export class UsersService {
	constructor(
		private prisma: PrismaService,
		private categoriesService: CategoriesService,
		private tagsService: TagsService
	) {}

	async getOrCreateByTelegramId(telegramId: string) {
		const existing = await this.prisma.user.findUnique({
			where: { telegramId },
			include: { accounts: true }
		})

		if (existing) return existing

			const user = await this.prisma.user.create({
				data: {
					telegramId,
					mainCurrency: 'USD',
					timezone: 'UTC+02:00'
				}
			})

		await this.prisma.account.create({
			data: {
				userId: user.id,
				name: 'Вне Wallet',
				type: 'cash',
				currency: 'USD',
				isHidden: true
			}
		})

		await this.categoriesService.createDefaults(user.id)
		await this.tagsService.createDefaults(user.id)

		const withAccounts = await this.prisma.user.findUnique({
			where: { id: user.id },
			include: { accounts: true }
		})
		return withAccounts!
	}

	async setMainCurrency(userId: string, code: string) {
		await this.prisma.user.update({
			where: { id: userId },
			data: { mainCurrency: code }
		})
	}

	async setDefaultAccount(userId: string, accountId: string) {
		const account = await this.prisma.account.findFirst({
			where: { id: accountId, userId, isHidden: false },
			select: { id: true }
		})
		if (!account) return
		await this.prisma.user.update({
			where: { id: userId },
			data: { defaultAccountId: accountId }
		})
	}

	async setTimezone(userId: string, timezone: string) {
		await this.prisma.user.update({
			where: { id: userId },
			data: { timezone }
		})
	}

	async deleteAllUserData(userId: string) {
		await this.prisma.$transaction(async tx => {
			await tx.transaction.deleteMany({ where: { userId } })
			await tx.accountAsset.deleteMany({
				where: { account: { userId } }
			})
			await tx.account.deleteMany({ where: { userId } })
			await tx.category.deleteMany({ where: { userId } })
			await tx.tag.deleteMany({ where: { userId } })
			await tx.tagAuditLog.deleteMany({ where: { userId } })
			await tx.savedAnalyticsView.deleteMany({ where: { userId } })
			await tx.alertConfig.deleteMany({ where: { userId } })
			await tx.subscription.deleteMany({ where: { userId } })
			await tx.premiumEvent.deleteMany({ where: { userId } })
				await tx.user.update({
					where: { id: userId },
					data: {
						mainCurrency: 'USD',
						timezone: 'UTC+02:00',
						defaultAccountId: null,
						activeAccountId: null
					}
			})
			await tx.account.create({
				data: {
					userId,
					name: 'Вне Wallet',
					type: 'cash',
					currency: 'USD',
					isHidden: true
				}
			})
		})
		await this.categoriesService.createDefaults(userId)
		await this.tagsService.createDefaults(userId)
	}
}
