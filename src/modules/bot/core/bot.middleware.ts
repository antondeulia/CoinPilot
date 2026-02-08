import { Context, MiddlewareFn } from 'grammy'
import { PrismaService } from '../../prisma/prisma.service'
import { UsersService } from '../../users/users.service'
import { Account, User } from 'generated/prisma/client'
import { LlmTransaction } from 'src/modules/llm/schemas/transaction.schema'
import { LlmAccount } from 'src/modules/llm/schemas/account.schema'

export interface BotState {
	user: User & { accounts: Account[] }
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
		draftTransactions?: LlmTransaction[]
		currentTransactionIndex?: number
		editingField?:
			| 'type'
			| 'description'
			| 'amount'
			| 'account'
			| 'date'
			| 'category'
			| 'tag'
		editMessageId?: number
		accountsPage?: number
		categoriesPage?: number
		awaitingTagInput?: boolean
		tagsPage?: number
		tagsSettingsMessageId?: number
		tagsSettingsHintMessageId?: number
		awaitingTagsJarvisEdit?: boolean
		pendingTransferSide?: 'from' | 'to'
		navigationStack?: string[]
		awaitingAccountInput?: boolean
		confirmingAccounts?: boolean
		draftAccounts?: LlmAccount[]
		currentAccountIndex?: number
		accountsViewPage?: number
		accountsViewSelectedId?: string | null
		editingAccountField?: 'jarvis'
		editingAccountDetailsId?: string
		transactionsViewPage?: number
		categoriesSelectedId?: string | null
		awaitingCategoryName?: boolean
		editingCategory?: 'create' | 'rename' | null
		categoriesMessageId?: number
		categoriesHintMessageId?: number
		editingTransactionId?: string
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
		ctx.state = {
			user,
			activeAccount
		}

		await next()
	}
