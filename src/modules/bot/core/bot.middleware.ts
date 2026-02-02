import { Context, MiddlewareFn } from 'grammy'
import { PrismaService } from '../../prisma/prisma.service'
import { UsersService } from '../../users/users.service'
import { Account, User } from 'generated/prisma/client'
import { LlmTransaction } from 'src/modules/llm/schemas/transaction.schema'

export interface BotState {
	user: User
	activeAccount: Account | null
}

export type BotContext = Context & {
	state: BotState
	session: {
		awaitingAccount: boolean
		awaitingTransaction: boolean
		tempMessageId: number | undefined
		homeMessageId: number
		confirmingTransaction?: boolean
		draftTransaction?: LlmTransaction
		editingField?: 'description' | 'amount' | 'date' | 'category'
	}
	chat: {
		id: string
	}
}

export const userContextMiddleware =
	(userService: UsersService, prisma: PrismaService): MiddlewareFn =>
	async (ctx: BotContext, next) => {
		if (!ctx.from) return next()

		const user = await userService.getOrCreateByTelegramId(String(ctx.from.id))

		const activeAccount = user.activeAccountId
			? await prisma.account.findUnique({
					where: { id: user.activeAccountId }
				})
			: null

		console.log(user, ' <- User')
		console.log(activeAccount, ' <- Active Account')

		ctx.state = {
			user,
			activeAccount
		}

		await next()
	}
