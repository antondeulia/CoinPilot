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
	| 'accounts_mass_edit'
	| 'transactions_mass_edit'
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
			newTagNamesInSession?: string[]
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
			accountsViewExpanded?: boolean
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
			accountDetailsSourceMessageId?: number
					pendingTransactionDraft?: LlmTransaction
					pendingTransactionMissing?: string[]
				accountDeltaPromptMessageId?: number
				pendingAccountDeltaOps?: Array<{
					accountId: string
					currency: string
					amount: number
					direction: 'in' | 'out'
				}>
				repeatTxConfirmMessageId?: number
				pendingAccountInputText?: string
				autoCreatedTxIdsForCurrentParse?: string[]
				aiAnalyticsBusy?: boolean
				aiAnalyticsLastFingerprint?: string
				aiAnalyticsProgressMessageId?: number
				onboardingStartMessageId?: number
				onboardingAccountsMessageId?: number
				awaitingMassAccountsInput?: boolean
				massAccountsDraft?: Array<{
					accountId: string
					accountName: string
					beforeAssets: Array<{ currency: string; amount: number }>
					afterAssets: Array<{ currency: string; amount: number }>
				}>
				massAccountsSummaryMessageId?: number
				massAccountsBusy?: boolean
				awaitingMassTransactionsInput?: boolean
				massTransactionsDraft?: Array<{
					transactionId: string
					action: 'update' | 'delete'
					before: {
						amount: number
						currency: string
						direction: 'income' | 'expense' | 'transfer'
						category: string | null
						description: string | null
						tagName: string | null
						transactionDate: string
					}
						after?: {
							direction?: 'income' | 'expense'
							category?: string | null
							categoryId?: string | null
							description?: string | null
							tagId?: string | null
							tagName?: string | null
							transactionDate?: string
					}
				}>
				massTransactionsSummaryMessageId?: number
				massTransactionsBusy?: boolean
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
			? await prisma.account.findFirst({
					where: { id: user.activeAccountId, userId: user.id }
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
