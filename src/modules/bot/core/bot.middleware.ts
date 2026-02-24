import { Context, MiddlewareFn } from 'grammy'
import { PrismaService } from '../../prisma/prisma.service'
import { UsersService } from '../../users/users.service'
import { SubscriptionService } from '../../subscription/subscription.service'
import { LlmTransaction } from '../../../modules/llm/schemas/transaction.schema'
import { LlmAccount } from '../../../modules/llm/schemas/account.schema'
import { Account, User } from '../../../generated/prisma/client'

export interface BotState {
	user: User & { accounts: Account[] }
	activeAccount: Account | null
	isPremium: boolean
}

export type InputMode =
	| 'idle'
	| 'transaction_parse'
	| 'transaction_edit'
	| 'account_parse'
	| 'account_jarvis_edit'
	| 'account_rename'
	| 'category_create'
	| 'tag_create'
	| 'tags_jarvis_edit'
	| 'main_currency_edit'
	| 'timezone_edit'
	| 'delete_confirm'

export type BotContext = Context & {
	state: BotState
		session: {
			inputMode?: InputMode
			awaitingAccount: boolean
			awaitingTransaction: boolean
			tempMessageId: number | undefined
			homeMessageId: number
			hintMessageId?: number
			resultMessageIds?: number[]
			previewMessageId?: number
			accountInputMessageIds?: number[]
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
			editingAccountField?: 'jarvis' | 'name'
		editingAccountDetailsId?: string
		transactionsViewPage?: number
		categoriesSelectedId?: string | null
		awaitingCategoryName?: boolean
		editingCategory?: 'create' | 'rename' | null
		categoriesMessageId?: number
		categoriesHintMessageId?: number
		editingTransactionId?: string
		awaitingDeleteConfirm?: boolean
			mainCurrencyHintMessageId?: number
			mainCurrencyErrorMessageIds?: number[]
			timezoneHintMessageId?: number
			timezoneErrorMessageIds?: number[]
			awaitingInlineCategoryCreate?: boolean
			awaitingInlineTagCreate?: boolean
				inlineCreateHintMessageId?: number
				accountDetailsEditMode?: 'jarvis' | 'name'
				pendingTransactionDraft?: LlmTransaction
				pendingTransactionMissing?: string[]
			}
	chat: {
		id: string
	}
}

export const userContextMiddleware =
	(
		userService: UsersService,
		prisma: PrismaService,
		subscriptionService: SubscriptionService
	): MiddlewareFn =>
	async (ctx: BotContext, next) => {
		if (!ctx.from) return next()

		const user = await userService.getOrCreateByTelegramId(String(ctx.from.id))

		const activeAccount = user.activeAccountId
			? await prisma.account.findUnique({
					where: { id: user.activeAccountId }
				})
			: null
		const isPremium = subscriptionService.isPremium(user)
		ctx.state = {
			user,
			activeAccount,
			isPremium
		}

		await next()
	}
