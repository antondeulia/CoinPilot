import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Bot, InlineKeyboard, session } from 'grammy'
import { UsersService } from '../users/users.service'
import { TransactionsService } from '../transactions/transactions.service'
import { LLMService } from '../llm/llm.service'
import { LlmTransaction } from '../llm/schemas/transaction.schema'
import { BotContext, userContextMiddleware } from './core/bot.middleware'
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
import {
	extractExplicitDateFromText,
	normalizeTxDate,
	pickTransactionDate
} from '../../utils/date'
import { LlmMemoryService } from '../llm-memory/llm-memory.service'
import { buildAddTransactionPrompt } from './callbacks/add-transaction.command'
import { isCryptoCurrency } from '../../utils/format'
import {
	attachTradeMeta,
	extractTradeMeta,
	stripTradeMeta,
	type TradeMeta,
	type TradeType
} from './utils/trade-meta'

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
		addTxCallback(this.bot, this.subscriptionService, this.accountsService)
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
				ctx.session.tempMessageId = undefined
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
					const isTransfer = tx.direction === 'transfer'
					const amt =
						!isTransfer && tx.convertedAmount != null && tx.convertToCurrency
							? Number(tx.convertedAmount)
							: Number(tx.amount)
					const cur =
						!isTransfer && tx.convertedAmount != null && tx.convertToCurrency
							? tx.convertToCurrency
							: tx.currency
					const amountMain = (await this.exchangeService.convert(amt, cur, mainCurrency)) ?? 0
					const tradeType = (tx.tradeType as 'buy' | 'sell' | null) ?? null
					const signed =
						tradeType === 'buy'
							? Math.abs(Number(tx.tradeBaseAmount ?? tx.amount))
							: tradeType === 'sell'
								? -Math.abs(Number(tx.tradeBaseAmount ?? tx.amount))
								: isTransfer
									? -Math.abs(Number(tx.amount))
								: tx.direction === 'expense'
									? -Math.abs(Number(tx.amount))
									: Math.abs(Number(tx.amount))
				lastTransactions.push({
					direction: tx.direction,
					tradeType,
					tradeBaseAmount:
						tx.tradeBaseAmount != null ? Number(tx.tradeBaseAmount) : null,
					tradeBaseCurrency: tx.tradeBaseCurrency ?? null,
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
				analyticsData
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
			ctx.session.editingAccountDetailsId = selectedId
			ctx.session.editingAccountField = 'jarvis'
			const msg = await ctx.reply(
				'Режим Jarvis-редактирования счёта.\n\nОпишите, что изменить в валютах и суммах: добавить/удалить валюты, изменить суммы.',
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

		this.bot.callbackQuery('accounts_name_edit_details', async ctx => {
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
			ctx.session.editingAccountDetailsId = selectedId
			ctx.session.editingAccountField = 'name'
			const msg = await ctx.reply(
				'Режим изменения названия счёта.\n\nОтправьте новое название. ИИ распознает и применит его.',
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
						false,
						(first as any)?.tradeType
					)
				}
				)
				ctx.session.tempMessageId = msg.message_id
				await renderHome(ctx, this.accountsService, this.analyticsService)
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
			ctx.session.awaitingTransaction = false
			ctx.session.confirmingTransaction = false
			ctx.session.draftTransactions = undefined
			ctx.session.currentTransactionIndex = undefined
			ctx.session.awaitingAccountInput = false
			ctx.session.awaitingTagsJarvisEdit = false
			ctx.session.awaitingCategoryName = false
			ctx.session.awaitingTagInput = false
			ctx.session.editingAccountField = undefined
			ctx.session.editingField = undefined
			;(ctx.session as any).editingCurrency = false
			const hint = await ctx.reply(
				'Введите одну валюту, например: USD, доллар, $, евро, UAH.',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'back_to_settings')
				}
			)
			;(ctx.session as any).editingMainCurrency = true
			;(ctx.session as any).mainCurrencyHintMessageId = hint.message_id
			;(ctx.session as any).mainCurrencyErrorMessageIds = []
		})
		this.bot.callbackQuery('timezone_open', async ctx => {
			ctx.session.awaitingTransaction = false
			ctx.session.confirmingTransaction = false
			ctx.session.draftTransactions = undefined
			ctx.session.currentTransactionIndex = undefined
			ctx.session.awaitingAccountInput = false
			ctx.session.awaitingTagsJarvisEdit = false
			ctx.session.awaitingCategoryName = false
			ctx.session.awaitingTagInput = false
			ctx.session.editingAccountField = undefined
			ctx.session.editingField = undefined
			;(ctx.session as any).editingMainCurrency = false
			;(ctx.session as any).editingCurrency = false
			const hint = await ctx.reply(
				'Введите часовой пояс в формате IANA (например Europe/Berlin) или UTC-смещение (+03:00).',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'back_to_settings')
				}
			)
			ctx.session.editingTimezone = true
			ctx.session.timezoneHintMessageId = hint.message_id
			ctx.session.timezoneErrorMessageIds = []
		})
		this.bot.callbackQuery('back_to_settings', async ctx => {
			;(ctx.session as any).editingMainCurrency = false
			ctx.session.editingTimezone = false
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
			if (ctx.session.timezoneHintMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.timezoneHintMessageId)
				} catch {}
				ctx.session.timezoneHintMessageId = undefined
			}
			for (const id of ctx.session.timezoneErrorMessageIds ?? []) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, id)
				} catch {}
			}
			ctx.session.timezoneErrorMessageIds = []
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
			;(ctx.session as any).awaitingDeleteConfirm = true
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
			try {
				await this.usersService.setDefaultAccount(user.id, accountId)
			} catch (e: any) {
				await ctx.reply(e?.message ?? 'Не удалось обновить основной счёт.', {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				return
			}
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
					;(ctx.session as any).awaitingDeleteConfirm = false
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

			if (text === 'На главное меню' || text === '🏠 На главное меню') {
				ctx.session.awaitingTransaction = false
				ctx.session.confirmingTransaction = false
				ctx.session.draftTransactions = undefined
				ctx.session.currentTransactionIndex = undefined
				ctx.session.editingField = undefined
				ctx.session.editMessageId = undefined
				;(ctx.session as any).editingTransactionId = undefined
				await renderHome(ctx, this.accountsService, this.analyticsService)
				return
			}
			if (text === '➕ Добавить транзакцию') {
				const txLimit = await this.subscriptionService.canCreateTransaction(
					ctx.state.user.id
				)
				if (!txLimit.allowed) {
					await ctx.reply(
						'💠 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!',
						{
							reply_markup: new InlineKeyboard()
								.text('💠 Pro-тариф', 'view_premium')
								.row()
								.text('Закрыть', 'hide_message')
						}
					)
					return
				}
				const allAccounts =
					await this.accountsService.getAllByUserIdIncludingHidden(
						ctx.state.user.id
					)
				const realAccounts = allAccounts.filter(
					a => !a.isHidden && a.name !== 'Вне Wallet'
				)
				if (!realAccounts.length) {
					await ctx.reply(
						'Сначала добавьте счёт во вкладке «Счета», затем создайте транзакцию.',
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					return
				}
				ctx.session.editingTimezone = false
				ctx.session.awaitingTagsJarvisEdit = false
				ctx.session.awaitingCategoryName = false
				ctx.session.awaitingAccountInput = false
				ctx.session.awaitingTagInput = false
				ctx.session.editingAccountField = undefined
				;(ctx.session as any).editingMainCurrency = false
				;(ctx.session as any).editingCurrency = false
				ctx.session.confirmingTransaction = false
				ctx.session.draftTransactions = undefined
				ctx.session.currentTransactionIndex = undefined
				ctx.session.awaitingTransaction = true
				const promptText = await buildAddTransactionPrompt(
					ctx as any,
					this.subscriptionService
				)
				const msg = await ctx.reply(promptText, {
					parse_mode: 'HTML',
					reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
				})
				ctx.session.tempMessageId = msg.message_id
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
					const tagHintId = (ctx.session as any).tagInputHintMessageId as
						| number
						| undefined
					if (tagHintId != null) {
						try {
							await ctx.api.deleteMessage(ctx.chat!.id, tagHintId)
						} catch {}
						;(ctx.session as any).tagInputHintMessageId = undefined
					}
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
									current?.direction === 'transfer' &&
										!(current as any)?.tradeType,
									!!(ctx.session as any).editingTransactionId,
									(current as any)?.tradeType
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
							const converted = await this.exchangeService.convert(
								current.amount,
								current.currency,
								codes[0]
							)
							current.convertedAmount =
								converted == null
									? null
									: await this.exchangeService.roundByCurrency(
											converted,
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
									(current as any)?.direction === 'transfer' &&
										!(current as any)?.tradeType,
									!!(ctx.session as any).editingTransactionId,
									(current as any)?.tradeType
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
					const normalizePairCurrency = (token: string): string =>
						({
							ЮСДТ: 'USDT',
							ЮСДЦ: 'USDC',
							ДОЛЛАР: 'USD',
							ЕВРО: 'EUR'
						}[token] ?? token)
					const normalizeCode = (code?: string | null): string =>
						normalizePairCurrency(String(code ?? '').trim().toUpperCase())
					const parsePairInput = (
						input: string,
						supportedCodes: Set<string>
					): { baseCurrency: string; quoteCurrency?: string } | null => {
						const raw = String(input ?? '').trim().toUpperCase()
						if (!raw) return null
						const cleaned = raw.replace(/\s+/g, '')
						if (cleaned.includes('/')) {
							const parts = cleaned.split('/')
							if (parts.length !== 2) return null
							const baseCurrency = normalizePairCurrency(parts[0])
							const quoteCurrency = normalizePairCurrency(parts[1])
							if (
								supportedCodes.has(baseCurrency) &&
								supportedCodes.has(quoteCurrency)
							) {
								return { baseCurrency, quoteCurrency }
							}
							return null
						}
						const direct = normalizePairCurrency(cleaned)
						if (supportedCodes.has(direct)) return { baseCurrency: direct }
						const sorted = Array.from(supportedCodes).sort((a, b) => b.length - a.length)
						for (const quoteCurrency of sorted) {
							if (!cleaned.endsWith(quoteCurrency)) continue
							const baseCurrency = normalizePairCurrency(
								cleaned.slice(0, cleaned.length - quoteCurrency.length)
							)
							if (supportedCodes.has(baseCurrency)) {
								return { baseCurrency, quoteCurrency }
							}
						}
						return null
					}
					const normalizeTradeDescriptionKey = (raw?: string | null): string =>
						String(raw ?? '')
							.toLowerCase()
							.replace(/[^\p{L}\p{N}]+/gu, '')
							.trim()
					const isGenericTradeDescription = (
						raw?: string | null,
						baseCurrency?: string | null,
						quoteCurrency?: string | null
					): boolean => {
						const key = normalizeTradeDescriptionKey(raw)
						if (!key) return true
						const baseKey = normalizeTradeDescriptionKey(baseCurrency)
						const quoteKey = normalizeTradeDescriptionKey(quoteCurrency)
						if (baseKey && key === baseKey) return true
						if (quoteKey && key === quoteKey) return true
						return (
							key === 'ордер' ||
							key === 'order' ||
							key === 'трейд' ||
							key === 'trade' ||
							key === 'покупка' ||
							key === 'продажа' ||
							key === 'transaction' ||
							key === 'транзакция' ||
							key === 'операция'
						)
					}
					const applyTradeCanonicalFromBase = async (params: {
						baseCurrency: string
						quoteCurrency: string
						baseAmount: number
					}): Promise<boolean> => {
						if (!(current as any).tradeType) {
							await ctx.reply('Сделка не определена как покупка/продажа.')
							return false
						}
						const tradeType = (current as any).tradeType as TradeType
						const baseCurrency = normalizeCode(params.baseCurrency)
						const quoteCurrency = normalizeCode(params.quoteCurrency)
						if (!baseCurrency || !quoteCurrency || baseCurrency === quoteCurrency) {
							await ctx.reply('Некорректная пара для пересчёта сделки.')
							return false
						}
						const roundedBaseAmount = await this.exchangeService.roundByCurrency(
							Math.abs(params.baseAmount),
							baseCurrency
						)
						const txDate = normalizeTxDate((current as any).transactionDate)
						let quoteAmount: number | null = null
						if (txDate) {
							const historicalRate = await this.exchangeService.getHistoricalRate(
								txDate,
								baseCurrency,
								quoteCurrency
							)
							if (
								historicalRate != null &&
								Number.isFinite(historicalRate) &&
								historicalRate > 0
							) {
								quoteAmount = roundedBaseAmount * historicalRate
							}
						}
						if (!(quoteAmount != null && quoteAmount > 0)) {
							const converted = await this.exchangeService.convert(
								roundedBaseAmount,
								baseCurrency,
								quoteCurrency
							)
							if (converted != null && Number.isFinite(converted) && converted > 0) {
								quoteAmount = converted
							}
						}
						if (!(quoteAmount != null && quoteAmount > 0)) {
							await ctx.reply(
								'Не удалось пересчитать вторую валюту пары по доступным курсам. Укажите вторую сторону сделки или попробуйте позже.'
							)
							return false
						}
						const roundedQuoteAmount = await this.exchangeService.roundByCurrency(
							quoteAmount,
							quoteCurrency
						)
						if (!(roundedQuoteAmount > 0)) {
							await ctx.reply('Не удалось рассчитать вторую сторону сделки.')
							return false
						}
						const executionPrice = Number(
							(roundedQuoteAmount / roundedBaseAmount).toFixed(12)
						)
						if (!(executionPrice > 0)) {
							await ctx.reply('Не удалось вычислить среднюю цену выполнения.')
							return false
						}
						if (tradeType === 'buy') {
							;(current as any).amount = roundedQuoteAmount
							;(current as any).currency = quoteCurrency
							;(current as any).convertedAmount = roundedBaseAmount
							;(current as any).convertToCurrency = baseCurrency
						} else {
							;(current as any).amount = roundedBaseAmount
							;(current as any).currency = baseCurrency
							;(current as any).convertedAmount = roundedQuoteAmount
							;(current as any).convertToCurrency = quoteCurrency
						}
						;(current as any).tradeBaseCurrency = baseCurrency
						;(current as any).tradeBaseAmount = roundedBaseAmount
						;(current as any).tradeQuoteCurrency = quoteCurrency
						;(current as any).tradeQuoteAmount = roundedQuoteAmount
						;(current as any).executionPrice = executionPrice
						if (
							isGenericTradeDescription(
								(current as any).description,
								baseCurrency,
								quoteCurrency
							)
						) {
							;(current as any).description = 'Ордер'
						}
						const meta: TradeMeta = {
							type: tradeType,
							baseCurrency,
							baseAmount: roundedBaseAmount,
							quoteCurrency,
							quoteAmount: roundedQuoteAmount,
							executionPrice,
							feeCurrency: (current as any).tradeFeeCurrency,
							feeAmount: Number((current as any).tradeFeeAmount ?? 0) || undefined
						}
						;(current as any).rawText = attachTradeMeta(
							stripTradeMeta(String((current as any).rawText ?? '')),
							meta
						)
						return true
					}

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
							if (isNaN(amount) || amount <= 0) {
								await ctx.reply('Некорректная сумма, попробуйте снова')
								return
							}
							if ((current as any).tradeType === 'buy' || (current as any).tradeType === 'sell') {
								const tradeType = (current as any).tradeType as TradeType
								const baseCurrency = normalizeCode(
									(current as any).tradeBaseCurrency ||
										(tradeType === 'buy'
											? (current as any).convertToCurrency
											: (current as any).currency)
								)
								const quoteCurrency = normalizeCode(
									(current as any).tradeQuoteCurrency ||
										(tradeType === 'buy'
											? (current as any).currency
											: (current as any).convertToCurrency)
								)
								const applied = await applyTradeCanonicalFromBase({
									baseCurrency,
									quoteCurrency,
									baseAmount: amount
								})
								if (!applied) return
							} else {
								current.amount = amount
							}
							break
						}

					case 'date': {
						const parsedDate = await this.llmService.parseDate(value)
						if (!parsedDate) {
							await ctx.reply(
								'Не удалось распознать дату, попробуйте ещё раз'
							)
							return
						}
						current.transactionDate = parsedDate.toISOString()
						break
					}

						case 'pair': {
							if (!(current as any).tradeType) {
								await ctx.reply('Пара доступна только для покупки/продажи')
								return
							}
							const known = await this.exchangeService.getKnownCurrencies()
							const supportedCodes = new Set<string>([
								...Array.from(known.fiat),
								...Array.from(known.crypto)
							])
							const parsedPair = parsePairInput(value, supportedCodes)
							if (!parsedPair?.baseCurrency) {
								await ctx.reply(
									'Не удалось распознать пару. Пример: TON/USDT, TONUSDT или TON.'
								)
								return
							}
							let quoteCurrency = normalizeCode(
								parsedPair.quoteCurrency ??
									(current as any).tradeQuoteCurrency ??
									''
							)
							if (
								!quoteCurrency ||
								!supportedCodes.has(quoteCurrency) ||
							quoteCurrency === parsedPair.baseCurrency
						) {
							const userAny = ctx.state.user as any
							const accountId =
								(current as any).accountId ||
								userAny.defaultAccountId ||
								ctx.state.activeAccount?.id
							const account = accountId
								? await this.accountsService.getOneWithAssets(accountId, userAny.id)
								: null
							const hasUsdc =
								(account?.assets ?? []).some(
									a => String(a.currency ?? '').toUpperCase() === 'USDC'
								) ||
								(
									await this.prisma.transaction.count({
										where: {
											userId: userAny.id,
											OR: [
												{ currency: 'USDC' },
												{ convertToCurrency: 'USDC' },
												{ tradeBaseCurrency: 'USDC' },
												{ tradeQuoteCurrency: 'USDC' }
											]
										}
									})
								) > 0
							quoteCurrency = hasUsdc ? 'USDC' : 'USDT'
						}
						if (
							!quoteCurrency ||
							!supportedCodes.has(quoteCurrency) ||
							quoteCurrency === parsedPair.baseCurrency
						) {
							await ctx.reply(
								'Не удалось определить вторую валюту пары. Укажите формат BASE/QUOTE.'
							)
								return
							}
							let baseAmount = Math.abs(
								Number(
									(current as any).tradeBaseAmount ??
										((current as any).tradeType === 'buy'
											? (current as any).convertedAmount
											: (current as any).amount)
								)
							)
							if (!(baseAmount > 0)) {
								await ctx.reply('Не удалось определить количество базового актива.')
								return
							}
							const applied = await applyTradeCanonicalFromBase({
								baseCurrency: parsedPair.baseCurrency,
								quoteCurrency,
								baseAmount
							})
							if (!applied) return
							break
						}

					case 'executionPrice': {
						const normalized = value.replace(/\s/g, '').replace(',', '.')
						const executionPrice = Number(normalized)
						if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
							await ctx.reply('Некорректная цена, попробуйте снова')
							return
						}
						if (!(current as any).tradeType) {
							await ctx.reply('Ср. цена доступна только для покупки/продажи')
							return
						}
						const tradeType = (current as any).tradeType as TradeType
						const baseCurrency = String(
							(current as any).tradeBaseCurrency ||
								(tradeType === 'buy'
									? (current as any).convertToCurrency
									: (current as any).currency) ||
								''
						).toUpperCase()
						const quoteCurrency = String(
							(current as any).tradeQuoteCurrency ||
								(tradeType === 'buy'
									? (current as any).currency
									: (current as any).convertToCurrency) ||
								''
						).toUpperCase()
						const baseAmountRaw =
							tradeType === 'buy'
								? Number((current as any).convertedAmount)
								: Number((current as any).amount)
						if (!Number.isFinite(baseAmountRaw) || baseAmountRaw <= 0) {
							await ctx.reply('Не удалось определить количество базового актива.')
							return
						}
						const baseAmount = Math.abs(baseAmountRaw)
						const quoteAmountRaw = baseAmount * executionPrice
						const quoteAmount = await this.exchangeService.roundByCurrency(
							quoteAmountRaw,
							quoteCurrency
						)
						if (tradeType === 'buy') {
							;(current as any).amount = quoteAmount
							;(current as any).currency = quoteCurrency
							;(current as any).convertedAmount = baseAmount
							;(current as any).convertToCurrency = baseCurrency
						} else {
							;(current as any).amount = baseAmount
							;(current as any).currency = baseCurrency
							;(current as any).convertedAmount = quoteAmount
							;(current as any).convertToCurrency = quoteCurrency
						}
						;(current as any).tradeBaseCurrency = baseCurrency
						;(current as any).tradeBaseAmount = baseAmount
						;(current as any).tradeQuoteCurrency = quoteCurrency
						;(current as any).tradeQuoteAmount = quoteAmount
						;(current as any).executionPrice = executionPrice
						const meta: TradeMeta = {
							type: tradeType,
							baseCurrency,
							baseAmount,
							quoteCurrency,
							quoteAmount,
							executionPrice,
							feeCurrency: (current as any).tradeFeeCurrency,
							feeAmount: Number((current as any).tradeFeeAmount ?? 0) || undefined
						}
							;(current as any).rawText = attachTradeMeta(
								stripTradeMeta(String((current as any).rawText ?? '')),
								meta
							)
							if (
								isGenericTradeDescription(
									(current as any).description,
									baseCurrency,
									quoteCurrency
								)
							) {
								;(current as any).description = 'Ордер'
							}
							break
						}

						case 'tradeFeeAmount': {
							if (!(current as any).tradeType) {
								await ctx.reply('Комиссия доступна только для покупки/продажи')
								return
							}
							const normalized = value.replace(/\s/g, '').replace(',', '.')
							const feeAmount = Number(normalized)
							if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
								await ctx.reply('Некорректная комиссия, попробуйте снова')
								return
							}
							const quoteCurrency = normalizeCode(
								(current as any).tradeQuoteCurrency ||
									((current as any).tradeType === 'buy'
										? (current as any).currency
										: (current as any).convertToCurrency)
							)
							;(current as any).tradeFeeAmount = await this.exchangeService.roundByCurrency(
								Math.abs(feeAmount),
								quoteCurrency || 'USDT'
							)
							if (!(current as any).tradeFeeCurrency) {
								;(current as any).tradeFeeCurrency = quoteCurrency || 'USDT'
							}
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
						tradeType: (current as any).tradeType ?? null,
						tradeBaseCurrency: (current as any).tradeBaseCurrency ?? null,
						tradeBaseAmount: (current as any).tradeBaseAmount ?? null,
							tradeQuoteCurrency: (current as any).tradeQuoteCurrency ?? null,
							tradeQuoteAmount: (current as any).tradeQuoteAmount ?? null,
							executionPrice: (current as any).executionPrice ?? null,
							tradeFeeCurrency: (current as any).tradeFeeCurrency ?? null,
							tradeFeeAmount: (current as any).tradeFeeAmount ?? null,
							categoryId: (current as any).categoryId ?? null,
						category: (current as any).category,
						description: (current as any).description,
						rawText: (current as any).rawText,
						transactionDate:
							normalizeTxDate((current as any).transactionDate) ?? undefined,
						tagId: (current as any).tagId ?? null,
						convertedAmount: (current as any).convertedAmount ?? null,
						convertToCurrency: (current as any).convertToCurrency ?? null,
							fromAccountId:
								(current as any).direction === 'transfer'
									? ((current as any).accountId ?? null)
									: null,
							toAccountId:
								(current as any).toAccountId ??
								((current as any).tradeType &&
								(current as any).direction === 'transfer'
									? ((current as any).accountId ?? null)
									: null)
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
									(current as any)?.direction === 'transfer' &&
										!(current as any)?.tradeType,
									!!(ctx.session as any).editingTransactionId,
									(current as any)?.tradeType
								)
							}
						)
					} catch {}
				}

				return
			}

			if (ctx.session.editingTimezone) {
				const value = text.trim()
				const isUtcOffset = /^[+-]\d{2}:\d{2}$/.test(value)
				const isUtcPrefixOffset = /^UTC[+-]\d{2}:\d{2}$/i.test(value)
				const normalizedOffset = isUtcPrefixOffset
					? value.replace(/^UTC/i, '')
					: value
				let timezoneToSave = value
				try {
					if (isUtcOffset || isUtcPrefixOffset) {
						timezoneToSave = normalizedOffset
					} else {
						new Intl.DateTimeFormat('ru-RU', { timeZone: value }).format(new Date())
						timezoneToSave = value
					}
				} catch {
					const err = await ctx.reply(
						'Неверный часовой пояс. Пример: Europe/Berlin или +03:00',
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					const ids = ctx.session.timezoneErrorMessageIds ?? []
					ids.push(err.message_id)
					ctx.session.timezoneErrorMessageIds = ids
					return
				}
				await (this.prisma as any).user.update({
					where: { id: ctx.state.user.id },
					data: { timezone: timezoneToSave }
				})
				if (ctx.session.timezoneHintMessageId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.timezoneHintMessageId)
					} catch {}
					ctx.session.timezoneHintMessageId = undefined
				}
				for (const id of ctx.session.timezoneErrorMessageIds ?? []) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, id)
					} catch {}
				}
				ctx.session.timezoneErrorMessageIds = []
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				ctx.session.editingTimezone = false
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
				return
			}

			if ((ctx.session as any).editingMainCurrency) {
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
				return
			}

			if (ctx.session.editingAccountDetailsId) {
				const accountId = ctx.session.editingAccountDetailsId
				const editMode = ctx.session.editingAccountField ?? 'jarvis'
				const isNameEdit = editMode === 'name'
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
					const current = {
						name: account.name,
						assets: account.assets.map(a => ({
							currency: a.currency,
							amount: Number(a.amount)
						}))
					}
				let updatedDraft:
					| { name: string; assets: { currency: string; amount: number }[] }
					| undefined
				try {
					if (isNameEdit) {
						let candidateName = text
						try {
							const parsed = await this.llmService.parseAccount(text)
							if (parsed?.[0]?.name) {
								candidateName = parsed[0].name
							}
						} catch {}
						updatedDraft = {
							name: this.normalizeAccountName(candidateName),
							assets: current.assets.map(a => ({
								currency: a.currency,
								amount: a.amount
							}))
						}
					} else {
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
							name: current.name,
							assets: updated.assets.map(a => ({
								currency: a.currency,
								amount: a.amount
							}))
						}
					}
						await this.accountsService.updateAccountWithAssets(
							accountId,
							user.id,
							updatedDraft ?? current
						)
				} catch {
					await ctx.reply(
						'Не удалось применить изменения, попробуйте сформулировать иначе.'
					)
					return
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
									? Number(tx.convertedAmount)
									: Number(tx.amount)
						const cur =
							tx.convertedAmount != null && tx.convertToCurrency
								? tx.convertToCurrency
								: tx.currency
							const amountMain =
								(await this.exchangeService.convert(amt, cur, mainCurrency)) ?? 0
							const tradeType = (tx.tradeType as 'buy' | 'sell' | null) ?? null
							const signed =
								tradeType === 'buy'
									? Math.abs(Number(tx.tradeBaseAmount ?? tx.amount))
									: tradeType === 'sell'
										? -Math.abs(Number(tx.tradeBaseAmount ?? tx.amount))
										: tx.direction === 'expense'
											? -Math.abs(Number(tx.amount))
											: Math.abs(Number(tx.amount))
						lastTransactions.push({
							direction: tx.direction,
							tradeType,
							tradeBaseAmount:
								tx.tradeBaseAmount != null ? Number(tx.tradeBaseAmount) : null,
							tradeBaseCurrency: tx.tradeBaseCurrency ?? null,
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
						analyticsData
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
				if (updatedDraft && !isNameEdit) {
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
							'Создать транзакцию для этого действия?',
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
				ctx.session.editingAccountField = undefined
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
					const parsed = await this.llmService.parseAccount(text)
					if (parsed && parsed.length) {
						drafts[index] = {
							...parsed[0],
							name: current.name
						}
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
					const fromPreviewCategoryCreate = Boolean(
						(ctx.session as any).categoryCreateFromPreview
					)
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
					;(ctx.session as any).categoryCreateFromPreview = false
					if (fromPreviewCategoryCreate && createdName != null) {
						const drafts = ctx.session.draftTransactions
						const index = ctx.session.currentTransactionIndex ?? 0
						const current = drafts?.[index] as any
						if (drafts && current && ctx.session.tempMessageId != null) {
							const selectedCategory = createdName.split(',')[0].trim()
							current.category = selectedCategory || current.category
							if (selectedCategory) {
								const selectedCategoryRow =
									await this.prisma.category.findFirst({
										where: {
											userId: ctx.state.user.id,
											name: selectedCategory
										},
										select: { id: true }
									})
								current.categoryId = selectedCategoryRow?.id
							}
							const txId = current.id ?? ctx.session.editingTransactionId
							if (txId) {
								await this.transactionsService.update(
									txId,
									ctx.state.user.id,
									{
										categoryId: current.categoryId ?? null,
										category: current.category
									}
								)
							}
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
											current?.direction === 'transfer' &&
												!(current as any)?.tradeType,
											!!ctx.session.editingTransactionId,
											(current as any)?.tradeType
										)
									}
								)
							} catch {}
						}
						return
					}
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
				const { categoryNames, existingTags, accountNames, memoryHints } =
					await this.getTransactionParseContext(user.id)
				await this.llmMemoryService.rememberRuleFromText(user.id, text)

				try {
					parsed = await this.llmService.parseTransaction(
						text,
						categoryNames,
						existingTags,
						accountNames,
						memoryHints
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
			parsed = parsed.map(tx => ({
				...tx,
				rawText: text
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

					ctx.session.awaitingAccountInput = false
					ctx.session.confirmingAccounts = true
					ctx.session.draftAccounts = parsed as any
					ctx.session.currentAccountIndex = 0

					await refreshAccountsPreview(ctx as any)
				} catch (e: any) {
					await ctx.reply('Не удалось распознать счёт, попробуйте ещё раз')
				}
				return
			}
		})

		const processImageMessage = async (
			ctx: BotContext,
			params: {
				fileId: string
				fileUniqueId: string
				mimeType: string
				caption?: string
			}
		) => {
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
			const { categoryNames, existingTags, accountNames, memoryHints } =
				await this.getTransactionParseContext(user.id)
			let imageDataUrl: string
			try {
				const buf = await this.downloadTelegramFile(ctx, params.fileId)
				const base64 = buf.toString('base64')
				const safeMime = params.mimeType?.startsWith('image/')
					? params.mimeType
					: 'image/jpeg'
				imageDataUrl = `data:${safeMime};base64,${base64}`
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
			const userCaption = params.caption?.trim() || ''
			if (userCaption) {
				await this.llmMemoryService.rememberRuleFromText(user.id, userCaption)
			}
			let parsed: LlmTransaction[]
			try {
				parsed = await this.llmService.parseTransactionFromImage(
					imageDataUrl,
					categoryNames,
					existingTags,
					accountNames,
					userCaption || undefined,
					memoryHints
				)
			} catch (e: unknown) {
				const err = e instanceof Error ? e : new Error(String(e))
				this.logger.warn(
					`parseTransactionFromImage failed: ${err.message}`,
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
			const parseToken = `PHOTO_PARSE:${new Date().toISOString().slice(0, 7)}:${params.fileUniqueId}`
			parsed = parsed.map(tx => ({
				...tx,
				rawText: userCaption ? `${parseToken} ${userCaption}` : parseToken
			}))
			await this.processParsedTransactions(ctx, parsed)
		}

		this.bot.on('message:photo', async ctx => {
			const photos = ctx.message.photo
			if (!photos?.length) return
			const largest = photos[photos.length - 1]
			await processImageMessage(ctx, {
				fileId: largest.file_id,
				fileUniqueId: largest.file_unique_id,
				mimeType: 'image/jpeg',
				caption: ctx.message.caption
			})
		})

		this.bot.on('message:document', async ctx => {
			const doc = ctx.message.document
			if (!doc?.file_id) return
			if (!String(doc.mime_type ?? '').startsWith('image/')) return
			await processImageMessage(ctx, {
				fileId: doc.file_id,
				fileUniqueId: doc.file_unique_id,
				mimeType: doc.mime_type ?? 'image/jpeg',
				caption: ctx.message.caption
			})
		})

		this.bot.on('message:voice', async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			const voice = ctx.message.voice
			if (!voice?.file_id) return

			// Голосом можно редактировать счёт в Jarvis-режиме.
			if (
				ctx.session.editingAccountField === 'jarvis' &&
				ctx.session.draftAccounts
			) {
				let transcript = ''
				try {
					const audioBuffer = await this.downloadTelegramFile(ctx, voice.file_id)
					transcript = await this.llmService.transcribeVoice(
						audioBuffer,
						voice.mime_type,
						'Транскрибируй финансовые данные счёта максимально точно.'
					)
				} catch {
					await ctx.reply('Не удалось распознать голосовое сообщение, попробуйте ещё раз.')
					return
				}
				if (!transcript) {
					await ctx.reply('Не удалось распознать голосовое сообщение, попробуйте ещё раз.')
					return
				}

				const drafts = ctx.session.draftAccounts
				if (!drafts.length) return
				const index = ctx.session.currentAccountIndex ?? 0
				const current = drafts[index]
				try {
					const parsed = await this.llmService.parseAccount(transcript)
					if (parsed?.length) {
						drafts[index] = {
							...parsed[0],
							name: current.name
						}
					}
				} catch {}

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
				ctx.session.editingAccountField === 'name' &&
				ctx.session.draftAccounts
			) {
				let transcript = ''
				try {
					const audioBuffer = await this.downloadTelegramFile(ctx, voice.file_id)
					transcript = await this.llmService.transcribeVoice(
						audioBuffer,
						voice.mime_type,
						'Транскрибируй новое название финансового счёта пользователя точно.'
					)
				} catch {
					await ctx.reply('Не удалось распознать голосовое сообщение, попробуйте ещё раз.')
					return
				}
				if (!transcript) {
					await ctx.reply('Не удалось распознать голосовое сообщение, попробуйте ещё раз.')
					return
				}
				const drafts = ctx.session.draftAccounts
				if (!drafts.length) return
				const index = ctx.session.currentAccountIndex ?? 0
				const current = drafts[index]
				let nextName = transcript
				try {
					const parsed = await this.llmService.parseAccount(transcript)
					if (parsed?.length && parsed[0]?.name) nextName = parsed[0].name
				} catch {}
				current.name = this.normalizeAccountName(nextName)
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

			if (!ctx.session.awaitingTransaction) return
			const { categoryNames, existingTags, accountNames, memoryHints } =
				await this.getTransactionParseContext(user.id)

			let transcript = ''
			try {
				const audioBuffer = await this.downloadTelegramFile(ctx, voice.file_id)
				transcript = await this.llmService.transcribeVoice(
					audioBuffer,
					voice.mime_type,
					'Транскрибируй финансовую операцию пользователя точно и без сокращений.'
				)
			} catch (e: unknown) {
				const err = e instanceof Error ? e : new Error(String(e))
				this.logger.warn(`voice transcription failed: ${err.message}`, err.stack)
				await ctx.reply(
					'Не удалось распознать голосовое сообщение. Попробуйте ещё раз или отправьте текстом.',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			if (!transcript) {
				await ctx.reply(
					'Не удалось получить текст из голосового сообщения. Попробуйте отправить ещё раз.',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}

			await this.llmMemoryService.rememberRuleFromText(user.id, transcript)
			let parsed: LlmTransaction[]
			try {
				parsed = await this.llmService.parseTransaction(
					transcript,
					categoryNames,
					existingTags,
					accountNames,
					memoryHints
				)
			} catch (e: unknown) {
				const err = e instanceof Error ? e : new Error(String(e))
				this.logger.warn(`parseTransaction (voice) failed: ${err.message}`, err.stack)
				await ctx.reply(
					'Техническая ошибка парсинга (ИИ недоступен или превышен лимит). Обратитесь к разработчику: @sselnorr',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			const parseToken = `VOICE_PARSE:${new Date().toISOString().slice(0, 7)}:${voice.file_unique_id}`
			parsed = parsed.map(tx => ({
				...tx,
				rawText: `${parseToken} ${transcript}`
			}))
			await this.processParsedTransactions(ctx, parsed)
		})

			this.bot.start()
		}

	private async getTransactionParseContext(userId: string): Promise<{
		categoryNames: string[]
		existingTags: string[]
		accountNames: string[]
		memoryHints: string[]
	}> {
		const [userCategories, frozen, userAccounts, memoryHints] = await Promise.all([
			this.categoriesService.getAllByUserId(userId),
			this.subscriptionService.getFrozenItems(userId),
			this.accountsService.getAllByUserIdIncludingHidden(userId),
			this.llmMemoryService.getHints(userId)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const frozenCategoryIds = new Set(frozen.customCategoryIdsOverLimit)
		const frozenTagIds = frozen.customTagIdsOverLimit
		const visibleCategories = userCategories.filter(
			c => !frozenCategoryIds.has(c.id)
		)
		const categoryNames = visibleCategories.map(c => c.name)
		const categoryIdByName = new Map(
			visibleCategories.map(c => [c.name, c.id])
		)
		const existingTags = await this.tagsService.getNamesAndAliases(userId, {
			excludeIds: frozenTagIds
		})
		const visibleAccounts = userAccounts.filter(
			(a: any) => !frozenAccountIds.has(a.id)
		)
		const accountNames = visibleAccounts
			.map((a: any) => a.name)
			.filter((n: string) => n !== 'Вне Wallet')
		return { categoryNames, existingTags, accountNames, memoryHints }
	}

	private normalizeAccountName(value: string): string {
		const cleaned = String(value ?? '')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[.,;:!?]+$/g, '')
		if (!cleaned) return 'Счёт'
		return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
	}

	private async downloadTelegramFile(
		ctx: BotContext,
		fileId: string
	): Promise<Buffer> {
		const file = await ctx.api.getFile(fileId)
		if (!file.file_path) {
			throw new Error('Telegram did not return file_path')
		}
		const token = this.config.getOrThrow<string>('BOT_TOKEN')
		const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
		const res = await fetch(url)
		if (!res.ok) {
			throw new Error(`Failed to download Telegram file: ${res.status}`)
		}
		return Buffer.from(await res.arrayBuffer())
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

		async closeTemp(ctx) {
		if (ctx.session.confirmingTransaction) return
		const tempId = ctx.session.tempMessageId
		if (tempId && tempId !== ctx.session.homeMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, tempId)
			} catch {}
		}
		ctx.session.tempMessageId = undefined
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
		const toPositive = (value: unknown): number | null => {
			const num = Number(value)
			if (!Number.isFinite(num)) return null
			const abs = Math.abs(num)
			return abs > 0 ? abs : null
		}
		const normalizedWithAmount = parsed
			.map(tx => {
				const amount = toPositive((tx as any).amount)
				const tradeBaseAmount = toPositive((tx as any).tradeBaseAmount)
				const tradeQuoteAmount = toPositive((tx as any).tradeQuoteAmount)
				const convertedAmount = toPositive((tx as any).convertedAmount)
				const executionPrice = toPositive((tx as any).executionPrice)
				const tradeType = (tx as any).tradeType as 'buy' | 'sell' | undefined
				const hasAnyAmount =
					amount != null ||
					tradeBaseAmount != null ||
					tradeQuoteAmount != null ||
					convertedAmount != null
				if (!hasAnyAmount) return null
				const normalized: any = { ...tx }
				if (amount != null) {
					normalized.amount = amount
				} else if (tradeType === 'buy') {
					normalized.amount =
						tradeQuoteAmount ??
						(tradeBaseAmount != null && executionPrice != null
							? tradeBaseAmount * executionPrice
							: undefined)
				} else if (tradeType === 'sell') {
					normalized.amount =
						tradeBaseAmount ??
						(convertedAmount != null && executionPrice != null && executionPrice > 0
							? convertedAmount / executionPrice
							: undefined)
				}
				return normalized
			})
			.filter(Boolean) as LlmTransaction[]
		if (!normalizedWithAmount.length) {
			await ctx.reply(
				'Не удалось извлечь сумму операции ни из текста, ни со скриншота. Укажите сумму в сообщении и попробуйте снова.',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				}
			)
			return
		}
		parsed = normalizedWithAmount

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
			const categoryIdByName = new Map(
				visibleCategories.map(c => [c.name, c.id])
			)
				const existingTags = await this.tagsService.getNamesAndAliases(user.id, {
					excludeIds: frozenTagIds
				})
			const outsideWalletAccount = userAccounts.find(
				(a: any) => a.name === 'Вне Wallet'
			)
			const outsideWalletId = outsideWalletAccount?.id ?? null
			const visibleUserAccounts = userAccounts.filter(
				(a: any) => !a.isHidden && a.name !== 'Вне Wallet'
			)
			if (!visibleUserAccounts.length) {
				await ctx.reply(
					'Сначала добавьте счёт во вкладке «Счета», затем создайте транзакцию.',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			const defaultAccountId =
				visibleUserAccounts.find(
					(a: any) => a.id === user.defaultAccountId
				)?.id ??
				visibleUserAccounts.find(
					(a: any) => a.id === ctx.state.activeAccount?.id
				)?.id ?? visibleUserAccounts[0]?.id ?? null
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
			налик: 'Наличные',
			наличные: 'Наличные',
			cash: 'Наличные',
			кэш: 'Наличные',
			байбит: 'Bybit',
			байбита: 'Bybit',
			байбите: 'Bybit',
			bybit: 'Bybit',
			bybita: 'Bybit',
			моно: 'Monobank',
			monobank: 'Monobank',
			мех: 'MEXC',
			mexc: 'MEXC'
		}

		const normalizeAccountAlias = (value?: string | null): string => {
			const raw = String(value ?? '').trim()
			if (!raw) return ''
			const lower = raw.toLowerCase()
			return accountAliasMap[lower] ?? raw
		}

		const normalizeCurrencyAlias = (value?: string | null): string => {
			const raw = String(value ?? '').trim().toUpperCase()
			const map: Record<string, string> = {
				USDT: 'USDT',
				'ЮСДТ': 'USDT',
				'USDT.T': 'USDT',
				USDC: 'USDC',
				'ЮСДЦ': 'USDC',
				USD: 'USD',
				'ДОЛЛАР': 'USD',
				EUR: 'EUR',
				'ЕВРО': 'EUR'
			}
			return map[raw] ?? raw
		}

		const parseQuoteCurrencyHint = (text: string): string | null => {
			const lowered = String(text ?? '').toLowerCase()
			const m = lowered.match(
				/\b(?:с|за|в|to|for|from)\s+(usdt|юсдт|usdc|юсдц|usd|доллар|eur|евро)\b/iu
			)
			if (!m) return null
			return normalizeCurrencyAlias(m[1])
		}

		const parseTradeFeeHint = (
			text: string,
			fallbackCurrency?: string | null
		): { amount: number; currency: string } | null => {
			const source = String(text ?? '')
			const patterns = [
				/(?:торговая\s+комиссия|комиссия|fee)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?)\s*([a-zа-я]{2,10})?/iu,
				/([0-9]+(?:[.,][0-9]+)?)\s*([a-zа-я]{2,10})\s*(?:торговая\s+комиссия|комиссия|fee)/iu
			]
			for (const pattern of patterns) {
				const m = source.match(pattern)
				if (!m) continue
				const amount = Number(String(m[1]).replace(',', '.'))
				if (!Number.isFinite(amount) || amount <= 0) continue
				const normalizedCurrency = normalizeCurrencyAlias(
					String(m[2] ?? fallbackCurrency ?? '')
				).toUpperCase()
				if (!normalizedCurrency) continue
				return { amount, currency: normalizedCurrency }
			}
			return null
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

		const normalizeForSearch = (value?: string | null): string =>
			String(value ?? '')
				.toLowerCase()
				.replace(/ё/g, 'е')
				.replace(/\s+/g, ' ')
				.trim()

		const escapeRegex = (value: string): string =>
			value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

		const isExplicitAccountMention = (
			sourceText: string,
			accountCandidate?: string | null
		): boolean => {
			const text = normalizeForSearch(sourceText)
			const candidate = normalizeForSearch(accountCandidate)
			if (!text || !candidate) return false
			const normalizedCandidate = normalizeAccountAlias(candidate).toLowerCase()
			const forms = new Set<string>([
				candidate,
				normalizedCandidate
			])
			for (const part of normalizedCandidate.split(/\s+/)) {
				if (part.length >= 3) forms.add(part)
			}
			for (const form of forms) {
				const term = normalizeForSearch(form)
				if (!term || term.length < 3) continue
				const safe = escapeRegex(term)
				const withPrep = new RegExp(
					`(?:^|[^\\p{L}\\p{N}])(?:с|со|из|на|в|для|from|to|into|onto)\\s+${safe}(?:[^\\p{L}\\p{N}]|$)`,
					'iu'
				)
				const withAccountWord = new RegExp(
					`(?:^|[^\\p{L}\\p{N}])(?:счет|счёт|аккаунт|кошелек|кошел[её]к|bank|wallet)\\s+${safe}(?:[^\\p{L}\\p{N}]|$)`,
					'iu'
				)
				if (withPrep.test(text) || withAccountWord.test(text)) {
					return true
				}
			}
			return false
		}

		const findLooseMentionedAccount = (
			sourceText: string
		): { id: string; name: string } | null => {
			const text = normalizeForSearch(sourceText)
			if (!text) return null
			const asWords = ` ${text} `
			for (const acc of userAccounts as any[]) {
				if (acc.name === 'Вне Wallet' || acc.isHidden) continue
				const accountNorm = normalizeForSearch(acc.name)
				if (!accountNorm || accountNorm.length < 3) continue
				if (asWords.includes(` ${accountNorm} `)) {
					return { id: acc.id, name: acc.name }
				}
			}
			for (const [alias, canonical] of Object.entries(accountAliasMap)) {
				const aliasNorm = normalizeForSearch(alias)
				if (!aliasNorm || aliasNorm.length < 3) continue
				if (!asWords.includes(` ${aliasNorm} `)) continue
				const matched = matchAccountByName(canonical)
				if (matched) return matched
			}
			return null
		}

		const normalizeDescriptionKey = (value?: string | null): string =>
			String(value ?? '')
				.toLowerCase()
				.replace(/[^\p{L}\p{N}]+/gu, '')
				.trim()

		const isGenericDescription = (value?: string | null): boolean => {
			const key = normalizeDescriptionKey(value)
			return (
				!key ||
				key === 'перевод' ||
				key === 'transfer' ||
				key === 'транзакция' ||
				key === 'transaction' ||
				key === 'операция' ||
				key === 'доход' ||
				key === 'income' ||
				key === 'расход' ||
				key === 'expense' ||
				key === 'платеж' ||
				key === 'payment'
			)
		}

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

		const deriveDescriptionFallback = (tx: any): string | null => {
			const raw = String(tx.rawText ?? '')
				.replace(/\b(?:PHOTO_PARSE|VOICE_PARSE):\S+/g, ' ')
				.trim()
			const source = `${raw} ${String(tx.description ?? '')}`
			const cleaned = source
				.replace(/[+-]?\d+(?:[.,]\d+)?/g, ' ')
				.replace(
					/\b(?:usd|eur|uah|rub|руб|грн|usdt|usdc|btc|eth|bnb|sol|xrp|ada|doge)\b/giu,
					' '
				)
				.replace(
					/\b(?:доход|расход|перевод|транзакция|операция|платеж|купил|купила|купили|оплата|списание|получил|получила|получено|send|sent|receive|received|income|expense|from|to|на|в|из|с|за|для)\b/giu,
					' '
				)
				.replace(/[^\p{L}\p{N}\s]/gu, ' ')
				.replace(/\s+/g, ' ')
				.trim()
			const stopwords = new Set([
				'и',
				'или',
				'это',
				'мой',
				'моя',
				'мою',
				'мои',
				'the',
				'a',
				'an',
				'of',
				'for'
			])
			const normalizedTokens = cleaned
				.split(' ')
				.map(t => t.trim())
				.filter(t => t.length >= 2 && !stopwords.has(t.toLowerCase()))
			let candidate =
				normalizedTokens.length > 0
					? normalizedTokens.slice(0, 2).join(' ')
					: ''
			if (!candidate && tx.category && tx.category !== '📦Другое') {
				candidate = String(tx.category)
					.replace(/[^\p{L}\p{N}\s]/gu, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.split(' ')
					.slice(0, 2)
					.join(' ')
			}
			if (!candidate) return null
			const normalizedCandidate =
				candidate.charAt(0).toUpperCase() + candidate.slice(1)
			if (isGenericDescription(normalizedCandidate)) return null
			return normalizedCandidate
		}

		const normalizeForCategoryMatch = (value?: string | null): string =>
			String(value ?? '')
				.toLowerCase()
				.replace(/ё/g, 'е')
				.replace(/[^\p{L}\p{N}\s]/gu, ' ')
				.replace(/\s+/g, ' ')
				.trim()

		const hasAnyToken = (source: string, tokens: string[]): boolean =>
			tokens.some(token => source.includes(token))

		const pickSpecializedFoodCategory = (
			sourceText: string,
			currentCategory?: string | null
		): string | null => {
			const normalizedSource = normalizeForCategoryMatch(sourceText)
			if (!normalizedSource) return null
			const coffeeAndCafeContextTokens = [
				'кофе',
				'капучино',
				'латте',
				'эспрессо',
				'американо',
				'coffee',
				'cappuccino',
				'latte',
				'espresso'
			]
			if (!hasAnyToken(normalizedSource, coffeeAndCafeContextTokens)) {
				return null
			}
			const specializedCategoryTokens = [
				'каф',
				'ресторан',
				'coffee',
				'cafe',
				'bar',
				'bistro'
			]
			const broadFoodTokens = ['еда', 'напит', 'продукт', 'food', 'grocery']
			const candidates = categoryNames.filter(name => {
				const norm = normalizeForCategoryMatch(name)
				return hasAnyToken(norm, specializedCategoryTokens)
			})
			if (!candidates.length) return null
			const normalizedCurrent = normalizeForCategoryMatch(currentCategory)
			if (
				normalizedCurrent &&
				hasAnyToken(normalizedCurrent, specializedCategoryTokens)
			) {
				return null
			}
			const currentLooksBroad =
				!normalizedCurrent || hasAnyToken(normalizedCurrent, broadFoodTokens)
			if (!currentLooksBroad) return null
			candidates.sort((a, b) => {
				const al = normalizeForCategoryMatch(a).length
				const bl = normalizeForCategoryMatch(b).length
				return bl - al
			})
			return candidates[0] ?? null
		}

		const hasDigitalPaymentCue = (sourceText: string): boolean =>
			/\b(telegram|tg|звезд|звёзд|stars|подписк|premium|донат|donat|donate|service|услуг|vpn|hosting|domain|icloud|youtube|spotify|netflix)\b/iu.test(
				sourceText
			)

		const pickDigitalPaymentCategory = (
			sourceText: string,
			currentCategory?: string | null
		): string | null => {
			const normalizedSource = normalizeForCategoryMatch(sourceText)
			if (!normalizedSource || !hasDigitalPaymentCue(normalizedSource)) return null
			const current = normalizeForCategoryMatch(currentCategory)
			if (current.includes('платеж') || current.includes('платёж')) {
				return null
			}
			const paymentCandidates = categoryNames.filter(name => {
				const norm = normalizeForCategoryMatch(name)
				return norm.includes('платеж') || norm.includes('платёж')
			})
			if (!paymentCandidates.length) return '📦Другое'
			paymentCandidates.sort((a, b) => {
				const an = normalizeForCategoryMatch(a)
				const bn = normalizeForCategoryMatch(b)
				const aExact = an === 'платежи' || an === 'платеж'
				const bExact = bn === 'платежи' || bn === 'платеж'
				if (aExact && !bExact) return -1
				if (bExact && !aExact) return 1
				return an.length - bn.length
			})
			return paymentCandidates[0] ?? '📦Другое'
		}

		const hasTradeExecutionCue = (sourceText: string): boolean =>
			/\b(order|ордер|исполн|pair|пара|тейкер|мейкер|спот|фьючерс|futures?)\b/iu.test(
				sourceText
			)

		const extractTransferCounterparty = (value?: string | null): string | null => {
			const text = String(value ?? '').replace(/\s+/g, ' ').trim()
			if (!text) return null
			const normalizeCandidate = (candidate: string): string | null => {
				const cleaned = candidate
					.replace(
						/^(?:кому|для|на|в|к|to|for|на счет|на сч[её]т|счет|сч[её]т)\s+/iu,
						''
					)
					.replace(/[.,;:!?]+$/g, '')
					.replace(/\s+/g, ' ')
					.trim()
				if (!cleaned) return null
				const tokens = cleaned.split(' ').slice(0, 2)
				return tokens.join(' ')
			}
			const verbMatch = text.match(
				/(?:перевод|отправил|перев[её]л|перекинул|скинул)\s+([^\d,+\-()]{2,40}?)(?=\s+\d|$|\s+(?:евро|eur|usd|usdt|rub|руб|грн|uah|btc|eth)\b)/iu
			)
			if (verbMatch) {
				const candidate = normalizeCandidate(verbMatch[1])
				if (candidate) return candidate.toLowerCase()
			}
			const toMatch = text.match(
				/\b(?:кому|для|to)\s+([^\d,+\-()]{2,40}?)(?=\s+\d|$|\s+(?:евро|eur|usd|usdt|rub|руб|грн|uah|btc|eth)\b)/iu
			)
			if (toMatch) {
				const candidate = normalizeCandidate(toMatch[1])
				if (candidate) return candidate.toLowerCase()
			}
			const dativeMatch = text.match(
				/\b(бате|папе|маме|брату|сестре|жене|мужу|сыну|дочери|дочке|другу|подруге)\b/iu
			)
			if (dativeMatch) return dativeMatch[1].toLowerCase()
			const dativeNameMatch = text.match(
				/\b(?:перевод|перев[её]л|отправил|перекинул|скинул)\s+([а-яёa-z][а-яёa-z'-]{2,})\b/iu
			)
			if (dativeNameMatch) {
				const candidate = normalizeCandidate(dativeNameMatch[1])
				if (candidate) return candidate.toLowerCase()
			}
			return null
		}

		const shouldIgnoreLlmDateFromAmount = (
			rawText: string,
			txLike: any,
			llmDate?: string | null
		): boolean => {
			if (!llmDate) return false
			const dt = normalizeTxDate(llmDate)
			if (!dt) return false
			const text = stripParseMarkers(String(rawText ?? ''))
			if (!text.trim()) return false
			if (extractExplicitDateFromText(text)) return false
			const parseDayMonth = (
				token: string
			): { day: number; month: number } | null => {
				const m = String(token ?? '').match(/^(\d{1,3})[.,](\d{1,8})$/)
				if (!m) return null
				const day = Number(m[1])
				const month = Number(m[2])
				if (!Number.isFinite(day) || !Number.isFinite(month)) return null
				if (day < 1 || day > 31 || month < 1 || month > 12) return null
				return { day, month }
			}
			const parsedTokens: Array<{ day: number; month: number }> = []
			const amountWithCurrency = /(\d{1,3}[.,]\d{1,8})\s*(?:[a-zа-я]{2,12}|[$€₴₽])/giu
			const currencyWithAmount = /(?:[a-zа-я]{2,12}|[$€₴₽])\s*(\d{1,3}[.,]\d{1,8})/giu
			for (const m of text.matchAll(amountWithCurrency)) {
				const parsed = parseDayMonth(m[1] ?? '')
				if (parsed) parsedTokens.push(parsed)
			}
			for (const m of text.matchAll(currencyWithAmount)) {
				const parsed = parseDayMonth(m[1] ?? '')
				if (parsed) parsedTokens.push(parsed)
			}
			const numericCandidates = [
				Number(txLike?.amount ?? NaN),
				Number(txLike?.tradeBaseAmount ?? NaN),
				Number(txLike?.tradeQuoteAmount ?? NaN),
				Number(txLike?.convertedAmount ?? NaN)
			]
			for (const candidate of numericCandidates) {
				if (!Number.isFinite(candidate) || candidate <= 0) continue
				const raw = Math.abs(candidate).toString()
				if (!raw.includes('.') || raw.includes('e')) continue
				const parsed = parseDayMonth(raw)
				if (parsed) parsedTokens.push(parsed)
			}
			if (!parsedTokens.length) return false
			const llmDay = dt.getDate()
			const llmMonth = dt.getMonth() + 1
			return parsedTokens.some(p => p.day === llmDay && p.month === llmMonth)
		}

		const stripParseMarkers = (value?: string | null): string =>
			String(value ?? '')
				.replace(/\b(?:PHOTO_PARSE|VOICE_PARSE):\S+/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()

		const hasTradeBuyVerb = (text: string): boolean =>
			/\b(купил|купила|купили|покупка|buy|bought|лонг|докупил|докупка)\b/iu.test(
				text
			)

		const hasTradeSellVerb = (text: string): boolean =>
			/\b(продал|продала|продали|продажа|sell|sold|шорт|закрыл)\b/iu.test(text)

		const hasCryptoCue = (text: string): boolean =>
			/\b(btc|eth|usdt|usdc|bnb|sol|xrp|ada|doge|ton|trx|ltc|xmr|dot|matic|avax|atom|link|uni|arb|op)\b/iu.test(
				text
			) || /\b(крипт|бирж|спот|фьючерс|фьюч|token|coin)\b/iu.test(text)

		const getAccountAssetAmount = (account: any, currency: string): number => {
			const target = String(currency ?? '').toUpperCase()
			if (!target) return 0
			const asset = (account?.assets ?? []).find(
				(a: any) => String(a.currency ?? '').toUpperCase() === target
			)
			const amount = Number(asset?.amount ?? 0)
			return Number.isFinite(amount) ? amount : 0
		}

		const accountHasAsset = (account: any, currency: string): boolean =>
			getAccountAssetAmount(account, currency) !== 0 ||
			(account?.assets ?? []).some(
				(a: any) => String(a.currency ?? '').toUpperCase() === String(currency ?? '').toUpperCase()
			)

		const hasPairLikeCue = (sourceText: string, currencyHint?: string | null): boolean => {
			const text = `${String(sourceText ?? '')} ${String(currencyHint ?? '')}`.toUpperCase()
			return (
				/\b[A-Z]{2,12}\s*\/\s*[A-Z]{2,12}\b/.test(text) ||
				/\b[A-Z]{2,12}(USDT|USDC|USD|EUR|BTC|ETH|BNB|TON)\b/.test(text)
			)
		}

		const parsePairToken = (
			token: string,
			knownCodes: Set<string>
		): { baseCurrency: string; quoteCurrency: string } | null => {
			const raw = String(token ?? '').trim().toUpperCase()
			if (!raw) return null
			if (raw.includes('/')) {
				const parts = raw.split('/')
				if (parts.length !== 2) return null
				const baseCurrency = normalizeCurrencyAlias(parts[0]).toUpperCase()
				const quoteCurrency = normalizeCurrencyAlias(parts[1]).toUpperCase()
				if (
					baseCurrency &&
					quoteCurrency &&
					knownCodes.has(baseCurrency) &&
					knownCodes.has(quoteCurrency)
				) {
					return { baseCurrency, quoteCurrency }
				}
				return null
			}
			const compact = raw.replace(/[^A-ZА-ЯЁ0-9]/g, '')
			if (!compact) return null
			const sortedCodes = Array.from(knownCodes).sort((a, b) => b.length - a.length)
			for (const quoteCurrency of sortedCodes) {
				if (!compact.endsWith(quoteCurrency)) continue
				const baseCurrency = compact.slice(0, compact.length - quoteCurrency.length)
				if (!baseCurrency) continue
				if (knownCodes.has(baseCurrency)) {
					return { baseCurrency, quoteCurrency }
				}
			}
			return null
		}

		const parsePairFromText = (
			text: string,
			knownCodes: Set<string>
		): { baseCurrency: string; quoteCurrency: string } | null => {
			const source = String(text ?? '').toUpperCase()
			const slashMatch = source.match(/\b([A-ZА-ЯЁ]{2,12})\s*\/\s*([A-ZА-ЯЁ]{2,12})\b/u)
			if (slashMatch) {
				const parsed = parsePairToken(`${slashMatch[1]}/${slashMatch[2]}`, knownCodes)
				if (parsed) return parsed
			}
			const compactTokens = source.match(/\b[A-Z]{5,20}\b/g) ?? []
			for (const token of compactTokens) {
				const parsed = parsePairToken(token, knownCodes)
				if (parsed) return parsed
			}
			return null
		}

		const extractAmountByCurrency = (
			text: string,
			currency: string
		): number | null => {
			const cur = String(currency ?? '').toUpperCase()
			if (!cur) return null
			const source = String(text ?? '')
			const escaped = escapeRegex(cur)
			const pattern = new RegExp(
				`([0-9]+(?:[.,][0-9]+)?)\\s*${escaped}\\b|\\b${escaped}\\s*([0-9]+(?:[.,][0-9]+)?)`,
				'iu'
			)
			const m = source.match(pattern)
			if (!m) return null
			const raw = m[1] ?? m[2]
			const num = Number(String(raw).replace(',', '.'))
			if (!Number.isFinite(num) || num <= 0) return null
			return Math.abs(num)
		}

		const pickPreferredQuoteCurrency = (
			accountLike?: { assets?: Array<{ currency?: string }> } | null,
			hadUsdcHistory: boolean = false
		): string | null => {
			const accountCodes = new Set(
				(accountLike?.assets ?? [])
					.map(a => String(a.currency ?? '').toUpperCase())
					.filter(Boolean)
			)
			if (accountCodes.has('USDC')) return 'USDC'
			if (hadUsdcHistory) return 'USDC'
			if (accountCodes.has('USDT')) return 'USDT'
			if (accountCodes.has('USD')) return 'USD'
			if (accountCodes.has('EUR')) return 'EUR'
			return null
		}

		const deriveTradeIntent = (
			tx: any
		): { type: TradeType; sourceText: string } | null => {
			const sourceText = stripParseMarkers(`${tx.rawText ?? ''} ${tx.description ?? ''}`).toLowerCase()
			if (!sourceText) return null
			const pairCue = hasPairLikeCue(sourceText, String(tx.currency ?? ''))
			const explicitTradeFields =
				!!tx.tradeBaseCurrency ||
				!!tx.tradeQuoteCurrency ||
				Number(tx.tradeBaseAmount ?? 0) > 0 ||
				Number(tx.tradeQuoteAmount ?? 0) > 0 ||
				Number(tx.executionPrice ?? 0) > 0
			const tradeExecutionCue = hasTradeExecutionCue(sourceText)
			const digitalPaymentCue = hasDigitalPaymentCue(sourceText)
			if (
				digitalPaymentCue &&
				!pairCue &&
				!explicitTradeFields &&
				!tradeExecutionCue
			) {
				return null
			}
			const explicit = (tx.tradeType as TradeType | undefined) ?? undefined
			if (explicit === 'buy' || explicit === 'sell') {
				return { type: explicit, sourceText }
			}
			const buy = hasTradeBuyVerb(sourceText)
			const sell = hasTradeSellVerb(sourceText)
			if (!buy && !sell) {
				return null
			}
			const cryptoCue =
				hasCryptoCue(sourceText) ||
				isCryptoCurrency(
					normalizeCurrencyAlias(String(tx.currency ?? '')).toUpperCase()
				)
			if (!pairCue && !explicitTradeFields && !tradeExecutionCue && !cryptoCue) {
				return null
			}
			if (buy && !sell) return { type: 'buy', sourceText }
			if (sell && !buy) return { type: 'sell', sourceText }
			return null
		}

		const resolveTradeQuoteAmount = async (
			baseAmount: number,
			baseCurrency: string,
			quoteCurrency: string,
			txDate?: string | null
		): Promise<number | null> => {
			const absBase = Math.abs(baseAmount)
			if (!(absBase > 0)) return null
			const from = String(baseCurrency ?? '').toUpperCase()
			const to = String(quoteCurrency ?? '').toUpperCase()
			if (!from || !to) return null
			if (from === to) return absBase
			let converted: number | null = null
			const date = normalizeTxDate(txDate)
			if (date) {
				const historicalRate = await this.exchangeService.getHistoricalRate(
					date,
					from,
					to
				)
				if (historicalRate != null && Number.isFinite(historicalRate) && historicalRate > 0) {
					converted = absBase * historicalRate
				}
			}
			if (converted == null) {
				converted = await this.exchangeService.convert(absBase, from, to)
			}
			if (converted == null) return null
			return this.exchangeService.roundByCurrency(converted, to)
		}

		const toExecutionPrice = async (
			quoteAmount: number,
			baseAmount: number,
			_quoteCurrency: string
		): Promise<number> => {
			const base = Math.abs(baseAmount)
			if (!(base > 0)) return 0
			const raw = Math.abs(quoteAmount) / base
			return Number(raw.toFixed(8))
		}

		const merged = new Map<string, any>()
		for (const tx of parsed as any[]) {
			const direction = tx.direction
			const llmDateCandidate = shouldIgnoreLlmDateFromAmount(
				String(tx.rawText ?? ''),
				tx,
				tx.transactionDate
			)
				? null
				: tx.transactionDate
			const preferLlmDate = /\bPHOTO_PARSE:\S+/u.test(String(tx.rawText ?? ''))
			const chosenDate = pickTransactionDate({
				userText: tx.rawText ?? '',
				llmDate: llmDateCandidate,
				preferLlmDate
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
			const tradeLike = deriveTradeIntent(tx)
			if (
				tradeLike ||
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
		const hadUsdcHistory = recentTx.some(t => {
			const candidates = [
				String((t as any).currency ?? '').toUpperCase(),
				String((t as any).convertToCurrency ?? '').toUpperCase(),
				String((t as any).tradeQuoteCurrency ?? '').toUpperCase(),
				String((t as any).tradeBaseCurrency ?? '').toUpperCase()
			]
			return candidates.includes('USDC')
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

		const normalizeTradeFields = async (
			tx: any,
			tradeIntent: { type: TradeType; sourceText: string }
		): Promise<boolean> => {
			const sourceText = stripParseMarkers(
				`${tx.rawText ?? ''} ${tx.description ?? ''}`
			)
			const explicitBaseCurrency = normalizeCurrencyAlias(
				String(tx.tradeBaseCurrency ?? '')
			).toUpperCase()
			const explicitQuoteCurrency = normalizeCurrencyAlias(
				String(tx.tradeQuoteCurrency ?? '')
			).toUpperCase()
			const pairFromCurrency = parsePairToken(String(tx.currency ?? ''), supportedCurrencies)
			const pairFromText = parsePairFromText(sourceText, supportedCurrencies)
			const baseCurrency =
				explicitBaseCurrency ||
				pairFromCurrency?.baseCurrency ||
				pairFromText?.baseCurrency ||
				normalizeCurrencyAlias(String(tx.currency ?? '')).toUpperCase()
			if (!baseCurrency || !supportedCurrencies.has(baseCurrency)) {
				tx.__tradeError =
					'Не удалось определить базовый актив и его количество для покупки/продажи. Укажите, что и в каком количестве купили/продали.'
				return false
			}
			const accountHintId =
				matchAccountByName(tx.account || tx.fromAccount || '')?.id ??
				findLooseMentionedAccount(sourceText)?.id ??
				null
			const accountForQuote =
				(accountHintId &&
					visibleAccountsWithAssets.find((a: any) => a.id === accountHintId)) ||
				defaultAccount
			let quoteCurrency =
				explicitQuoteCurrency ||
				pairFromCurrency?.quoteCurrency ||
				pairFromText?.quoteCurrency ||
				normalizeCurrencyAlias(
					tx.convertToCurrency ?? parseQuoteCurrencyHint(tradeIntent.sourceText) ?? ''
				).toUpperCase()
			if (
				!quoteCurrency ||
				!supportedCurrencies.has(quoteCurrency) ||
				quoteCurrency === baseCurrency
			) {
				quoteCurrency = (
					pickPreferredQuoteCurrency(accountForQuote as any, hadUsdcHistory) ||
					'USDT'
				).toUpperCase()
			}
			if (
				!quoteCurrency ||
				!supportedCurrencies.has(quoteCurrency) ||
				quoteCurrency === baseCurrency
			) {
				const fallbackQuote = ['USDT', 'USDC', 'USD', 'EUR'].find(
					code => supportedCurrencies.has(code) && code !== baseCurrency
				)
				quoteCurrency = fallbackQuote ?? ''
			}
			if (tradeIntent.type === 'buy' && quoteCurrency) {
				const hasQuoteAsset = (visibleAccountsWithAssets as any[]).some(
					acc => acc.name !== 'Вне Wallet' && accountHasAsset(acc, quoteCurrency)
				)
				if (!hasQuoteAsset) {
					const alternativeQuote = ['USDC', 'USDT', 'USD', 'EUR'].find(
						code =>
							code !== baseCurrency &&
							supportedCurrencies.has(code) &&
							(visibleAccountsWithAssets as any[]).some(
								acc => acc.name !== 'Вне Wallet' && accountHasAsset(acc, code)
							)
					)
					if (alternativeQuote) {
						quoteCurrency = alternativeQuote
					}
				}
			}
			if (
				!quoteCurrency ||
				!supportedCurrencies.has(quoteCurrency) ||
				quoteCurrency === baseCurrency
			) {
				tx.__tradeError =
					'Не удалось определить вторую валюту пары. Укажите пару в формате BASE/QUOTE (например TON/USDT).'
				return false
			}

			let baseAmount = Math.abs(Number(tx.tradeBaseAmount ?? 0))
			if (!(baseAmount > 0)) {
				const amount = Math.abs(Number(tx.amount ?? 0))
				const convertedAmount = Math.abs(Number(tx.convertedAmount ?? 0))
				const amountCurrency = normalizeCurrencyAlias(String(tx.currency ?? '')).toUpperCase()
				const convertedCurrency = normalizeCurrencyAlias(
					String(tx.convertToCurrency ?? '')
				).toUpperCase()
				if (amount > 0 && amountCurrency === baseCurrency) baseAmount = amount
				else if (convertedAmount > 0 && convertedCurrency === baseCurrency) {
					baseAmount = convertedAmount
				} else if (tradeIntent.type === 'sell' && amount > 0 && !amountCurrency) {
					baseAmount = amount
				}
			}
			if (!(baseAmount > 0)) {
				baseAmount = extractAmountByCurrency(sourceText, baseCurrency) ?? 0
			}
			if (!(baseAmount > 0)) {
				tx.__tradeError =
					'Не удалось определить базовый актив и его количество для покупки/продажи. Укажите, что и в каком количестве купили/продали.'
				return false
			}
			baseAmount = await this.exchangeService.roundByCurrency(baseAmount, baseCurrency)

			let quoteAmount = Math.abs(Number(tx.tradeQuoteAmount ?? 0))
			if (!(quoteAmount > 0)) {
				const amount = Math.abs(Number(tx.amount ?? 0))
				const convertedAmount = Math.abs(Number(tx.convertedAmount ?? 0))
				const amountCurrency = normalizeCurrencyAlias(String(tx.currency ?? '')).toUpperCase()
				const convertedCurrency = normalizeCurrencyAlias(
					String(tx.convertToCurrency ?? '')
				).toUpperCase()
				if (amount > 0 && amountCurrency === quoteCurrency) quoteAmount = amount
				else if (convertedAmount > 0 && convertedCurrency === quoteCurrency) {
					quoteAmount = convertedAmount
				}
			}
			if (!(quoteAmount > 0)) {
				quoteAmount = extractAmountByCurrency(sourceText, quoteCurrency) ?? 0
			}
			const explicitExecutionPrice = Number(tx.executionPrice ?? 0)
			if (!(quoteAmount > 0) && explicitExecutionPrice > 0) {
				quoteAmount = await this.exchangeService.roundByCurrency(
					baseAmount * explicitExecutionPrice,
					quoteCurrency
				)
			}
			if (!(quoteAmount > 0)) {
				quoteAmount =
					(await resolveTradeQuoteAmount(
						baseAmount,
						baseCurrency,
						quoteCurrency,
						tx.transactionDate
					)) ?? 0
			}
			const executionPrice =
				explicitExecutionPrice > 0
					? explicitExecutionPrice
					: await toExecutionPrice(quoteAmount, baseAmount, quoteCurrency)
			if (!(quoteAmount > 0) || !(executionPrice > 0)) {
				tx.__tradeError =
					`Не удалось рассчитать ${tradeIntent.type === 'buy' ? 'покупку' : 'продажу'} ${baseCurrency}. ` +
					'Укажите сумму во второй валюте (например, USDT/USDC) или среднюю цену выполнения.'
				return false
			}
			quoteAmount = await this.exchangeService.roundByCurrency(quoteAmount, quoteCurrency)

			const explicitFeeAmount = Math.abs(Number(tx.tradeFeeAmount ?? 0))
			const explicitFeeCurrency = normalizeCurrencyAlias(
				String(tx.tradeFeeCurrency ?? '')
			).toUpperCase()
			const feeFromText = parseTradeFeeHint(
				`${tx.rawText ?? ''} ${tx.description ?? ''}`,
				quoteCurrency
			)
			const resolvedFeeAmount =
				explicitFeeAmount > 0 ? explicitFeeAmount : feeFromText?.amount ?? 0
			let resolvedFeeCurrency =
				explicitFeeCurrency ||
				feeFromText?.currency ||
				quoteCurrency
			if (!supportedCurrencies.has(resolvedFeeCurrency)) {
				resolvedFeeCurrency = quoteCurrency
			}
			const feeAmountRounded =
				resolvedFeeAmount > 0
					? await this.exchangeService.roundByCurrency(
							resolvedFeeAmount,
							resolvedFeeCurrency
						)
					: 0

			tx.direction = 'transfer'
			tx.tradeType = tradeIntent.type
			tx.tradeBaseCurrency = baseCurrency
			tx.tradeBaseAmount = baseAmount
			tx.tradeQuoteCurrency = quoteCurrency
			tx.tradeQuoteAmount = quoteAmount
			tx.executionPrice = executionPrice
			tx.tradeFeeCurrency = feeAmountRounded > 0 ? resolvedFeeCurrency : undefined
			tx.tradeFeeAmount = feeAmountRounded > 0 ? feeAmountRounded : undefined
			if (tradeIntent.type === 'buy') {
				tx.amount = quoteAmount
				tx.currency = quoteCurrency
				tx.convertToCurrency = baseCurrency
				tx.convertedAmount = baseAmount
			} else {
				tx.amount = baseAmount
				tx.currency = baseCurrency
				tx.convertToCurrency = quoteCurrency
				tx.convertedAmount = quoteAmount
			}
				if (
					!tx.description ||
					isGenericDescription(tx.description) ||
					normalizeDescriptionKey(tx.description) === normalizeDescriptionKey(baseCurrency) ||
					normalizeDescriptionKey(tx.description) === normalizeDescriptionKey(quoteCurrency) ||
					normalizeDescriptionKey(tx.description) === 'наличные'
				) {
					tx.description = 'Ордер'
				}
			tx.rawText = attachTradeMeta(stripTradeMeta(String(tx.rawText ?? '')), {
				type: tx.tradeType,
				baseCurrency,
				baseAmount,
				quoteCurrency,
				quoteAmount,
				executionPrice,
				feeCurrency: tx.tradeFeeCurrency,
				feeAmount: tx.tradeFeeAmount
			})
			return true
		}

		for (const tx of withFeeTransactions) {
			if (tx.currency) {
				tx.currency = String(tx.currency).toUpperCase().trim()
			}
			tx.account = normalizeAccountAlias(tx.account)
			tx.fromAccount = normalizeAccountAlias(tx.fromAccount)
			tx.toAccount = normalizeAccountAlias(tx.toAccount)
			const sourceText = stripParseMarkers(
				`${tx.rawText ?? ''} ${tx.description ?? ''}`
			).toLowerCase()
			const hasMinusSign = /(^|[\s(])-\s*\d/.test(sourceText)
			const hasPlusSign = /(^|[\s(])\+\s*\d/.test(sourceText)
			const incomeHintByText =
				/\b(доход|прибыль|получение|получил|получено|income|receive|received)\b/.test(
					sourceText
				)
			const expenseHintByText =
				/\b(расход|списани|оплат|покупк|debit|purchase)\b/.test(sourceText)
			const transferKeywordHint =
				/\b(перев[её]л|перевод|перекинул|скинул|отправил|send|sent|вывел|снял)\b/.test(
					sourceText
				)
			const transferRouteHint =
				/(?:^|[\s,])(с|из|from)\s+.+(?:\s|,)(в|на|to|into)\s+/.test(sourceText)
			const transferCounterpartyHint = !!extractTransferCounterparty(
				tx.rawText ?? tx.description
			)
			const explicitTransferType =
				/тип\s*[:\-]?\s*перевод|это\s+перевод|\(тип\s*перевод\)/.test(sourceText)
			const withdrawHint = /\b(вывел|вывод|снял)\b/.test(sourceText)
			if (
				transferKeywordHint ||
				transferRouteHint ||
				transferCounterpartyHint ||
				explicitTransferType ||
				withdrawHint
			) {
				tx.direction = 'transfer'
			} else if (hasPlusSign || incomeHintByText) {
				tx.direction = 'income'
			} else if (hasMinusSign || expenseHintByText) {
				tx.direction = 'expense'
			}
			const tradeIntent = deriveTradeIntent(tx)
			if (tradeIntent) {
				const normalized = await normalizeTradeFields(tx, tradeIntent)
				if (!normalized) {
					continue
				}
			} else if (tx.currency && !supportedCurrencies.has(tx.currency)) {
				await ctx.reply(
					`Валюта ${tx.currency} не поддерживается, свяжитесь с разработчиком.`,
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			if (tx.direction === 'transfer' && isGenericTransferDescription(tx.description)) {
				const counterparty = extractTransferCounterparty(tx.rawText ?? tx.description)
				if (counterparty) {
					tx.description =
						counterparty.charAt(0).toUpperCase() + counterparty.slice(1)
				} else if (withdrawHint) {
					tx.description = 'Вывод'
				} else {
					const fallbackName = String(tx.toAccount ?? tx.fromAccount ?? '')
						.trim()
					if (
						fallbackName &&
						fallbackName !== 'Вне Wallet' &&
						isExplicitAccountMention(String(tx.rawText ?? ''), fallbackName)
					) {
						tx.description = fallbackName
					}
				}
			}
			if (isGenericDescription(tx.description)) {
				const fallbackDescription = deriveDescriptionFallback(tx)
				if (fallbackDescription) {
					tx.description = fallbackDescription
				}
			}
			if (
				!tx.tradeType &&
				(!tx.category ||
					tx.category === 'Не выбрано' ||
					tx.category === '📦Другое' ||
					!tx.tag_text)
			) {
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
			if (!tx.tradeType && tx.direction !== 'transfer') {
				const specializedCategory = pickSpecializedFoodCategory(
					`${tx.rawText ?? ''} ${tx.description ?? ''}`,
					tx.category
				)
				if (specializedCategory) {
					tx.category = specializedCategory
				}
			}
			if (!tx.tradeType && tx.direction === 'expense') {
				const digitalCategory = pickDigitalPaymentCategory(
					`${tx.rawText ?? ''} ${tx.description ?? ''}`,
					tx.category
				)
				if (digitalCategory) {
					tx.category = digitalCategory
				}
			}
		}

		const pickTradeAccountBySoldCurrency = (
			soldCurrency: string,
			preferredIds: Array<string | null | undefined>
		): { id: string; name: string } | null => {
			const target = String(soldCurrency ?? '').toUpperCase()
			if (!target) return null
			const candidates = (visibleAccountsWithAssets as any[]).filter(
				acc => acc.name !== 'Вне Wallet'
			)
			const withAsset = candidates.filter(acc => accountHasAsset(acc, target))
			if (!withAsset.length) return null
			for (const id of preferredIds) {
				if (!id) continue
				const found = withAsset.find(acc => acc.id === id)
				if (found) return { id: found.id, name: found.name }
			}
			let best: any = null
			for (const candidate of withAsset) {
				if (!best) {
					best = candidate
					continue
				}
				if (getAccountAssetAmount(candidate, target) > getAccountAssetAmount(best, target)) {
					best = candidate
				}
			}
			return best ? { id: best.id, name: best.name } : null
		}

		for (const tx of withFeeTransactions) {
			const isTransfer = tx.direction === 'transfer'
			const isTrade = tx.tradeType === 'buy' || tx.tradeType === 'sell'
			const txRawText = stripParseMarkers(String(tx.rawText ?? ''))
			const parsedAccountStr = isTransfer
				? (tx.fromAccount && String(tx.fromAccount).trim()) || (tx.account && String(tx.account).trim()) || ''
				: (tx.account && String(tx.account).trim()) || ''
			const hasExplicitFromMention = isExplicitAccountMention(txRawText, parsedAccountStr)
			let matched =
				parsedAccountStr &&
				(hasExplicitFromMention || (isTrade && !!parsedAccountStr))
					? matchAccountByName(parsedAccountStr)
					: null
			if (!matched) {
				matched = findLooseMentionedAccount(txRawText)
			}
			const matchedAccountId = matched?.id ?? null
			tx.accountId = isTransfer
				? matchedAccountId ?? defaultAccountId
				: matchedAccountId ?? defaultAccountId
			let acc = matchedAccountId
				? userAccounts.find((a: any) => a.id === matchedAccountId)
				: defaultAccount
			tx.account = acc?.name ?? defaultAccount?.name ?? null
			if (!isTransfer && (matchedAccountId === outsideWalletId || tx.account === 'Вне Wallet')) {
				tx.accountId = defaultAccountId
				tx.account = defaultAccount?.name ?? null
				acc = defaultAccount
			}
			if (isTrade) {
				const soldCurrency = String(
					tx.tradeType === 'buy' ? tx.tradeQuoteCurrency : tx.tradeBaseCurrency
				).toUpperCase()
				if (!soldCurrency || !supportedCurrencies.has(soldCurrency)) {
					tx.__tradeError =
						'Не удалось определить валюту, которую нужно продать в сделке. Укажите пару в формате BASE/QUOTE.'
					continue
				}
				const preferredMentioned =
					findLooseMentionedAccount(txRawText)?.id ?? matchedAccountId
				const tradeAccount = pickTradeAccountBySoldCurrency(soldCurrency, [
					preferredMentioned,
					ctx.state.activeAccount?.id,
					defaultAccountId
				])
				if (!tradeAccount) {
					tx.__tradeError =
						`Для ${tx.tradeType === 'buy' ? 'покупки' : 'продажи'} требуется актив ${soldCurrency} на счёте. ` +
						'Добавьте этот актив в любой счёт и повторите попытку.'
					continue
				}
				tx.accountId = tradeAccount.id
				tx.account = tradeAccount.name
				tx.fromAccount = tradeAccount.name
				tx.toAccountId = tradeAccount.id
				tx.toAccount = tradeAccount.name
				acc =
					visibleAccountsWithAssets.find((a: any) => a.id === tradeAccount.id) ??
					acc
			}
				if (isTransfer) {
					const toStr = tx.toAccount && String(tx.toAccount).trim()
					const hasExplicitToMention = isExplicitAccountMention(txRawText, toStr)
					const withdrawHint = /\b(вывел|вывод|снял)\b/i.test(txRawText)
					const withdrawWithoutExplicitAccounts =
						withdrawHint && !hasExplicitFromMention && !hasExplicitToMention
					if (isTrade) {
						tx.toAccountId = tx.accountId
						tx.toAccount = tx.account
						if (
							!tx.description ||
							isGenericDescription(tx.description) ||
							normalizeDescriptionKey(tx.description) ===
								normalizeDescriptionKey(tx.tradeBaseCurrency)
						) {
							tx.description = 'Ордер'
						}
					} else {
						const explicitCounterparty = extractTransferCounterparty(
							tx.rawText ?? tx.description
						)
						const descriptionCandidate =
							!isGenericTransferDescription(tx.description) &&
							tx.description &&
							tx.description !== 'Вывод'
								? String(tx.description).trim()
								: ''
						const targetCandidate =
							toStr || explicitCounterparty || descriptionCandidate
						const toMatched =
							targetCandidate && targetCandidate !== 'Вне Wallet'
								? matchAccountByName(targetCandidate)
								: null
						if (toMatched) {
							tx.toAccountId = toMatched.id
							tx.toAccount = toMatched.name
						} else {
							tx.toAccountId = outsideWalletId
							tx.toAccount = 'Вне Wallet'
							if (targetCandidate && isGenericTransferDescription(tx.description)) {
								tx.description =
									targetCandidate.charAt(0).toUpperCase() +
									targetCandidate.slice(1)
							}
						}
					}
					if (!tx.accountId) {
						tx.accountId = defaultAccountId
						tx.account = defaultAccount?.name
					}
					if (!isTrade && withdrawWithoutExplicitAccounts) {
						tx.accountId = defaultAccountId
						tx.account = defaultAccount?.name
						tx.toAccountId = outsideWalletId
						tx.toAccount = 'Вне Wallet'
						tx.description = 'Вывод'
					}
					if (!isTrade && tx.accountId === tx.toAccountId && tx.accountId != null) {
						if (tx.accountId === outsideWalletId) {
							tx.accountId = defaultAccountId
							tx.account = defaultAccount?.name
						} else if (outsideWalletId) {
							tx.toAccountId = outsideWalletId
							tx.toAccount = 'Вне Wallet'
						}
					}
				}
			if (
				!isTransfer &&
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
			tx.categoryId = tx.category ? categoryIdByName.get(tx.category) : undefined
			if (
				!tx.tradeType &&
				tx.accountId &&
				tx.currency &&
				typeof tx.amount === 'number'
			) {
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
						const converted = await this.exchangeService.convert(
							tx.amount,
							tx.currency,
							tx.convertToCurrency
						)
						tx.convertedAmount =
							converted == null
								? null
								: await this.exchangeService.roundByCurrency(
										converted,
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
		const tradeErrorTx = withFeeTransactions.find(
			tx => typeof (tx as any).__tradeError === 'string'
		) as { __tradeError?: string } | undefined
		if (tradeErrorTx?.__tradeError) {
			await ctx.reply(tradeErrorTx.__tradeError, {
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			})
			return
		}

		const first = withFeeTransactions[0]
		const hasAnyField =
			typeof first.amount === 'number' ||
			(typeof first.description === 'string' &&
				first.description.trim().length > 0)
		if (!hasAnyField) {
			await ctx.reply(
				'Прости, я не смог понять, что ты имеешь в виду 😕\n' +
					'Попробуй, например:\n\n' +
					'• Купил кофе за 120 грн\n' +
					'• Зарплата 1500 USD\n' +
					'• Купил 5 монет BTC'
			)
			return
		}

		const txLimit = await this.subscriptionService.canCreateTransaction(user.id)
		if (
			!txLimit.allowed ||
			(!ctx.state.isPremium && txLimit.current + withFeeTransactions.length > txLimit.limit)
		) {
			await ctx.reply(
				'💠 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}

		for (const tx of withFeeTransactions) {
			const isTransfer = tx.direction === 'transfer'
			const effectiveAccountId =
				isTransfer
					? tx.accountId ?? defaultAccountId ?? outsideWalletId ?? null
					: tx.accountId ?? defaultAccountId ?? null
			if (!effectiveAccountId) {
				await ctx.reply(
					'Не удалось определить счёт для транзакции. Добавьте счёт во вкладке «Счета».',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			if (!isTransfer && effectiveAccountId === outsideWalletId) {
				await ctx.reply(
					'Счёт «Вне Wallet» нельзя использовать для доходов и расходов.',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				return
			}
			if (
				isTransfer &&
				!tx.tradeType &&
				tx.toAccountId === effectiveAccountId &&
				outsideWalletId
			) {
				tx.toAccountId = outsideWalletId === effectiveAccountId ? defaultAccountId : outsideWalletId
			}
			let tagId = tx.tagId as string | undefined
			if (tx.tagIsNew && tx.tagName) {
				const tagLimit = await this.subscriptionService.canCreateTag(user.id)
				if (
					!tagLimit.allowed ||
					(!ctx.state.isPremium && tagLimit.current + 1 > tagLimit.limit)
				) {
					tx.tagIsNew = false
					tx.tagName = undefined
					tagId = undefined
				} else {
					try {
						const createdTag = await this.tagsService.create(user.id, tx.tagName)
						tagId = createdTag.id
						tx.tagId = createdTag.id
						tx.tagName = createdTag.name
						tx.tagIsNew = false
					} catch {
						tagId = undefined
					}
				}
			}
			if (tagId) {
				await this.tagsService.incrementUsage(tagId)
			}
				const created = await this.transactionsService.create({
					userId: user.id,
					accountId: effectiveAccountId,
					amount: tx.amount ?? 0,
					currency: tx.currency ?? 'USD',
					direction: tx.direction,
					tradeType: tx.tradeType ?? undefined,
					tradeBaseCurrency: tx.tradeBaseCurrency ?? undefined,
					tradeBaseAmount: tx.tradeBaseAmount ?? undefined,
					tradeQuoteCurrency: tx.tradeQuoteCurrency ?? undefined,
					tradeQuoteAmount: tx.tradeQuoteAmount ?? undefined,
					executionPrice: tx.executionPrice ?? undefined,
					tradeFeeCurrency: tx.tradeFeeCurrency ?? undefined,
					tradeFeeAmount: tx.tradeFeeAmount ?? undefined,
					...(isTransfer
						? {
								fromAccountId: effectiveAccountId,
							toAccountId:
								tx.toAccountId ??
								(tx.tradeType ? effectiveAccountId : outsideWalletId ?? undefined)
						}
					: {
							categoryId: tx.categoryId ?? undefined,
							category: tx.category ?? '📦Другое'
						}),
				description: tx.description,
				rawText: tx.rawText || '',
				transactionDate: pickTransactionDate({
					userText: tx.rawText ?? '',
					llmDate: shouldIgnoreLlmDateFromAmount(
						String(tx.rawText ?? ''),
						tx,
						tx.transactionDate
					)
						? null
						: tx.transactionDate,
					preferLlmDate: /\bPHOTO_PARSE:\S+/u.test(String(tx.rawText ?? ''))
				}),
				tagId: tagId ?? undefined,
				convertedAmount: tx.convertedAmount,
				convertToCurrency: tx.convertToCurrency
			})
			tx.id = created.id
			tx.transactionDate = created.transactionDate.toISOString()
		}

		ctx.session.awaitingTransaction = false
		ctx.session.confirmingTransaction = true
		ctx.session.draftTransactions = withFeeTransactions
		ctx.session.currentTransactionIndex = 0

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
					first?.direction === 'transfer' && !(first as any)?.tradeType,
					false,
					(first as any)?.tradeType
				)
			}
		)
		ctx.session.tempMessageId = msg.message_id
		await renderHome(ctx, this.accountsService, this.analyticsService)
	}
}

