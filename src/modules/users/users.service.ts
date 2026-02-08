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
				accounts: {
					create: [
						{ name: 'Наличные', type: 'cash', currency: 'EUR' },
						{
							name: 'Вне Wallet',
							type: 'cash',
							currency: 'USD',
							isHidden: true
						}
					]
				}
			},
			include: { accounts: true }
		})

		const account = user.accounts.find(a => !a.isHidden) ?? user.accounts[0]

		await this.categoriesService.createDefaults(user.id)
		await this.tagsService.createDefaults(user.id)

		await this.prisma.user.update({
			where: { id: user.id },
			data: { activeAccountId: account.id, defaultAccountId: account.id }
		})

		return {
			...user,
			activeAccountId: account.id,
			defaultAccountId: account.id
		}
	}

	async setMainCurrency(userId: string, code: string) {
		await this.prisma.user.update({
			where: { id: userId },
			data: { mainCurrency: code }
		})
	}

	async setDefaultAccount(userId: string, accountId: string) {
		await this.prisma.user.update({
			where: { id: userId },
			data: { defaultAccountId: accountId }
		})
	}
}
