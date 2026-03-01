import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Bot, InlineKeyboard, session } from 'grammy'
import { UsersService } from '../users/users.service'
import { TransactionsService } from '../transactions/transactions.service'
import {
	LLMService,
	type LlmMassTransactionFilter
} from '../llm/llm.service'
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
import {
	addTxCallback,
	openAddTransactionFlow
} from './callbacks/add-transaction.command'
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
		premiumCallback
	} from './callbacks'
import { renderConfirmMessage } from './elements/tx-confirm-msg'
import { refreshAccountsPreview } from './callbacks/accounts-preview.callback'
import { hideMessageCallback } from './callbacks/hide-message.callback'
import { categoriesListKb } from './callbacks/view-categories.callback'
import { tagsListText } from './callbacks/view-tags.callback'
import {
	buildSettingsView,
	mainCurrencyPickerKeyboard,
	timezonePickerKeyboard
} from '../../shared/keyboards/settings'
import { levenshtein } from '../../utils/normalize'
import {
	extractExplicitDateFromText,
	normalizeTxDate,
	pickTransactionDate
} from '../../utils/date'
import { LlmMemoryService } from '../llm-memory/llm-memory.service'
import { formatExactAmount, isCryptoCurrency } from '../../utils/format'
import { normalizeTag } from '../../utils/normalize'
import {
	resolveTransactionCurrency,
	type CurrencyResolutionResult
} from './currency-resolution.util'
import {
	extractExchangeIntentFromText,
	pickSourceAccountId,
	pickTargetAccountId
} from './exchange-intent.util'

const ONBOARDING_ACCOUNTS_FIRST_OPEN_TEXT = `Добавь <b>два счёта</b>, которыми ты пользуешься в повседневной жизни. Формат свободный — можно писать через запятую, пробелы или с новой строки.

<blockquote>• <b>«Наличные»</b> — укажи валюту или несколько валют, которые используешь ежедневно.
• Банковский счёт — укажи валюту и актуальный баланс.
• Вместо банковского счёта или наличных можно добавить биржевой счёт или кошелёк, если ими пользуешься чаще.</blockquote>

Пример сообщения:
<blockquote>Наличные UAH 41 000
Приват24 EUR 1250</blockquote>

После добавления двух счётов система откроет тебе доступ к полноценной аналитике и дальнейшим шагам.`
const ONBOARDING_SUPPRESS_AFTER_DELETE_MARKER =
	'onboarding_suppressed_after_delete_v1'
const MAX_LLM_INPUT_TEXT_LENGTH = 3000
const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024
const MAX_VOICE_FILE_BYTES = 2 * 1024 * 1024
const LLM_RATE_LIMIT_WINDOW_MS = 15_000
const LLM_RATE_LIMIT_MAX_REQUESTS = 8
const MAX_MASS_TX_MATCHES = 500

type MassTransactionDraftRow = {
	transactionId: string
	action: 'update' | 'delete'
	before: {
		amount: number
		currency: string
		direction: 'income' | 'expense' | 'transfer'
		accountName: string | null
		toAccountName: string | null
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
}

@Injectable()
export class BotService implements OnModuleInit {
	private readonly logger = new Logger(BotService.name)
	private readonly bot: Bot<BotContext>
	private readonly llmRateLimiter = new Map<
		string,
		{ windowStart: number; count: number }
	>()

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
	async sendToUser(
		telegramId: string,
		text: string,
		extra?: {
			parse_mode?: 'HTML'
			reply_markup?: InlineKeyboard
			link_preview_options?: { is_disabled?: boolean }
		}
	): Promise<void> {
		await this.bot.api.sendMessage(Number(telegramId), text, extra as any).catch(() => {})
	}

	private extractTelegramErrorMessage(error: unknown): string {
		const maybeAny = error as any
		return String(
			maybeAny?.description ?? maybeAny?.message ?? maybeAny ?? ''
		).toLowerCase()
	}

	private isTelegramNotModified(error: unknown): boolean {
		return this.extractTelegramErrorMessage(error).includes(
			'message is not modified'
		)
	}

	private shouldTelegramEditFallback(error: unknown): boolean {
		const msg = this.extractTelegramErrorMessage(error)
		return (
			msg.includes('message to edit not found') ||
			msg.includes("message can't be edited") ||
			msg.includes('query is too old') ||
			msg.includes('message_id_invalid')
		)
	}

	private async safeEditMessageText(
		ctx: BotContext,
		messageId: number | undefined,
		text: string,
		extra: {
			parse_mode?: 'HTML'
			reply_markup?: InlineKeyboard
			link_preview_options?: { is_disabled?: boolean }
			updateHomeOnFallback?: boolean
		} = {}
	): Promise<void> {
		if (messageId == null) {
			const msg = await ctx.reply(text, extra as any)
			if (extra.updateHomeOnFallback !== false) {
				ctx.session.homeMessageId = msg.message_id
			}
			return
		}
		try {
			await ctx.api.editMessageText(ctx.chat!.id, messageId, text, extra as any)
			return
		} catch (error: unknown) {
			if (this.isTelegramNotModified(error)) return
			if (!this.shouldTelegramEditFallback(error)) return
		}
		const msg = await ctx.reply(text, extra as any)
		if (extra.updateHomeOnFallback !== false) {
			ctx.session.homeMessageId = msg.message_id
		}
	}

	private shouldLimitLlmTextInCurrentMode(ctx: BotContext): boolean {
		return Boolean(
			ctx.session.awaitingTransaction ||
				ctx.session.awaitingAccountInput ||
				ctx.session.awaitingMassAccountsInput ||
				ctx.session.awaitingMassTransactionsInput ||
				this.isJarvisAssetEditModeActive(ctx) ||
				ctx.session.accountDetailsEditMode === 'name' ||
				ctx.session.editingField
		)
	}

	private async ensureLlmTextInputWithinLimit(
		ctx: BotContext,
		text: string
	): Promise<boolean> {
		if (!this.shouldLimitLlmTextInCurrentMode(ctx)) return true
		if (String(text ?? '').length <= MAX_LLM_INPUT_TEXT_LENGTH) return true
		await ctx.reply(
			`Слишком длинный ввод. Максимум ${MAX_LLM_INPUT_TEXT_LENGTH} символов за одно сообщение.`,
			{
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			}
		)
		return false
	}

	private consumeLlmQuota(userId: string): boolean {
		const now = Date.now()
		const current = this.llmRateLimiter.get(userId)
		if (!current || now - current.windowStart > LLM_RATE_LIMIT_WINDOW_MS) {
			this.llmRateLimiter.set(userId, {
				windowStart: now,
				count: 1
			})
			return true
		}
		if (current.count >= LLM_RATE_LIMIT_MAX_REQUESTS) return false
		current.count += 1
		this.llmRateLimiter.set(userId, current)
		return true
	}

	private async ensureLlmRateLimit(ctx: BotContext): Promise<boolean> {
		const userId = String(ctx.state.user?.id ?? '')
		if (!userId) return true
		if (this.consumeLlmQuota(userId)) return true
		await ctx.reply(
			'Слишком много запросов за короткое время. Подождите 15 секунд и попробуйте снова.',
			{
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			}
		)
		return false
	}

	private async reloadUserContext(ctx: BotContext): Promise<any | null> {
		if (!ctx.from) return null
		const freshUser = await this.usersService.getOrCreateByTelegramId(
			String(ctx.from.id)
		)
		;(ctx.state as any).user = freshUser
		;(ctx.state as any).activeAccount =
			freshUser.accounts.find((a: any) => a.id === freshUser.activeAccountId) ??
			null
		;(ctx.state as any).isPremium = this.subscriptionService.isPremium(
			freshUser as any
		)
		return freshUser
	}

	private async renderAccountsListView(
		ctx: BotContext,
		targetMessageId?: number
	): Promise<void> {
		const user = await this.reloadUserContext(ctx)
		if (!user) return
		const [accountsWithAssets, frozen, visibleAccounts] = await Promise.all([
			this.accountsService.getAllWithAssets(user.id),
			this.subscriptionService.getFrozenItems(user.id),
			this.accountsService.getAllByUserId(user.id)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const pageSize = 9
		const totalPages = Math.max(1, Math.ceil(visibleAccounts.length / pageSize))
		const page = Math.min(
			Math.max(0, ctx.session.accountsViewPage ?? 0),
			totalPages - 1
		)
		ctx.session.accountsViewPage = page
		const expanded = ctx.session.accountsViewExpanded ?? false
		const text = await viewAccountsListText(
			accountsWithAssets,
			user.mainCurrency ?? 'USD',
			this.exchangeService,
			this.analyticsService,
			user.id,
			user.lastTipText,
			expanded
		)
		await this.safeEditMessageText(
			ctx,
			targetMessageId ?? ctx.session.homeMessageId,
			text,
			{
				parse_mode: 'HTML',
				reply_markup: accountSwitchKeyboard(
					visibleAccounts,
					user.activeAccountId,
					page,
					null,
					user.defaultAccountId,
					frozenAccountIds,
					false,
					expanded
				)
			}
		)
	}

	private async runStartupSanityChecks(): Promise<void> {
		try {
			await this.prisma.user.findFirst({
				select: {
					id: true,
					timezone: true,
					lastDailyReminderAt: true
				}
			})
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.error(
				`Startup Prisma sanity check failed for User fields: ${err.message}`
			)
		}

		try {
			const memoryDelegate = (this.prisma as any)?.llmUserMemory
			if (!memoryDelegate || typeof memoryDelegate.findFirst !== 'function') {
				this.logger.error(
					'Startup Prisma sanity check: llmUserMemory delegate is unavailable.'
				)
				return
			}
			await memoryDelegate.findFirst({ select: { id: true } })
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.error(
				`Startup Prisma sanity check failed for llmUserMemory: ${err.message}`
			)
		}
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
		await this.runStartupSanityChecks()

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

				this.bot.catch(async err => {
					const msg = err.message ?? ''
					if (
						msg.includes('message is not modified') ||
						msg.includes('message to edit not found') ||
						msg.includes("message can't be edited") ||
						msg.includes('query is too old') ||
						msg.includes('message_id_invalid') ||
						msg.includes('ECONNRESET') ||
						msg.includes('ETIMEDOUT')
					) {
						return
					}
				this.logger.error(`Bot error: ${msg}`, err.stack)
				const errorCtx = (err as any)?.ctx as BotContext | undefined
				if (errorCtx?.chat?.id) {
					try {
						await errorCtx.reply(
							'Техническая ошибка обработки. Отправьте сообщение ещё раз.'
						)
					} catch {}
				}
			})

			// Commands
			startCommand(
				this.bot,
				this.accountsService,
				this.analyticsService,
				this.prisma,
				this.subscriptionService
			)
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
			this.transactionsService,
			this.accountsService
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
			accountsPaginationCallback(
				this.bot,
				this.subscriptionService,
				this.accountsService
			)
		addAccountCallback(this.bot, this.subscriptionService)
		accountsPreviewCallbacks(this.bot)
			accountsJarvisEditCallback(this.bot, this.subscriptionService)
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
			this.subscriptionService
		)
		viewTagsCallback(
			this.bot,
			this.tagsService,
			this.subscriptionService
		)
			analyticsMainCallback(
				this.bot,
				this.analyticsService,
				this.llmService,
				this.prisma,
				this.llmMemoryService,
				this.subscriptionService
			)
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
			let monthlyChangePct = Number.NaN
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

				await this.safeEditMessageText(
					ctx,
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
			ctx.session.accountDetailsSourceMessageId = undefined
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

			await this.safeEditMessageText(
				ctx,
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
				ctx.session.accountsViewExpanded = false
				await this.renderAccountsListView(ctx, ctx.session.homeMessageId)
				const visibleAccounts = await this.accountsService.getAllByUserId(user.id)
				const onboardingSuppressed = await this.subscriptionService.hasMarker(
					user.id,
					ONBOARDING_SUPPRESS_AFTER_DELETE_MARKER
			)
			const shouldShowAccountsOnboarding =
				!onboardingSuppressed && visibleAccounts.length < FREE_LIMITS.MAX_ACCOUNTS
			if (shouldShowAccountsOnboarding) {
				if (ctx.session.onboardingStartMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.onboardingStartMessageId
						)
					} catch {}
					ctx.session.onboardingStartMessageId = undefined
				}
				if (ctx.session.onboardingAccountsMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.onboardingAccountsMessageId
						)
					} catch {}
					ctx.session.onboardingAccountsMessageId = undefined
				}
				const onboardingMessage = await ctx.reply(
					ONBOARDING_ACCOUNTS_FIRST_OPEN_TEXT,
					{
						parse_mode: 'HTML',
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
				ctx.session.onboardingAccountsMessageId = onboardingMessage.message_id
			} else {
				ctx.session.onboardingStartMessageId = undefined
				ctx.session.onboardingAccountsMessageId = undefined
			}
		})

			this.bot.callbackQuery(/^current_account:/, async ctx => {
				const accountId = ctx.callbackQuery.data.split(':')[1]

				const user = ctx.state.user
				const visibleAccounts = await this.accountsService.getAllByUserId(user.id)
				// @ts-ignore
				const account = user.accounts.find(a => a.id === accountId)

				if (!account) return

				const frozen = await this.subscriptionService.getFrozenItems(user.id)
				const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
				const expanded = ctx.session.accountsViewExpanded ?? false
				await ctx.editMessageText(accountInfoText(account), {
					parse_mode: 'HTML',
					// @ts-ignore
					reply_markup: accountSwitchKeyboard(
						visibleAccounts,
						user.activeAccountId,
						0,
						undefined,
						user.defaultAccountId || '',
						frozenAccountIds,
						false,
						expanded
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
			const sourceMessageId = ctx.callbackQuery.message!.message_id
			ctx.session.accountDetailsSourceMessageId = sourceMessageId
				const accountId = ctx.callbackQuery.data.split(':')[1]
				if (ctx.session.accountsViewSelectedId === accountId) {
					ctx.session.accountsViewSelectedId = null
					ctx.session.accountDetailsSourceMessageId = undefined
					await this.renderAccountsListView(ctx, ctx.callbackQuery.message!.message_id)
					return
				}
				ctx.session.accountsViewSelectedId = accountId
				await this.refreshAccountDetailsView(ctx, accountId)
			})

			this.bot.callbackQuery('accounts_unselect', async ctx => {
				ctx.session.accountsViewSelectedId = null
				ctx.session.accountDetailsSourceMessageId = undefined
				await this.renderAccountsListView(ctx, ctx.callbackQuery.message!.message_id)
			})

			this.bot.callbackQuery('accounts_view_toggle', async ctx => {
				ctx.session.accountsViewExpanded = !(ctx.session.accountsViewExpanded ?? false)
				const selectedId = ctx.session.accountsViewSelectedId
				if (selectedId) {
					ctx.session.accountDetailsSourceMessageId =
						ctx.callbackQuery.message?.message_id
					await this.refreshAccountDetailsView(ctx, selectedId)
					return
				}
				await this.renderAccountsListView(
					ctx,
					ctx.callbackQuery.message?.message_id
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
					text: 'Редактирование замороженного счёта доступно в Pro-тарифе.'
				})
				return
			}
			ctx.session.accountDetailsSourceMessageId =
				ctx.callbackQuery.message?.message_id ?? ctx.session.homeMessageId
			activateInputMode(ctx, 'account_jarvis_edit', {
				editingAccountDetailsId: selectedId,
				accountDetailsEditMode: 'jarvis'
			})
			const msg = await ctx.reply(
				'✏️ Меняются только валюта и сумма. Укажите валюту и действие: добавить, убрать или изменить.',
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
			ctx.session.accountDetailsSourceMessageId =
				ctx.callbackQuery.message?.message_id ?? ctx.session.homeMessageId
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
				await this.renderAccountsListView(
					ctx,
					((ctx.session as any).accountsDeleteSourceMessageId as number) ??
						ctx.callbackQuery.message!.message_id
				)
				;(ctx.session as any).accountsDeleteSourceMessageId = undefined
				await ctx.reply(`✅ Счёт удалён: ${account?.name ?? ''}`, {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
		})

		this.bot.callbackQuery('add_account', async ctx => {
			// заглушка, реальная логика вынесена в addAccountCallback
		})

		this.bot.callbackQuery('accounts_mass_edit_open', async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			const accounts = await this.accountsService.getAllWithAssets(user.id)
			const editable = accounts.filter(
				a => String(a.name ?? '').trim().toLowerCase() !== 'вне wallet'
			)
			if (!editable.length) {
				await ctx.reply('Нет счетов для массового редактирования.', {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				return
			}
			activateInputMode(ctx, 'accounts_mass_edit', {
				awaitingMassAccountsInput: true,
				massAccountsDraft: undefined,
				massAccountsBusy: false
			})
			const msg = await ctx.reply(
				'🪄 Массовое изменение счетов активировано.\n\nОтправьте команды с названиями счетов и активов. Можно текстом, голосом или фото.\nПример:\nBybit: TON 11.1, USDT -12.3\nMonobank: USD 0, EUR 25',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'accounts_mass_edit_close'
					)
				}
			)
			ctx.session.editMessageId = msg.message_id
		})

				this.bot.callbackQuery('accounts_mass_edit_close', async ctx => {
					const ids = Array.from(
						new Set(
							[
								ctx.session.editMessageId,
								ctx.session.massAccountsSummaryMessageId,
								ctx.callbackQuery.message?.message_id
							].filter((id): id is number => id != null)
						)
					)
				for (const id of ids) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, id)
				} catch {}
				}
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
			})

			this.bot.callbackQuery('accounts_mass_edit_repeat', async ctx => {
				if (ctx.session.massAccountsSummaryMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.massAccountsSummaryMessageId
						)
					} catch {}
				}
				ctx.session.massAccountsSummaryMessageId = undefined
				ctx.session.massAccountsDraft = undefined
				ctx.session.massAccountsBusy = false
				ctx.session.awaitingMassAccountsInput = true
				await ctx.answerCallbackQuery({
					text: 'Черновик сброшен. Отправьте новое указание.'
				})
			})

			this.bot.callbackQuery('accounts_mass_edit_confirm', async ctx => {
			if (ctx.session.massAccountsBusy) return
			const draft = ctx.session.massAccountsDraft ?? []
			if (!draft.length) return
			ctx.session.massAccountsBusy = true
			try {
				const ops: Array<{
					accountId: string
					currency: string
					amount: number
					direction: 'in' | 'out'
				}> = []
				for (const row of draft) {
					await this.accountsService.updateAccountWithAssets(
						row.accountId,
						ctx.state.user.id,
						{
							name: row.accountName,
							assets: row.afterAssets
						}
					)
					ops.push(...this.buildAccountDeltaOps(row))
				}
				if (ctx.session.massAccountsSummaryMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.massAccountsSummaryMessageId
						)
					} catch {}
				}
				if (ctx.session.editMessageId != null) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
					} catch {}
				}
				ctx.session.massAccountsSummaryMessageId = undefined
				ctx.session.massAccountsDraft = undefined
				ctx.session.awaitingMassAccountsInput = false
				await ctx.reply('✅ Массовые изменения счетов успешно применены.', {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				await renderHome(ctx as any, this.accountsService, this.analyticsService)
				if (ops.length > 0) {
					ctx.session.pendingAccountDeltaOps = ops
					const prompt = await ctx.reply('Создать операцию для этого действия?', {
						reply_markup: new InlineKeyboard()
							.text('Да', 'account_delta_create_tx_yes')
							.text('Закрыть', 'account_delta_create_tx_close')
					})
					ctx.session.accountDeltaPromptMessageId = prompt.message_id
				}
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
				} catch (error: unknown) {
					const reason = error instanceof Error ? error.message.trim() : ''
					await ctx.reply(
						reason || 'Не удалось применить массовые изменения счетов.',
						{
							reply_markup: new InlineKeyboard().text(
								'Закрыть',
								'accounts_mass_edit_close'
							)
						}
					)
				} finally {
				ctx.session.massAccountsBusy = false
				}
			})

			this.bot.callbackQuery('transactions_mass_edit_open', async ctx => {
				const user: any = ctx.state.user
				if (!user) return
				const txCount = await this.prisma.transaction.count({
					where: { userId: user.id }
				})
				if (!txCount) {
					await ctx.reply('Нет транзакций для массового редактирования.', {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
					return
				}
				activateInputMode(ctx, 'transactions_mass_edit', {
					awaitingMassTransactionsInput: true,
					massTransactionsDraft: undefined,
					massTransactionsSummaryMessageId: undefined,
					massTransactionsBusy: false
				})
				const msg = await ctx.reply(
					'🪄 Массовое редактирование транзакций активировано.\n\nОтправьте чёткое указание текстом или голосом.\nПримеры:\n• поменяй для всех транзакций с категорией "Другое" на категорию "Покупки", кроме refund zib\n• удали все транзакции с тегом cashback за январь',
					{
						reply_markup: new InlineKeyboard().text(
							'Закрыть',
							'transactions_mass_edit_close'
						)
					}
				)
				ctx.session.editMessageId = msg.message_id
			})

			this.bot.callbackQuery('transactions_mass_edit_close', async ctx => {
				const ids = Array.from(
					new Set(
						[
							ctx.session.editMessageId,
							ctx.session.massTransactionsSummaryMessageId,
							ctx.callbackQuery.message?.message_id
						].filter((id): id is number => id != null)
					)
				)
				for (const id of ids) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, id)
					} catch {}
				}
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
			})

			this.bot.callbackQuery('transactions_mass_edit_repeat', async ctx => {
				if (ctx.session.massTransactionsSummaryMessageId != null) {
					try {
						await ctx.api.deleteMessage(
							ctx.chat!.id,
							ctx.session.massTransactionsSummaryMessageId
						)
					} catch {}
				}
				ctx.session.massTransactionsSummaryMessageId = undefined
				ctx.session.massTransactionsDraft = undefined
				ctx.session.massTransactionsBusy = false
				ctx.session.awaitingMassTransactionsInput = true
				await ctx.answerCallbackQuery({
					text: 'Черновик сброшен. Отправьте новое указание.'
				})
			})

			this.bot.callbackQuery('transactions_mass_edit_confirm', async ctx => {
				if (ctx.session.massTransactionsBusy) return
				const draft = ctx.session.massTransactionsDraft ?? []
				if (!draft.length) return
				ctx.session.massTransactionsBusy = true
				try {
					let updatedCount = 0
					let deletedCount = 0
					for (const row of draft) {
						if (row.action === 'delete') {
							await this.transactionsService.delete(
								row.transactionId,
								ctx.state.user.id
							)
							deletedCount += 1
							continue
						}
						const after = row.after ?? {}
						await this.transactionsService.update(
							row.transactionId,
							ctx.state.user.id,
							{
								...(after.direction != null
									? { direction: after.direction }
									: {}),
									...(after.category !== undefined
										? { category: after.category ?? undefined }
										: {}),
									...(after.categoryId !== undefined
										? { categoryId: after.categoryId ?? null }
										: {}),
								...(after.description != null
									? { description: after.description }
									: {}),
								...(after.tagId !== undefined
									? { tagId: after.tagId ?? null }
									: {}),
								...(after.transactionDate != null
									? {
											transactionDate:
												normalizeTxDate(after.transactionDate) ?? undefined
										}
									: {})
							}
						)
						updatedCount += 1
					}
					if (ctx.session.massTransactionsSummaryMessageId != null) {
						try {
							await ctx.api.deleteMessage(
								ctx.chat!.id,
								ctx.session.massTransactionsSummaryMessageId
							)
						} catch {}
					}
					if (ctx.session.editMessageId != null) {
						try {
							await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
						} catch {}
					}
					ctx.session.massTransactionsSummaryMessageId = undefined
					ctx.session.massTransactionsDraft = undefined
					ctx.session.awaitingMassTransactionsInput = false
					const changesPreview = draft.slice(0, 12).map(row => {
						const accountLabel =
							row.before.direction === 'transfer'
								? `${row.before.accountName || '—'} -> ${
										row.before.toAccountName || '—'
									}`
								: row.before.accountName || '—'
						const base = `${formatExactAmount(
							row.before.amount,
							row.before.currency,
							{ maxFractionDigits: 18 }
						)} · ${row.before.description || row.before.category || 'Без названия'} · ${accountLabel}`
						if (row.action === 'delete') return `🗑 ${base}`
						const changedFields: string[] = []
						if (row.after?.direction) changedFields.push('тип')
						if (row.after?.category !== undefined) changedFields.push('категория')
						if (row.after?.tagId !== undefined) changedFields.push('тег')
						if (row.after?.description !== undefined) changedFields.push('описание')
						if (row.after?.transactionDate) changedFields.push('дата')
						return `✏️ ${base} → ${changedFields.join(', ')}`
					})
					const moreRows =
						draft.length > 12 ? `\n... и ещё ${draft.length - 12}` : ''
					await ctx.reply(
						`✅ Массовое редактирование выполнено.\nИзменено: ${updatedCount}\nУдалено: ${deletedCount}\n\n${changesPreview.join('\n')}${moreRows}`,
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
				} catch (error: unknown) {
					const reason = error instanceof Error ? error.message.trim() : ''
					await ctx.reply(
						reason || 'Не удалось применить массовое редактирование транзакций.',
						{
							reply_markup: new InlineKeyboard().text(
								'Закрыть',
								'transactions_mass_edit_close'
							)
						}
					)
				} finally {
					ctx.session.massTransactionsBusy = false
				}
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

			await this.renderSettingsView(ctx)
		})

		this.bot.callbackQuery('main_currency_open', async ctx => {
			const hint = await ctx.reply(
				'🌍 Выберите основную валюту для аналитики или введите её текстом.\nПоддерживается код и названия (например: USD, EUR, UAH, BYN, доллар, евро).',
				{
					reply_markup: mainCurrencyPickerKeyboard()
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
				'⌚️ Выберите ваш часовой пояс. Используйте формат UTC или воспользуйтесь одной из кнопок ниже.',
				{
					reply_markup: timezonePickerKeyboard()
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
			await this.cleanupTimezonePromptMessages(
				ctx,
				ctx.callbackQuery.message?.message_id
			)
			await this.renderSettingsView(ctx)
			resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
		})
		this.bot.callbackQuery('back_to_settings', async ctx => {
			await this.cleanupMainCurrencyPromptMessages(
				ctx,
				ctx.callbackQuery.message?.message_id
			)
			await this.cleanupTimezonePromptMessages(
				ctx,
				ctx.callbackQuery.message?.message_id
			)
			resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
			await this.renderSettingsView(ctx)
		})
		this.bot.callbackQuery(/^main_currency_set:/, async ctx => {
			const rawCode = ctx.callbackQuery.data.replace('main_currency_set:', '').trim()
			const code = this.normalizeMainCurrency(rawCode)
			if (!code) return
			await this.usersService.setMainCurrency(ctx.state.user.id, code)
			await this.cleanupMainCurrencyPromptMessages(
				ctx,
				ctx.callbackQuery.message?.message_id
			)
			await this.renderSettingsView(ctx)
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
			await this.renderSettingsView(ctx)
		})

				this.bot.on('message:text', async ctx => {
					const text = ctx.message.text.trim()
					if (!(await this.ensureLlmTextInputWithinLimit(ctx, text))) return

				if (text === '/help' || text === 'Помощь' || text === '❓ Помощь') {
					await this.replyHelp(ctx)
					return
				}
				if (text === '➕ Добавить транзакцию') {
					await openAddTransactionFlow(ctx, this.subscriptionService)
					return
				}
					if (
						text === '🏠 На главное меню' ||
						text === 'На главное меню' ||
						text === 'На главную'
					) {
						resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
						await renderHome(ctx, this.accountsService, this.analyticsService, {
							forceNewMessage: true,
							preservePreviousMessages: true
						})
						return
					}

				if ((ctx.session as any).awaitingDeleteConfirm) {
				if (text === 'delete-confirm') {
					const userId = ctx.state.user.id
					resetInputModes(ctx)
					await this.usersService.deleteAllUserData(userId)
					await this.subscriptionService.markMarkerIfAbsent(
						userId,
						ONBOARDING_SUPPRESS_AFTER_DELETE_MARKER
					)
					ctx.session.onboardingStartMessageId = undefined
					ctx.session.onboardingAccountsMessageId = undefined
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

				const llmHeavyModeActive =
					ctx.session.awaitingTransaction ||
					ctx.session.awaitingAccountInput ||
					ctx.session.awaitingMassAccountsInput ||
					ctx.session.awaitingMassTransactionsInput ||
					this.isJarvisAssetEditModeActive(ctx) ||
					(ctx.session.editingField === 'date' &&
						Array.isArray(ctx.session.draftTransactions))
				if (llmHeavyModeActive && !(await this.ensureLlmRateLimit(ctx))) return

				if (ctx.session.awaitingMassAccountsInput) {
					if (await this.handleMassAccountsInstruction(ctx, text)) {
						return
					}
				}
				if (ctx.session.awaitingMassTransactionsInput) {
					if (await this.handleMassTransactionsInstruction(ctx, text)) {
						return
					}
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
						'💠 В бесплатной версии недоступно создание своих категорий. Для добавления своих категорий, вы можете перейти на Pro-тариф.',
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
					const txId = current.id ?? ctx.session.editingTransactionId
					if (txId) {
						await this.transactionsService.update(txId, ctx.state.user.id, {
							categoryId: created.id,
							category: created.name
						})
					}

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
						'💠 3 кастомных тега — лимит Basic. Разблокируйте безлимит с Pro-тарифом!',
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
					const txId = current.id ?? ctx.session.editingTransactionId
					if (txId) {
						await this.transactionsService.update(txId, ctx.state.user.id, {
							tagId: created.id
						})
					}

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
				const normalizeBase = (value: string): string =>
					value
						.toLowerCase()
						.replace(
							/(иями|ями|ами|ией|ией|ией|ов|ев|ей|ам|ям|ах|ях|ой|ий|ый|ая|ое|ые|ом|ем|у|ю|а|я|ы|и|е|о)$/u,
							''
						)
						.trim()
				const allTags = await this.tagsService.getAllByUserId(ctx.state.user.id)
				const exact = allTags.find(t => t.name === normalized)
				const base = normalizeBase(normalized)
				const byBase =
					!exact && base.length >= 3
						? allTags.find(t => normalizeBase(t.name) === base)
						: null
				const typo = !exact
					? allTags.find(t => levenshtein(normalized, t.name) <= 1)
					: null
				const similar = await this.tagsService.findSimilar(ctx.state.user.id, normalized)
				const best = similar[0]
				if (exact) {
					current.tagId = exact.id
					current.tagName = exact.name
					current.tagIsNew = false
					current.tagWasNewInSession = false
				} else if (byBase) {
					current.tagId = byBase.id
					current.tagName = byBase.name
					current.tagIsNew = false
					current.tagWasNewInSession = false
				} else if (typo) {
					current.tagId = typo.id
					current.tagName = typo.name
					current.tagIsNew = false
					current.tagWasNewInSession = false
				} else if (best && best.similarity >= 0.7) {
					current.tagId = best.tag.id
					current.tagName = best.tag.name
					current.tagIsNew = false
					current.tagWasNewInSession = false
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
								'💠 3 кастомных тега — лимит Basic. Разблокируйте безлимит с Pro-тарифом!',
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
						current.tagWasNewInSession = true
						ctx.session.newTagNamesInSession = Array.from(
							new Set([...(ctx.session.newTagNamesInSession ?? []), createdTag.name])
						)
						await this.tagsService.incrementUsage(createdTag.id)
					} catch (e: any) {
						await ctx.reply(e?.message ?? 'Не удалось найти или добавить тег.', {
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

			if (
				isInputMode(ctx, 'main_currency_edit') ||
				(ctx.session as any).editingMainCurrency
			) {
				const code = this.normalizeMainCurrency(text)
				if (!code) {
					const errorMessage = await ctx.reply(
						'Не удалось распознать валюту, попробуйте ещё раз.',
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					const ids =
						((ctx.session as any).mainCurrencyErrorMessageIds as
							| number[]
							| undefined) ?? []
					ids.push(errorMessage.message_id)
					;(ctx.session as any).mainCurrencyErrorMessageIds = ids
					return
				}

				await this.usersService.setMainCurrency(ctx.state.user.id, code)
				await this.cleanupMainCurrencyPromptMessages(ctx)

				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}

				await this.renderSettingsView(ctx)
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
				return
			}

			if (isInputMode(ctx, 'timezone_edit')) {
				const normalized = this.normalizeTimezone(text)
				if (!normalized) {
					const msg = await ctx.reply(
						'Не удалось распознать часовой пояс. Попробуйте перефразировать или написать по-другому.',
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
				await this.cleanupTimezonePromptMessages(ctx)
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id)
				} catch {}
				await this.renderSettingsView(ctx)
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
							const supportedCurrencies = await this.getSupportedCurrencySet()
							const deterministic = this.parseDeterministicAssetOps(
								text,
								supportedCurrencies
							)
							let nextAssets: Array<{ currency: string; amount: number }>
							if (deterministic && 'error' in deterministic) {
								await ctx.reply(deterministic.error)
								return
							}
							if (!deterministic && !this.isAssetEditInstruction(text)) {
								await ctx.reply(
									'✏️ Меняются только валюта и сумма. Укажите валюту и действие: добавить, убрать или изменить.'
								)
								return
							}
							if (deterministic && deterministic.ops.length) {
								nextAssets = this.applyAssetOpsToCurrent(
									current.assets,
									deterministic.ops
								)
							} else {
								const updated = await this.llmService.parseAccountEdit(current, text)
								nextAssets = updated.assets.map(a => ({
									currency: String(a.currency ?? '').toUpperCase().trim(),
									amount: Number(a.amount ?? 0)
								}))
								const unsupported = nextAssets.find(
									a => !supportedCurrencies.has(String(a.currency).toUpperCase())
								)
								if (unsupported) {
									await ctx.reply(
										`Валюта ${unsupported.currency} не поддерживается. Чтобы добавить её, свяжитесь с помощником @coinpilot_helper.`
									)
									return
								}
							}
							if (
								!ctx.state.isPremium &&
								nextAssets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
							) {
								await this.subscriptionService.trackEvent(
									user.id,
									PremiumEventType.limit_hit,
									'assets'
								)
								await ctx.reply(
									`💠 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Basic. Разблокируйте безлимит с Pro-тарифом!`,
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
								assets: nextAssets
							}
							await this.accountsService.updateAccountWithAssets(accountId, user.id, {
								name: current.name,
								assets: updatedDraft.assets
							})
						} catch (error: unknown) {
							const reason = error instanceof Error ? error.message.trim() : ''
							await ctx.reply(
								reason
									? `Не удалось применить изменения по активам: ${reason}`
									: 'Не удалось применить изменения по активам. Уточните валюту и сумму.'
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
					const freshAccount = await this.accountsService.getOneWithAssets(
						accountId,
						user.id
					)
					if (freshAccount) {
						await this.refreshAccountDetailsView(ctx, accountId)
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

						try {
							const supportedCurrencies = await this.getSupportedCurrencySet()
							const deterministic = this.parseDeterministicAssetOps(
								text,
								supportedCurrencies
							)
							let nextAssets: Array<{ currency: string; amount: number }>
							if (deterministic && 'error' in deterministic) {
								await ctx.reply(deterministic.error)
								return
							}
							if (!deterministic && !this.isAssetEditInstruction(text)) {
								await ctx.reply(
									'✏️ Меняются только валюта и сумма. Укажите валюту и действие: добавить, убрать или изменить.'
								)
								return
							}
							if (deterministic && deterministic.ops.length) {
								nextAssets = this.applyAssetOpsToCurrent(
									current.assets,
									deterministic.ops
								)
							} else {
								const updated = await this.llmService.parseAccountEdit(
									{
										name: current.name,
										assets: current.assets
									},
									text
								)
								nextAssets = updated.assets.map(a => ({
									currency: String(a.currency ?? '').toUpperCase().trim(),
									amount: Number(a.amount ?? 0)
								}))
								const unsupported = nextAssets.find(
									a => !supportedCurrencies.has(String(a.currency).toUpperCase())
								)
								if (unsupported) {
									await ctx.reply(
										`Валюта ${unsupported.currency} не поддерживается. Чтобы добавить её, свяжитесь с помощником @coinpilot_helper.`
									)
									return
								}
							}
							drafts[index] = {
								...current,
								assets: nextAssets
							}
						} catch (error: unknown) {
							const reason = error instanceof Error ? error.message.trim() : ''
							await ctx.reply(
								reason
									? `Не удалось применить изменения по активам: ${reason}`
									: 'Не удалось применить изменения по активам. Уточните валюту и сумму.'
							)
							return
						}

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
								'💠 3 кастомных тега — лимит Basic. Разблокируйте безлимит с Pro-тарифом!',
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
					.text('Добавить или изменить теги', 'tags_jarvis_edit')
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
									'💠 В бесплатной версии недоступно создание своих категорий. Для добавления своих категорий, вы можете перейти на Pro-тариф.',
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
					try {
						await this.llmMemoryService.getHints(user.id)
						await this.llmMemoryService.rememberRuleFromText(user.id, text)
					} catch (error: unknown) {
						const err = error instanceof Error ? error : new Error(String(error))
						this.logger.warn(`LLM memory is temporarily unavailable: ${err.message}`)
					}

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
							const pendingInput = String(ctx.session.pendingAccountInputText ?? '').trim()
							const parseSource = [pendingInput, text].filter(Boolean).join('\n')
							const supportedCurrencies = await this.getSupportedCurrencySet()
							const parsed = await this.llmService.parseAccount(
								parseSource,
								supportedCurrencies
							)

						if (!parsed.length) {
							ctx.session.pendingAccountInputText = parseSource.slice(-1000)
							await ctx.reply(
								'Не хватает данных для счёта. Укажите недостающие поля (название, сумма, валюта), я дополню уже распознанное.'
							)
							return
						}
						const normalized = parsed.map(acc => ({
							...acc,
							rawText:
								acc.rawText && acc.rawText.trim().length > 0
									? acc.rawText
									: parseSource
						}))
						activateInputMode(ctx, 'idle', {
							awaitingAccountInput: false,
							confirmingAccounts: true,
							draftAccounts: normalized as any,
						currentAccountIndex: 0
						})
						ctx.session.pendingAccountInputText = undefined

						await refreshAccountsPreview(ctx as any)
					} catch (e: any) {
						const pendingInput = String(ctx.session.pendingAccountInputText ?? '').trim()
						ctx.session.pendingAccountInputText = [pendingInput, text]
							.filter(Boolean)
							.join('\n')
							.slice(-1000)
						const reason = String(e?.message ?? '').trim()
						const response =
							reason.length > 0
								? reason
								: 'Не удалось полностью распознать счёт. Отправьте недостающие поля (например: "Bybit 120 USDT"), я дополню текущий черновик.'
						await ctx.reply(response)
					}
					return
				}
		})

			this.bot.on('message:photo', async ctx => {
				const user: any = ctx.state.user
				if (!user) return
				const isJarvisAssetEdit = this.isJarvisAssetEditModeActive(ctx)
				const isMassAccountsEdit = !!ctx.session.awaitingMassAccountsInput
				if (
					!ctx.session.awaitingTransaction &&
					!isJarvisAssetEdit &&
					!isMassAccountsEdit
				)
					return

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
					if (!(await this.ensureLlmRateLimit(ctx))) return
					const imageDataUrl = await this.buildImageDataUrl(
						largest.file_id,
						'image/jpeg',
						MAX_IMAGE_FILE_BYTES
					)
				const caption = ctx.message.caption?.trim() || undefined
				if (isJarvisAssetEdit) {
					const instruction =
						await this.llmService.parseAccountEditInstructionFromImage(
							imageDataUrl,
							caption
						)
					if (!instruction) {
						await ctx.reply(
							'Не удалось распознать изменения активов со скриншота. Добавьте короткую текстовую команду.'
						)
						return
					}
					await this.applyJarvisAssetInstruction(ctx, instruction)
					return
				}
				if (isMassAccountsEdit) {
					const instruction =
						await this.llmService.parseAccountEditInstructionFromImage(
							imageDataUrl,
							caption
						)
					if (!instruction) {
						await ctx.reply(
							'Не удалось распознать команды по фото. Добавьте короткое текстовое уточнение с названиями счетов.'
						)
						return
					}
					await this.handleMassAccountsInstruction(ctx, instruction)
					return
				}
				const parseToken = `PHOTO_PARSE:${new Date()
					.toISOString()
					.slice(0, 7)}:${largest.file_unique_id}`
				await this.parseTransactionsFromImage(
					ctx,
					imageDataUrl,
					caption,
					parseToken
				)
				} catch (error: unknown) {
					if (String((error as Error)?.message ?? '').startsWith('FILE_TOO_LARGE:')) {
						await ctx.reply(
							`Файл слишком большой. Максимальный размер изображения: ${Math.floor(
								MAX_IMAGE_FILE_BYTES / (1024 * 1024)
							)} MB.`,
							{
								reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
							}
						)
						return
					}
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
			const doc = ctx.message.document
			if (!doc?.mime_type || !doc.mime_type.startsWith('image/')) return
			const user: any = ctx.state.user
			if (!user) return
			const isJarvisAssetEdit = this.isJarvisAssetEditModeActive(ctx)
			const isMassAccountsEdit = !!ctx.session.awaitingMassAccountsInput
			if (!ctx.session.awaitingTransaction && !isJarvisAssetEdit && !isMassAccountsEdit) return

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
					if (!(await this.ensureLlmRateLimit(ctx))) return
					const imageDataUrl = await this.buildImageDataUrl(
						doc.file_id,
						doc.mime_type || 'image/jpeg',
						MAX_IMAGE_FILE_BYTES
					)
				const caption = ctx.message.caption?.trim() || undefined
				if (isJarvisAssetEdit) {
					const instruction =
						await this.llmService.parseAccountEditInstructionFromImage(
							imageDataUrl,
							caption
						)
					if (!instruction) {
						await ctx.reply(
							'Не удалось распознать изменения активов со скриншота. Добавьте короткую текстовую команду.'
						)
						return
					}
					await this.applyJarvisAssetInstruction(ctx, instruction)
					return
				}
				if (isMassAccountsEdit) {
					const instruction =
						await this.llmService.parseAccountEditInstructionFromImage(
							imageDataUrl,
							caption
						)
					if (!instruction) {
						await ctx.reply(
							'Не удалось распознать команды по фото. Добавьте короткое текстовое уточнение с названиями счетов.'
						)
						return
					}
					await this.handleMassAccountsInstruction(ctx, instruction)
					return
				}
				const parseToken = `PHOTO_PARSE:${new Date()
					.toISOString()
					.slice(0, 7)}:${doc.file_unique_id}`
				await this.parseTransactionsFromImage(
					ctx,
					imageDataUrl,
					caption,
					parseToken
				)
				} catch (error: unknown) {
					if (String((error as Error)?.message ?? '').startsWith('FILE_TOO_LARGE:')) {
						await ctx.reply(
							`Файл слишком большой. Максимальный размер изображения: ${Math.floor(
								MAX_IMAGE_FILE_BYTES / (1024 * 1024)
							)} MB.`,
							{
								reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
							}
						)
						return
					}
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
					if (!(await this.ensureLlmRateLimit(ctx))) return
					const audioBuffer = await this.downloadTelegramFile(
						ctx.message.voice.file_id,
						MAX_VOICE_FILE_BYTES
					)
					const textFromVoice = await this.llmService.transcribeAudio(audioBuffer, {
					fileName: `${ctx.message.voice.file_unique_id}.ogg`,
					mimeType: 'audio/ogg',
					language: 'ru'
				})
				if (!textFromVoice) {
					await ctx.reply('Не удалось распознать голосовое сообщение.')
					return
				}
				if (await this.applyJarvisAssetInstruction(ctx, textFromVoice)) {
					return
				}
					if (ctx.session.awaitingMassAccountsInput) {
						await this.handleMassAccountsInstruction(ctx, textFromVoice)
						return
					}
					if (ctx.session.awaitingMassTransactionsInput) {
						await this.handleMassTransactionsInstruction(ctx, textFromVoice)
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
							const pendingInput = String(ctx.session.pendingAccountInputText ?? '').trim()
							const parseSource = [pendingInput, textFromVoice]
								.filter(Boolean)
								.join('\n')
							try {
								const supportedCurrencies = await this.getSupportedCurrencySet()
								const parsed = await this.llmService.parseAccount(
									parseSource,
									supportedCurrencies
								)
							if (!parsed.length) {
								ctx.session.pendingAccountInputText = parseSource.slice(-1000)
								await ctx.reply(
									'Не хватает данных для счёта. Добавьте недостающие поля (название, сумма, валюта).'
								)
								return
							}
							const normalized = parsed.map(acc => ({
								...acc,
								rawText:
									acc.rawText && acc.rawText.trim().length > 0
										? acc.rawText
										: parseSource
							}))
							ctx.session.awaitingAccountInput = false
							ctx.session.confirmingAccounts = true
							ctx.session.draftAccounts = normalized as any
							ctx.session.currentAccountIndex = 0
							ctx.session.pendingAccountInputText = undefined
							await refreshAccountsPreview(ctx as any)
							return
						} catch (error: unknown) {
							ctx.session.pendingAccountInputText = parseSource.slice(-1000)
							const reason =
								error instanceof Error ? error.message.trim() : ''
							await ctx.reply(
								reason ||
									'Не удалось полностью распознать счёт. Добавьте недостающие поля, я дополню текущий черновик.'
							)
							return
						}
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
					const accountId = ctx.session.editingAccountDetailsId
					const renamed = await this.accountsService.renameAccount(
						accountId,
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
					ctx.session.editingAccountDetailsId = undefined
					ctx.session.accountDetailsEditMode = undefined
					await this.refreshAccountDetailsView(ctx, accountId)
					return
				}
				} catch (error: unknown) {
					if (String((error as Error)?.message ?? '').startsWith('FILE_TOO_LARGE:')) {
						await ctx.reply(
							`Голосовое сообщение слишком большое. Максимум ${Math.floor(
								MAX_VOICE_FILE_BYTES / (1024 * 1024)
							)} MB.`,
							{
								reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
							}
						)
						return
					}
					await ctx.reply(
						'Не удалось обработать голосовое сообщение. Попробуйте текстом.'
					)
			}
		})

				this.bot.start()
			}

	private async refreshAccountDetailsView(
		ctx: BotContext,
		accountId: string
	): Promise<void> {
		const freshUser = await this.usersService.getOrCreateByTelegramId(
			String(ctx.from!.id)
		)
		;(ctx.state as any).user = freshUser
		;(ctx.state as any).activeAccount =
			freshUser.accounts.find(a => a.id === freshUser.activeAccountId) ?? null

		const account = await this.accountsService.getOneWithAssets(accountId, freshUser.id)
		if (!account) return

		const mainCurrency = freshUser.mainCurrency ?? 'USD'
		const isPremium = this.subscriptionService.isPremium(freshUser as any)
		const lastTxs = await this.prisma.transaction.findMany({
			where: {
				userId: freshUser.id,
				OR: [{ accountId }, { toAccountId: accountId }]
			},
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
				freshUser.id,
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
			] = await Promise.all([
				this.analyticsService.getSummary(
					freshUser.id,
					'month',
					mainCurrency,
					accountId
				),
				this.analyticsService.getTopCategories(
					freshUser.id,
					'month',
					mainCurrency,
					3,
					accountId,
					beg
				),
				this.analyticsService.getTopIncomeCategories(
					freshUser.id,
					'month',
					mainCurrency,
					beg,
					3,
					accountId
				),
				this.analyticsService.getAnomalies(
					freshUser.id,
					'month',
					mainCurrency,
					100,
					accountId,
					beg
				),
				this.analyticsService.getTransfersTotal(
					freshUser.id,
					'month',
					mainCurrency,
					accountId
				),
				this.analyticsService.getExternalTransferOutTotal(
					freshUser.id,
					'month',
					mainCurrency,
					accountId
				),
				this.analyticsService.getCashflow(
					freshUser.id,
					'month',
					mainCurrency,
					accountId
				),
				this.analyticsService.getBurnRate(
					freshUser.id,
					'month',
					mainCurrency,
					accountId
				)
			])
			const thresholdAnomaly = beg > 0 ? beg * 0.5 : 100
			const topTransfersWithPct = await this.analyticsService.getTopTransfers(
				freshUser.id,
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

		const text = await accountDetailsText(
			account,
			mainCurrency,
			this.exchangeService,
			account.id === freshUser.defaultAccountId,
			isPremium,
			lastTransactions,
			analyticsData,
			freshUser.timezone ?? 'UTC+02:00'
		)
		const page = ctx.session.accountsViewPage ?? 0
		const [visibleAccounts, frozen] = await Promise.all([
			this.prisma.account.findMany({
				where: { userId: freshUser.id, isHidden: false },
				orderBy: { createdAt: 'asc' }
			}),
			this.subscriptionService.getFrozenItems(freshUser.id)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const selectedFrozen = frozenAccountIds.has(accountId)
		const sourceMessageId =
			ctx.session.accountDetailsSourceMessageId ?? ctx.session.homeMessageId
			const replyMarkup = accountSwitchKeyboard(
				visibleAccounts,
				freshUser.activeAccountId,
				page,
				accountId,
				freshUser.defaultAccountId ?? undefined,
				frozenAccountIds,
				selectedFrozen,
				ctx.session.accountsViewExpanded ?? false
			)
		try {
			await ctx.api.editMessageText(ctx.chat!.id, sourceMessageId, text, {
				parse_mode: 'HTML',
				reply_markup: replyMarkup
			})
		} catch {
			const msg = await ctx.reply(text, {
				parse_mode: 'HTML',
				reply_markup: replyMarkup
			})
			ctx.session.homeMessageId = msg.message_id
			ctx.session.accountDetailsSourceMessageId = msg.message_id
		}
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

💠 Подписка

Вы можете подключить Pro-тариф в разделе «💠 Подписка».

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

	private normalizeMainCurrency(value: string): string | null {
		const raw = String(value ?? '').trim().toUpperCase()
		if (!raw) return null
		const compact = raw.replace(/\s+/g, '')
		const alias: Record<string, string> = {
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
			ТЕТЕР: 'USDT',
			BYN: 'BYN',
			BYP: 'BYN',
			BYR: 'BYN',
			БЕЛРУБ: 'BYN',
			БЕЛОРУБЛЬ: 'BYN',
			БЕЛАРУСКИЙРУБЛЬ: 'BYN',
			БЕЛОРУССКИЙРУБЛЬ: 'BYN'
		}
		if (alias[compact]) return alias[compact]
		const stripped = compact.replace(/[^A-ZА-ЯЁ$€₴£₽]/g, '')
		return alias[stripped] ?? null
	}

	private async renderSettingsView(ctx: BotContext): Promise<void> {
		const user = await this.usersService.getOrCreateByTelegramId(String(ctx.from!.id))
		;(ctx.state as any).user = user
		;(ctx.state as any).activeAccount =
			user.accounts.find(a => a.id === user.activeAccountId) ?? null
		;(ctx.state as any).isPremium = this.subscriptionService.isPremium(user as any)
		const view = buildSettingsView(user as any)
		await this.safeEditMessageText(ctx, ctx.session.homeMessageId, view.text, {
			parse_mode: 'HTML',
			reply_markup: view.keyboard
		})
	}

	private async cleanupMainCurrencyPromptMessages(
		ctx: BotContext,
		currentMessageId?: number
	): Promise<void> {
		const ids = new Set<number>()
		const hintId = (ctx.session as any).mainCurrencyHintMessageId as
			| number
			| undefined
		if (hintId != null) ids.add(hintId)
		for (const id of ((ctx.session as any).mainCurrencyErrorMessageIds ?? []) as number[]) {
			ids.add(id)
		}
		if (currentMessageId != null && currentMessageId !== ctx.session.homeMessageId) {
			ids.add(currentMessageId)
		}
		for (const id of ids) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, id)
			} catch {}
		}
		;(ctx.session as any).mainCurrencyHintMessageId = undefined
		;(ctx.session as any).mainCurrencyErrorMessageIds = []
		;(ctx.session as any).editingMainCurrency = false
	}

	private async cleanupTimezonePromptMessages(
		ctx: BotContext,
		currentMessageId?: number
	): Promise<void> {
		const ids = new Set<number>()
		const hintId = (ctx.session as any).timezoneHintMessageId as number | undefined
		if (hintId != null) ids.add(hintId)
		for (const id of ((ctx.session as any).timezoneErrorMessageIds ?? []) as number[]) {
			ids.add(id)
		}
		if (currentMessageId != null && currentMessageId !== ctx.session.homeMessageId) {
			ids.add(currentMessageId)
		}
		for (const id of ids) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, id)
			} catch {}
		}
		;(ctx.session as any).timezoneHintMessageId = undefined
		;(ctx.session as any).timezoneErrorMessageIds = []
	}

	private normalizeTimezone(value: string): string | null {
		const raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
		const shortcuts: Record<string, string> = {
			'+2': 'UTC+02:00',
			'+1': 'UTC+01:00',
			'0': 'UTC+00:00',
			'+0': 'UTC+00:00',
			'-1': 'UTC-01:00',
			'UTC+2': 'UTC+02:00',
			'UTC+1': 'UTC+01:00',
			'UTC0': 'UTC+00:00',
			'UTC+0': 'UTC+00:00',
			'UTC-1': 'UTC-01:00'
		}
		if (shortcuts[raw]) return shortcuts[raw]
		const withPrefix = raw.startsWith('UTC') ? raw : `UTC${raw}`
		const m = withPrefix.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/)
		if (!m) return null
		const sign = m[1]
		const hh = Number(m[2])
		const mm = Number(m[3] ?? '0')
		if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 14 || mm > 59) {
			return null
		}
		return `UTC${sign}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
	}

	private async downloadTelegramFile(
		fileId: string,
		maxBytes?: number
	): Promise<Buffer> {
		const file = await this.bot.api.getFile(fileId)
		const knownSize = Number((file as any)?.file_size ?? 0)
		if (
			typeof maxBytes === 'number' &&
			Number.isFinite(maxBytes) &&
			knownSize > 0 &&
			knownSize > maxBytes
		) {
			throw new Error(`FILE_TOO_LARGE:${knownSize}:${maxBytes}`)
		}
		const token = this.config.getOrThrow<string>('BOT_TOKEN')
		const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
		const res = await fetch(url)
		if (!res.ok) {
			throw new Error('Failed to download telegram file')
		}
		const buffer = Buffer.from(await res.arrayBuffer())
		if (
			typeof maxBytes === 'number' &&
			Number.isFinite(maxBytes) &&
			buffer.length > maxBytes
		) {
			throw new Error(`FILE_TOO_LARGE:${buffer.length}:${maxBytes}`)
		}
		return buffer
	}

	private async buildImageDataUrl(
		fileId: string,
		mimeType: string = 'image/jpeg',
		maxBytes: number = MAX_IMAGE_FILE_BYTES
	): Promise<string> {
		const fileBuffer = await this.downloadTelegramFile(fileId, maxBytes)
		return `data:${mimeType};base64,${fileBuffer.toString('base64')}`
	}

	private isJarvisAssetEditModeActive(ctx: BotContext): boolean {
		return (
			(!!ctx.session.editingAccountDetailsId &&
				ctx.session.accountDetailsEditMode === 'jarvis') ||
			(ctx.session.editingAccountField === 'jarvis' &&
				!!ctx.session.draftAccounts &&
				ctx.session.draftAccounts.length > 0)
		)
	}

	private async applyJarvisAssetInstruction(
		ctx: BotContext,
		instruction: string
	): Promise<boolean> {
		const text = String(instruction ?? '').trim()
		if (!text) {
			await ctx.reply(
				'Не удалось распознать изменения по активам. Укажите действие и валюту.'
			)
			return true
		}
		const user: any = ctx.state.user
		if (!user) return false

		if (
			ctx.session.editingAccountDetailsId &&
			ctx.session.accountDetailsEditMode === 'jarvis'
		) {
			const accountId = ctx.session.editingAccountDetailsId
			const account = await this.accountsService.getOneWithAssets(accountId, user.id)
			if (!account) {
				ctx.session.editingAccountDetailsId = undefined
				ctx.session.accountDetailsEditMode = undefined
				return true
			}
			const current = {
				name: account.name,
				assets: account.assets.map(a => ({
					currency: a.currency,
					amount: a.amount
				}))
			}

			try {
				const supportedCurrencies = await this.getSupportedCurrencySet()
				const deterministic = this.parseDeterministicAssetOps(
					text,
					supportedCurrencies
				)
				let nextAssets: Array<{ currency: string; amount: number }>
				if (deterministic && 'error' in deterministic) {
					await ctx.reply(deterministic.error)
					return true
				}
				if (!deterministic && !this.isAssetEditInstruction(text)) {
					await ctx.reply(
						'✏️ Меняются только валюта и сумма. Укажите валюту и действие: добавить, убрать или изменить.'
					)
					return true
				}
				if (deterministic && deterministic.ops.length) {
					nextAssets = this.applyAssetOpsToCurrent(current.assets, deterministic.ops)
				} else {
					const updated = await this.llmService.parseAccountEdit(current, text)
					nextAssets = updated.assets.map(a => ({
						currency: String(a.currency ?? '').toUpperCase().trim(),
						amount: Number(a.amount ?? 0)
					}))
					const unsupported = nextAssets.find(
						a => !supportedCurrencies.has(String(a.currency).toUpperCase())
					)
					if (unsupported) {
						await ctx.reply(
							`Валюта ${unsupported.currency} не поддерживается. Чтобы добавить её, свяжитесь с помощником @coinpilot_helper.`
						)
						return true
					}
				}
				if (
					!ctx.state.isPremium &&
					nextAssets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
				) {
					await this.subscriptionService.trackEvent(
						user.id,
						PremiumEventType.limit_hit,
						'assets'
					)
					await ctx.reply(
						`💠 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Basic. Разблокируйте безлимит с Pro-тарифом!`,
						{
							reply_markup: new InlineKeyboard()
								.text('💠 Pro-тариф', 'view_premium')
								.row()
								.text('Закрыть', 'hide_message')
						}
					)
					return true
				}

				await this.accountsService.updateAccountWithAssets(accountId, user.id, {
					name: current.name,
					assets: nextAssets
				})

				const beforeMap = new Map<string, number>()
				for (const a of current.assets) {
					beforeMap.set(String(a.currency).toUpperCase(), Number(a.amount))
				}
				const afterMap = new Map<string, number>()
				for (const a of nextAssets) {
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
					const prompt = await ctx.reply('Создать операцию для этого действия?', {
						reply_markup: new InlineKeyboard()
							.text('Да', 'account_delta_create_tx_yes')
							.text('Закрыть', 'account_delta_create_tx_close')
					})
					ctx.session.accountDeltaPromptMessageId = prompt.message_id
				}

				if (ctx.session.editMessageId) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
					} catch {}
					ctx.session.editMessageId = undefined
				}

					ctx.session.editingAccountDetailsId = undefined
					ctx.session.accountDetailsEditMode = undefined
					await this.refreshAccountDetailsView(ctx, accountId)
					return true
				} catch (error: unknown) {
				const reason = error instanceof Error ? error.message.trim() : ''
				await ctx.reply(
					reason
						? `Не удалось применить изменения по активам: ${reason}`
						: 'Не удалось применить изменения по активам. Уточните валюту и сумму.'
				)
				return true
			}
		}

		if (ctx.session.editingAccountField === 'jarvis' && ctx.session.draftAccounts) {
			const drafts = ctx.session.draftAccounts
			if (!drafts.length) return true
			const index = ctx.session.currentAccountIndex ?? 0
			const current = drafts[index]

			try {
				const supportedCurrencies = await this.getSupportedCurrencySet()
				const deterministic = this.parseDeterministicAssetOps(text, supportedCurrencies)
				let nextAssets: Array<{ currency: string; amount: number }>
				if (deterministic && 'error' in deterministic) {
					await ctx.reply(deterministic.error)
					return true
				}
				if (!deterministic && !this.isAssetEditInstruction(text)) {
					await ctx.reply(
						'✏️ Меняются только валюта и сумма. Укажите валюту и действие: добавить, убрать или изменить.'
					)
					return true
				}
				if (deterministic && deterministic.ops.length) {
					nextAssets = this.applyAssetOpsToCurrent(current.assets, deterministic.ops)
				} else {
					const updated = await this.llmService.parseAccountEdit(
						{
							name: current.name,
							assets: current.assets
						},
						text
					)
					nextAssets = updated.assets.map(a => ({
						currency: String(a.currency ?? '').toUpperCase().trim(),
						amount: Number(a.amount ?? 0)
					}))
					const unsupported = nextAssets.find(
						a => !supportedCurrencies.has(String(a.currency).toUpperCase())
					)
					if (unsupported) {
						await ctx.reply(
							`Валюта ${unsupported.currency} не поддерживается. Чтобы добавить её, свяжитесь с помощником @coinpilot_helper.`
						)
						return true
					}
				}

				drafts[index] = {
					...current,
					assets: nextAssets
				}
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
				return true
			} catch (error: unknown) {
				const reason = error instanceof Error ? error.message.trim() : ''
				await ctx.reply(
					reason
						? `Не удалось применить изменения по активам: ${reason}`
						: 'Не удалось применить изменения по активам. Уточните валюту и сумму.'
				)
				return true
			}
		}

		return false
	}

	private isAssetEditInstruction(text: string): boolean {
		const source = String(text ?? '').trim().toLowerCase()
		if (!source) return false
		const hasNumber = /[-+]?\d+(?:[.,]\d+)?/u.test(source)
		const hasCurrencyCode = /\b[A-Za-z]{2,10}\b/.test(source)
		const hasAction =
			/\b(?:добав|прибав|плюс|увелич|уменьш|убав|минус|выч|замени|установ|сделай|оставь|удали|убери|remove|delete|add|set|minus|plus|increase|decrease)\b/iu.test(
				source
			)
		const hasAssetWord =
			/\b(?:актив|валют|баланс|сумм|amount|asset|assets|currency|currencies)\b/iu.test(
				source
			)
		return (
			(hasNumber && hasCurrencyCode) ||
			(hasAction && hasCurrencyCode) ||
			(hasAction && hasAssetWord)
		)
	}

	private async getSupportedCurrencySet(): Promise<Set<string>> {
		const known = await this.exchangeService.getKnownCurrencies()
		return new Set<string>(
			[...Array.from(known.fiat), ...Array.from(known.crypto)].map(code =>
				String(code).toUpperCase()
			)
		)
	}

	private parseInstructionAmount(raw: string): number | null {
		const value = Number(String(raw).replace(',', '.'))
		if (!Number.isFinite(value) || value < 0) return null
		return value
	}

	private applyAssetOpsToCurrent(
		currentAssets: Array<{ currency: string; amount: number }>,
		ops: Array<
			| { type: 'add' | 'set' | 'minus'; currency: string; amount: number }
			| { type: 'remove'; currency: string }
		>
	): Array<{ currency: string; amount: number }> {
		const map = new Map<string, number>()
		const order: string[] = []
		for (const asset of currentAssets) {
			const code = String(asset.currency ?? '').toUpperCase().trim()
			if (!code) continue
			if (!order.includes(code)) order.push(code)
			map.set(code, Number(asset.amount ?? 0))
		}
		for (const op of ops) {
			if (op.type === 'remove') {
				map.delete(op.currency)
				continue
			}
			const prev = map.get(op.currency) ?? 0
			let next = prev
			if (op.type === 'set') next = op.amount
			if (op.type === 'add') next = prev + op.amount
			if (op.type === 'minus') next = prev - op.amount
			if (!Number.isFinite(next) || next < 0) {
				throw new Error(`Отрицательный баланс по ${op.currency} недопустим.`)
			}
			map.set(op.currency, Number(next.toFixed(12)))
			if (!order.includes(op.currency)) order.push(op.currency)
		}
		const result = order
			.filter(code => map.has(code))
			.map(code => ({
				currency: code,
				amount: map.get(code) ?? 0
			}))
		if (!result.length) {
			throw new Error('После изменения должен остаться минимум один актив.')
		}
		return result
	}

	private buildAccountDeltaOps(row: {
		accountId: string
		beforeAssets: Array<{ currency: string; amount: number }>
		afterAssets: Array<{ currency: string; amount: number }>
	}): Array<{
		accountId: string
		currency: string
		amount: number
		direction: 'in' | 'out'
	}> {
		const beforeMap = new Map<string, number>()
		for (const a of row.beforeAssets) {
			beforeMap.set(String(a.currency ?? '').toUpperCase(), Number(a.amount ?? 0))
		}
		const afterMap = new Map<string, number>()
		for (const a of row.afterAssets) {
			afterMap.set(String(a.currency ?? '').toUpperCase(), Number(a.amount ?? 0))
		}
		const currencies = new Set<string>([
			...Array.from(beforeMap.keys()),
			...Array.from(afterMap.keys())
		])
		const out: Array<{
			accountId: string
			currency: string
			amount: number
			direction: 'in' | 'out'
		}> = []
		for (const currency of currencies) {
			const before = beforeMap.get(currency) ?? 0
			const after = afterMap.get(currency) ?? 0
			const delta = Number((after - before).toFixed(12))
			if (!delta) continue
			out.push({
				accountId: row.accountId,
				currency,
				amount: Math.abs(delta),
				direction: delta > 0 ? 'in' : 'out'
			})
		}
		return out
	}

	private normalizeAccountMatchToken(value: string): string {
		return String(value ?? '')
			.toLowerCase()
			.replace(/ё/g, 'е')
			.replace(/[^\p{L}\p{N}]+/gu, '')
			.trim()
	}

	private getAccountNameAliases(name: string): string[] {
		const lowered = String(name ?? '').toLowerCase()
		const aliases: string[] = [name]
		if (/\bbybit\b/i.test(lowered)) aliases.push('байбит', 'bybit')
		if (/\bmexc\b/i.test(lowered)) aliases.push('мех', 'мекс', 'mexc')
		if (/\bbingx\b/i.test(lowered)) aliases.push('бингх', 'bingx')
		if (/\btrust\s*wallet\b/i.test(lowered))
			aliases.push('trust wallet', 'trustwallet', 'траст валлет', 'траст')
		if (/\bmonobank\b/i.test(lowered)) aliases.push('монобанк', 'mono')
		if (/\babank\b/i.test(lowered)) aliases.push('абанк', 'abank')
		if (/налич/i.test(lowered)) aliases.push('нал', 'наличные', 'cash')
		return Array.from(new Set(aliases))
	}

	private isAccountMentioned(line: string, accountName: string): boolean {
		const source = this.normalizeAccountMatchToken(line)
		if (!source) return false
		for (const alias of this.getAccountNameAliases(accountName)) {
			const token = this.normalizeAccountMatchToken(alias)
			if (token.length < 2) continue
			if (source.includes(token)) return true
		}
		return false
	}

	private assetsEqual(
		left: Array<{ currency: string; amount: number }>,
		right: Array<{ currency: string; amount: number }>
	): boolean {
		if (left.length !== right.length) return false
		const asKey = (arr: Array<{ currency: string; amount: number }>) =>
			arr
				.map(a => `${String(a.currency ?? '').toUpperCase()}:${Number(a.amount ?? 0).toFixed(12)}`)
				.sort()
				.join('|')
		return asKey(left) === asKey(right)
	}

	private formatMassAccountsSummary(
		draft: Array<{
			accountId: string
			accountName: string
			beforeAssets: Array<{ currency: string; amount: number }>
			afterAssets: Array<{ currency: string; amount: number }>
		}>
	): string {
		const blocks = draft.map(row => {
			const lines: string[] = []
			const beforeMap = new Map(
				row.beforeAssets.map(a => [
					String(a.currency ?? '').toUpperCase(),
					Number(a.amount ?? 0)
				])
			)
			const afterMap = new Map(
				row.afterAssets.map(a => [
					String(a.currency ?? '').toUpperCase(),
					Number(a.amount ?? 0)
				])
			)
			const currencies = new Set([
				...Array.from(beforeMap.keys()),
				...Array.from(afterMap.keys())
			])
			for (const currency of currencies) {
				const before = beforeMap.get(currency) ?? 0
				const after = afterMap.get(currency) ?? 0
				if (Number(before.toFixed(12)) === Number(after.toFixed(12))) continue
				const beforeStr = formatExactAmount(before, currency, { maxFractionDigits: 18 })
				const afterStr = formatExactAmount(after, currency, { maxFractionDigits: 18 })
				lines.push(`• ${currency}: ${beforeStr} → ${afterStr}`)
			}
			return `🏦 ${row.accountName}\n<blockquote>${
				lines.length ? lines.join('\n') : '• без изменений'
			}</blockquote>`
		})
		return `🪄 <b>Предпросмотр массовых изменений</b>

${blocks.join('\n\n')}

Проверьте изменения. Можно отправить дополнительные правки текстом, голосом или фото — я пересчитаю саммари.`
	}

	private async buildMassAccountsDraft(
		ctx: BotContext,
		instruction: string
	): Promise<
		Array<{
			accountId: string
			accountName: string
			beforeAssets: Array<{ currency: string; amount: number }>
			afterAssets: Array<{ currency: string; amount: number }>
		}>
	> {
		const user: any = ctx.state.user
		const accounts = await this.accountsService.getAllWithAssets(user.id)
		const editable = accounts.filter(
			a => String(a.name ?? '').trim().toLowerCase() !== 'вне wallet'
		)
		const lines = String(instruction ?? '')
			.split(/\r?\n|;/g)
			.map(x => x.trim())
			.filter(Boolean)
		const byAccount = new Map<string, string[]>()
		for (const line of lines) {
			for (const acc of editable) {
				if (!this.isAccountMentioned(line, acc.name)) continue
				const rows = byAccount.get(acc.id) ?? []
				rows.push(line)
				byAccount.set(acc.id, rows)
			}
		}
		if (!byAccount.size) {
			throw new Error(
				'Укажите названия счетов в команде. Пример: "Bybit: TON 11.1, USDT -12.3".'
			)
		}
		const supportedCurrencies = await this.getSupportedCurrencySet()
		const output: Array<{
			accountId: string
			accountName: string
			beforeAssets: Array<{ currency: string; amount: number }>
			afterAssets: Array<{ currency: string; amount: number }>
		}> = []
		for (const acc of editable) {
			const linesForAccount = byAccount.get(acc.id)
			if (!linesForAccount?.length) continue
			const joinedInstruction = linesForAccount.join('\n')
			const beforeAssets = (acc.assets ?? []).map(a => ({
				currency: String(a.currency ?? '').toUpperCase(),
				amount: Number(a.amount ?? 0)
			}))
			const deterministic = this.parseDeterministicAssetOps(
				joinedInstruction,
				supportedCurrencies
			)
			let afterAssets: Array<{ currency: string; amount: number }>
			if (deterministic && 'error' in deterministic) {
				throw new Error(deterministic.error)
			}
			if (deterministic && deterministic.ops.length > 0) {
				afterAssets = this.applyAssetOpsToCurrent(beforeAssets, deterministic.ops)
			} else {
				const updated = await this.llmService.parseAccountEdit(
					{
						name: acc.name,
						assets: beforeAssets
					},
					joinedInstruction
				)
				afterAssets = updated.assets
					.map(a => ({
						currency: String(a.currency ?? '').toUpperCase(),
						amount: Number(a.amount ?? 0)
					}))
					.filter(a => !!a.currency && Number.isFinite(a.amount) && a.amount >= 0)
				const unsupported = afterAssets.find(a => !supportedCurrencies.has(a.currency))
				if (unsupported) {
					throw new Error(
						`Валюта ${unsupported.currency} не поддерживается. Используйте ISO-коды из доступных валют.`
					)
				}
			}
			if (this.assetsEqual(beforeAssets, afterAssets)) continue
			output.push({
				accountId: acc.id,
				accountName: acc.name,
				beforeAssets,
				afterAssets
			})
		}
		return output
	}

	private async handleMassAccountsInstruction(
		ctx: BotContext,
		instruction: string
	): Promise<boolean> {
		if (!ctx.session.awaitingMassAccountsInput) return false
		const text = String(instruction ?? '').trim()
		if (!text) {
			await ctx.reply(
				'Не удалось распознать команду. Добавьте названия счетов и активы.',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'accounts_mass_edit_close'
					)
				}
			)
			return true
		}
		try {
			const draft = await this.buildMassAccountsDraft(ctx, text)
			if (!draft.length) {
				await ctx.reply(
					'Изменения не найдены. Уточните команды с названиями счетов и валютами.',
					{
						reply_markup: new InlineKeyboard().text(
							'Закрыть',
							'accounts_mass_edit_close'
						)
					}
				)
				return true
			}
			if (ctx.session.massAccountsSummaryMessageId != null) {
				try {
					await ctx.api.deleteMessage(
						ctx.chat!.id,
						ctx.session.massAccountsSummaryMessageId
					)
				} catch {}
			}
			const summary = this.formatMassAccountsSummary(draft)
				const msg = await ctx.reply(summary, {
					parse_mode: 'HTML',
					reply_markup: new InlineKeyboard()
						.text('Подтвердить', 'accounts_mass_edit_confirm')
						.text('Закрыть', 'accounts_mass_edit_close')
						.row()
						.text('Повторить', 'accounts_mass_edit_repeat')
				})
			ctx.session.massAccountsDraft = draft
			ctx.session.massAccountsSummaryMessageId = msg.message_id
			return true
		} catch (error: unknown) {
			const reason = error instanceof Error ? error.message.trim() : ''
			await ctx.reply(
				reason || 'Не удалось подготовить массовое изменение счетов.',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'accounts_mass_edit_close'
					)
				}
			)
			return true
		}
	}

	private normalizeMassTxToken(value: string): string {
		return String(value ?? '')
			.toLowerCase()
			.replace(/ё/g, 'е')
			.replace(
				/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+\s*)+/u,
				''
			)
			.replace(/[^\p{L}\p{N}]+/gu, '')
			.trim()
	}

	private transliterateCyrillicToLatin(value: string): string {
		const map: Record<string, string> = {
			а: 'a',
			б: 'b',
			в: 'v',
			г: 'g',
			д: 'd',
			е: 'e',
			ж: 'zh',
			з: 'z',
			и: 'i',
			й: 'y',
			к: 'k',
			л: 'l',
			м: 'm',
			н: 'n',
			о: 'o',
			п: 'p',
			р: 'r',
			с: 's',
			т: 't',
			у: 'u',
			ф: 'f',
			х: 'h',
			ц: 'ts',
			ч: 'ch',
			ш: 'sh',
			щ: 'sch',
			ъ: '',
			ы: 'y',
			ь: '',
			э: 'e',
			ю: 'yu',
			я: 'ya'
		}
		return Array.from(String(value ?? '').toLowerCase())
			.map(ch => map[ch] ?? ch)
			.join('')
	}

	private fuzzyTokenMatch(
		leftRaw: string,
		rightRaw: string,
		maxDistance: number
	): boolean {
		const left = this.normalizeMassTxToken(leftRaw)
		const right = this.normalizeMassTxToken(rightRaw)
		if (!left || !right) return false
		if (left === right) return true
		if (left.length >= 4 && right.length >= 4) {
			if (left.includes(right) || right.includes(left)) return true
		}
		const distance = levenshtein(left, right)
		const adaptive = Math.max(
			1,
			Math.floor(Math.min(left.length, right.length) * 0.35) + 1
		)
		return distance <= Math.min(maxDistance, adaptive)
	}

	private namesCloseEnough(leftRaw: string, rightRaw: string): boolean {
		return this.fuzzyTokenMatch(leftRaw, rightRaw, 2)
	}

	private accountNamesCloseEnough(leftRaw: string, rightRaw: string): boolean {
		const leftVariants = this.getAccountNameAliases(leftRaw)
		const rightVariants = this.getAccountNameAliases(rightRaw)
		for (const left of leftVariants) {
			for (const right of rightVariants) {
				if (this.fuzzyTokenMatch(left, right, 3)) return true
				const leftLatin = this.transliterateCyrillicToLatin(left)
				const rightLatin = this.transliterateCyrillicToLatin(right)
				if (this.fuzzyTokenMatch(leftLatin, rightLatin, 3)) return true
			}
		}
		return false
	}

	private extractMentionedAccountIds(
		instruction: string,
		accounts: Array<{ id: string; name: string }>
	): Set<string> {
		const text = String(instruction ?? '').trim()
		const out = new Set<string>()
		if (!text) return out
		for (const account of accounts) {
			const aliases = this.getAccountNameAliases(account.name)
			if (aliases.some(alias => this.accountNamesCloseEnough(text, alias))) {
				out.add(account.id)
			}
		}
		return out
	}

	private parseMassTxDate(value?: string): Date | null {
		if (!value) return null
		const explicit = extractExplicitDateFromText(value, new Date())
		if (explicit) return explicit
		return normalizeTxDate(value)
	}

	private isSameUtcDate(left: Date, right: Date): boolean {
		return (
			left.getUTCFullYear() === right.getUTCFullYear() &&
			left.getUTCMonth() === right.getUTCMonth() &&
			left.getUTCDate() === right.getUTCDate()
		)
	}

	private normalizeMassTxCurrency(raw: string): string {
		const compact = String(raw ?? '')
			.trim()
			.toUpperCase()
			.replace(/\s+/g, '')
		const aliases: Record<string, string> = {
			USDT: 'USDT',
			ТЕТЕР: 'USDT',
			TON: 'TON',
			ТОН: 'TON',
			USD: 'USD',
			$: 'USD',
			EUR: 'EUR',
			'€': 'EUR',
			UAH: 'UAH',
			'₴': 'UAH',
			RUB: 'RUB',
			RUR: 'RUB',
			'₽': 'RUB'
		}
		return aliases[compact] ?? compact
	}

	private parseMassTxAmount(raw: string): { value: number; precision: number } | null {
		const input = String(raw ?? '').trim()
		if (!input) return null
		const normalized = input.replace(/\s+/g, '').replace(',', '.')
		if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null
		const value = Number(normalized)
		if (!Number.isFinite(value)) return null
		const fractional = normalized.includes('.') ? normalized.split('.')[1] ?? '' : ''
		return {
			value: Math.abs(value),
			precision: Math.min(18, fractional.length)
		}
	}

	private extractAmountCurrencyPairs(
		instruction: string
	): Array<{ amount: number; currency: string; precision: number }> {
		const text = String(instruction ?? '')
		const pairs: Array<{ amount: number; currency: string; precision: number }> = []
		const seen = new Set<string>()
		const patterns: Array<{
			regex: RegExp
			amountGroup: number
			currencyGroup: number
		}> = [
			{
				regex:
					/(?<![\p{L}\p{N}_])([+-]?\d+(?:[.,]\d+)?)\s*([A-Za-zА-Яа-яЁё$€₴₽]{2,10})(?![\p{L}\p{N}_])/gu,
				amountGroup: 1,
				currencyGroup: 2
			},
			{
				regex:
					/(?<![\p{L}\p{N}_])([A-Za-zА-Яа-яЁё$€₴₽]{2,10})\s*([+-]?\d+(?:[.,]\d+)?)(?![\p{L}\p{N}_])/gu,
				amountGroup: 2,
				currencyGroup: 1
			}
		]
		for (const pattern of patterns) {
			pattern.regex.lastIndex = 0
			for (const match of text.matchAll(pattern.regex)) {
				const numberPart = this.parseMassTxAmount(
					match[pattern.amountGroup] ?? ''
				)
				const currencyRaw = match[pattern.currencyGroup] ?? ''
				if (!numberPart) continue
				const currency = this.normalizeMassTxCurrency(currencyRaw)
				if (!/^[A-Z$€₴₽]{2,10}$/.test(currency)) continue
				const key = `${currency}:${numberPart.value}:${numberPart.precision}`
				if (seen.has(key)) continue
				seen.add(key)
				pairs.push({
					amount: numberPart.value,
					currency,
					precision: numberPart.precision
				})
			}
		}
		return pairs
	}

	private txMatchesAmountCurrencyPair(
		tx: any,
		pair: { amount: number; currency: string; precision: number }
	): boolean {
		const txCurrency = this.normalizeMassTxCurrency(String(tx.currency ?? ''))
		if (txCurrency !== pair.currency) return false
		const actual = Math.abs(Number(tx.amount ?? 0))
		if (!Number.isFinite(actual)) return false
		const expected = pair.amount
		const precisionTolerance =
			pair.precision > 0 ? Math.max(1e-8, 0.5 * 10 ** -pair.precision) : 0.5
		const baselineTolerance = isCryptoCurrency(pair.currency) ? 0.00000001 : 0.01
		const tolerance = Math.max(baselineTolerance, precisionTolerance)
		return Math.abs(actual - expected) <= tolerance
	}

	private txMatchesMassFilter(tx: any, filter?: LlmMassTransactionFilter): boolean {
		if (!filter) return true
		if (filter.direction && tx.direction !== filter.direction) return false
		if (
			filter.currency &&
			String(tx.currency ?? '').toUpperCase() !==
				String(filter.currency ?? '').toUpperCase()
		) {
			return false
		}
		if (typeof filter.amount === 'number' && Number.isFinite(filter.amount)) {
			const expected = Math.abs(Number(filter.amount))
			const actual = Math.abs(Number(tx.amount ?? 0))
			const currencyCode = String(filter.currency ?? tx.currency ?? '').toUpperCase()
			const tolerance = isCryptoCurrency(currencyCode) ? 0.00000001 : 0.01
			if (Math.abs(actual - expected) > tolerance) return false
		}
		if (
			filter.category != null &&
			!this.namesCloseEnough(String(tx.category ?? ''), String(filter.category))
		) {
			return false
		}
		if (
			filter.description != null &&
			!this.namesCloseEnough(
				String(tx.description ?? ''),
				String(filter.description ?? '')
			)
		) {
			return false
		}
		if (
			filter.tag != null &&
			!this.namesCloseEnough(String(tx.tag?.name ?? ''), String(filter.tag ?? ''))
		) {
			return false
		}
		if (
			filter.account != null &&
			!this.accountNamesCloseEnough(
				String(tx.account?.name ?? ''),
				String(filter.account ?? '')
			)
		) {
			return false
		}
		if (
			filter.toAccount != null &&
			!this.accountNamesCloseEnough(
				String(tx.toAccount?.name ?? ''),
				String(filter.toAccount ?? '')
			)
		) {
			return false
		}
		const filterDate = this.parseMassTxDate(filter.transactionDate)
		if (filterDate) {
			const txDate = normalizeTxDate(tx.transactionDate)
			if (!txDate || !this.isSameUtcDate(txDate, filterDate)) return false
		}
		return true
	}

	private stripAmountCurrencyFromFilter(
		filter?: LlmMassTransactionFilter
	): LlmMassTransactionFilter | undefined {
		if (!filter) return undefined
		const rest: LlmMassTransactionFilter = { ...filter }
		delete rest.amount
		delete rest.currency
		return Object.keys(rest).length ? rest : undefined
	}

	private async resolveMassEditCategory(
		userId: string,
		categoryInput: string | null | undefined
	): Promise<{ id: string; name: string } | undefined> {
		if (categoryInput === undefined) return undefined
		const raw = String(categoryInput ?? '').trim()
		if (!raw) return undefined
		const categories = await this.categoriesService.getSelectableByUserId(userId)
		if (/^(без\s+категории|none|null|no\s*category|другое)$/iu.test(raw)) {
			const fallback = categories.find(c => this.namesCloseEnough(c.name, '📦Другое'))
			if (!fallback) {
				throw new Error('Категория "📦Другое" не найдена в списке пользователя.')
			}
			return { id: fallback.id, name: fallback.name }
		}
		const matched = categories.find(c => this.namesCloseEnough(c.name, raw))
		if (!matched) {
			throw new Error(
				`Категория "${raw}" не найдена. Укажите точнее название категории.`
			)
		}
		return { id: matched.id, name: matched.name }
	}

	private async resolveMassEditTag(params: {
		userId: string
		tagInput: string | null | undefined
	}): Promise<{ apply: boolean; tagId?: string | null; tagName?: string | null }> {
		if (params.tagInput === undefined) return { apply: false }
		const raw = String(params.tagInput ?? '').trim()
		if (!raw) return { apply: false }
		if (/^(без\s+тега|none|null|no\s*tag)$/iu.test(raw)) {
			return { apply: true, tagId: null, tagName: null }
		}
		const tags = await this.tagsService.getAllByUserId(params.userId)
		const normalizedInput = normalizeTag(raw)
		const exact = tags.find(tag => normalizeTag(tag.name) === normalizedInput)
		if (exact) {
			return { apply: true, tagId: exact.id, tagName: exact.name }
		}
		const byAlias = tags.find(tag =>
			(tag.aliases ?? []).some(alias =>
				this.namesCloseEnough(alias.alias, normalizedInput)
			)
		)
		if (byAlias) {
			return { apply: true, tagId: byAlias.id, tagName: byAlias.name }
		}
		const fuzzy = tags.find(tag => this.namesCloseEnough(tag.name, normalizedInput))
		if (fuzzy) {
			return { apply: true, tagId: fuzzy.id, tagName: fuzzy.name }
		}
		throw new Error(`Тег "${raw}" не найден. Укажите точнее тег для изменения.`)
	}

	private async buildMassTransactionsDraft(
		ctx: BotContext,
		instruction: string
	): Promise<MassTransactionDraftRow[]> {
		const user = ctx.state.user as any
		const [categories, tags, accounts, transactions] = await Promise.all([
			this.categoriesService.getSelectableByUserId(user.id),
			this.tagsService.getAllByUserId(user.id),
			this.accountsService.getAllByUserIdIncludingHidden(user.id),
			this.prisma.transaction.findMany({
				where: { userId: user.id },
				orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
				include: {
					account: true,
					toAccount: true,
					tag: true
				}
			})
		])
		if (!transactions.length) {
			throw new Error('Нет транзакций для массового редактирования.')
		}
		const lowered = String(instruction ?? '').toLowerCase()
		if (/\b(созда[йть]|добав[ьить].*транзак|new\s+transaction)\b/iu.test(lowered)) {
			throw new Error(
				'Массовое редактирование транзакций поддерживает только update/delete. Создание транзакций запрещено.'
			)
		}
		const parsed = await this.llmService.parseMassTransactionEditInstruction({
			instruction,
			categoryNames: categories.map(c => c.name),
			tagNames: tags.map(t => t.name),
			accountNames: accounts.map(a => a.name),
			timezone: user.timezone ?? 'UTC+02:00'
		})
		if (parsed.action === 'update' && !parsed.update) {
			throw new Error(
				'Не найдено полей для обновления. Можно менять только категорию, тип, тег, описание и дату.'
			)
		}
		const mentionedAccountIds =
			parsed.action === 'delete'
				? this.extractMentionedAccountIds(
						instruction,
						accounts.map(a => ({ id: a.id, name: a.name }))
					)
				: new Set<string>()
		let matched = transactions.filter(tx => this.txMatchesMassFilter(tx, parsed.filter))
		if (parsed.action === 'delete') {
			const amountCurrencyPairs = this.extractAmountCurrencyPairs(instruction)
			if (amountCurrencyPairs.length) {
				const extraFilter = this.stripAmountCurrencyFromFilter(parsed.filter)
				const pairMatched = transactions.filter(tx => {
					if (
						extraFilter &&
						!this.txMatchesMassFilter(tx, extraFilter)
					) {
						return false
					}
					return amountCurrencyPairs.some(pair =>
						this.txMatchesAmountCurrencyPair(tx, pair)
					)
				})
				if (amountCurrencyPairs.length > 1 || !matched.length) {
					matched = pairMatched
				}
			}
		}
		const protectByMentionedAccounts =
			parsed.action === 'delete' && mentionedAccountIds.size > 0
		if (parsed.deleteAll && !protectByMentionedAccounts) {
			matched = transactions
		}
		if (protectByMentionedAccounts) {
			matched = matched.filter(tx => {
				const fromId = String(tx.accountId ?? '')
				const toId = String(tx.toAccountId ?? '')
				return mentionedAccountIds.has(fromId) || (toId && mentionedAccountIds.has(toId))
			})
		}
		if (parsed.exclude) {
			matched = matched.filter(tx => !this.txMatchesMassFilter(tx, parsed.exclude))
		}
		if (!matched.length) {
			throw new Error(
				'Не найдено подходящих транзакций. Уточните фильтр (например сумму, дату или счёт).'
			)
		}
		if (matched.length > MAX_MASS_TX_MATCHES) {
			throw new Error(
				`Слишком много совпадений (${matched.length}). Уточните фильтр и попробуйте снова.`
			)
		}
		if (parsed.mode === 'single' && matched.length > 1) {
			throw new Error(
				`Транзакций с таким названием несколько (${matched.length}), укажите ещё данные для транзакции, которую нужно изменить.`
			)
		}
		const draft: MassTransactionDraftRow[] = []
		if (parsed.action === 'delete') {
			for (const tx of matched) {
				draft.push({
					transactionId: tx.id,
					action: 'delete',
					before: {
						amount: Number(tx.amount ?? 0),
						currency: tx.currency,
						direction: tx.direction as 'income' | 'expense' | 'transfer',
						accountName: tx.account?.name ?? null,
						toAccountName: tx.toAccount?.name ?? null,
						category: tx.category ?? null,
						description: tx.description ?? null,
						tagName: tx.tag?.name ?? null,
						transactionDate: tx.transactionDate.toISOString()
					}
				})
			}
			return draft
		}
		const update = parsed.update ?? {}
		const targetCategory = await this.resolveMassEditCategory(
			user.id,
			update.category
		)
		const targetTag = await this.resolveMassEditTag({
			userId: user.id,
			tagInput: update.tag
		})
		const targetDirection = update.direction
		const targetDescription =
			update.description != null
				? String(update.description).trim().slice(0, 80)
				: undefined
		const targetDate = this.parseMassTxDate(update.transactionDate)
		for (const tx of matched) {
			const after: MassTransactionDraftRow['after'] = {}
			if (
				targetDirection &&
				tx.direction !== 'transfer' &&
				tx.direction !== targetDirection
			) {
				after.direction = targetDirection
			}
				if (
					targetCategory !== undefined &&
					(tx.categoryId ?? null) !== targetCategory.id
				) {
					after.category = targetCategory.name
					after.categoryId = targetCategory.id
				}
			if (targetDescription && String(tx.description ?? '') !== targetDescription) {
				after.description = targetDescription
			}
			if (targetTag.apply) {
				const currentTagId = tx.tagId ?? null
				const nextTagId = targetTag.tagId ?? null
				if (currentTagId !== nextTagId) {
					after.tagId = nextTagId
					after.tagName = targetTag.tagName ?? null
				}
			}
			if (targetDate) {
				const txDate = normalizeTxDate(tx.transactionDate)
				if (!txDate || !this.isSameUtcDate(txDate, targetDate)) {
					after.transactionDate = targetDate.toISOString()
				}
			}
			if (!Object.keys(after).length) continue
			draft.push({
				transactionId: tx.id,
				action: 'update',
				before: {
					amount: Number(tx.amount ?? 0),
					currency: tx.currency,
					direction: tx.direction as 'income' | 'expense' | 'transfer',
					accountName: tx.account?.name ?? null,
					toAccountName: tx.toAccount?.name ?? null,
					category: tx.category ?? null,
					description: tx.description ?? null,
					tagName: tx.tag?.name ?? null,
					transactionDate: tx.transactionDate.toISOString()
				},
				after
			})
		}
		if (!draft.length) {
			throw new Error('Изменения не найдены. Все выбранные транзакции уже в нужном состоянии.')
		}
		return draft
	}

	private formatMassTransactionsSummary(draft: MassTransactionDraftRow[]): string {
		const escapeHtml = (value: string): string =>
			String(value ?? '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
		const limit = 25
		const lines: string[] = []
		for (const row of draft.slice(0, limit)) {
			const amountStr = formatExactAmount(row.before.amount, row.before.currency, {
				maxFractionDigits: 18
			})
			const date = normalizeTxDate(row.before.transactionDate)
			const dateStr = date
				? date.toLocaleDateString('ru-RU')
				: String(row.before.transactionDate).slice(0, 10)
			const accountLabel =
				row.before.direction === 'transfer'
					? `${escapeHtml(row.before.accountName || '—')} → ${escapeHtml(
							row.before.toAccountName || '—'
						)}`
					: escapeHtml(row.before.accountName || '—')
			const title = `${amountStr} · ${escapeHtml(
				row.before.description || row.before.category || 'Без названия'
			)} · ${accountLabel} · ${dateStr}`
			if (row.action === 'delete') {
				lines.push(`🗑 ${title}`)
				continue
			}
			const changes: string[] = []
			if (row.after?.direction) {
				changes.push(`тип: ${escapeHtml(row.before.direction)} → ${escapeHtml(row.after.direction)}`)
			}
			if (row.after?.category !== undefined) {
				changes.push(
					`категория: ${escapeHtml(row.before.category || '—')} → ${escapeHtml(
						row.after.category || '—'
					)}`
				)
			}
			if (row.after?.description !== undefined) {
				changes.push(
					`описание: ${escapeHtml(row.before.description || '—')} → ${escapeHtml(
						row.after.description || '—'
					)}`
				)
			}
			if (row.after?.tagId !== undefined) {
				changes.push(
					`тег: ${escapeHtml(row.before.tagName || '—')} → ${escapeHtml(
						row.after.tagName || '—'
					)}`
				)
			}
			if (row.after?.transactionDate) {
				const nextDate = normalizeTxDate(row.after.transactionDate)
				const nextDateStr = nextDate
					? nextDate.toLocaleDateString('ru-RU')
					: String(row.after.transactionDate).slice(0, 10)
				changes.push(`дата: ${dateStr} → ${nextDateStr}`)
			}
			lines.push(
				`✏️ ${title}\n<blockquote>${changes.length ? changes.join('\n') : 'без изменений'}</blockquote>`
			)
		}
		const hidden = draft.length > limit ? `\n\n... и ещё ${draft.length - limit}` : ''
		return `🪄 <b>Предпросмотр массового редактирования транзакций</b>

Найдено к изменению: <b>${draft.length}</b>

${lines.join('\n\n')}${hidden}

Подтвердите изменения или нажмите «Повторить», чтобы ввести другое указание.`
	}

	private async handleMassTransactionsInstruction(
		ctx: BotContext,
		instruction: string
	): Promise<boolean> {
		if (!ctx.session.awaitingMassTransactionsInput) return false
		const text = String(instruction ?? '').trim()
		if (!text) {
			await ctx.reply(
				'Не удалось распознать команду. Укажите фильтр и что изменить.',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'transactions_mass_edit_close'
					)
				}
			)
			return true
		}
		try {
			const draft = await this.buildMassTransactionsDraft(ctx, text)
			if (ctx.session.massTransactionsSummaryMessageId != null) {
				try {
					await ctx.api.deleteMessage(
						ctx.chat!.id,
						ctx.session.massTransactionsSummaryMessageId
					)
				} catch {}
			}
			const summary = this.formatMassTransactionsSummary(draft)
			const msg = await ctx.reply(summary, {
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard()
					.text('Подтвердить', 'transactions_mass_edit_confirm')
					.text('Отменить', 'transactions_mass_edit_close')
					.row()
					.text('Повторить', 'transactions_mass_edit_repeat')
			})
			ctx.session.massTransactionsDraft = draft
			ctx.session.massTransactionsSummaryMessageId = msg.message_id
			return true
		} catch (error: unknown) {
			const reason = error instanceof Error ? error.message.trim() : ''
			await ctx.reply(
				reason || 'Не удалось подготовить массовое редактирование транзакций.',
				{
					reply_markup: new InlineKeyboard().text(
						'Закрыть',
						'transactions_mass_edit_close'
					)
				}
			)
			return true
		}
	}

	private parseDeterministicAssetOps(
		instruction: string,
		supportedCurrencies: Set<string>
	):
		| {
				ops: Array<
					| { type: 'add' | 'set' | 'minus'; currency: string; amount: number }
					| { type: 'remove'; currency: string }
				>
		  }
		| { error: string }
		| null {
		const source = String(instruction ?? '')
		const ops: Array<
			| { type: 'add' | 'set' | 'minus'; currency: string; amount: number }
			| { type: 'remove'; currency: string }
		> = []
		const normalizeInstructionCurrency = (raw: string): string => {
			const compact = String(raw ?? '')
				.trim()
				.toUpperCase()
				.replace(/\s+/g, '')
			const aliases: Record<string, string> = {
				'$': 'USD',
				USD: 'USD',
				ДОЛЛАР: 'USD',
				ДОЛЛАРЫ: 'USD',
				ДОЛЛАРОВ: 'USD',
				'€': 'EUR',
				EUR: 'EUR',
				ЕВРО: 'EUR',
				'₴': 'UAH',
				UAH: 'UAH',
				ГРН: 'UAH',
				ГРИВНА: 'UAH',
				ГРИВНЫ: 'UAH',
				'₽': 'RUB',
				RUB: 'RUB',
				RUR: 'RUB',
				РУБ: 'RUB',
				РУБЛЬ: 'RUB',
				'£': 'GBP',
				GBP: 'GBP',
				ФУНТ: 'GBP',
				BYN: 'BYN',
				BYP: 'BYN',
				BYR: 'BYN',
				БЕЛРУБ: 'BYN',
				БЕЛОРУБЛЬ: 'BYN',
				ТЕТЕР: 'USDT'
			}
			const fromAlias = aliases[compact]
			if (fromAlias) return fromAlias
			const normalized = compact.replace(/[^A-Z0-9]/g, '')
			return aliases[normalized] ?? normalized
		}
		const assertCurrency = (
			raw: string
		): { code: string | null; error?: string } => {
			const code = normalizeInstructionCurrency(raw)
			if (!code) return { code: null }
			if (!supportedCurrencies.has(code)) {
				return {
					code: null,
					error: `Валюта ${code} не поддерживается. Чтобы добавить её, свяжитесь с помощником @coinpilot_helper.`
				}
			}
			return { code }
		}

		for (const m of source.matchAll(
			/(?:добав(?:ь|ить)?|прибав(?:ь|ить)?|плюс|add|increase)\s+(\d+(?:[.,]\d+)?)\s*([A-Za-zА-Яа-яЁё$€₴£₽]{1,16})(?:\s*\/\s*([A-Za-zА-Яа-яЁё$€₴£₽]{1,16}))?/giu
		)) {
			const amount = this.parseInstructionAmount(m[1])
			if (amount == null) continue
			const { code, error } = assertCurrency(m[2])
			if (error) return { error }
			if (!code) continue
			ops.push({ type: 'add', currency: code, amount })
		}
		for (const m of source.matchAll(
			/(?:добав(?:ь|ить)?|прибав(?:ь|ить)?|плюс|add|increase)\s+([A-Za-zА-Яа-яЁё$€₴£₽]{1,16})(?:\s*\/\s*([A-Za-zА-Яа-яЁё$€₴£₽]{1,16}))?\s*(\d+(?:[.,]\d+)?)/giu
		)) {
			const amount = this.parseInstructionAmount(m[2])
			if (amount == null) continue
			const { code, error } = assertCurrency(m[1])
			if (error) return { error }
			if (!code) continue
			ops.push({ type: 'add', currency: code, amount })
		}
		for (const m of source.matchAll(
			/(?:уменьш(?:и|ить)?|убав(?:ь|ить)?|минус|выч(?:есть|ти)?|minus|decrease)\s+(\d+(?:[.,]\d+)?)\s*([A-Za-zА-Яа-яЁё$€₴£₽]{1,16})/giu
		)) {
			const amount = this.parseInstructionAmount(m[1])
			if (amount == null) continue
			const { code, error } = assertCurrency(m[2])
			if (error) return { error }
			if (!code) continue
			ops.push({ type: 'minus', currency: code, amount })
		}
		for (const m of source.matchAll(
			/(?:установ(?:и|ить)?|замен(?:и|ить)?|set)\s+([A-Za-zА-Яа-яЁё$€₴£₽]{1,16})\s*(\d+(?:[.,]\d+)?)/giu
		)) {
			const amount = this.parseInstructionAmount(m[2])
			if (amount == null) continue
			const { code, error } = assertCurrency(m[1])
			if (error) return { error }
			if (!code) continue
			ops.push({ type: 'set', currency: code, amount })
		}
		for (const m of source.matchAll(
			/(?:удали|убери|remove|delete)\s+(?:(?:весь|всю|all)\s+)?(?:актив(?:а)?|валют[ауы]?|asset|currency)?\s*:?[\s]*([A-Za-zА-Яа-яЁё$€₴£₽]{1,16})(?:\s*\/\s*[A-Za-zА-Яа-яЁё$€₴£₽]{1,16})?/giu
		)) {
			const { code, error } = assertCurrency(m[1])
			if (error) return { error }
			if (!code) continue
			ops.push({ type: 'remove', currency: code })
		}

		if (!ops.length) return null
		return { ops }
	}

	private getParseSessionKey(rawText: string | null | undefined): string | null {
		const source = String(rawText ?? '')
		const m = source.match(/PHOTO_PARSE:[^\s]+/i)
		return m?.[0]?.toLowerCase() ?? null
	}

		private expandCompositeTrades(parsed: any[]): any[] {
			const expanded = parsed.map(tx => ({ ...tx }))
			const byKey = new Map<string, any[]>()
			for (const tx of expanded) {
				const dateKey = String(tx.transactionDate ?? '').slice(0, 10)
				const rawKey = String(tx.rawText ?? '').trim().toLowerCase()
				const sessionKey = this.getParseSessionKey(tx.rawText)
				const key = `${dateKey}|${sessionKey ?? rawKey}`
				const rows = byKey.get(key) ?? []
				rows.push(tx)
				byKey.set(key, rows)
			}
		const buySignal =
			/\b(?:swap|обмен|exchange|конверт|ордер|order|filled|исполнен)\b/iu
		for (const txs of byKey.values()) {
			const sourceText = txs
				.map(tx => `${tx.rawText ?? ''} ${tx.description ?? ''}`)
				.join(' ')
				.toLowerCase()
			if (!buySignal.test(sourceText)) continue
			if (txs.some(tx => tx.direction === 'income')) continue
			const expenses = txs.filter(
				tx =>
					tx.direction === 'expense' &&
					tx.currency &&
					typeof tx.amount === 'number' &&
					Number.isFinite(tx.amount) &&
					tx.amount > 0
			)
			if (!expenses.length) continue
			const existingByCurrency = new Map<string, number[]>()
			for (const tx of txs) {
				const cur = String(tx.currency ?? '').toUpperCase()
				const amount = Number(tx.amount ?? 0)
				if (!cur || !Number.isFinite(amount) || amount <= 0) continue
				const rows = existingByCurrency.get(cur) ?? []
				rows.push(amount)
				existingByCurrency.set(cur, rows)
			}
			const seenExpenseCurrencies = new Set(
				expenses.map(tx => String(tx.currency ?? '').toUpperCase())
			)
			const candidates = this.extractAmountCurrencyPairs(sourceText).filter(pair => {
				if (seenExpenseCurrencies.has(pair.currency)) return false
				const existing = existingByCurrency.get(pair.currency) ?? []
				return !existing.some(amount => Math.abs(amount - pair.amount) < 1e-8)
			})
			if (!candidates.length) continue
			const baseExpense = expenses.sort((a, b) => Number(b.amount) - Number(a.amount))[0]
			const acquired = candidates[0]
					expanded.push({
						...baseExpense,
						direction: 'income',
						amount: acquired.amount,
						currency: acquired.currency,
						category: baseExpense.category ?? undefined,
						description: baseExpense.description || `Покупка ${acquired.currency}`,
						tag_text: baseExpense.tag_text,
						normalized_tag: baseExpense.normalized_tag,
				tag_confidence: baseExpense.tag_confidence
			})
		}
		return expanded
	}

	private escapeRegexToken(value: string): string {
		return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	}

	private isFeeLikeTransaction(tx: any): boolean {
		const feeWordPattern = /\b(комисс(?:ия|ии|ию|ией)?|fee|maker|taker|gas)\b/iu
		const text = `${tx?.description ?? ''} ${tx?.tag_text ?? ''} ${
			tx?.normalized_tag ?? ''
		}`.toLowerCase()
		if (feeWordPattern.test(text)) return true

		const raw = String(tx?.rawText ?? '').toLowerCase()
		const amount = Number(tx?.amount ?? 0)
		const currency = String(tx?.currency ?? '').toUpperCase().trim()
		if (!raw || !Number.isFinite(amount) || amount <= 0 || !currency) return false

		const amountVariants = new Set<string>()
		const amountRaw = String(tx?.amount ?? '').replace(',', '.').trim()
		if (amountRaw) amountVariants.add(amountRaw)
		amountVariants.add(amount.toString())
		amountVariants.add(amount.toFixed(8).replace(/0+$/g, '').replace(/\.$/, ''))
		amountVariants.add(amount.toFixed(12).replace(/0+$/g, '').replace(/\.$/, ''))
		const currencyToken = this.escapeRegexToken(currency)

		for (const variant of amountVariants) {
			if (!variant) continue
			const amountToken = this.escapeRegexToken(variant)
			const feeNearAmount = new RegExp(
				`(?:комисс|fee|maker|taker|gas)[^\\n\\r]{0,32}${amountToken}\\s*${currencyToken}|${amountToken}\\s*${currencyToken}[^\\n\\r]{0,32}(?:комисс|fee|maker|taker|gas)`,
				'iu'
			)
			if (feeNearAmount.test(raw)) return true
		}

		return false
	}

	private convertExchangeLikeToTransfers(parsed: any[]): any[] {
		const grouped = new Map<string, any[]>()
		for (const tx of parsed) {
			const dateKey = String(tx.transactionDate ?? '').slice(0, 10)
			const rawKey = String(tx.rawText ?? '').trim().toLowerCase()
			const sessionKey = this.getParseSessionKey(tx.rawText)
			const key = `${dateKey}|${sessionKey ?? rawKey}`
			const rows = grouped.get(key) ?? []
			rows.push(tx)
			grouped.set(key, rows)
		}

		const out: any[] = []
		for (const txs of grouped.values()) {
			const sourceText = txs
				.map(tx => `${tx.rawText ?? ''} ${tx.description ?? ''}`)
				.join(' ')
				.toLowerCase()
			const hasExchangeSignal =
				/\b(валютообмен|обменял?|swap|exchange|конверт|исполнен|ордер|order|filled)\b/iu.test(
					sourceText
				) || /\b[A-Z]{2,10}\s*\/\s*[A-Z]{2,10}\b/u.test(sourceText.toUpperCase())

			const feeTxs = txs.filter(tx => this.isFeeLikeTransaction(tx))
			const coreTxs = txs.filter(tx => !this.isFeeLikeTransaction(tx))
			const distinctCurrencies = new Set(
				coreTxs
					.map(tx => String(tx.currency ?? '').toUpperCase())
					.filter(Boolean)
			)
			const hasIncomeAndExpense =
				coreTxs.some(tx => tx.direction === 'income') &&
				coreTxs.some(tx => tx.direction === 'expense')
			const hasImageContext = sourceText.includes('photo_parse:')
			const expenseCandidates = coreTxs
				.filter(
					tx =>
						tx.direction === 'expense' &&
						typeof tx.amount === 'number' &&
						Number.isFinite(tx.amount) &&
						tx.amount > 0
				)
				.sort((a, b) => Number(b.amount) - Number(a.amount))
			const hasExpensePair =
				expenseCandidates.length >= 2 && distinctCurrencies.size >= 2
			const hasExchangeShape =
				(hasIncomeAndExpense || hasExpensePair) &&
				distinctCurrencies.size >= 2 &&
				hasImageContext

			if ((!hasExchangeSignal && !hasExchangeShape) || distinctCurrencies.size < 2) {
				out.push(...txs)
				continue
			}

			const textIntent = extractExchangeIntentFromText(
				sourceText,
				this.extractAmountCurrencyPairs(sourceText)
			)

			const spent = expenseCandidates[0]
			if (!spent) {
				out.push(...txs)
				continue
			}
			let received = coreTxs
				.filter(
					tx =>
						tx.direction === 'income' &&
						String(tx.currency ?? '').toUpperCase() !==
							String(spent.currency ?? '').toUpperCase() &&
						typeof tx.amount === 'number' &&
						Number.isFinite(tx.amount) &&
						tx.amount > 0
				)
				.sort((a, b) => Number(b.amount) - Number(a.amount))[0]
			if (!received) {
				const fallbackExpense = expenseCandidates.find(
					tx =>
						tx !== spent &&
						String(tx.currency ?? '').toUpperCase() !==
							String(spent.currency ?? '').toUpperCase()
				)
				if (fallbackExpense) {
					received = {
						...fallbackExpense,
						direction: 'income',
						description:
							fallbackExpense.description ||
							`Обмен ${String(fallbackExpense.currency ?? '').toUpperCase()}`
					}
				}
			}
			if (!received) {
				const inferred = this.extractAmountCurrencyPairs(sourceText)
					.filter(
						pair =>
							pair.currency !== String(spent.currency ?? '').toUpperCase() &&
							pair.amount > 0
					)
					.sort((a, b) => b.amount - a.amount)[0]
				if (inferred) {
					received = {
						...spent,
						direction: 'income',
						amount: inferred.amount,
						currency: inferred.currency,
						description: `Обмен ${inferred.currency}`
					}
				}
			}
			if (!received) {
				out.push(...txs)
				continue
			}

			const sourceCurrency = String(
				textIntent?.sourceCurrency ?? spent.currency ?? ''
			).toUpperCase()
			const targetCurrency = String(
				textIntent?.targetCurrency ?? received.currency ?? ''
			).toUpperCase()
			const sourceAmount = Number(textIntent?.sourceAmount ?? spent.amount ?? 0)
			const targetAmount = Number(textIntent?.targetAmount ?? received.amount ?? 0)
			if (
				!sourceCurrency ||
				!targetCurrency ||
				sourceCurrency === targetCurrency ||
				!Number.isFinite(sourceAmount) ||
				sourceAmount <= 0
			) {
				out.push(...txs)
				continue
			}
			const exchangeTransfer = {
				...spent,
				direction: 'transfer',
				amount: Math.abs(sourceAmount),
				currency: sourceCurrency,
				convertToCurrency: targetCurrency,
				convertedAmount:
					Number.isFinite(targetAmount) && targetAmount > 0
						? Math.abs(targetAmount)
						: undefined,
				account:
					String(spent.account ?? spent.fromAccount ?? '').trim() || undefined,
				fromAccount:
					String(spent.fromAccount ?? spent.account ?? '').trim() || undefined,
				toAccount:
					String(received.toAccount ?? received.account ?? '').trim() || undefined,
				category: undefined,
				categoryId: undefined,
				__exchangeLike: true,
				__conversionSource:
					Number.isFinite(targetAmount) && targetAmount > 0
						? 'explicit'
						: 'unknown'
			}
			out.push(exchangeTransfer, ...feeTxs)
			this.logger.debug(
				`exchange-normalizer: collapsed to single transfer+conversion (currencies=${Array.from(
					distinctCurrencies
				).join(',')}, fee=${feeTxs.length})`
			)
		}

		return out
	}

	private dedupeParsedTransactions(parsed: any[]): any[] {
		const map = new Map<string, any>()
		for (const tx of parsed) {
			const normalizedDate =
				normalizeTxDate(tx.transactionDate)?.toISOString().slice(0, 10) ??
				String(tx.transactionDate ?? '').slice(0, 10)
			const amount = Number(tx.amount ?? 0)
			const key = [
				String(tx.direction ?? ''),
				normalizedDate,
				String(tx.currency ?? '').toUpperCase(),
				String(tx.convertToCurrency ?? '').toUpperCase(),
				Number.isFinite(Number(tx.convertedAmount ?? NaN))
					? Number(tx.convertedAmount).toFixed(12)
					: '0',
				String(tx.accountId ?? tx.account ?? '').toLowerCase(),
				String(tx.toAccountId ?? tx.toAccount ?? '').toLowerCase(),
				Number.isFinite(amount) ? amount.toFixed(12) : '0',
				String(tx.description ?? '').toLowerCase()
			].join('|')
			if (!map.has(key)) map.set(key, tx)
		}
		return Array.from(map.values())
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
		const isExchangeLike = Boolean(tx?.__exchangeLike)
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
			if (isExchangeLike) {
				if (!tx.convertToCurrency || String(tx.convertToCurrency).trim().length === 0) {
					missing.push('целевая валюта обмена')
				}
				if (
					!(
						typeof tx.convertedAmount === 'number' &&
						Number.isFinite(tx.convertedAmount) &&
						tx.convertedAmount > 0
					)
				) {
					missing.push('сумма зачисления')
				}
				if (
					tx.convertToCurrency &&
					String(tx.convertToCurrency).toUpperCase() ===
						String(tx.currency ?? '').toUpperCase()
				) {
					missing.push('целевая валюта должна отличаться от валюты списания')
				}
			}
		} else {
			if (!tx.accountId) missing.push('счёт')
			if (outsideWalletId && tx.accountId === outsideWalletId) {
				missing.push('для дохода/расхода нужен обычный счёт')
			}
		}
		return missing
	}

	private pickDominantDate(dates: Date[]): Date | null {
		if (!dates.length) return null
		const grouped = new Map<string, { date: Date; count: number }>()
		for (const d of dates) {
			const key = d.toISOString().slice(0, 10)
			const prev = grouped.get(key)
			if (prev) {
				prev.count += 1
				continue
			}
			grouped.set(key, { date: d, count: 1 })
		}
		let best: { date: Date; count: number } | null = null
		for (const row of grouped.values()) {
			if (!best || row.count > best.count) best = row
		}
		return best?.date ?? null
	}

	private extractFullDateCandidates(text: string): Date[] {
		const source = String(text ?? '')
		const out: Date[] = []
		for (const m of source.matchAll(
			/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/g
		)) {
			const y = Number(m[1])
			const mo = Number(m[2])
			const d = Number(m[3])
			const hh = Number(m[4] ?? '12')
			const mm = Number(m[5] ?? '0')
			const ss = Number(m[6] ?? '0')
			if (
				!Number.isFinite(y) ||
				!Number.isFinite(mo) ||
				!Number.isFinite(d) ||
				mo < 1 ||
				mo > 12 ||
				d < 1 ||
				d > 31
			) {
				continue
			}
			const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss, 0))
			if (!isNaN(dt.getTime())) out.push(dt)
		}
		for (const m of source.matchAll(
			/\b([0-3]?\d)[./-]([01]?\d)[./-](20\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/g
		)) {
			const d = Number(m[1])
			const mo = Number(m[2])
			const y = Number(m[3])
			const hh = Number(m[4] ?? '12')
			const mm = Number(m[5] ?? '0')
			const ss = Number(m[6] ?? '0')
			if (
				!Number.isFinite(y) ||
				!Number.isFinite(mo) ||
				!Number.isFinite(d) ||
				mo < 1 ||
				mo > 12 ||
				d < 1 ||
				d > 31
			) {
				continue
			}
			const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss, 0))
			if (!isNaN(dt.getTime())) out.push(dt)
		}
		return out
	}

	private stabilizeParsedDate(
		tx: any,
		params: {
			now: Date
			isImageBatch: boolean
			dominantDate: Date | null
		}
	): Date {
		const sourceText = `${tx.rawText ?? ''} ${tx.description ?? ''}`.trim()
		const cleanedSourceText = sourceText
			.replace(/PHOTO_PARSE:[^\s]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
		// For image batches we already anchor date from image/caption.
		if (params.isImageBatch && params.dominantDate) {
			return params.dominantDate
		}
		const explicitDate = extractExplicitDateFromText(cleanedSourceText, params.now)
		if (explicitDate) return explicitDate
		const chosen = pickTransactionDate({
			userText: cleanedSourceText,
			llmDate: tx.transactionDate,
			now: params.now
		})
		if (!params.isImageBatch || !params.dominantDate) return chosen
		const hasFutureIntent =
			/\b(завтра|послезавтра|следующ|next|tomorrow|nextmonth|nextweek)\b/iu.test(
				cleanedSourceText
			)
		const dayMs = 24 * 60 * 60 * 1000
		const isFarFuture = chosen.getTime() - params.now.getTime() > 2 * dayMs
		const dayGap = Math.abs(chosen.getTime() - params.dominantDate.getTime()) / dayMs
		if ((isFarFuture && !hasFutureIntent) || dayGap > 31) {
			return params.dominantDate
		}
		return chosen
	}

	private async preserveTransactionDraftOnError(
		ctx: BotContext,
		tx: any,
		missing: string[],
		reason: string
	): Promise<void> {
		const recognized: string[] = []
		if (tx?.description) recognized.push(`Название: ${tx.description}`)
		if (tx?.category) recognized.push(`Категория: ${tx.category}`)
		if (tx?.account) recognized.push(`Счёт: ${tx.account}`)
		if (tx?.amount) recognized.push(`Сумма: ${tx.amount}`)
		if (tx?.currency) recognized.push(`Валюта: ${tx.currency}`)
		activateInputMode(ctx, 'transaction_parse', {
			awaitingTransaction: true,
			pendingTransactionDraft: tx
				? ({
						...tx,
						__missing: undefined
					} as any)
				: undefined,
			pendingTransactionMissing: missing
		})
		await ctx.reply(
			`${reason}\n` +
				(missing.length
					? `\nНе хватает данных: ${missing.join(', ')}.`
					: '\nУточните данные операции.') +
				'\nОтправьте только новые/исправленные поля, я дополню текущий черновик.' +
				(recognized.length ? `\n\nУже распознано:\n${recognized.join('\n')}` : ''),
			{
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			}
		)
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

			const timezone = user?.timezone ?? 'UTC+02:00'
			const [parsed, extractedImageDate] = await Promise.all([
				this.llmService.parseTransactionFromImage(
					imageDataUrl,
					categoryNames,
					existingTags,
					accountNames,
					caption,
					timezone
				),
				this.llmService.extractTransactionDateFromImage(
					imageDataUrl,
					caption,
					timezone
				)
			])
			const now = new Date()
			const captionDate = extractExplicitDateFromText(caption ?? '', now)
			const fullDateCandidates = parsed.flatMap(tx =>
				this.extractFullDateCandidates(
					`${tx?.rawText ?? ''} ${tx?.description ?? ''}`
				)
			)
			const parsedFullDate = this.pickDominantDate(fullDateCandidates)
			const imageAnchorDate =
				captionDate ??
				parsedFullDate ??
				(extractedImageDate ? normalizeTxDate(extractedImageDate) : null)
			const normalized = parsed.map(tx => {
				const composedRaw = [
					parseToken,
					caption?.trim() || '',
					tx.rawText?.trim() || ''
				]
					.filter(Boolean)
					.join(' ')
					.trim()
				return {
					...tx,
					rawText: composedRaw,
					transactionDate:
						imageAnchorDate?.toISOString() ??
						(tx.transactionDate ? String(tx.transactionDate) : undefined)
				}
			})
			await this.processParsedTransactions(ctx, normalized)
		}

	async closeTemp(ctx) {
		const keep = new Set<number>((ctx.session.resultMessageIds ?? []) as number[])
			const ids = [
				ctx.session.tempMessageId,
				ctx.session.hintMessageId,
				ctx.session.previewMessageId,
				ctx.session.inlineCreateHintMessageId,
				ctx.session.massAccountsSummaryMessageId,
				ctx.session.massTransactionsSummaryMessageId,
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
			ctx.session.massAccountsSummaryMessageId = undefined
			ctx.session.massTransactionsSummaryMessageId = undefined
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
			const fallbackCategoryName =
				visibleCategories.find(c =>
					this.namesCloseEnough(c.name, '📦Другое')
				)?.name ??
				visibleCategories[0]?.name ??
				null
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

			const now = new Date()
			const isImageBatch = (parsed as any[]).some(tx =>
				String(tx?.rawText ?? '').includes('PHOTO_PARSE:')
			)
			const explicitDates = (parsed as any[])
				.map(tx => {
					const source = `${tx?.rawText ?? ''} ${tx?.description ?? ''}`
						.replace(/PHOTO_PARSE:[^\s]+/g, ' ')
						.replace(/\s+/g, ' ')
						.trim()
					return extractExplicitDateFromText(source, now)
				})
				.filter((d): d is Date => !!d)
			const llmDates = (parsed as any[])
				.map(tx => normalizeTxDate(tx?.transactionDate))
				.filter((d): d is Date => !!d)
			const dominantDate = this.pickDominantDate(
				isImageBatch
					? llmDates
					: explicitDates.length > 0
						? explicitDates
						: llmDates
			)
			const merged = new Map<string, any>()
			for (const tx of parsed as any[]) {
				const direction = tx.direction
				const chosenDate = this.stabilizeParsedDate(tx, {
					now,
					isImageBatch,
					dominantDate
				})
				tx.transactionDate = chosenDate.toISOString()
			const txDate = chosenDate.toISOString().slice(0, 10)
			const account = normalizeAccountAlias(tx.account ?? tx.fromAccount ?? '')
				const category = tx.category ?? ''
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
				const expandedTransactions = this.expandCompositeTrades(parsedNormalized)
				const exchangeNormalized = this.convertExchangeLikeToTransfers(
					expandedTransactions
				)
				const withFeeTransactions: any[] = []
				const feeSignatures = new Set(
					exchangeNormalized
						.filter(tx => tx.direction === 'expense' && this.isFeeLikeTransaction(tx))
						.map(
							tx =>
								`${String(tx.rawText ?? '').toLowerCase()}|${String(tx.currency ?? '').toUpperCase()}`
						)
				)
				for (const tx of exchangeNormalized) {
					withFeeTransactions.push(tx)
				const raw = String(tx.rawText ?? '').toLowerCase()
				if (
					tx.direction !== 'transfer' ||
					!isCryptoCurrency(String(tx.currency ?? '')) ||
					!/комисси|fee/u.test(raw)
				) {
					continue
				}
				const feeSignature = `${String(tx.rawText ?? '').toLowerCase()}|${String(
					tx.currency ?? ''
				).toUpperCase()}`
				if (feeSignatures.has(feeSignature)) {
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
			const normalizedTransactions = this.dedupeParsedTransactions(withFeeTransactions)
			const supportedCurrencies = await this.getSupportedCurrencySet()

		const [recentTx, accountUsageRows] = await Promise.all([
			this.prisma.transaction.findMany({
				where: { userId: user.id, description: { not: null } },
				orderBy: { transactionDate: 'desc' },
				take: 200,
				include: { tag: true, account: true }
			}),
			this.prisma.transaction.findMany({
				where: { userId: user.id },
				select: { accountId: true, toAccountId: true, transactionDate: true },
				orderBy: { transactionDate: 'desc' },
				take: 500
			})
		])
		const accountStatsById = new Map<
			string,
			{ usageCount: number; lastUsedAtMs: number }
		>()
		for (const row of accountUsageRows) {
			const ts = new Date(row.transactionDate).getTime()
			const touch = (id?: string | null) => {
				if (!id || id === outsideWalletId) return
				const prev = accountStatsById.get(id)
				if (!prev) {
					accountStatsById.set(id, { usageCount: 1, lastUsedAtMs: ts })
					return
				}
				prev.usageCount += 1
				if (ts > prev.lastUsedAtMs) prev.lastUsedAtMs = ts
			}
			touch(row.accountId)
			touch(row.toAccountId)
		}
		const visibleAccountById = new Map(
			visibleAccountsWithAssets.map((account: any) => [account.id, account])
		)
		const exchangeAccounts = visibleAccountsWithAssets
			.filter((account: any) => account.id !== outsideWalletId)
			.map((account: any) => ({
				id: account.id,
				assets: (account.assets ?? []).map((asset: any) => ({
					currency: String(asset.currency ?? account.currency ?? '').toUpperCase(),
					amount: Number(asset.amount ?? 0)
				}))
			}))
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

		for (const tx of normalizedTransactions) {
			if (tx.currency) {
				tx.currency = String(tx.currency).toUpperCase().trim()
			}
				if (tx.currency && !supportedCurrencies.has(tx.currency)) {
					await this.preserveTransactionDraftOnError(
						ctx,
						tx,
						['поддерживаемая валюта'],
						`Валюта ${tx.currency} не поддерживается.`
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
				const uniqueCurrenciesInText = new Set(
					this.extractAmountCurrencyPairs(sourceText).map(pair => pair.currency)
				)
				const hasCryptoContext =
					/\b(?:btc|eth|usdt|usdc|bnb|sol|xrp|ada|doge|ton|крипт|токен|token|coin|монет)\b/iu.test(
						sourceText
					)
				const hasTradeVerb = /\b(?:buy|sell|купил|купила|продал|продажа)\b/iu.test(sourceText)
				const exchangeHint =
					/(валютообмен|обмен|конвертац|swap|exchange)/iu.test(sourceText) ||
					/\b[a-z]{2,10}\s*\/\s*[a-z]{2,10}\b/iu.test(sourceText) ||
					(hasTradeVerb &&
						(hasCryptoContext || uniqueCurrenciesInText.size >= 2))
				const exchangeIntent = extractExchangeIntentFromText(
					sourceText,
					this.extractAmountCurrencyPairs(sourceText)
				)
				if (exchangeHint && exchangeIntent) {
					this.logger.debug(
						`exchange-resolver: intent source=${exchangeIntent.sourceAmount ?? '?'} ${
							exchangeIntent.sourceCurrency ?? '?'
						} target=${exchangeIntent.targetAmount ?? '?'} ${
							exchangeIntent.targetCurrency ?? '?'
						} explicit=${exchangeIntent.explicitPair}`
					)
				}
				const descriptionText = String(tx.description ?? '').toLowerCase()
				const cashOutHint =
					/(снял[аи]?\s+налич|снятие\s+налич|cashout|cash out)/iu.test(
						descriptionText
					) || /\bобнал\b/iu.test(sourceText)
			if (transferHint) {
				tx.direction = 'transfer'
			}
			if (exchangeHint && !this.isFeeLikeTransaction(tx)) {
				tx.direction = 'transfer'
				;(tx as any).__exchangeLike = true
				if (!tx.currency && exchangeIntent?.sourceCurrency) {
					tx.currency = exchangeIntent.sourceCurrency
				}
				if (
					!(typeof tx.amount === 'number' && Number.isFinite(tx.amount) && tx.amount > 0) &&
					exchangeIntent?.sourceAmount
				) {
					tx.amount = exchangeIntent.sourceAmount
				}
				if (!tx.convertToCurrency && exchangeIntent?.targetCurrency) {
					tx.convertToCurrency = exchangeIntent.targetCurrency
				}
				if (
					!(
						typeof tx.convertedAmount === 'number' &&
						Number.isFinite(tx.convertedAmount) &&
						tx.convertedAmount > 0
					) &&
					exchangeIntent?.targetAmount
				) {
					tx.convertedAmount = exchangeIntent.targetAmount
					;(tx as any).__conversionSource = 'explicit'
				}
			}
				if (cashOutHint) {
					tx.direction = 'transfer'
					if (!tx.tag_text) {
						tx.tag_text = 'обнал'
						tx.normalized_tag = 'обнал'
						tx.tag_confidence = Math.max(Number(tx.tag_confidence ?? 0), 0.95)
					}
				}
				const weakCategory =
					!tx.category ||
					tx.category === 'Не выбрано' ||
					(fallbackCategoryName != null && tx.category === fallbackCategoryName)
				if (weakCategory || !tx.tag_text) {
					const similar = findSimilar(tx.description)
					if (similar) {
						if (weakCategory) {
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
			if (!tx.tag_text && this.isFeeLikeTransaction(tx)) {
				tx.tag_text = 'комиссия'
				tx.normalized_tag = 'комиссия'
				tx.tag_confidence = Math.max(Number(tx.tag_confidence ?? 0), 0.95)
			}
			tx.description = this.normalizeDescription(tx.description, tx.direction)
		}

		for (const tx of normalizedTransactions) {
			tx.userTimezone = user.timezone ?? 'UTC+02:00'
			if (typeof tx.amount === 'number' && Number.isFinite(tx.amount)) {
				tx.amount = Math.abs(tx.amount)
			}
			const isTransfer = tx.direction === 'transfer'
			const isExchangeLike = isTransfer && Boolean((tx as any).__exchangeLike)
				const parsedAccountStr = isTransfer
					? (tx.fromAccount && String(tx.fromAccount).trim()) || (tx.account && String(tx.account).trim()) || ''
					: (tx.account && String(tx.account).trim()) || ''
				const matched = parsedAccountStr ? matchAccountByName(parsedAccountStr) : null
				const matchedAccountId = matched?.id ?? null
				const isExplicitOutsideFrom =
					isTransfer &&
					normalizeAccountAlias(parsedAccountStr).toLowerCase() ===
						'вне wallet'
				tx.accountId = isTransfer
					? isExplicitOutsideFrom
						? outsideWalletId ?? defaultAccountId
						: matchedAccountId ?? (parsedAccountStr ? defaultAccountId : outsideWalletId ?? defaultAccountId)
					: matchedAccountId ?? defaultAccountId
				let acc = matchedAccountId
					? userAccounts.find((a: any) => a.id === matchedAccountId)
					: defaultAccount
				tx.account = isExplicitOutsideFrom
					? 'Вне Wallet'
					: acc?.name ?? defaultAccount?.name ?? null
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
				const sourceCurrency = String(tx.currency ?? '').toUpperCase()
				const exchangeSourceId =
					isExchangeLike && !isExplicitOutsideFrom
						? matchedAccountId ??
								pickSourceAccountId({
									accounts: exchangeAccounts,
									statsByAccountId: accountStatsById,
									sourceCurrency,
									requiredAmount: Number(tx.amount ?? 0),
									defaultAccountId
								})
							: null
				if (exchangeSourceId) {
					tx.accountId = exchangeSourceId
					tx.account = visibleAccountById.get(exchangeSourceId)?.name ?? tx.account
					this.logger.debug(
						`exchange-resolver: source account selected accountId=${exchangeSourceId} currency=${sourceCurrency}`
					)
				}
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
						if (isExchangeLike) {
							const targetCurrency = String(tx.convertToCurrency ?? '').toUpperCase()
								const targetId =
									pickTargetAccountId({
										accounts: exchangeAccounts,
										statsByAccountId: accountStatsById,
										targetCurrency,
										defaultAccountId
									}) ?? tx.accountId
								tx.toAccountId = targetId
								tx.toAccount = visibleAccountById.get(targetId ?? '')?.name ?? tx.account
						} else {
							tx.toAccountId = outsideWalletId
							tx.toAccount = 'Вне Wallet'
						}
					}
				} else {
					if (isExchangeLike) {
						const targetCurrency = String(tx.convertToCurrency ?? '').toUpperCase()
							const targetId =
								pickTargetAccountId({
									accounts: exchangeAccounts,
									statsByAccountId: accountStatsById,
									targetCurrency,
									defaultAccountId
								}) ?? tx.accountId
							tx.toAccountId = targetId
							tx.toAccount = visibleAccountById.get(targetId ?? '')?.name ?? tx.account
					} else {
						tx.toAccountId = outsideWalletId
						tx.toAccount = 'Вне Wallet'
					}
				}
				if (!tx.accountId) {
					tx.accountId = isExchangeLike
						? defaultAccountId
						: outsideWalletId ?? defaultAccountId
					tx.account =
						tx.accountId === outsideWalletId ? 'Вне Wallet' : defaultAccount?.name
				}
				if (isExchangeLike && outsideWalletId && tx.accountId === outsideWalletId) {
					tx.accountId = defaultAccountId
					tx.account = defaultAccount?.name ?? tx.account
				}
				if (
					!isExchangeLike &&
					outsideWalletId &&
					tx.accountId === outsideWalletId &&
					tx.toAccountId === outsideWalletId &&
					defaultAccountId &&
					defaultAccountId !== outsideWalletId
				) {
					tx.accountId = defaultAccountId
					tx.account = defaultAccount?.name ?? tx.account
				}
				if (
					isExchangeLike &&
					tx.toAccountId &&
					tx.toAccount &&
					tx.convertToCurrency
				) {
					this.logger.debug(
						`exchange-resolver: target account selected toAccountId=${tx.toAccountId} convertToCurrency=${String(
							tx.convertToCurrency
						).toUpperCase()}`
					)
				}
			}
				const accountForTx =
					tx.accountId &&
					visibleAccountsWithAssets.find(
						(a: any) => a.id === tx.accountId
					)
				const accountAssets =
					accountForTx?.assets?.map((asset: any) => ({
						currency: String(
							asset.currency ?? accountForTx?.currency ?? ''
						).toUpperCase(),
						amount: Number(asset.amount ?? 0)
					})) ?? []
				const currencyResolution: CurrencyResolutionResult =
					resolveTransactionCurrency({
						rawText: String(tx.rawText ?? ''),
						description: String(tx.description ?? ''),
						llmCurrency: String(tx.currency ?? ''),
						direction: tx.direction,
						amount: Number(tx.amount ?? 0),
						assets: accountAssets,
						fallbackAccountCurrency: String(
							accountForTx?.currency ?? defaultAccount?.currency ?? ''
						),
						supportedCurrencies
					})
				if (currencyResolution.currency) {
					tx.currency = currencyResolution.currency
				}
				;(tx as any).currencyResolution = currencyResolution
				const normalizeText = `${tx.rawText ?? ''} ${tx.description ?? ''}`.toLowerCase()
				const textExchangeIntent = extractExchangeIntentFromText(
					normalizeText,
					this.extractAmountCurrencyPairs(normalizeText)
				)
				if (
					isTransfer &&
					(Boolean((tx as any).__exchangeLike) ||
						(Boolean(tx.convertToCurrency) && tx.convertToCurrency !== tx.currency))
				) {
					;(tx as any).__exchangeLike = true
					if (!tx.convertToCurrency && textExchangeIntent?.targetCurrency) {
						tx.convertToCurrency = textExchangeIntent.targetCurrency
					}
					if (
						!(
							typeof tx.convertedAmount === 'number' &&
							Number.isFinite(tx.convertedAmount) &&
							tx.convertedAmount > 0
						) &&
						textExchangeIntent?.targetAmount
					) {
						tx.convertedAmount = Math.abs(Number(textExchangeIntent.targetAmount))
						;(tx as any).__conversionSource = 'explicit'
					}
					if (tx.convertToCurrency) {
						tx.convertToCurrency = String(tx.convertToCurrency).toUpperCase().trim()
						if (!supportedCurrencies.has(tx.convertToCurrency)) {
							await this.preserveTransactionDraftOnError(
								ctx,
								tx,
								['поддерживаемая валюта конвертации'],
								`Валюта ${tx.convertToCurrency} не поддерживается.`
							)
							return
						}
						if (
							!(
								typeof tx.convertedAmount === 'number' &&
								Number.isFinite(tx.convertedAmount) &&
								tx.convertedAmount > 0
							) &&
							typeof tx.amount === 'number' &&
							Number.isFinite(tx.amount) &&
							tx.amount > 0 &&
							tx.currency &&
							tx.currency !== tx.convertToCurrency
						) {
							const converted = await this.exchangeService.convert(
								Math.abs(tx.amount),
								tx.currency,
								tx.convertToCurrency
							)
							if (converted == null) {
								await this.preserveTransactionDraftOnError(
									ctx,
									tx,
									['конвертация по курсу'],
									`Не удалось получить курс для обмена ${tx.currency} → ${tx.convertToCurrency}.`
								)
								return
							}
							tx.convertedAmount = Math.abs(converted)
							;(tx as any).__conversionSource = 'rate'
						}
						this.logger.debug(
							`exchange-resolver: conversion source=${String(
								(tx as any).__conversionSource ?? 'unknown'
							)} ${tx.currency}->${tx.convertToCurrency}`
						)
					}
				}
				if (tx.currency && !supportedCurrencies.has(String(tx.currency).toUpperCase())) {
					await this.preserveTransactionDraftOnError(
						ctx,
						tx,
						['поддерживаемая валюта'],
						`Валюта ${tx.currency} не поддерживается.`
					)
					return
				}
					if (
						accountForTx &&
						(!accountForTx.assets || accountForTx.assets.length === 0)
					) {
					const accountName = accountForTx.name || 'Основной счёт'
					await this.preserveTransactionDraftOnError(
						ctx,
						tx,
						['счёт с добавленными активами'],
						`На счёте «${accountName}» нет активов для этой операции.`
					)
					return
				}
				if (!tx.category || !categoryNames.includes(tx.category)) {
					tx.category = fallbackCategoryName
				}
				const matchedCategory = tx.category
					? visibleCategories.find(c => c.name === tx.category)
					: undefined
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
									a => String(a.currency || account.currency).toUpperCase()
								)
							)
						)
						const txCurrency = String(tx.currency ?? '').toUpperCase()
						const hasCurrencyOnAccount = codes.includes(txCurrency)
						const isDebitOperation =
							tx.direction === 'expense' || tx.direction === 'transfer'
							if (
								isDebitOperation &&
								tx.accountId !== outsideWalletId &&
								!hasCurrencyOnAccount
							) {
								await this.preserveTransactionDraftOnError(
									ctx,
									tx,
									[`актив ${tx.currency} на счёте`],
									`Нельзя создать операцию: на счёте «${account.name}» нет актива ${tx.currency}.`
								)
								return
							}
						if (!hasCurrencyOnAccount) {
							if (!Boolean((tx as any).__exchangeLike)) {
								tx.convertToCurrency = undefined
								tx.convertedAmount = undefined
							}
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

			const hasTransactionalSignal = normalizedTransactions.some(
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
			const firstInvalid = normalizedTransactions.find(tx => {
				const missing = this.getMissingCriticalFields(tx, outsideWalletId)
				;(tx as any).__missing = missing
				return missing.length > 0
			}) as any
			if (firstInvalid) {
				const missing = (firstInvalid.__missing as string[]) ?? []
				await this.preserveTransactionDraftOnError(
					ctx,
					firstInvalid,
					missing,
					`Не хватает данных для создания операции.`
				)
				return
			}

			const createdDrafts: any[] = []
			const autoCreatedTxIds: string[] = []
			try {
				for (const draft of normalizedTransactions as any[]) {
					const accountId =
						draft.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
					if (!accountId) {
						throw new Error('Не выбран счёт для операции.')
					}
					let tagId = draft.tagId
					if (draft.tagIsNew && draft.tagName && !tagId) {
						const createdTag = await this.tagsService.create(user.id, draft.tagName)
						tagId = createdTag.id
					}
					if (tagId) {
						await this.tagsService.incrementUsage(tagId)
					}
					const isTransfer = draft.direction === 'transfer'
					const toAccountId = isTransfer
						? draft.toAccountId ??
							((draft as any).__exchangeLike
								? accountId
								: outsideWalletId ?? undefined)
						: undefined
					const createdTx = await this.transactionsService.create({
						accountId,
						amount: draft.amount,
						currency: draft.currency,
						direction: draft.direction,
						...(isTransfer
							? {
									fromAccountId: accountId,
									toAccountId
								}
							: {
									categoryId: draft.categoryId ?? undefined,
									category: draft.category ?? '📦Другое'
								}),
						description: draft.description,
						rawText: draft.rawText || '',
						userId: ctx.state.user.id,
						tagId: tagId ?? undefined,
						convertedAmount: draft.convertedAmount,
						convertToCurrency: draft.convertToCurrency,
						transactionDate: draft.transactionDate
							? normalizeTxDate(draft.transactionDate) ?? undefined
							: undefined
					})
					createdDrafts.push({
						...draft,
						id: createdTx.id,
						accountId,
						tagId: tagId ?? undefined,
						tagIsNew: false
					})
					autoCreatedTxIds.push(createdTx.id)
				}
				} catch (error: unknown) {
					for (const txId of autoCreatedTxIds) {
						await this.transactionsService.delete(txId, ctx.state.user.id).catch(() => {})
					}
					const err = error instanceof Error ? error : new Error(String(error))
					await this.preserveTransactionDraftOnError(
						ctx,
						(normalizedTransactions[0] as any) ?? null,
						[],
						`Не удалось создать операции: ${err.message}.`
					)
					return
				}

			activateInputMode(ctx, 'transaction_edit', {
				awaitingTransaction: false,
				confirmingTransaction: true,
				draftTransactions: createdDrafts,
				currentTransactionIndex: 0,
				autoCreatedTxIdsForCurrentParse: autoCreatedTxIds
			})

			const firstCreated = createdDrafts[0] as any
			const firstAccountId = firstCreated?.accountId ?? defaultAccountId
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
				firstCreated.currency && accountCurrencies.includes(firstCreated.currency)
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
						firstCreated,
						0,
						createdDrafts.length,
						user.defaultAccountId,
						undefined,
						'Просмотр транзакций'
					),
				{
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard(
						createdDrafts.length,
						0,
						showConversion,
						firstCreated?.direction === 'transfer',
						false
					)
				}
			)
			ctx.session.tempMessageId = msg.message_id
			ctx.session.previewMessageId = msg.message_id
			ctx.session.resultMessageIds = [
				...((ctx.session.resultMessageIds ?? []) as number[]),
				msg.message_id
			]
				await renderHome(ctx as any, this.accountsService, this.analyticsService, {
					forceNewMessage: true,
					preservePreviousMessages: true
				})
			}
		}

