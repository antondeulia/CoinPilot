import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Bot, InlineKeyboard, session } from 'grammy'
import { UsersService } from '../users/users.service'
import { TransactionsService } from '../transactions/transactions.service'
import { LLMService } from '../llm/llm.service'
import { LlmTransaction } from '../llm/schemas/transaction.schema'
import { BotContext, userContextMiddleware } from './core/bot.middleware'
import { activateInputMode, isInputMode, resetInputModes } from './core/input-mode'
import { PrismaService } from '../prisma/prisma.service'
import { AccountsService } from '../accounts/accounts.service'
import { CategoriesService } from '../categories/categories.service'
import { TagsService } from '../tags/tags.service'
import { ExchangeService } from '../exchange/exchange.service'
import { AnalyticsService } from '../analytics/analytics.service'
import { SubscriptionService } from '../subscription/subscription.service'
import { StripeService } from '../stripe/stripe.service'
import { FREE_LIMITS } from '../subscription/subscription.constants'
import { PremiumEventType } from '../../generated/prisma/enums'
import { accountInfoText } from '../../utils'
import { accountSwitchKeyboard } from '../../shared/keyboards'
import {
	viewAccountsListText,
	accountDetailsText,
	type AccountLastTxRow,
	type AccountAnalyticsData
} from './elements/accounts'
import { homeKeyboard, homeText } from '../../shared/keyboards/home'
import { startCommand } from './commands/start.command'
import { renderHome } from './utils/render-home'
import {
	confirmKeyboard,
	confirmTxCallback,
	getShowConversion
} from './callbacks/confirm-tx'
import { addTxCallback } from './callbacks/add-transaction.command'
import { cancelTxCallback } from './callbacks/cancel-tx'
import {
	editTxCallback,
	editTypeCallback,
	editDescriptionCallback,
	editAmountCallback,
	editAccountCallback,
	editTargetAccountCallback,
	editDateCallback,
	editCategoryCallback,
	editTagCallback,
	editCurrencyCallback,
	editConversionCallback,
	paginationTransactionsCallback,
	closeEditCallback,
	repeatParseCallback,
	saveDeleteCallback,
	accountsPaginationCallback,
	addAccountCallback,
	accountsPreviewCallbacks,
	accountsJarvisEditCallback,
	saveDeleteAccountsCallback,
	viewTransactionsCallback,
	viewCategoriesCallback,
	viewTagsCallback,
	analyticsMainCallback,
	analyticsCategoriesCallback,
	analyticsTagsCallback,
	analyticsTypeCallback,
	analyticsFilterCallback,
	analyticsSavedCallback,
	analyticsChartCallback,
	analyticsExportCallback,
	analyticsAlertsCallback,
	premiumCallback
} from './callbacks'
import { renderConfirmMessage } from './elements/tx-confirm-msg'
import { refreshAccountsPreview } from './callbacks/accounts-preview.callback'
import { hideMessageCallback } from './callbacks/hide-message.callback'
import { categoriesListKb } from './callbacks/view-categories.callback'
import { tagsListText } from './callbacks/view-tags.callback'
import { buildSettingsView } from '../../shared/keyboards/settings'
import { levenshtein } from '../../utils/normalize'
import { normalizeTxDate, pickTransactionDate } from '../../utils/date'
import { LlmMemoryService } from '../llm-memory/llm-memory.service'
import { buildAddTransactionPrompt } from './callbacks/add-transaction.command'
import { isCryptoCurrency } from '../../utils/format'

@Injectable()
export class BotService implements OnModuleInit {
	private readonly logger = new Logger(BotService.name)
	private readonly bot: Bot<BotContext>

	constructor(
		private readonly config: ConfigService,
		private readonly usersService: UsersService,
		private readonly transactionsService: TransactionsService,
		private readonly llmService: LLMService,
		private readonly prisma: PrismaService,
		private readonly accountsService: AccountsService,
		private readonly categoriesService: CategoriesService,
		private readonly tagsService: TagsService,
		private readonly exchangeService: ExchangeService,
		private readonly analyticsService: AnalyticsService,
		private readonly subscriptionService: SubscriptionService,
		private readonly stripeService: StripeService,
		private readonly llmMemoryService: LlmMemoryService
	) {
		const token = this.config.getOrThrow<string>('BOT_TOKEN')
		this.bot = new Bot<BotContext>(token)
	}

	/** Send a text message to a user by Telegram ID (for cron/notifications). */
	async sendToUser(telegramId: string, text: string): Promise<void> {
		await this.bot.api.sendMessage(Number(telegramId), text).catch(() => {})
	}

	async onModuleInit() {
		await this.bot.api.setMyCommands([
			{
				command: 'start',
				description: 'Открыть меню'
			},
			{
				command: 'help',
				description: 'Помощь и инструкция'
			}
		])

		this.bot.use(
			session({
				initial: () => ({})
			})
		)

		// Ответ на callback до тяжёлой загрузки (userContext), чтобы не истекал query
		this.bot.use((ctx, next) => {
			if (ctx.callbackQuery) {
				return ctx
					.answerCallbackQuery()
					.catch(() => {})
					.then(() => next())
			}
			return next()
		})

		this.bot.use(
			userContextMiddleware(
				this.usersService,
				this.prisma,
				this.subscriptionService
			)
		)

		this.bot.catch(err => {
			const msg = err.message ?? ''
			if (
				msg.includes('message is not modified') ||
				msg.includes('message to edit not found') ||
				msg.includes("message can't be edited")
			) {
				return
			}
			console.error('Bot error:', err.message)
		})

			// Commands
			startCommand(this.bot, this.accountsService, this.analyticsService)
			this.bot.command('help', async ctx => {
				await this.replyHelp(ctx)
			})

		// Callbacks
		addTxCallback(this.bot, this.subscriptionService)
		confirmTxCallback(
			this.bot,
			this.transactionsService,
			this.accountsService,
			this.tagsService,
			this.subscriptionService,
			this.analyticsService
		)
		cancelTxCallback(
			this.bot,
			this.transactionsService,
			this.accountsService,
			this.analyticsService
		)
		editTxCallback(this.bot, this.accountsService)
		editTypeCallback(this.bot, this.accountsService, this.transactionsService)
		editDescriptionCallback(this.bot)
		editAmountCallback(this.bot)
		editAccountCallback(this.bot, this.accountsService, this.transactionsService)
		editTargetAccountCallback(
			this.bot,
			this.accountsService,
			this.transactionsService
		)
		editDateCallback(this.bot)
		editCategoryCallback(
			this.bot,
			this.categoriesService,
			this.accountsService,
			this.transactionsService
		)
		editTagCallback(
			this.bot,
			this.tagsService,
			this.accountsService,
			this.transactionsService
		)
		editCurrencyCallback(
			this.bot,
			this.accountsService,
			this.exchangeService,
			this.transactionsService
		)
		editConversionCallback(
			this.bot,
			this.accountsService,
			this.exchangeService,
			this.transactionsService
		)
		paginationTransactionsCallback(this.bot, this.accountsService)
		closeEditCallback(this.bot, this.accountsService)
		repeatParseCallback(
			this.bot,
			this.subscriptionService,
			this.transactionsService
		)
		saveDeleteCallback(
			this.bot,
			this.transactionsService,
			this.accountsService,
			this.tagsService,
			this.subscriptionService,
			this.analyticsService
		)
		editAccountCallback(this.bot, this.accountsService, this.transactionsService)
		accountsPaginationCallback(this.bot, this.subscriptionService)
		addAccountCallback(this.bot, this.subscriptionService)
		accountsPreviewCallbacks(this.bot)
		accountsJarvisEditCallback(this.bot, this.llmService)
		saveDeleteAccountsCallback(
			this.bot,
			this.accountsService,
			this.usersService,
			this.subscriptionService,
			this.analyticsService,
			this.exchangeService
		)
		viewTransactionsCallback(
			this.bot,
			this.prisma,
			this.transactionsService,
			this.accountsService,
			this.analyticsService
		)
		viewCategoriesCallback(
			this.bot,
			this.categoriesService,
			this.subscriptionService,
			this.prisma
		)
		viewTagsCallback(
			this.bot,
			this.tagsService,
			this.subscriptionService,
			this.prisma
		)
		analyticsMainCallback(this.bot, this.analyticsService)
		analyticsCategoriesCallback(this.bot, this.analyticsService, this.prisma)
		analyticsTagsCallback(this.bot, this.analyticsService)
		analyticsTypeCallback(this.bot, this.analyticsService)
		analyticsFilterCallback(this.bot)
		analyticsSavedCallback(this.bot, this.prisma)
		analyticsChartCallback(this.bot, this.prisma, this.exchangeService, this.analyticsService)
		analyticsExportCallback(
			this.bot,
			this.prisma,
			this.subscriptionService,
			this.analyticsService
		)
		analyticsAlertsCallback(this.bot, this.prisma)
		premiumCallback(this.bot, this.subscriptionService, this.stripeService)

		hideMessageCallback(this.bot)

		this.bot.callbackQuery('go_home', async ctx => {
			const stack = ctx.session.navigationStack ?? []
			stack.pop()
			ctx.session.navigationStack = stack
			if (!ctx.session.awaitingTransaction) {
				await this.closeTemp(ctx)
			}
			;(ctx.session as any).editingCurrency = false
			;(ctx.session as any).editingMainCurrency = false
			ctx.session.editingField = undefined

			const user: any = ctx.state.user
			const mainCurrency = user?.mainCurrency ?? 'USD'
			const accounts = (user?.accounts ?? []).filter(
				(a: { isHidden?: boolean }) => !a.isHidden
			)
			const accountsCount = accounts.length
			let totalBalance = 0
			let monthlyChangePct = 0
			try {
				const [summary, cashflow] = await Promise.all([
					this.analyticsService.getSummary(
						user.id,
						'30d',
						mainCurrency
					),
					this.analyticsService.getCashflow(
						user.id,
						'30d',
						mainCurrency
					)
				])
				totalBalance = summary.balance
				const beginning = summary.balance - cashflow
				if (beginning > 0) {
					monthlyChangePct = (cashflow / beginning) * 100
				}
			} catch {}

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				homeText(totalBalance, mainCurrency, accountsCount, monthlyChangePct),
				{
					parse_mode: 'HTML',
					link_preview_options: { is_disabled: true },
					reply_markup: homeKeyboard()
				}
			)
		})

		this.bot.callbackQuery('accounts_back', async ctx => {
			const stack = ctx.session.navigationStack ?? []
			stack.pop()
			ctx.session.navigationStack = stack
			await this.closeTemp(ctx)
			;(ctx.session as any).editingCurrency = false
			;(ctx.session as any).editingMainCurrency = false
			ctx.session.editingField = undefined

			const user: any = ctx.state.user
			if (!user) return
			const mainCurrency = user?.mainCurrency ?? 'USD'
			const accounts = (user?.accounts ?? []).filter(
				(a: { isHidden?: boolean }) => !a.isHidden
			)
			const accountsCount = accounts.length
			let totalBalance = 0
			let monthlyChangePct = 0
			try {
				const [summary, cashflow] = await Promise.all([
					this.analyticsService.getSummary(
						user.id,
						'30d',
						mainCurrency
					),
					this.analyticsService.getCashflow(
						user.id,
						'30d',
						mainCurrency
					)
				])
				totalBalance = summary.balance
				const beginning = summary.balance - cashflow
				if (beginning > 0) {
					monthlyChangePct = (cashflow / beginning) * 100
				}
			} catch {}

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				homeText(totalBalance, mainCurrency, accountsCount, monthlyChangePct),
				{
					parse_mode: 'HTML',
					reply_markup: homeKeyboard()
				}
			)
		})

		this.bot.callbackQuery('view_accounts', async ctx => {
			if (!ctx.session.awaitingTransaction && !ctx.session.confirmingTransaction) {
				await this.closeTemp(ctx)
			}

			const user: any = ctx.state.user
			if (!user) return

			ctx.session.navigationStack = [...(ctx.session.navigationStack ?? []), 'home']
			ctx.session.accountsViewPage = 0
			ctx.session.accountsViewSelectedId = null

			const [accountsWithAssets, frozen] = await Promise.all([
				this.accountsService.getAllWithAssets(user.id),
				this.subscriptionService.getFrozenItems(user.id)
			])
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			const text = await viewAccountsListText(
				accountsWithAssets,
				user.mainCurrency ?? 'USD',
				this.exchangeService,
				this.analyticsService,
				user.id,
				user.lastTipText
			)

			const visibleAccounts = (user.accounts ?? []).filter(
				(a: { isHidden?: boolean }) => !a.isHidden
			)
			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				text,
				{
					parse_mode: 'HTML',
					// @ts-ignore
					reply_markup: accountSwitchKeyboard(
						visibleAccounts,
						user.activeAccountId,
						0,
						null,
						user.defaultAccountId,
						frozenAccountIds
					)
				}
			)
		})

		this.bot.callbackQuery(/^current_account:/, async ctx => {
			const accountId = ctx.callbackQuery.data.split(':')[1]

			const user = ctx.state.user
			const visibleAccounts = (user.accounts ?? []).filter(
				(a: { isHidden?: boolean }) => !a.isHidden
			)
			// @ts-ignore
			const account = user.accounts.find(a => a.id === accountId)

			if (!account) return

			const frozen = await this.subscriptionService.getFrozenItems(user.id)
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			await ctx.editMessageText(accountInfoText(account), {
				parse_mode: 'HTML',
				// @ts-ignore
				reply_markup: accountSwitchKeyboard(
					visibleAccounts,
					user.activeAccountId,
					0,
					undefined,
					user.defaultAccountId || '',
					frozenAccountIds
				)
			})
		})

		this.bot.command('use', async ctx => {
			const id = ctx.message?.text.split(' ')[1]
			if (!id) {
				await ctx.reply('Укажи id счёта')
				return
			}

			const account = await this.prisma.account.findFirst({
				where: {
					id,
					userId: ctx.state.user.id
				}
			})

			if (!account) {
				await ctx.reply('Счёт не найден')
				return
			}

			await this.prisma.user.update({
				where: { id: ctx.state.user.id },
				data: { activeAccountId: id }
			})

			await ctx.reply(`Активный счёт: ${account.name} · ${account.currency}`)
		})

		this.bot.callbackQuery(/^use_account:/, async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			const accountId = ctx.callbackQuery.data.split(':')[1]
			if (ctx.session.accountsViewSelectedId === accountId) {
				ctx.session.accountsViewSelectedId = null
				const page = ctx.session.accountsViewPage ?? 0
				const [accountsWithAssets, frozen] = await Promise.all([
					this.accountsService.getAllWithAssets(user.id),
					this.subscriptionService.getFrozenItems(user.id)
				])
				const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
				const visibleAccounts = (user.accounts ?? []).filter(
					(a: { isHidden?: boolean }) => !a.isHidden
				)
				const text = await viewAccountsListText(
					accountsWithAssets,
					user.mainCurrency ?? 'USD',
					this.exchangeService,
					this.analyticsService,
					user.id,
					user.lastTipText
				)
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.callbackQuery.message!.message_id,
					text,
					{
						parse_mode: 'HTML',
						reply_markup: accountSwitchKeyboard(
							visibleAccounts,
							user.activeAccountId,
							page,
							null,
							user.defaultAccountId,
							frozenAccountIds
						)
					}
				)
				return
			}
			const frozen = await this.subscriptionService.getFrozenItems(user.id)
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			const account = await this.accountsService.getOneWithAssets(
				accountId,
				user.id
			)
			if (!account) return

			ctx.session.accountsViewSelectedId = accountId
			const page = ctx.session.accountsViewPage ?? 0
			const mainCurrency = user.mainCurrency ?? 'USD'
			const isPremium = !!ctx.state.isPremium

			const lastTxs = await this.prisma.transaction.findMany({
				where: { accountId, userId: user.id },
				orderBy: { transactionDate: 'desc' },
				take: 3,
				include: { tag: true, toAccount: true }
			})
			const lastTransactions: AccountLastTxRow[] = []
			for (const tx of lastTxs) {
				const amt =
					tx.convertedAmount != null && tx.convertToCurrency
						? tx.convertedAmount
						: tx.amount
				const cur =
					tx.convertedAmount != null && tx.convertToCurrency
						? tx.convertToCurrency
						: tx.currency
				const amountMain = (await this.exchangeService.convert(amt, cur, mainCurrency)) ?? 0
				const signed = tx.direction === 'expense' ? -Math.abs(tx.amount) : Math.abs(tx.amount)
				lastTransactions.push({
					direction: tx.direction,
					amount: signed,
					currency: tx.currency,
					amountMain: Math.abs(amountMain),
					description: tx.description,
					transactionDate: tx.transactionDate,
					category: tx.category,
					tagName: tx.tag?.name ?? null,
					toAccountName: tx.toAccount?.name ?? null
				})
			}

			let analyticsData: AccountAnalyticsData | undefined
			if (isPremium) {
				const beg = await this.analyticsService.getBeginningBalance(
					user.id,
					'month',
					mainCurrency,
					accountId
				)
				const [
					summary,
					topExpenses,
					topIncome,
					anomalies,
					transfersTotal,
					externalTransferOut,
					cashflow,
					burnRate
				] =
					await Promise.all([
						this.analyticsService.getSummary(user.id, 'month', mainCurrency, accountId),
						this.analyticsService.getTopCategories(user.id, 'month', mainCurrency, 3, accountId, beg),
						this.analyticsService.getTopIncomeCategories(user.id, 'month', mainCurrency, beg, 3, accountId),
						this.analyticsService.getAnomalies(user.id, 'month', mainCurrency, 100, accountId, beg),
						this.analyticsService.getTransfersTotal(user.id, 'month', mainCurrency, accountId),
						this.analyticsService.getExternalTransferOutTotal(
							user.id,
							'month',
							mainCurrency,
							accountId
						),
						this.analyticsService.getCashflow(user.id, 'month', mainCurrency, accountId),
						this.analyticsService.getBurnRate(user.id, 'month', mainCurrency, accountId)
					])
				const thresholdAnomaly = beg > 0 ? beg * 0.5 : 100
				const topTransfersWithPct = await this.analyticsService.getTopTransfers(
					user.id,
					'month',
					mainCurrency,
					3,
					accountId,
					beg
				)
				analyticsData = {
					beginningBalance: beg,
					expenses: summary.expenses + externalTransferOut,
					income: summary.income,
					transfersTotal,
					balance: summary.balance,
					cashflow,
					burnRate,
					topExpenses: topExpenses.map(c => ({ categoryName: c.categoryName, sum: c.sum, pct: c.pct })),
					topIncome: topIncome.map(c => ({ categoryName: c.categoryName, sum: c.sum, pct: c.pct })),
					topTransfers: topTransfersWithPct.map(t => ({
						fromAccountName: t.fromAccountName,
						toAccountName: t.toAccountName,
						sum: t.sum,
						pct: t.pct,
						descriptions: t.descriptions
					})),
					anomalies: anomalies.map(x => ({
						description: x.description ?? x.tagOrCategory ?? null,
						amountMain: x.amount
					})),
					thresholdAnomaly
				}
			}

			const text = await accountDetailsText(
				account,
				mainCurrency,
				this.exchangeService,
				account.id === user.defaultAccountId,
				isPremium,
				lastTransactions,
				analyticsData,
				user.timezone ?? 'UTC+02:00'
			)
			const selectedFrozen = frozenAccountIds.has(accountId)
			const visibleAccounts = (user.accounts ?? []).filter(
				(a: { isHidden?: boolean }) => !a.isHidden
			)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				text,
				{
					parse_mode: 'HTML',
					reply_markup: accountSwitchKeyboard(
						visibleAccounts,
						user.activeAccountId,
						page,
						accountId,
						user.defaultAccountId,
						frozenAccountIds,
						selectedFrozen
					)
				}
			)
		})

		this.bot.callbackQuery('accounts_unselect', async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			ctx.session.accountsViewSelectedId = null
			const page = ctx.session.accountsViewPage ?? 0
			const [accountsWithAssets, frozen] = await Promise.all([
				this.accountsService.getAllWithAssets(user.id),
				this.subscriptionService.getFrozenItems(user.id)
			])
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			const visibleAccounts = (user.accounts ?? []).filter(
				(a: { isHidden?: boolean }) => !a.isHidden
			)
			const text = await viewAccountsListText(
				accountsWithAssets,
				user.mainCurrency ?? 'USD',
				this.exchangeService,
				this.analyticsService,
				user.id,
				user.lastTipText
			)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				text,
				{
					parse_mode: 'HTML',
					reply_markup: accountSwitchKeyboard(
						visibleAccounts,
						user.activeAccountId,
						page,
						null,
						user.defaultAccountId,
						frozenAccountIds
					)
				}
			)
		})

		this.bot.callbackQuery('accounts_jarvis_edit_details', async ctx => {
			const selectedId = ctx.session.accountsViewSelectedId
			if (!selectedId) return
			const user: any = ctx.state.user
			const frozen = await this.subscriptionService.getFrozenItems(user.id)
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			if (frozenAccountIds.has(selectedId)) {
				await ctx.answerCallbackQuery({
					text: 'Редактирование замороженного счёта доступно в Premium.'
				})
				return
			}
			activateInputMode(ctx, 'account_jarvis_edit', {
				editingAccountDetailsId: selectedId,
				accountDetailsEditMode: 'jarvis'
			})
			const msg = await ctx.reply(
				'Режим Jarvis-редактирования счёта.\n\nОпишите изменения только по активам и суммам (без переименования).',
				{
					parse_mode: 'HTML',
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'close_jarvis_details_edit'
					)
				}
			)
			ctx.session.editMessageId = msg.message_id
		})

		this.bot.callbackQuery('accounts_rename_details', async ctx => {
			const selectedId = ctx.session.accountsViewSelectedId
			if (!selectedId) return
			activateInputMode(ctx, 'account_rename', {
				editingAccountDetailsId: selectedId,
				accountDetailsEditMode: 'name'
			})
			const msg = await ctx.reply(
				'Отправьте новое название счёта (текст или голос).',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'close_jarvis_details_edit'
					)
				}
			)
			ctx.session.editMessageId = msg.message_id
		})

		this.bot.callbackQuery(/^account_delete:/, async ctx => {
			const accountId = ctx.callbackQuery.data.replace('account_delete:', '')
			const user: any = ctx.state.user
			const account = await this.accountsService.getOneWithAssets(accountId, user.id)
			if (!account) return
			;(ctx.session as any).accountsDeleteSourceMessageId =
				ctx.callbackQuery.message!.message_id
			const msg = await ctx.reply(
				`Удалить счёт «${account.name}»?\n\nТранзакции по счёту будут удалены.`,
				{
					reply_markup: new InlineKeyboard()
						.text('Подтвердить', `account_delete_confirm:${accountId}`)
						.text('Отменить', `account_delete_cancel`)
				}
			)
			;(ctx.session as any).accountsDeleteConfirmMessageId = msg.message_id
		})

		this.bot.callbackQuery('account_delete_cancel', async ctx => {
			const confirmMsgId = (ctx.session as any).accountsDeleteConfirmMessageId
			if (confirmMsgId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, confirmMsgId)
				} catch {}
			}
			;(ctx.session as any).accountsDeleteConfirmMessageId = undefined
			;(ctx.session as any).accountsDeleteSourceMessageId = undefined
		})

		this.bot.callbackQuery(/^account_delete_confirm:/, async ctx => {
			const accountId = ctx.callbackQuery.data.replace('account_delete_confirm:', '')
			const user: any = ctx.state.user
			const account = await this.accountsService.getOneWithAssets(accountId, user.id)
			const deleted = await this.accountsService.deleteAccount(accountId, user.id)
			if (!deleted) return
			ctx.session.accountsViewSelectedId = null
			const confirmMsgId = (ctx.session as any).accountsDeleteConfirmMessageId
			if (confirmMsgId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, confirmMsgId)
				} catch {}
			}
			;(ctx.session as any).accountsDeleteConfirmMessageId = undefined
			const freshUser = await this.prisma.user.findUnique({
				where: { telegramId: String(ctx.from!.id) }
			})
			if (!freshUser) return
			const [accountsWithAssets, frozen] = await Promise.all([
				this.accountsService.getAllWithAssets(freshUser.id),
				this.subscriptionService.getFrozenItems(freshUser.id)
			])
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			const visibleAccounts = await this.prisma.account.findMany({
				where: { userId: freshUser.id, isHidden: false },
				orderBy: { createdAt: 'asc' }
			})
			const text = await viewAccountsListText(
				accountsWithAssets,
				freshUser.mainCurrency ?? 'USD',
				this.exchangeService,
				this.analyticsService,
				freshUser.id,
				(freshUser as any).lastTipText
			)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				((ctx.session as any).accountsDeleteSourceMessageId as number) ??
					ctx.callbackQuery.message!.message_id,
				text,
				{
					parse_mode: 'HTML',
					reply_markup: accountSwitchKeyboard(
						visibleAccounts,
						freshUser.activeAccountId,
						0,
						null,
						freshUser.defaultAccountId ?? undefined,
						frozenAccountIds
					)
				}
			)
			;(ctx.session as any).accountsDeleteSourceMessageId = undefined
			await ctx.reply(`✅ Счёт удалён: ${account?.name ?? ''}`, {
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			})
		})

		this.bot.callbackQuery('add_account', async ctx => {
			// заглушка, реальная логика вынесена в addAccountCallback
		})

		this.bot.callbackQuery('account_delta_create_tx_close', async ctx => {
			const msgId = ctx.session.accountDeltaPromptMessageId
			if (msgId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, msgId)
				} catch {}
			}
			ctx.session.accountDeltaPromptMessageId = undefined
			ctx.session.pendingAccountDeltaOps = undefined
		})

		this.bot.callbackQuery('account_delta_create_tx_yes', async ctx => {
			const ops = ctx.session.pendingAccountDeltaOps ?? []
			const user = ctx.state.user as any
			if (!ops.length) {
				ctx.session.accountDeltaPromptMessageId = undefined
				ctx.session.pendingAccountDeltaOps = undefined
				return
			}
			const allAccounts = await this.accountsService.getAllByUserIdIncludingHidden(user.id)
			const outside = allAccounts.find(a => a.name === 'Вне Wallet')
			if (!outside) {
				await ctx.reply('Системный счёт "Вне Wallet" не найден.', {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				return
			}
			const createdDrafts: any[] = []
			for (const op of ops) {
				const account = allAccounts.find(a => a.id === op.accountId)
				if (!account) continue
				const fromAccountId = op.direction === 'in' ? outside.id : account.id
				const toAccountId = op.direction === 'in' ? account.id : outside.id
				const created = await this.transactionsService.create({
					userId: user.id,
					accountId: fromAccountId,
					amount: op.amount,
					currency: op.currency,
					direction: 'transfer',
					fromAccountId,
					toAccountId,
					description: 'Корректировка баланса',
					rawText: `ACCOUNT_DELTA:${op.accountId}:${op.currency}`
				})
				createdDrafts.push({
					id: created.id,
					action: 'create_transaction',
					accountId: fromAccountId,
					account: op.direction === 'in' ? 'Вне Wallet' : account.name,
					amount: created.amount,
					currency: created.currency,
					direction: created.direction,
					category: created.category ?? '📦Другое',
					description: created.description ?? null,
					transactionDate: created.transactionDate.toISOString(),
					tagId: undefined,
					tagName: undefined,
					tagIsNew: false,
					convertToCurrency: created.convertToCurrency ?? undefined,
					convertedAmount: created.convertedAmount ?? undefined,
					toAccountId,
					toAccount: op.direction === 'in' ? account.name : 'Вне Wallet'
				})
			}
			if (!createdDrafts.length) {
				ctx.session.accountDeltaPromptMessageId = undefined
				ctx.session.pendingAccountDeltaOps = undefined
				return
			}
			const promptId = ctx.session.accountDeltaPromptMessageId
			if (promptId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, promptId)
				} catch {}
			}
			ctx.session.accountDeltaPromptMessageId = undefined
			ctx.session.pendingAccountDeltaOps = undefined
			ctx.session.awaitingTransaction = false
			ctx.session.confirmingTransaction = true
			ctx.session.draftTransactions = createdDrafts as any
			ctx.session.currentTransactionIndex = 0

			const first = createdDrafts[0]
			const showConversion = await getShowConversion(
				first,
				first.accountId ?? null,
				user.id,
				this.accountsService
			)
			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
			}
			const msg = await ctx.reply(
				renderConfirmMessage(first, 0, createdDrafts.length, user.defaultAccountId),
				{
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard(
						createdDrafts.length,
						0,
						showConversion,
						true,
						false
					)
				}
			)
			ctx.session.tempMessageId = msg.message_id
		})

		this.bot.callbackQuery('view_settings', async ctx => {
			if (!ctx.session.awaitingTransaction && !ctx.session.confirmingTransaction) {
				await this.closeTemp(ctx)
			}

			ctx.session.navigationStack = [...(ctx.session.navigationStack ?? []), 'home']

			const user: any = ctx.state.user
			const alertsEnabledCount = await this.prisma.alertConfig.count({
				where: { userId: user.id, enabled: true }
			})
			const view = buildSettingsView(user, alertsEnabledCount)

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				view.text,
				{ parse_mode: 'HTML', reply_markup: view.keyboard }
			)
		})

		this.bot.callbackQuery('main_currency_open', async ctx => {
			const hint = await ctx.reply(
				'Введите одну валюту, например: USD, доллар, $, евро, UAH.',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'back_to_settings')
				}
			)
			activateInputMode(ctx, 'main_currency_edit', {
				mainCurrencyHintMessageId: hint.message_id,
				mainCurrencyErrorMessageIds: []
			})
			;(ctx.session as any).editingMainCurrency = true
		})

		this.bot.callbackQuery('timezone_open', async ctx => {
			const hint = await ctx.reply(
				'Выберите или введите часовой пояс в формате UTC±HH:MM, например UTC+02:00.',
				{
					reply_markup: new InlineKeyboard()
						.text('UTC+02:00', 'timezone_set:UTC+02:00')
						.text('UTC+03:00', 'timezone_set:UTC+03:00')
						.row()
						.text('UTC+00:00', 'timezone_set:UTC+00:00')
						.text('UTC-05:00', 'timezone_set:UTC-05:00')
						.row()
						.text('Закрыть', 'back_to_settings')
				}
			)
			activateInputMode(ctx, 'timezone_edit', {
				timezoneHintMessageId: hint.message_id,
				timezoneErrorMessageIds: []
			})
		})

		this.bot.callbackQuery(/^timezone_set:/, async ctx => {
			const timezone = ctx.callbackQuery.data.replace('timezone_set:', '').trim()
			const normalized = this.normalizeTimezone(timezone)
			if (!normalized) return
			await this.usersService.setTimezone(ctx.state.user.id, normalized)
			const user: any = { ...ctx.state.user, timezone: normalized }
			const alertsEnabledCount = await this.prisma.alertConfig.count({
				where: { userId: user.id, enabled: true }
			})
			const view = buildSettingsView(user, alertsEnabledCount)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.homeMessageId,
				view.text,
				{ parse_mode: 'HTML', reply_markup: view.keyboard }
			)
			resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
		})
		this.bot.callbackQuery('back_to_settings', async ctx => {
			resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
			;(ctx.session as any).editingMainCurrency = false
			const hintMessageId = (ctx.session as any).mainCurrencyHintMessageId as
				| number
				| undefined
			if (hintMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, hintMessageId)
				} catch {}
				;(ctx.session as any).mainCurrencyHintMessageId = undefined
			}
			const errorMessageIds =
				((ctx.session as any).mainCurrencyErrorMessageIds as number[] | undefined) ??
				[]
			for (const id of errorMessageIds) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, id)
				} catch {}
			}
			;(ctx.session as any).mainCurrencyErrorMessageIds = []
			const timezoneHintMessageId = (ctx.session as any).timezoneHintMessageId as
				| number
				| undefined
			if (timezoneHintMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, timezoneHintMessageId)
				} catch {}
				;(ctx.session as any).timezoneHintMessageId = undefined
			}
			const timezoneErrorMessageIds =
				((ctx.session as any).timezoneErrorMessageIds as number[] | undefined) ??
				[]
			for (const id of timezoneErrorMessageIds) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, id)
				} catch {}
			}
			;(ctx.session as any).timezoneErrorMessageIds = []
			const user: any = ctx.state.user
			const alertsEnabledCount = await this.prisma.alertConfig.count({
				where: { userId: user.id, enabled: true }
			})
			const view = buildSettingsView(user, alertsEnabledCount)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.homeMessageId,
				view.text,
				{ parse_mode: 'HTML', reply_markup: view.keyboard }
			)
		})
		this.bot.callbackQuery(/^main_currency_set:/, async ctx => {
			const code = ctx.callbackQuery.data.replace('main_currency_set:', '')
			await this.usersService.setMainCurrency(ctx.state.user.id, code)
			const user: any = { ...ctx.state.user, mainCurrency: code }
			const alertsEnabledCount = await this.prisma.alertConfig.count({
				where: { userId: user.id, enabled: true }
			})
			const view = buildSettingsView(user, alertsEnabledCount)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				view.text,
				{ parse_mode: 'HTML', reply_markup: view.keyboard }
			)
			resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
		})

		this.bot.callbackQuery('confirm_delete_all_data', async ctx => {
			const kb = new InlineKeyboard()
				.text('Да', 'delete_data_step2')
				.text('Нет', 'back_to_settings')
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				'Вы уверены, что хотите удалить все данные? Это действие необратимо.',
				{ reply_markup: kb }
			)
		})

		this.bot.callbackQuery('delete_data_step2', async ctx => {
			activateInputMode(ctx, 'delete_confirm', {
				awaitingDeleteConfirm: true
			})
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				"Для подтверждения отправьте в чат: 'delete-confirm'",
				{
					reply_markup: new InlineKeyboard().text(
						'← Назад',
						'back_to_settings'
					)
				}
			)
		})

		this.bot.callbackQuery('default_account_open', async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			;(ctx.session as any).defaultAccountPage = 0
			const kb = new InlineKeyboard()
			const accounts = (user.accounts as {
				id: string
				name: string
				isHidden?: boolean
			}[]).filter(a => !a.isHidden)
			const pageSize = 9
			const page = 0
			const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))
			const slice = accounts.slice(0, pageSize)
			for (let i = 0; i < slice.length; i += 3) {
				const chunk = slice.slice(i, i + 3)
				for (const acc of chunk) {
					const isCurrent = acc.id === user.defaultAccountId
					kb.text(
						`${isCurrent ? '✅ ' : ''}${acc.name}`,
						`set_default_account:${acc.id}`
					)
				}
				kb.row()
			}
			kb.text('« Назад', 'default_account_page_prev')
				.text(`1/${totalPages}`, 'default_account_page_current')
				.text('Вперёд »', 'default_account_page_next')
				.row()
				.text('← Назад', 'back_to_settings')
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				'Выберите основной счёт:',
				{ reply_markup: kb }
			)
		})

		this.bot.callbackQuery(/^default_account_page_/, async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			const accounts = (user.accounts as {
				id: string
				name: string
				isHidden?: boolean
			}[]).filter(a => !a.isHidden)
			const pageSize = 9
			const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))
			let page = (ctx.session as any).defaultAccountPage ?? 0
			const action = ctx.callbackQuery.data.split('_page_')[1]
			if (action === 'prev') {
				page = page <= 0 ? totalPages - 1 : page - 1
			}
			if (action === 'next') {
				page = page >= totalPages - 1 ? 0 : page + 1
			}
			;(ctx.session as any).defaultAccountPage = page
			const start = page * pageSize
			const slice = accounts.slice(start, start + pageSize)
			const kb = new InlineKeyboard()
			for (let i = 0; i < slice.length; i += 3) {
				const chunk = slice.slice(i, i + 3)
				for (const acc of chunk) {
					const isCurrent = acc.id === user.defaultAccountId
					kb.text(
						`${isCurrent ? '✅ ' : ''}${acc.name}`,
						`set_default_account:${acc.id}`
					)
				}
				kb.row()
			}
			kb.text('« Назад', 'default_account_page_prev')
				.text(`${page + 1}/${totalPages}`, 'default_account_page_current')
				.text('Вперёд »', 'default_account_page_next')
				.row()
				.text('← Назад', 'back_to_settings')
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				'Выберите основной счёт:',
				{ reply_markup: kb }
			)
		})

		this.bot.callbackQuery(/^set_default_account:/, async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			const accountId = ctx.callbackQuery.data.split(':')[1]
			await this.usersService.setDefaultAccount(user.id, accountId)
			user.defaultAccountId = accountId
			const alertsEnabledCount = await this.prisma.alertConfig.count({
				where: { userId: user.id, enabled: true }
			})
			const view = buildSettingsView(user, alertsEnabledCount)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				view.text,
				{ parse_mode: 'HTML', reply_markup: view.keyboard }
			)
		})

			this.bot.on('message:text', async ctx => {
				const text = ctx.message.text.trim()

				if (text === '/help' || text === 'Помощь' || text === '❓ Помощь') {
					await this.replyHelp(ctx)
					return
				}

				if ((ctx.session as any).awaitingDeleteConfirm) {
				if (text === 'delete-confirm') {
					const userId = ctx.state.user.id
					resetInputModes(ctx)
					await this.usersService.deleteAllUserData(userId)
					await ctx.reply('Все данные пользователя удалены.')
					const user = await this.usersService.getOrCreateByTelegramId(
						String(ctx.from!.id)
					)
					;(ctx.state as any).user = user
					;(ctx.state as any).activeAccount =
						user.accounts.find(a => a.id === user.activeAccountId) ?? null
					await renderHome(ctx, this.accountsService, this.analyticsService)
				}
				return
			}

			if (ctx.session.awaitingInlineCategoryCreate && ctx.session.draftTransactions) {
				const name = text.trim().slice(0, 20)
				if (!name) {
					await ctx.reply('Введите корректное название категории.', {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
					return
				}
				const limit = await this.subscriptionService.canCreateCategory(
					ctx.state.user.id
				)
				if (!limit.allowed) {
					await this.subscriptionService.trackEvent(
						ctx.state.user.id,
						PremiumEventType.limit_hit,
						'categories'
					)
					await ctx.reply(
						'💠 В бесплатной версии недоступно создание своих категорий. Для добавления своих категорий, вы можете перейти на Premium.',
						{
							reply_markup: new InlineKeyboard()
								.text('💠 Pro-тариф', 'view_premium')
								.row()
								.text('Закрыть', 'hide_message')
						}
					)
					return
				}
				const created = await this.categoriesService.create(ctx.state.user.id, name)
				const drafts = ctx.session.draftTransactions
				const index = ctx.session.currentTransactionIndex ?? 0
				const current = drafts[index] as any
				current.category = created.name
				current.categoryId = created.id

				const hintId = ctx.session.inlineCreateHintMessageId
				if (hintId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, hintId)
					} catch {}
				}
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				resetInputModes(ctx, {
					draftTransactions: drafts,
					currentTransactionIndex: index,
					confirmingTransaction: true,
					tempMessageId: ctx.session.tempMessageId,
					homeMessageId: ctx.session.homeMessageId
				})
				const user = ctx.state.user as any
				const accountId =
					current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
				const showConversion = await getShowConversion(
					current,
					accountId ?? null,
					ctx.state.user.id,
					this.accountsService
				)
				if (ctx.session.tempMessageId != null) {
					await ctx.api.editMessageText(
						ctx.chat!.id,
						ctx.session.tempMessageId,
						renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
						{
							parse_mode: 'HTML',
							reply_markup: confirmKeyboard(
								drafts.length,
								index,
								showConversion,
								current?.direction === 'transfer',
								!!ctx.session.editingTransactionId
							)
						}
					)
				}
				return
			}

			if (ctx.session.awaitingInlineTagCreate && ctx.session.draftTransactions) {
				const raw = text.trim()
				if (!raw || raw.length > 15) {
					await ctx.reply('Введите название тега длиной до 15 символов.', {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
					return
				}
				const limit = await this.subscriptionService.canCreateTag(ctx.state.user.id)
				if (!limit.allowed) {
					await this.subscriptionService.trackEvent(
						ctx.state.user.id,
						PremiumEventType.limit_hit,
						'tags'
					)
					await ctx.reply(
						'💠 3 кастомных тега — лимит Free. Разблокируйте безлимит с Premium!',
						{
							reply_markup: new InlineKeyboard()
								.text('💠 Pro-тариф', 'view_premium')
								.row()
								.text('Закрыть', 'hide_message')
						}
					)
					return
				}
				const created = await this.tagsService.create(ctx.state.user.id, raw)
				const drafts = ctx.session.draftTransactions
				const index = ctx.session.currentTransactionIndex ?? 0
				const current = drafts[index] as any
				current.tagId = created.id
				current.tagName = created.name
				current.tagIsNew = false

				const hintId = ctx.session.inlineCreateHintMessageId
				if (hintId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, hintId)
					} catch {}
				}
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				resetInputModes(ctx, {
					draftTransactions: drafts,
					currentTransactionIndex: index,
					confirmingTransaction: true,
					tempMessageId: ctx.session.tempMessageId,
					homeMessageId: ctx.session.homeMessageId
				})
				const user = ctx.state.user as any
				const accountId =
					current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
				const showConversion = await getShowConversion(
					current,
					accountId ?? null,
					ctx.state.user.id,
					this.accountsService
				)
				if (ctx.session.tempMessageId != null) {
					await ctx.api.editMessageText(
						ctx.chat!.id,
						ctx.session.tempMessageId,
						renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
						{
							parse_mode: 'HTML',
							reply_markup: confirmKeyboard(
								drafts.length,
								index,
								showConversion,
								current?.direction === 'transfer',
								!!ctx.session.editingTransactionId
							)
						}
					)
				}
				return
			}

			if (ctx.session.awaitingTagInput && ctx.session.draftTransactions) {
				const drafts = ctx.session.draftTransactions
				if (!drafts.length) return
				const index = ctx.session.currentTransactionIndex ?? 0
				const current = drafts[index] as any
				const prevTag = {
					tagId: current.tagId,
					tagName: current.tagName,
					tagIsNew: current.tagIsNew
				}
				const raw = text.trim()
				if (raw.length > 20) {
					await ctx.reply(
						'Название тега не должно превышать 20 символов. Введите короче.',
						{
							reply_markup: new InlineKeyboard().text(
								'Закрыть',
								'back_to_preview'
							)
						}
					)
					return
				}
				const normalized = this.tagsService.normalizeTag(raw)
				if (!normalized) {
					await ctx.reply('Введите корректное название тега.', {
						reply_markup: new InlineKeyboard().text(
							'Закрыть',
							'back_to_preview'
						)
					})
					return
				}
				const allTags = await this.tagsService.getAllByUserId(ctx.state.user.id)
				const exact = allTags.find(t => t.name === normalized)
				const typo = !exact
					? allTags.find(t => levenshtein(normalized, t.name) <= 1)
					: null
				const similar = await this.tagsService.findSimilar(ctx.state.user.id, normalized)
				const best = similar[0]
				if (exact) {
					current.tagId = exact.id
					current.tagName = exact.name
					current.tagIsNew = false
				} else if (typo) {
					current.tagId = typo.id
					current.tagName = typo.name
					current.tagIsNew = false
				} else if (best && best.similarity >= 0.7) {
					current.tagId = best.tag.id
					current.tagName = best.tag.name
					current.tagIsNew = false
				} else {
					const tagLimit = await this.subscriptionService.canCreateTag(
						ctx.state.user.id
					)
					if (!tagLimit.allowed) {
						current.tagId = prevTag.tagId
						current.tagName = prevTag.tagName
						current.tagIsNew = prevTag.tagIsNew
						if (ctx.state.isPremium) {
							await ctx.reply(
								'Достигнут системный лимит тегов. Удалите лишние теги и попробуйте снова.',
								{
									reply_markup: new InlineKeyboard().text(
										'Закрыть',
										'hide_message'
									)
								}
							)
						} else {
							await ctx.reply(
								'💠 3 кастомных тега — лимит Free. Разблокируйте безлимит с Premium!',
								{
									reply_markup: new InlineKeyboard()
										.text('💠 Pro-тариф', 'view_premium')
										.row()
										.text('Закрыть', 'hide_message')
								}
							)
						}
						return
					}
					try {
						const createdTag = await this.tagsService.create(
							ctx.state.user.id,
							normalized
						)
						current.tagId = createdTag.id
						current.tagName = createdTag.name
						current.tagIsNew = false
						await this.tagsService.incrementUsage(createdTag.id)
					} catch (e: any) {
						await ctx.reply(e?.message ?? 'Не удалось создать тег.', {
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						})
						return
					}
				}
				const txId = current.id ?? ctx.session.editingTransactionId
				if (txId) {
					await this.transactionsService.update(txId, ctx.state.user.id, {
						tagId: current.tagId ?? null
					})
				}
				ctx.session.awaitingTagInput = false
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				const user = ctx.state.user as any
				const accountId =
					current.accountId ||
					user.defaultAccountId ||
					ctx.state.activeAccount?.id
				const showConversion = await getShowConversion(
					current,
					accountId ?? null,
					ctx.state.user.id,
					this.accountsService
				)
				if (ctx.session.tempMessageId != null) {
					try {
						await ctx.api.editMessageText(
							ctx.chat!.id,
							ctx.session.tempMessageId,
							renderConfirmMessage(
								current,
								index,
								drafts.length,
								user.defaultAccountId
							),
							{
								parse_mode: 'HTML',
								reply_markup: confirmKeyboard(
									drafts.length,
									index,
									showConversion,
									current?.direction === 'transfer',
									!!(ctx.session as any).editingTransactionId
								)
							}
						)
					} catch {}
				}
				return
			}

			if ((ctx.session as any).editingCurrency && ctx.session.draftTransactions) {
				const drafts = ctx.session.draftTransactions
				if (!drafts.length) return

				const index = ctx.session.currentTransactionIndex ?? 0
				const current = drafts[index] as any
				const value = text
				const upper = value.trim().toUpperCase()
				const map: Record<string, string> = {
					USD: 'USD',
					ДОЛЛАР: 'USD',
					$: 'USD',
					EUR: 'EUR',
					ЕВРО: 'EUR',
					'€': 'EUR',
					UAH: 'UAH',
					ГРН: 'UAH',
					ГРИВНА: 'UAH',
					'₴': 'UAH',
					RUB: 'RUB',
					РУБЛЬ: 'RUB',
					'₽': 'RUB',
					GBP: 'GBP',
					ФУНТ: 'GBP',
					'£': 'GBP',
					PLN: 'PLN',
					ЗЛОТЫЙ: 'PLN',
					SEK: 'SEK',
					КРОНА: 'SEK',
					USDT: 'USDT',
					ТЕТЕР: 'USDT'
				}
				const normalized = upper.replace(/\s+/g, '')
				const code =
					map[normalized] ||
					map[normalized.replace(/[^A-ZА-ЯЁ]/gi, '') as keyof typeof map]
				if (!code) {
					await ctx.reply('Не удалось распознать валюту, попробуйте ещё раз.', {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
					return
				}

				current.currency = code
				current.convertToCurrency = undefined
				current.convertedAmount = undefined

				const user = ctx.state.user as any
				const accountId =
					current.accountId ||
					user.defaultAccountId ||
					ctx.state.activeAccount?.id
				const showConversion = await getShowConversion(
					current,
					accountId ?? null,
					ctx.state.user.id,
					this.accountsService
				)
				if (showConversion && accountId && typeof current.amount === 'number') {
					const account = await this.accountsService.getOneWithAssets(
						accountId,
						ctx.state.user.id
					)
					if (account?.assets?.length) {
						const codes = Array.from(
							new Set(
								account.assets.map(
									(a: any) => a.currency || account.currency
								)
							)
						)
						if (codes.length) {
							current.convertToCurrency = codes[0]
							current.convertedAmount = await this.exchangeService.convert(
								current.amount,
								current.currency,
								codes[0]
							)
						}
					}
				}

				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}

				if (ctx.session.tempMessageId != null) {
					try {
						await ctx.api.editMessageText(
							ctx.chat!.id,
							ctx.session.tempMessageId,
							renderConfirmMessage(
								current,
								index,
								drafts.length,
								user.defaultAccountId
							),
							{
								parse_mode: 'HTML',
								reply_markup: confirmKeyboard(
									drafts.length,
									index,
									showConversion,
									(current as any)?.direction === 'transfer',
									!!(ctx.session as any).editingTransactionId
								)
							}
						)
					} catch {}
				}

				;(ctx.session as any).editingCurrency = false
				return
			}

			if (ctx.session.editingField && ctx.session.draftTransactions) {
				const drafts = ctx.session.draftTransactions
				if (!drafts.length) return

				const index = ctx.session.currentTransactionIndex ?? 0
				const current = drafts[index]
				const field = ctx.session.editingField
				const value = text
				const beforeFieldValue = String((current as any)?.[field] ?? '')

				switch (field) {
					case 'description': {
						const trimmed = value.trim()
						if (!trimmed) {
							await ctx.reply('Введите корректное название')
							return
						}
						current.description =
							trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
						break
					}

					case 'amount': {
						const normalized = value.replace(/\s/g, '').replace(',', '.')
						const amount = Number(normalized)
						if (isNaN(amount)) {
							await ctx.reply('Некорректная сумма, попробуйте снова')
							return
						}
						current.amount = amount
						break
					}

					case 'date': {
						const parsedDate = await this.llmService.parseDate(
							value,
							(ctx.state.user as any)?.timezone ?? 'UTC+02:00'
						)
						if (!parsedDate) {
							await ctx.reply(
								'Не удалось распознать дату, попробуйте ещё раз'
							)
							return
						}
						current.transactionDate = parsedDate.toISOString()
						break
					}

					default:
						break
				}
				const afterFieldValue = String((current as any)?.[field] ?? '')
				await this.llmMemoryService.rememberCorrection({
					userId: ctx.state.user.id,
					rawText: (current as any)?.rawText ?? '',
					before: beforeFieldValue,
					after: afterFieldValue,
					field
				})
				const txId = (current as any)?.id ?? ctx.session.editingTransactionId
				if (txId) {
					await this.transactionsService.update(txId, ctx.state.user.id, {
						accountId: (current as any).accountId,
						amount: (current as any).amount,
						currency: (current as any).currency,
						direction: (current as any).direction,
						category: (current as any).category,
						description: (current as any).description,
						transactionDate:
							normalizeTxDate((current as any).transactionDate) ?? undefined,
						tagId: (current as any).tagId ?? null,
						convertedAmount: (current as any).convertedAmount ?? null,
						convertToCurrency: (current as any).convertToCurrency ?? null,
						fromAccountId:
							(current as any).direction === 'transfer'
								? ((current as any).accountId ?? null)
								: null,
						toAccountId: (current as any).toAccountId ?? null
					})
				}

				// успешное редактирование
				ctx.session.editingField = undefined

				if (ctx.session.editMessageId) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.editMessageId
						)
					} catch {}
					ctx.session.editMessageId = undefined
				}

				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}

				const user = ctx.state.user as any
				const accountId =
					(current as any).accountId ||
					user.defaultAccountId ||
					ctx.state.activeAccount?.id
				const showConversion = await getShowConversion(
					current as any,
					accountId ?? null,
					ctx.state.user.id,
					this.accountsService
				)

				if (ctx.session.tempMessageId != null) {
					try {
						await ctx.api.editMessageText(
							ctx.chat!.id,
							ctx.session.tempMessageId,
							renderConfirmMessage(
								current,
								index,
								drafts.length,
								user.defaultAccountId
							),
							{
								parse_mode: 'HTML',
								reply_markup: confirmKeyboard(
									drafts.length,
									index,
									showConversion,
									(current as any)?.direction === 'transfer',
									!!(ctx.session as any).editingTransactionId
								)
							}
						)
					} catch {}
				}

				return
			}

			if (isInputMode(ctx, 'main_currency_edit') || (ctx.session as any).editingMainCurrency) {
				const value = text
				const upper = value.trim().toUpperCase()
				const map: Record<string, string> = {
					USD: 'USD',
					ДОЛЛАР: 'USD',
					$: 'USD',
					EUR: 'EUR',
					ЕВРО: 'EUR',
					'€': 'EUR',
					UAH: 'UAH',
					ГРН: 'UAH',
					ГРИВНА: 'UAH',
					'₴': 'UAH',
					RUB: 'RUB',
					РУБЛЬ: 'RUB',
					'₽': 'RUB',
					GBP: 'GBP',
					ФУНТ: 'GBP',
					'£': 'GBP',
					PLN: 'PLN',
					ЗЛОТЫЙ: 'PLN',
					SEK: 'SEK',
					КРОНА: 'SEK',
					USDT: 'USDT',
					ТЕТЕР: 'USDT'
				}
				const normalized = upper.replace(/\s+/g, '')
				const code =
					map[normalized] ||
					map[normalized.replace(/[^A-ZА-ЯЁ]/gi, '') as keyof typeof map]
				if (!code) {
					const errorMessage = await ctx.reply(
						'Не удалось распознать валюту, попробуйте ещё раз.',
						{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					const ids =
						((ctx.session as any).mainCurrencyErrorMessageIds as number[] | undefined) ??
						[]
					ids.push(errorMessage.message_id)
					;(ctx.session as any).mainCurrencyErrorMessageIds = ids
					return
				}

				await this.usersService.setMainCurrency(ctx.state.user.id, code)

				const hintMessageId = (ctx.session as any).mainCurrencyHintMessageId as
					| number
					| undefined
				if (hintMessageId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, hintMessageId)
					} catch {}
					;(ctx.session as any).mainCurrencyHintMessageId = undefined
				}
				const errorMessageIds =
					((ctx.session as any).mainCurrencyErrorMessageIds as number[] | undefined) ??
					[]
				for (const id of errorMessageIds) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, id)
					} catch {}
				}
				;(ctx.session as any).mainCurrencyErrorMessageIds = []

				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}

				const user: any = await this.usersService.getOrCreateByTelegramId(
					String(ctx.from!.id)
				)
				const alertsEnabledCount = await this.prisma.alertConfig.count({
					where: { userId: user.id, enabled: true }
				})
				const view = buildSettingsView(user as any, alertsEnabledCount)
				try {
					await ctx.api.editMessageText(
						ctx.chat!.id,
						ctx.session.homeMessageId,
						view.text,
						{ parse_mode: 'HTML', reply_markup: view.keyboard }
					)
				} catch {
					const msg = await ctx.reply(view.text, {
						parse_mode: 'HTML',
						reply_markup: view.keyboard
					})
					ctx.session.homeMessageId = msg.message_id
				}
				;(ctx.session as any).editingMainCurrency = false
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
				return
			}

			if (isInputMode(ctx, 'timezone_edit')) {
				const normalized = this.normalizeTimezone(text)
				if (!normalized) {
					const msg = await ctx.reply(
						'Не удалось распознать часовой пояс. Используйте формат UTC+02:00.',
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'back_to_settings')
						}
					)
					const ids =
						((ctx.session as any).timezoneErrorMessageIds as number[] | undefined) ??
						[]
					ids.push(msg.message_id)
					;(ctx.session as any).timezoneErrorMessageIds = ids
					return
				}
				await this.usersService.setTimezone(ctx.state.user.id, normalized)
				const hintMessageId = (ctx.session as any).timezoneHintMessageId as
					| number
					| undefined
				if (hintMessageId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, hintMessageId)
					} catch {}
					;(ctx.session as any).timezoneHintMessageId = undefined
				}
				for (const id of ((ctx.session as any).timezoneErrorMessageIds ?? []) as number[]) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, id)
					} catch {}
				}
				;(ctx.session as any).timezoneErrorMessageIds = []
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				const user: any = await this.usersService.getOrCreateByTelegramId(
					String(ctx.from!.id)
				)
				const alertsEnabledCount = await this.prisma.alertConfig.count({
					where: { userId: user.id, enabled: true }
				})
				const view = buildSettingsView(user as any, alertsEnabledCount)
				await ctx.api.editMessageText(ctx.chat!.id, ctx.session.homeMessageId, view.text, {
					parse_mode: 'HTML',
					reply_markup: view.keyboard
				})
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
				return
			}

			if (ctx.session.editingAccountDetailsId) {
				const accountId = ctx.session.editingAccountDetailsId
				const user: any = ctx.state.user
				if (!user) return
				const account = await this.accountsService.getOneWithAssets(
					accountId,
					user.id
				)
				if (!account) {
					ctx.session.editingAccountDetailsId = undefined
					return
				}
				let current:
					| { name: string; assets: { currency: string; amount: number }[] }
					| undefined
				let updatedDraft:
					| { name: string; assets: { currency: string; amount: number }[] }
					| undefined
				if (ctx.session.accountDetailsEditMode === 'name') {
					const renamed = await this.accountsService.renameAccount(
						accountId,
						user.id,
						text
					)
					if (!renamed) {
						await ctx.reply('Не удалось изменить название счёта.')
						return
					}
				} else {
				current = {
					name: account.name,
					assets: account.assets.map(a => ({
						currency: a.currency,
						amount: a.amount
					}))
				}
				try {
					const updated = await this.llmService.parseAccountEdit(current, text)
					if (
						!ctx.state.isPremium &&
						updated.assets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
					) {
						await this.subscriptionService.trackEvent(
							user.id,
							PremiumEventType.limit_hit,
							'assets'
						)
						await ctx.reply(
							`💠 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Free. Разблокируйте безлимит с Premium!`,
							{
								reply_markup: new InlineKeyboard()
									.text('💠 Pro-тариф', 'view_premium')
									.row()
									.text('Закрыть', 'hide_message')
							}
						)
							return
						}
					updatedDraft = {
						name: updated.name,
						assets: updated.assets.map(a => ({
							currency: a.currency,
							amount: a.amount
						}))
					}
					await this.accountsService.updateAccountWithAssets(
						accountId,
						user.id,
						updated
					)
				} catch {
					await ctx.reply(
						'Не удалось применить изменения, попробуйте сформулировать иначе.'
					)
					return
				}
				}
				if (ctx.session.editMessageId) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.editMessageId
						)
					} catch {}
					ctx.session.editMessageId = undefined
				}
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				const freshAccount = await this.accountsService.getOneWithAssets(
					accountId,
					user.id
				)
				if (freshAccount) {
					const mainCurrency = user.mainCurrency ?? 'USD'
					const isPremium = !!(ctx.state as any).isPremium
					const lastTxs = await this.prisma.transaction.findMany({
						where: { accountId, userId: user.id },
						orderBy: { transactionDate: 'desc' },
						take: 3,
						include: { tag: true, toAccount: true }
					})
					const lastTransactions: AccountLastTxRow[] = []
					for (const tx of lastTxs) {
						const amt =
							tx.convertedAmount != null && tx.convertToCurrency
								? tx.convertedAmount
								: tx.amount
						const cur =
							tx.convertedAmount != null && tx.convertToCurrency
								? tx.convertToCurrency
								: tx.currency
						const amountMain =
							(await this.exchangeService.convert(amt, cur, mainCurrency)) ?? 0
						const signed =
							tx.direction === 'expense' ? -Math.abs(tx.amount) : Math.abs(tx.amount)
						lastTransactions.push({
							direction: tx.direction,
							amount: signed,
							currency: tx.currency,
							amountMain: Math.abs(amountMain),
							description: tx.description,
							transactionDate: tx.transactionDate,
							category: tx.category,
							tagName: tx.tag?.name ?? null,
							toAccountName: tx.toAccount?.name ?? null
						})
					}
					let analyticsData: AccountAnalyticsData | undefined
					if (isPremium) {
						const beg = await this.analyticsService.getBeginningBalance(
							user.id,
							'month',
							mainCurrency,
							accountId
						)
						const [
							summary,
							topExpenses,
							topIncome,
							anomalies,
							transfersTotal,
							externalTransferOut,
							cashflow,
							burnRate
						] =
							await Promise.all([
								this.analyticsService.getSummary(
									user.id,
									'month',
									mainCurrency,
									accountId
								),
								this.analyticsService.getTopCategories(
									user.id,
									'month',
									mainCurrency,
									3,
									accountId,
									beg
								),
								this.analyticsService.getTopIncomeCategories(
									user.id,
									'month',
									mainCurrency,
									beg,
									3,
									accountId
								),
								this.analyticsService.getAnomalies(
									user.id,
									'month',
									mainCurrency,
									100,
									accountId,
									beg
								),
								this.analyticsService.getTransfersTotal(
									user.id,
									'month',
									mainCurrency,
									accountId
								),
								this.analyticsService.getExternalTransferOutTotal(
									user.id,
									'month',
									mainCurrency,
									accountId
								),
								this.analyticsService.getCashflow(
									user.id,
									'month',
									mainCurrency,
									accountId
							),
							this.analyticsService.getBurnRate(
								user.id,
								'month',
								mainCurrency,
								accountId
								)
							])
						const thresholdAnomaly = beg > 0 ? beg * 0.5 : 100
						const topTransfersWithPct = await this.analyticsService.getTopTransfers(
							user.id,
							'month',
							mainCurrency,
							3,
							accountId,
							beg
						)
						analyticsData = {
							beginningBalance: beg,
							expenses: summary.expenses + externalTransferOut,
							income: summary.income,
							transfersTotal,
							balance: summary.balance,
							cashflow,
							burnRate,
							topExpenses: topExpenses.map(c => ({
								categoryName: c.categoryName,
								sum: c.sum,
								pct: c.pct
							})),
							topIncome: topIncome.map(c => ({
								categoryName: c.categoryName,
								sum: c.sum,
								pct: c.pct
							})),
							topTransfers: topTransfersWithPct.map(t => ({
								fromAccountName: t.fromAccountName,
								toAccountName: t.toAccountName,
								sum: t.sum,
								pct: t.pct,
								descriptions: t.descriptions
							})),
							anomalies: anomalies.map(x => ({
								description: x.description ?? x.tagOrCategory ?? null,
								amountMain: x.amount
							})),
							thresholdAnomaly
						}
					}
					const detailsText = await accountDetailsText(
						freshAccount,
						mainCurrency,
						this.exchangeService,
						freshAccount.id === user.defaultAccountId,
						isPremium,
						lastTransactions,
						analyticsData,
						user.timezone ?? 'UTC+02:00'
					)
					const page = ctx.session.accountsViewPage ?? 0
					const [freshUser, frozen] = await Promise.all([
						this.prisma.user.findUnique({
							where: { telegramId: String(ctx.from!.id) }
						}),
						this.subscriptionService.getFrozenItems(user.id)
					])
					if (!freshUser) return
					const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
					const visibleAccounts = await this.prisma.account.findMany({
						where: { userId: freshUser.id, isHidden: false },
						orderBy: { createdAt: 'asc' }
					})
					await ctx.api.editMessageText(
						ctx.chat!.id,
						ctx.session.homeMessageId,
						detailsText,
						{
							parse_mode: 'HTML',
							reply_markup: accountSwitchKeyboard(
								visibleAccounts,
								freshUser.activeAccountId,
								page,
								accountId,
								freshUser.defaultAccountId ?? undefined,
								frozenAccountIds
							)
						}
					)
				}
				if (updatedDraft && current) {
					const beforeMap = new Map<string, number>()
					for (const a of current.assets) {
						beforeMap.set(String(a.currency).toUpperCase(), Number(a.amount))
					}
					const afterMap = new Map<string, number>()
					for (const a of updatedDraft.assets) {
						afterMap.set(String(a.currency).toUpperCase(), Number(a.amount))
					}
					const allCurrencies = new Set<string>([
						...Array.from(beforeMap.keys()),
						...Array.from(afterMap.keys())
					])
					const ops: Array<{
						accountId: string
						currency: string
						amount: number
						direction: 'in' | 'out'
					}> = []
					for (const currency of allCurrencies) {
						const before = beforeMap.get(currency) ?? 0
						const after = afterMap.get(currency) ?? 0
						const delta = Number((after - before).toFixed(8))
						if (!delta) continue
						ops.push({
							accountId,
							currency,
							amount: Math.abs(delta),
							direction: delta > 0 ? 'in' : 'out'
						})
					}
					ctx.session.pendingAccountDeltaOps = ops
					if (ops.length > 0) {
						const prompt = await ctx.reply(
							'Создать операцию для этого действия?',
							{
								reply_markup: new InlineKeyboard()
									.text('Да', 'account_delta_create_tx_yes')
									.text('Закрыть', 'account_delta_create_tx_close')
							}
						)
						ctx.session.accountDeltaPromptMessageId = prompt.message_id
					}
				}
				ctx.session.editingAccountDetailsId = undefined
				ctx.session.accountDetailsEditMode = undefined
				return
			}

			if (
				ctx.session.editingAccountField === 'name' &&
				ctx.session.draftAccounts
			) {
				const drafts = ctx.session.draftAccounts
				if (!drafts.length) return
				const index = ctx.session.currentAccountIndex ?? 0
				const current = drafts[index] as any
				const raw = text.trim()
				if (!raw) {
					await ctx.reply('Введите корректное название счёта.')
					return
				}
				const extractEmoji = (v: string) =>
					v.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+)/u)?.[1] ??
					''
				const stripLeadingEmoji = (v: string) =>
					v.replace(
						/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u,
						''
					).trim()
				const prevEmoji = extractEmoji(String(current.name ?? ''))
				const nextEmoji = extractEmoji(raw) || prevEmoji || '💼'
				const baseName = stripLeadingEmoji(raw) || stripLeadingEmoji(String(current.name ?? '')) || 'Счёт'
				current.name = `${nextEmoji} ${baseName}`.trim()

				ctx.session.editingAccountField = undefined
				if (ctx.session.editMessageId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
					} catch {}
					ctx.session.editMessageId = undefined
				}
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				if (ctx.session.tempMessageId != null) {
					await refreshAccountsPreview(ctx as any)
				}
				return
			}

			if (
				ctx.session.editingAccountField === 'jarvis' &&
				ctx.session.draftAccounts
			) {
				const drafts = ctx.session.draftAccounts
				if (!drafts.length) return

				const index = ctx.session.currentAccountIndex ?? 0
				const current = drafts[index]

				// пока простая перезапарсировка всего текста как одного счёта
				try {
					const updated = await this.llmService.parseAccountEdit(
						{
							name: current.name,
							assets: current.assets
						},
						text
					)
					drafts[index] = {
						...current,
						assets: updated.assets
					}
				} catch {}

				ctx.session.editingAccountField = undefined

				if (ctx.session.editMessageId) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.editMessageId
						)
					} catch {}
					ctx.session.editMessageId = undefined
				}

				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}

				if (ctx.session.tempMessageId != null) {
					await refreshAccountsPreview(ctx as any)
				}

				return
			}

			if (ctx.session.awaitingTagsJarvisEdit) {
				const userId = ctx.state.user.id
				let tags = await this.tagsService.getAllByUserId(userId)
				const currentTagNames = tags.map(t => t.name)
				let result: {
					add: string[]
					delete: string[]
					rename: { from: string; to: string }[]
				}
				const applied = {
					add: [] as string[],
					delete: [] as string[],
					rename: [] as { from: string; to: string }[]
				}
				try {
					result = await this.llmService.parseTagEdit(currentTagNames, text)
					for (const name of result.delete) {
						const normalized = this.tagsService.normalizeTag(name)
						const tag = tags.find(t => t.name === normalized)
						if (tag) {
							await this.tagsService.delete(tag.id, userId)
							applied.delete.push(tag.name)
						}
					}
					for (const { from, to } of result.rename) {
						const fromNorm = this.tagsService.normalizeTag(from)
						const tag = tags.find(t => t.name === fromNorm)
						if (tag) {
							const updated = await this.tagsService.rename(tag.id, userId, to)
							applied.rename.push({ from: tag.name, to: updated.name })
							tags = await this.tagsService.getAllByUserId(userId)
						}
					}
					if (result.add.length > 0) {
						const limitTag = await this.subscriptionService.canCreateTag(userId)
						if (
							!limitTag.allowed ||
							(!ctx.state.isPremium &&
								limitTag.current + result.add.length > limitTag.limit)
						) {
							await ctx.reply(
								'💠 3 кастомных тега — лимит Free. Разблокируйте безлимит с Premium!',
								{
									reply_markup: new InlineKeyboard()
										.text('💠 Pro-тариф', 'view_premium')
										.row()
										.text('Закрыть', 'hide_message')
								}
							)
							return
						}
					}
					for (const name of result.add) {
						const created = await this.tagsService.create(userId, name)
						applied.add.push(created.name)
					}
				} catch (e: any) {
					await ctx.reply(e?.message ?? 'Не удалось применить изменения.')
					return
				}
				if (ctx.session.tagsSettingsHintMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.tagsSettingsHintMessageId
						)
					} catch {}
					ctx.session.tagsSettingsHintMessageId = undefined
				}
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				ctx.session.awaitingTagsJarvisEdit = false
				const [freshTags, frozen] = await Promise.all([
					this.tagsService.getAllByUserId(userId),
					this.subscriptionService.getFrozenItems(userId)
				])
				const frozenSet = new Set(frozen.customTagIdsOverLimit)
				const tagsListMsg = tagsListText(
					freshTags.map(t => ({ id: t.id, name: t.name })),
					frozenSet
				)
				const tagsKb = new InlineKeyboard()
					.text('Jarvis-редактирование', 'tags_jarvis_edit')
					.row()
					.text('← Назад', 'back_from_tags')
				if (ctx.session.tagsSettingsMessageId != null) {
					try {
						await ctx.api.editMessageText(
							ctx.chat!.id,
							ctx.session.tagsSettingsMessageId,
							tagsListMsg,
							{ parse_mode: 'HTML', reply_markup: tagsKb }
						)
					} catch {}
				}
				const summaryLines: string[] = []
				if (applied.rename.length) {
					summaryLines.push(
						'Переименовано: ' +
							applied.rename.map(r => `«${r.from}» → «${r.to}»`).join(', ')
					)
				}
				if (applied.delete.length) {
					summaryLines.push('Удалено: ' + applied.delete.join(', '))
				}
				if (applied.add.length) {
					summaryLines.push('Создано: ' + applied.add.join(', '))
				}
				const summaryText =
					summaryLines.length > 0
						? '✅ Изменения применены.\n\n' + summaryLines.join('\n')
						: 'ℹ️ Изменений не обнаружено.'
				await ctx.reply(summaryText, {
					parse_mode: 'HTML',
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				return
			}

			if (ctx.session.awaitingCategoryName && ctx.session.editingCategory) {
				const userId = ctx.state.user.id
				const nameInput = (text || '').trim()
				if (!nameInput) {
					await ctx.reply('Название не может быть пустым')
					return
				}
				let createdName: string | null = null
				try {
					if (ctx.session.editingCategory === 'create') {
						const names = nameInput
							.split(/\n/)
							.map(s => s.trim().slice(0, 20))
							.filter(Boolean)
						const createdNames: string[] = []
						for (const singleName of names) {
							const limitCat =
								await this.subscriptionService.canCreateCategory(userId)
							if (!limitCat.allowed) {
								await this.subscriptionService.trackEvent(
									userId,
									PremiumEventType.limit_hit,
									'categories'
								)
								await ctx.reply(
									'💠 В бесплатной версии недоступно создание своих категорий. Для добавления своих категорий, вы можете перейти на Premium.',
									{
										reply_markup: new InlineKeyboard()
											.text('💠 Pro-тариф', 'view_premium')
											.row()
											.text('Закрыть', 'hide_message')
									}
								)
								return
							}
							const created = await this.categoriesService.create(
								userId,
								singleName
							)
							createdNames.push(created.name)
						}
						createdName =
							createdNames.length > 0 ? createdNames.join(', ') : null
					} else {
						const selectedId = ctx.session.categoriesSelectedId
						if (!selectedId) return
						await this.categoriesService.update(selectedId, userId, nameInput)
					}
				} catch (e: any) {
					await ctx.reply(e?.message ?? 'Ошибка')
					return
				}
				if (ctx.session.categoriesHintMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.categoriesHintMessageId
						)
					} catch {}
					ctx.session.categoriesHintMessageId = undefined
				}
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				ctx.session.awaitingCategoryName = false
				ctx.session.editingCategory = undefined
				if (createdName != null) {
					const successKb = {
						inline_keyboard: [
							[{ text: 'Закрыть', callback_data: 'close_category_success' }]
						]
					}
					const msg =
						createdName.includes(', ') 
							? `Добавлены категории: ${createdName}.`
							: `Успешное добавление новой категории под названием «${createdName}».`
					await ctx.reply(msg, { reply_markup: successKb })
				}
				ctx.session.categoriesSelectedId = null
				const mid = ctx.session.categoriesMessageId
				if (mid != null) {
					const [categories, frozen] = await Promise.all([
						this.categoriesService.getSelectableByUserId(userId),
						this.subscriptionService.getFrozenItems(userId)
					])
					const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
					const page = Math.min(
						ctx.session.categoriesPage ?? 0,
						Math.max(0, Math.ceil(categories.length / 9) - 1)
					)
					ctx.session.categoriesPage = page
					await ctx.api.editMessageText(ctx.chat!.id, mid, '<b>Категории</b>', {
						parse_mode: 'HTML',
						reply_markup: categoriesListKb(
							categories.map(c => ({ id: c.id, name: c.name })),
							page,
							null,
							frozenSet
						)
					})
				}
				return
			}

			if (ctx.session.awaitingTransaction) {
				let parsed: LlmTransaction[]
				const user: any = ctx.state.user
				const timezone = user?.timezone ?? 'UTC+02:00'
				const [userCategories, frozen, userAccounts] = await Promise.all([
					this.categoriesService.getAllByUserId(user.id),
					this.subscriptionService.getFrozenItems(user.id),
					this.accountsService.getAllByUserIdIncludingHidden(user.id)
				])
				const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
				const frozenCategoryIds = new Set(frozen.customCategoryIdsOverLimit)
				const frozenTagIds = frozen.customTagIdsOverLimit
				const visibleCategories = userCategories.filter(
					c => !frozenCategoryIds.has(c.id)
				)
				const categoryNames = visibleCategories.map(c => c.name)
				const existingTags = await this.tagsService.getNamesAndAliases(user.id, {
					excludeIds: frozenTagIds
				})
				const visibleAccounts = userAccounts.filter(
					(a: any) => !frozenAccountIds.has(a.id)
				)
				const accountNames = visibleAccounts
					.map((a: any) => a.name)
					.filter((n: string) => n !== 'Вне Wallet')
				const memoryHints = await this.llmMemoryService.getHints(user.id)
				await this.llmMemoryService.rememberRuleFromText(user.id, text)

				try {
					parsed = await this.llmService.parseTransaction(
						text,
						categoryNames,
						existingTags,
						accountNames,
						timezone
					)
				} catch (e: unknown) {
					const err = e instanceof Error ? e : new Error(String(e))
					this.logger.warn(
						`parseTransaction failed: ${err.message}`,
						err.stack
					)
					await ctx.reply(
						'Техническая ошибка парсинга (ИИ недоступен или превышен лимит). Обратитесь к разработчику: @sselnorr',
						{
							reply_markup: new InlineKeyboard().text(
								'Закрыть',
								'hide_message'
							)
						}
					)
					return
				}
				const pending = ctx.session.pendingTransactionDraft as any
				if (pending) {
					const next = (parsed && parsed.length ? parsed[0] : {}) as any
					const merged: any = { ...pending }
					for (const [k, v] of Object.entries(next)) {
						if (v == null) continue
						if (typeof v === 'string' && v.trim().length === 0) continue
						merged[k] = v
					}
					parsed = [merged]
				}
				parsed = parsed.map(tx => ({
					...tx,
					rawText: tx.rawText && tx.rawText.trim().length > 0 ? tx.rawText : text
				}))

				await this.processParsedTransactions(ctx, parsed)
				return
			}

			if (ctx.session.awaitingAccountInput) {
				const accountInputMessageIds = ((ctx.session as any).accountInputMessageIds ??
					[]) as number[]
				accountInputMessageIds.push(ctx.message.message_id)
				;(ctx.session as any).accountInputMessageIds = accountInputMessageIds
				try {
					const parsed = await this.llmService.parseAccount(text)

					if (!parsed.length) {
						await ctx.reply('Не удалось распознать счёт, попробуйте ещё раз')
						return
					}
					const normalized = parsed.map(acc => ({
						...acc,
						rawText:
							acc.rawText && acc.rawText.trim().length > 0
								? acc.rawText
								: text
					}))
					activateInputMode(ctx, 'idle', {
						awaitingAccountInput: false,
						confirmingAccounts: true,
						draftAccounts: normalized as any,
						currentAccountIndex: 0
					})

					await refreshAccountsPreview(ctx as any)
				} catch (e: any) {
					await ctx.reply('Не удалось распознать счёт, попробуйте ещё раз')
				}
				return
			}
		})

		this.bot.on('message:photo', async ctx => {
			if (!ctx.session.awaitingTransaction) return
			const user: any = ctx.state.user
			if (!user) return
			const imageLimit = await this.subscriptionService.canParseImage(user.id)
			if (!ctx.state.isPremium && !imageLimit.allowed) {
				await ctx.reply(
					'📸 Лимит фото-распознавания в Basic исчерпан. Перейдите на Pro для безлимита.',
					{
						reply_markup: new InlineKeyboard()
							.text('💠 Pro-тариф', 'view_premium')
							.row()
							.text('Закрыть', 'hide_message')
					}
				)
				return
			}
			const photos = ctx.message.photo
			if (!photos?.length) return
			const largest = photos[photos.length - 1]
			try {
				const imageDataUrl = await this.buildImageDataUrl(
					largest.file_id,
					'image/jpeg'
				)
				const parseToken = `PHOTO_PARSE:${new Date()
					.toISOString()
					.slice(0, 7)}:${largest.file_unique_id}`
				await this.parseTransactionsFromImage(
					ctx,
					imageDataUrl,
					ctx.message.caption?.trim() || undefined,
					parseToken
				)
			} catch {
				await ctx.reply(
					'Не удалось загрузить фото. Попробуйте ещё раз или отправьте текст.',
					{
						reply_markup: new InlineKeyboard().text(
							'Закрыть',
							'hide_message'
						)
					}
				)
				return
			}
		})

		this.bot.on('message:document', async ctx => {
			if (!ctx.session.awaitingTransaction) return
			const doc = ctx.message.document
			if (!doc?.mime_type || !doc.mime_type.startsWith('image/')) return
			const user: any = ctx.state.user
			if (!user) return
			const imageLimit = await this.subscriptionService.canParseImage(user.id)
			if (!ctx.state.isPremium && !imageLimit.allowed) {
				await ctx.reply(
					'📸 Лимит фото-распознавания в Basic исчерпан. Перейдите на Pro для безлимита.',
					{
						reply_markup: new InlineKeyboard()
							.text('💠 Pro-тариф', 'view_premium')
							.row()
							.text('Закрыть', 'hide_message')
					}
				)
				return
			}
			try {
				const imageDataUrl = await this.buildImageDataUrl(
					doc.file_id,
					doc.mime_type || 'image/jpeg'
				)
				const parseToken = `PHOTO_PARSE:${new Date()
					.toISOString()
					.slice(0, 7)}:${doc.file_unique_id}`
				await this.parseTransactionsFromImage(
					ctx,
					imageDataUrl,
					ctx.message.caption?.trim() || undefined,
					parseToken
				)
			} catch {
				await ctx.reply(
					'Не удалось загрузить изображение. Попробуйте ещё раз или отправьте текст.',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
			}
		})

		this.bot.on('message:voice', async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			try {
				const audioBuffer = await this.downloadTelegramFile(ctx.message.voice.file_id)
				const textFromVoice = await this.llmService.transcribeAudio(audioBuffer, {
					fileName: `${ctx.message.voice.file_unique_id}.ogg`,
					mimeType: 'audio/ogg',
					language: 'ru'
				})
				if (!textFromVoice) {
					await ctx.reply('Не удалось распознать голосовое сообщение.')
					return
				}
				if (ctx.session.awaitingTransaction) {
					const [userCategories, frozen, userAccounts] = await Promise.all([
						this.categoriesService.getAllByUserId(user.id),
						this.subscriptionService.getFrozenItems(user.id),
						this.accountsService.getAllByUserIdIncludingHidden(user.id)
					])
					const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
					const frozenCategoryIds = new Set(frozen.customCategoryIdsOverLimit)
					const frozenTagIds = frozen.customTagIdsOverLimit
					const visibleCategories = userCategories.filter(
						c => !frozenCategoryIds.has(c.id)
					)
					const categoryNames = visibleCategories.map(c => c.name)
					const existingTags = await this.tagsService.getNamesAndAliases(user.id, {
						excludeIds: frozenTagIds
					})
					const visibleAccounts = userAccounts.filter(
						(a: any) => !frozenAccountIds.has(a.id)
					)
					const accountNames = visibleAccounts
						.map((a: any) => a.name)
						.filter((n: string) => n !== 'Вне Wallet')
					const parsed = await this.llmService.parseTransaction(
						textFromVoice,
						categoryNames,
						existingTags,
						accountNames,
						user?.timezone ?? 'UTC+02:00'
					)
					const normalized = parsed.map(tx => ({
						...tx,
						rawText:
							tx.rawText && tx.rawText.trim().length > 0
								? tx.rawText
								: textFromVoice
					}))
					await this.processParsedTransactions(ctx, normalized)
					return
				}
				if (ctx.session.awaitingAccountInput) {
					const parsed = await this.llmService.parseAccount(textFromVoice)
					if (!parsed.length) {
						await ctx.reply('Не удалось распознать счёт, попробуйте ещё раз')
						return
					}
					ctx.session.awaitingAccountInput = false
					ctx.session.confirmingAccounts = true
					ctx.session.draftAccounts = parsed as any
					ctx.session.currentAccountIndex = 0
					await refreshAccountsPreview(ctx as any)
					return
				}
				if (
					ctx.session.editingAccountField === 'name' &&
					ctx.session.draftAccounts
				) {
					const drafts = ctx.session.draftAccounts
					const index = ctx.session.currentAccountIndex ?? 0
					const current = drafts[index] as any
					const extractEmoji = (v: string) =>
						v.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+)/u)?.[1] ??
						''
					const stripLeadingEmoji = (v: string) =>
						v.replace(
							/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u,
							''
						).trim()
					const prevEmoji = extractEmoji(String(current.name ?? ''))
					const nextEmoji = extractEmoji(textFromVoice) || prevEmoji || '💼'
					const baseName =
						stripLeadingEmoji(textFromVoice) ||
						stripLeadingEmoji(String(current.name ?? '')) ||
						'Счёт'
					current.name = `${nextEmoji} ${baseName}`.trim()
					ctx.session.editingAccountField = undefined
					if (ctx.session.editMessageId) {
						try {
							await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
						} catch {}
						ctx.session.editMessageId = undefined
					}
					if (ctx.session.tempMessageId != null) {
						await refreshAccountsPreview(ctx as any)
					}
					return
				}
				if (ctx.session.accountDetailsEditMode === 'name' && ctx.session.editingAccountDetailsId) {
					const renamed = await this.accountsService.renameAccount(
						ctx.session.editingAccountDetailsId,
						user.id,
						textFromVoice
					)
					if (!renamed) {
						await ctx.reply('Не удалось изменить название счёта.')
						return
					}
					if (ctx.session.editMessageId) {
						try {
							await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
						} catch {}
						ctx.session.editMessageId = undefined
					}
					await ctx.reply('✅ Название счёта обновлено.', {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
					return
				}
			} catch {
				await ctx.reply(
					'Не удалось обработать голосовое сообщение. Попробуйте текстом.'
				)
			}
		})

			this.bot.start()
		}

	private async replyHelp(ctx: BotContext) {
		const text = `📘 Помощь

🌐 Полезные ссылки
🧩 Мой переходник — https://t.me/isi_crypto
📄 Пользовательское соглашение — <a href="https://docs.google.com/document/d/1vQyIYfhtVHiBtn_j8C85W1Fd-KX_FV5Vg7aGxSYXf-k/edit?usp=sharing">Открыть</a>
🔐 Политика конфиденциальности — <a href="https://docs.google.com/document/d/1Rm1KJ68G-wuftglO4MkUqPWf87NIBJyMuy_YuA-iOPc/edit?usp=sharing">Открыть</a>
💬 Поддержка — @sselnorr

🚀 Как пользоваться CoinPilot
CoinPilot помогает учитывать крипту и фиат в одном месте — быстро и безопасно. 

1️⃣ Добавление счетов

Нажмите /start, перейдите в "Счета" и добавьте свои счета в формате:

"Название — сумма — валюта"

Можно вводить серийно — система распознает данные автоматически.

2️⃣ Добавление транзакций

Просто отправьте текст или фото операции.
ИИ-парсер распознает сумму, категорию и валюту.

3️⃣ Аналитика

В разделе аналитики вы получите:
• Баланс по всем счетам
• Метрики
• Распределение активов
• Статистику по периодам

⭐️ Подписка

Вы можете подключить Pro-тариф в разделе «⭐️ Подписка».

Pro открывает:
• Безлимитные транзакции и счета
• Расширенную аналитику
• Экспорт CSV / Excel
• Доступ к будущим Pro-функциям

💳 Оплата проходит через Stripe — международную защищённую платёжную систему.
Подписку можно изменить или отменить в любое время. После отмены доступ сохранится до конца оплаченного периода.

🔐 Безопасность данных

• Мы не запрашиваем доступ к вашим кошелькам или API
• Данные шифруются
• Никогда не передаются третьим лицам
• Вы можете удалить все свои данные в настройках
• После удаления восстановление невозможно

Ваши данные принадлежат только вам.`
		await ctx.reply(text, {
			parse_mode: 'HTML',
			link_preview_options: { is_disabled: true },
			reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
		})
	}

	private normalizeTimezone(value: string): string | null {
		const raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
		const m = raw.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/)
		if (!m) return null
		const sign = m[1]
		const hh = Number(m[2])
		const mm = Number(m[3] ?? '0')
		if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 14 || mm > 59) {
			return null
		}
		return `UTC${sign}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
	}

	private async downloadTelegramFile(fileId: string): Promise<Buffer> {
		const file = await this.bot.api.getFile(fileId)
		const token = this.config.getOrThrow<string>('BOT_TOKEN')
		const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
		const res = await fetch(url)
		if (!res.ok) {
			throw new Error('Failed to download telegram file')
		}
		return Buffer.from(await res.arrayBuffer())
	}

	private async buildImageDataUrl(
		fileId: string,
		mimeType: string = 'image/jpeg'
	): Promise<string> {
		const fileBuffer = await this.downloadTelegramFile(fileId)
		return `data:${mimeType};base64,${fileBuffer.toString('base64')}`
	}

	private normalizeDescription(
		description: string | null | undefined,
		direction: string | undefined
	): string {
		const raw = String(description ?? '').trim()
		if (!raw) return direction === 'transfer' ? 'Перевод' : '—'
		const cleaned = raw
			.replace(/\b(перевод|доход|расход|income|expense|transfer)\b/gi, '')
			.replace(/\s{2,}/g, ' ')
			.trim()
		if (cleaned.length === 0) {
			if (direction === 'transfer') return 'Перевод'
			if (direction === 'income') return 'Доход'
			if (direction === 'expense') return 'Расход'
			return '—'
		}
		return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
	}

	private getMissingCriticalFields(
		tx: any,
		outsideWalletId: string | null
	): string[] {
		const missing: string[] = []
		if (!(typeof tx.amount === 'number') || !Number.isFinite(tx.amount) || tx.amount <= 0) {
			missing.push('сумма (> 0)')
		}
		if (!tx.currency || String(tx.currency).trim().length === 0) {
			missing.push('валюта')
		}
		if (tx.direction === 'transfer') {
			if (!tx.accountId) missing.push('счёт отправителя')
			if (!tx.toAccountId) missing.push('счёт получателя')
			if (
				outsideWalletId &&
				tx.accountId === outsideWalletId &&
				tx.toAccountId === outsideWalletId
			) {
				missing.push('одна сторона перевода должна быть обычным счётом')
			}
		} else {
			if (!tx.accountId) missing.push('счёт')
			if (outsideWalletId && tx.accountId === outsideWalletId) {
				missing.push('для дохода/расхода нужен обычный счёт')
			}
		}
		return missing
	}

	private async parseTransactionsFromImage(
		ctx: BotContext,
		imageDataUrl: string,
		caption: string | undefined,
		parseToken: string
	): Promise<void> {
		const user: any = ctx.state.user
		const [userCategories, frozen, userAccounts] = await Promise.all([
			this.categoriesService.getAllByUserId(user.id),
			this.subscriptionService.getFrozenItems(user.id),
			this.accountsService.getAllByUserIdIncludingHidden(user.id)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const frozenCategoryIds = new Set(frozen.customCategoryIdsOverLimit)
		const frozenTagIds = frozen.customTagIdsOverLimit
		const visibleCategories = userCategories.filter(c => !frozenCategoryIds.has(c.id))
		const categoryNames = visibleCategories.map(c => c.name)
		const existingTags = await this.tagsService.getNamesAndAliases(user.id, {
			excludeIds: frozenTagIds
		})
		const visibleAccounts = userAccounts.filter(
			(a: any) => !frozenAccountIds.has(a.id)
		)
		const accountNames = visibleAccounts
			.map((a: any) => a.name)
			.filter((n: string) => n !== 'Вне Wallet')

		const parsed = await this.llmService.parseTransactionFromImage(
			imageDataUrl,
			categoryNames,
			existingTags,
			accountNames,
			caption,
			user?.timezone ?? 'UTC+02:00'
		)
		const normalized = parsed.map(tx => ({
			...tx,
			rawText: parseToken
		}))
		await this.processParsedTransactions(ctx, normalized)
	}

	async closeTemp(ctx) {
		const keep = new Set<number>((ctx.session.resultMessageIds ?? []) as number[])
		const ids = [
			ctx.session.tempMessageId,
			ctx.session.hintMessageId,
			ctx.session.previewMessageId,
			ctx.session.inlineCreateHintMessageId,
			(ctx.session as any).accountInputHintMessageId,
			(ctx.session as any).mainCurrencyHintMessageId,
			(ctx.session as any).timezoneHintMessageId
		].filter((id): id is number => typeof id === 'number')
		for (const id of ids) {
			if (id === ctx.session.homeMessageId || keep.has(id)) continue
			try {
				await ctx.api.deleteMessage(ctx.chat.id, id)
			} catch {}
		}
		ctx.session.tempMessageId = undefined
		ctx.session.hintMessageId = undefined
		ctx.session.previewMessageId = undefined
		ctx.session.inlineCreateHintMessageId = undefined
		;(ctx.session as any).accountInputHintMessageId = undefined
		;(ctx.session as any).mainCurrencyHintMessageId = undefined
		;(ctx.session as any).timezoneHintMessageId = undefined
	}

	private async processParsedTransactions(
		ctx: BotContext,
		parsed: LlmTransaction[]
	): Promise<void> {
		const user: any = ctx.state.user
		if (!parsed.length) {
			await ctx.reply(
				'Прости, я не смог понять, что ты имеешь в виду 😕\n' +
					'Попробуй, например:\n\n' +
					'• Купил кофе за 120 грн\n' +
					'• Зарплата 1500 USD\n' +
					'• Купил 5 монет BTC'
			)
			return
		}
		if (parsed.length > 10) {
			await ctx.reply(
				'Максимум 10 транзакций за один раз. Сократите сообщение.',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'hide_message'
					)
				}
			)
			return
		}
		const [userCategories, frozen, userAccounts] = await Promise.all([
			this.categoriesService.getAllByUserId(user.id),
			this.subscriptionService.getFrozenItems(user.id),
			this.accountsService.getAllByUserIdIncludingHidden(user.id)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const frozenCategoryIds = new Set(frozen.customCategoryIdsOverLimit)
		const frozenTagIds = frozen.customTagIdsOverLimit
		const visibleCategories = userCategories.filter(
			c => !frozenCategoryIds.has(c.id)
		)
		const categoryNames = visibleCategories.map(c => c.name)
		const existingTags = await this.tagsService.getNamesAndAliases(user.id, {
			excludeIds: frozenTagIds
		})
		const outsideWalletAccount = userAccounts.find(
			(a: any) => a.name === 'Вне Wallet'
		)
		const outsideWalletId = outsideWalletAccount?.id ?? null
		const defaultAccountId =
			user.defaultAccountId || ctx.state.activeAccount?.id || null
		const defaultAccount = defaultAccountId
			? await this.accountsService.getOneWithAssets(
					defaultAccountId,
					user.id
				)
			: null
		const visibleAccountsWithAssets =
			await this.accountsService.getAllWithAssets(user.id)
		const defaultHasEur =
			defaultAccount?.assets?.some(
				a => (a.currency || defaultAccount.currency) === 'EUR'
			) ?? false
		const accountsWithEur = visibleAccountsWithAssets.filter(acc =>
			acc.assets?.some(
				a => (a.currency || (acc as any).currency) === 'EUR'
			)
		)
		const singleAccountWithEur =
			accountsWithEur.length === 1 ? accountsWithEur[0] : null
		const accountAliasMap: Record<string, string> = {
			нал: 'Наличные',
			наличные: 'Наличные',
			байбит: 'Bybit',
			bybit: 'Bybit',
			мех: 'MEXC',
			mexc: 'MEXC'
		}

		const normalizeAccountAlias = (value?: string | null): string => {
			const raw = String(value ?? '').trim()
			if (!raw) return ''
			const lower = raw.toLowerCase()
			return accountAliasMap[lower] ?? raw
		}

		const matchAccountByName = (name: string): { id: string; name: string } | null => {
			if (!name || !userAccounts.length) return null
			const lower = normalizeAccountAlias(name).toLowerCase()
			if (!lower) return null
			for (const acc of userAccounts as any[]) {
				if (acc.name === 'Вне Wallet') continue
				const accLower = acc.name.toLowerCase()
				if (
					accLower === lower ||
					accLower.includes(lower) ||
					lower.includes(accLower)
				) {
					return { id: acc.id, name: acc.name }
				}
			}
			let best: { id: string; name: string; dist: number } | null = null
			const compact = lower.replace(/\s+/g, '')
			for (const acc of userAccounts as any[]) {
				if (acc.name === 'Вне Wallet') continue
				const accCompact = String(acc.name).toLowerCase().replace(/\s+/g, '')
				const dist = levenshtein(compact, accCompact)
				if (!best || dist < best.dist) {
					best = { id: acc.id, name: acc.name, dist }
				}
			}
			if (best && best.dist <= 2) return { id: best.id, name: best.name }
			return null
		}

		const normalizeDescriptionKey = (value?: string | null): string =>
			String(value ?? '')
				.toLowerCase()
				.replace(/[^\p{L}\p{N}]+/gu, '')
				.trim()

		const isGenericTransferDescription = (value?: string | null): boolean => {
			const key = normalizeDescriptionKey(value)
			return (
				!key ||
				key === 'перевод' ||
				key === 'transfer' ||
				key === 'transaction' ||
				key === 'транзакция' ||
				key === 'операция'
			)
		}

		const extractTransferCounterparty = (value?: string | null): string | null => {
			const text = String(value ?? '').replace(/\s+/g, ' ').trim()
			if (!text) return null
			const normalizeCandidate = (candidate: string): string | null => {
				const cleaned = candidate
					.replace(/[.,;:!?]+$/g, '')
					.replace(/\s+/g, ' ')
					.trim()
				if (!cleaned) return null
				const tokens = cleaned.split(' ').slice(0, 2)
				return tokens.join(' ')
			}
			const verbMatch = text.match(
				/(?:отправил|перев[её]л|перекинул|скинул)\s+([^\d,+\-()]{2,40}?)(?=\s+\d|$|\s+(?:евро|eur|usd|usdt|rub|руб|грн|uah|btc|eth)\b)/iu
			)
			if (verbMatch) {
				const candidate = normalizeCandidate(verbMatch[1])
				if (candidate) return candidate.toLowerCase()
			}
			const dativeMatch = text.match(
				/\b(бате|папе|маме|брату|сестре|жене|мужу|сыну|дочери|дочке|другу|подруге)\b/iu
			)
			if (dativeMatch) return dativeMatch[1].toLowerCase()
			return null
		}

		const merged = new Map<string, any>()
		for (const tx of parsed as any[]) {
			const direction = tx.direction
			const chosenDate = pickTransactionDate({
				userText: tx.rawText ?? '',
				llmDate: tx.transactionDate
			})
			tx.transactionDate = chosenDate.toISOString()
			const txDate = chosenDate.toISOString().slice(0, 10)
			const account = normalizeAccountAlias(tx.account ?? tx.fromAccount ?? '')
			const category = tx.category ?? '📦Другое'
			const currency = (tx.currency ?? '').toUpperCase()
			const merchantKey = String(tx.description ?? '')
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s]/gu, ' ')
				.replace(/\s+/g, ' ')
				.trim()
			if (direction === 'transfer') {
				const key = `transfer|${txDate}|${currency}|${account}|${normalizeAccountAlias(
					tx.toAccount ?? ''
				)}`
				if (!merged.has(key)) merged.set(key, { ...tx })
				else {
					const prev = merged.get(key)
					prev.amount = Number(prev.amount ?? 0) + Number(tx.amount ?? 0)
				}
				continue
			}
			const key = `${direction}|${txDate}|${currency}|${account}|${category}|${merchantKey}|${
				tx.tag_text ?? ''
			}`
			if (!merged.has(key)) {
				merged.set(key, { ...tx })
				continue
			}
			const prev = merged.get(key)
			prev.amount = Number(prev.amount ?? 0) + Number(tx.amount ?? 0)
			if (!prev.description && tx.description) {
				prev.description = tx.description
			}
		}
		const parsedNormalized = Array.from(merged.values()) as any[]
		const withFeeTransactions: any[] = []
		for (const tx of parsedNormalized) {
			withFeeTransactions.push(tx)
			const raw = String(tx.rawText ?? '').toLowerCase()
			if (
				tx.direction !== 'transfer' ||
				!isCryptoCurrency(String(tx.currency ?? '')) ||
				!/комисси|fee/u.test(raw)
			) {
				continue
			}
			const feeMatch = raw.match(
				/(?:комисси[яиюе]|fee)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*([a-z]{2,10})?/iu
			)
			const feeAltMatch = raw.match(
				/(\d+(?:[.,]\d+)?)\s*([a-z]{2,10})\s*(?:комисси[яиюе]|fee)/iu
			)
			const m = feeMatch ?? feeAltMatch
			if (!m) continue
			const feeRaw = Number(String(m[1]).replace(',', '.'))
			if (!isFinite(feeRaw) || feeRaw <= 0) continue
			const feeCurrency = String((m[2] ?? tx.currency) || '').toUpperCase()
			if (feeCurrency !== String(tx.currency ?? '').toUpperCase()) continue
			const amount = Number(tx.amount ?? 0)
			if (!(amount > feeRaw)) continue
			const netAmount = Number((amount - feeRaw).toFixed(8))
			tx.amount = netAmount
			const feeTx = {
				...tx,
				amount: feeRaw,
				direction: 'expense',
				category: '📉Финансовые расходы',
				description: 'Комиссия за перевод',
				tag_text: 'комиссия',
				normalized_tag: 'комиссия',
				tag_confidence: 0.99
			}
			withFeeTransactions.push(feeTx)
		}
		const knownCurrencies = await this.exchangeService.getKnownCurrencies()
		const supportedCurrencies = new Set<string>([
			...Array.from(knownCurrencies.fiat),
			...Array.from(knownCurrencies.crypto)
		])

		const recentTx = await this.prisma.transaction.findMany({
			where: { userId: user.id, description: { not: null } },
			orderBy: { transactionDate: 'desc' },
			take: 200,
			include: { tag: true, account: true }
		})
		const findSimilar = (description?: string | null) => {
			const target = String(description ?? '').trim().toLowerCase()
			if (!target) return null
			return (
				recentTx.find(t => {
					const src = String(t.description ?? '').trim().toLowerCase()
					if (!src) return false
					return src.includes(target) || target.includes(src)
				}) ?? null
			)
		}

		for (const tx of withFeeTransactions) {
			if (tx.currency) {
				tx.currency = String(tx.currency).toUpperCase().trim()
			}
			if (tx.currency && !supportedCurrencies.has(tx.currency)) {
				await ctx.reply(
					`Валюта ${tx.currency} не поддерживается, свяжитесь с разработчиком.`,
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			tx.account = normalizeAccountAlias(tx.account)
			tx.fromAccount = normalizeAccountAlias(tx.fromAccount)
			tx.toAccount = normalizeAccountAlias(tx.toAccount)
			const sourceText = `${tx.rawText ?? ''} ${tx.description ?? ''}`.toLowerCase()
			const transferHint =
				/(перев[её]л|перевел|перевод|перекинул|вывел|send|sent|withdraw|withdrawal)/.test(
					sourceText
				)
			if (transferHint) {
				tx.direction = 'transfer'
			}
			if (
				/(telegram\s*stars|донат|подписк|subscription|apple\.com\/bill|google\*|patreon|payment)/.test(
					sourceText
				)
			) {
				const paymentCategory = categoryNames.find((name: string) =>
					/платеж|платёж|оплат/i.test(name)
				)
				if (paymentCategory) {
					tx.category = paymentCategory
				}
			}
			if (
				/(кофе|cafe|кафе|ресторан|обед|ужин|блюд)/.test(sourceText) &&
				(!tx.category || tx.category === '📦Другое')
			) {
				const foodLike = categoryNames.find((name: string) =>
					/еда|food|кафе|кофе|рестора|напит/i.test(name)
				)
				if (foodLike) tx.category = foodLike
			}
			if (!tx.category || tx.category === 'Не выбрано' || tx.category === '📦Другое' || !tx.tag_text) {
				const similar = findSimilar(tx.description)
				if (similar) {
					if (!tx.category || tx.category === 'Не выбрано' || tx.category === '📦Другое') {
						tx.category = similar.category ?? tx.category
					}
					if (!tx.tag_text && similar.tag?.name) {
						tx.tag_text = similar.tag.name
						tx.normalized_tag = similar.tag.name.toLowerCase()
						tx.tag_confidence = 0.95
					}
					if (!tx.account && similar.account?.name) {
						tx.account = similar.account.name
					}
				}
			}
			tx.description = this.normalizeDescription(tx.description, tx.direction)
		}

		for (const tx of parsedNormalized) {
			tx.userTimezone = user.timezone ?? 'UTC+02:00'
			if (typeof tx.amount === 'number' && Number.isFinite(tx.amount)) {
				tx.amount = Math.abs(tx.amount)
			}
			const isTransfer = tx.direction === 'transfer'
			const parsedAccountStr = isTransfer
				? (tx.fromAccount && String(tx.fromAccount).trim()) || (tx.account && String(tx.account).trim()) || ''
				: (tx.account && String(tx.account).trim()) || ''
			const matched = parsedAccountStr ? matchAccountByName(parsedAccountStr) : null
			const matchedAccountId = matched?.id ?? null
			tx.accountId = isTransfer
				? matchedAccountId ?? (parsedAccountStr ? defaultAccountId : outsideWalletId ?? defaultAccountId)
				: matchedAccountId ?? defaultAccountId
			let acc = matchedAccountId
				? userAccounts.find((a: any) => a.id === matchedAccountId)
				: defaultAccount
			tx.account = acc?.name ?? defaultAccount?.name ?? null
			if (
				!isTransfer &&
				(matchedAccountId === outsideWalletId ||
					tx.account === 'Вне Wallet')
			) {
				tx.accountId = defaultAccountId
				tx.account = defaultAccount?.name ?? null
				acc = defaultAccount
			}
			if (isTransfer) {
				let toStr = tx.toAccount && String(tx.toAccount).trim()
				if (!toStr) {
					const source = `${tx.rawText ?? ''} ${tx.description ?? ''}`.trim()
					const m = source.match(
						/(?:перев[её]л|перевел|перевод|to|кому|send)\s+([A-Za-zА-Яа-яЁё0-9_\- ]{2,})/i
					)
					if (m?.[1]) {
						toStr = m[1].trim()
					}
				}
				if (toStr) {
					const toMatched = matchAccountByName(toStr)
					if (toMatched) {
						tx.toAccountId = toMatched.id
						tx.toAccount = toMatched.name
					} else {
						tx.toAccountId = outsideWalletId
						tx.toAccount = 'Вне Wallet'
					}
				} else {
					tx.toAccountId = outsideWalletId
					tx.toAccount = 'Вне Wallet'
				}
				if (!tx.accountId) {
					tx.accountId = outsideWalletId ?? defaultAccountId
					tx.account = tx.accountId === outsideWalletId ? 'Вне Wallet' : defaultAccount?.name
				}
				if (
					outsideWalletId &&
					tx.accountId === outsideWalletId &&
					tx.toAccountId === outsideWalletId &&
					defaultAccountId &&
					defaultAccountId !== outsideWalletId
				) {
					tx.accountId = defaultAccountId
					tx.account = defaultAccount?.name ?? tx.account
				}
			}
			if (
				tx.accountId === defaultAccountId &&
				tx.currency === 'EUR' &&
				!defaultHasEur &&
				singleAccountWithEur
			) {
				tx.accountId = singleAccountWithEur.id
				tx.account = singleAccountWithEur.name
				acc = singleAccountWithEur
			}
			const accountForTx =
				tx.accountId &&
				visibleAccountsWithAssets.find(
					(a: any) => a.id === tx.accountId
				)
			if (
				accountForTx &&
				(!accountForTx.assets || accountForTx.assets.length === 0)
			) {
				const accountName = accountForTx.name || 'Основной счёт'
				await ctx.reply(
					`Вы не указали связанный счёт, поэтому транзакция привязана к основному счёту «${accountName}», но в нём отсутствуют активы. Добавьте валюты в счёт.`,
					{
						reply_markup: new InlineKeyboard().text(
							'Закрыть',
							'hide_message'
						)
					}
				)
				return
			}
			if (!tx.category || !categoryNames.includes(tx.category)) {
				tx.category = '📦Другое'
			}
			const matchedCategory = visibleCategories.find(c => c.name === tx.category)
			tx.categoryId = matchedCategory?.id
			if (tx.accountId && tx.currency && typeof tx.amount === 'number') {
				const account = await this.accountsService.getOneWithAssets(
					tx.accountId,
					user.id
				)
				if (account && account.assets.length) {
					const codes = Array.from(
						new Set(
							account.assets.map(
								a => a.currency || account.currency
							)
						)
					)
					if (!codes.includes(tx.currency) && codes.length) {
						tx.convertToCurrency = codes[0]
						tx.convertedAmount =
							await this.exchangeService.convert(
								tx.amount,
								tx.currency,
								tx.convertToCurrency
							)
					}
				}
			}
			if (tx.tag_text) {
				const resolved = await this.tagsService.resolveTag(
					user.id,
					tx.tag_text,
					tx.normalized_tag ?? '',
					tx.tag_confidence ?? 0
				)
				if (resolved.tagName) {
					tx.tagId = resolved.tagId
					tx.tagName = resolved.tagName
					tx.tagIsNew = resolved.isNew
				}
			}
		}

		const first = parsedNormalized[0] as any
		const hasTransactionalSignal = parsedNormalized.some(
			tx =>
				(typeof tx.amount === 'number' && Number.isFinite(tx.amount) && tx.amount > 0) ||
				(typeof tx.currency === 'string' && tx.currency.trim().length > 0)
		)
		if (!hasTransactionalSignal) {
			await ctx.reply(
				'Прости, я не смог выделить данные транзакции. Добавьте сумму и валюту, например: "кофе 120 UAH".',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				}
			)
			return
		}
		const firstInvalid = parsedNormalized.find(tx => {
			const missing = this.getMissingCriticalFields(tx, outsideWalletId)
			;(tx as any).__missing = missing
			return missing.length > 0
		}) as any
		if (firstInvalid) {
			const missing = (firstInvalid.__missing as string[]) ?? []
			const recognized: string[] = []
			if (firstInvalid.description) {
				recognized.push(`Название: ${firstInvalid.description}`)
			}
			if (firstInvalid.category) {
				recognized.push(`Категория: ${firstInvalid.category}`)
			}
			if (firstInvalid.account) {
				recognized.push(`Счёт: ${firstInvalid.account}`)
			}
			activateInputMode(ctx, 'transaction_parse', {
				awaitingTransaction: true,
				pendingTransactionDraft: {
					...firstInvalid,
					__missing: undefined
				} as any,
				pendingTransactionMissing: missing
			})
			await ctx.reply(
				`Не хватает данных для создания операции: ${missing.join(', ')}.\n` +
					`Отправьте только недостающие поля, я дополню текущий черновик.` +
					(recognized.length > 0
						? `\n\nУже распознано:\n${recognized.join('\n')}`
						: ''),
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				}
			)
			return
		}

		activateInputMode(ctx, 'transaction_edit', {
			awaitingTransaction: false,
			confirmingTransaction: true,
			draftTransactions: parsedNormalized,
			currentTransactionIndex: 0
		})

		const firstAccountId = (first as any)?.accountId ?? defaultAccountId
		const previewAccount =
			(firstAccountId &&
				visibleAccountsWithAssets.find((a: any) => a.id === firstAccountId)) ||
			defaultAccount
		const accountCurrencies = previewAccount
			? Array.from(
					new Set(
						previewAccount.assets?.map(
							a => a.currency || previewAccount.currency
						) ?? []
					)
				)
			: []
		const showConversion = !(
			first.currency && accountCurrencies.includes(first.currency)
		)
		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.session.tempMessageId
				)
			} catch {}
		}
		const msg = await ctx.reply(
			renderConfirmMessage(
				first,
				0,
				withFeeTransactions.length,
				user.defaultAccountId
			),
			{
				parse_mode: 'HTML',
				reply_markup: confirmKeyboard(
					withFeeTransactions.length,
					0,
					showConversion,
					first?.direction === 'transfer',
					false
				)
			}
		)
		ctx.session.tempMessageId = msg.message_id
		ctx.session.previewMessageId = msg.message_id
	}
}

