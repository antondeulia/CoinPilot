import { Injectable, OnModuleInit } from '@nestjs/common'
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
import { FREE_LIMITS } from '../subscription/subscription.constants'
import { PremiumEventType } from '../../generated/prisma/enums'
import { accountInfoText } from '../../utils'
import { accountSwitchKeyboard } from '../../shared/keyboards'
import { viewAccountsListText, accountDetailsText } from './elements/accounts'
import { homeKeyboard, homeText } from '../../shared/keyboards/home'
import { startCommand } from './commands/start.command'
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

@Injectable()
export class BotService implements OnModuleInit {
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
		private readonly subscriptionService: SubscriptionService
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
			console.error('Bot error:', err.message)
		})

		// Commands
		startCommand(this.bot, this.accountsService)

		// Callbacks
		addTxCallback(this.bot)
		confirmTxCallback(
			this.bot,
			this.transactionsService,
			this.accountsService,
			this.tagsService,
			this.subscriptionService
		)
		cancelTxCallback(this.bot, this.accountsService)
		editTxCallback(this.bot, this.accountsService)
		editTypeCallback(this.bot, this.accountsService)
		editDescriptionCallback(this.bot)
		editAmountCallback(this.bot)
		editAccountCallback(this.bot, this.accountsService)
		editTargetAccountCallback(this.bot, this.accountsService)
		editDateCallback(this.bot)
		editCategoryCallback(this.bot, this.categoriesService, this.accountsService)
		editTagCallback(this.bot, this.tagsService, this.accountsService)
		editCurrencyCallback(this.bot, this.accountsService, this.exchangeService)
		editConversionCallback(this.bot, this.accountsService, this.exchangeService)
		paginationTransactionsCallback(this.bot, this.accountsService)
		closeEditCallback(this.bot, this.accountsService)
		repeatParseCallback(this.bot)
		saveDeleteCallback(
			this.bot,
			this.transactionsService,
			this.accountsService,
			this.tagsService,
			this.subscriptionService
		)
		editAccountCallback(this.bot, this.accountsService)
		accountsPaginationCallback(this.bot, this.subscriptionService)
		addAccountCallback(this.bot)
		accountsPreviewCallbacks(this.bot)
		accountsJarvisEditCallback(this.bot, this.llmService)
		saveDeleteAccountsCallback(
			this.bot,
			this.accountsService,
			this.usersService,
			this.subscriptionService
		)
		viewTransactionsCallback(
			this.bot,
			this.prisma,
			this.transactionsService,
			this.accountsService
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
		analyticsMainCallback(this.bot, this.analyticsService)
		analyticsCategoriesCallback(this.bot, this.analyticsService, this.prisma)
		analyticsTagsCallback(this.bot, this.analyticsService)
		analyticsTypeCallback(this.bot, this.analyticsService)
		analyticsFilterCallback(this.bot)
		analyticsSavedCallback(this.bot, this.prisma)
		analyticsChartCallback(this.bot, this.prisma, this.exchangeService)
		analyticsExportCallback(
			this.bot,
			this.prisma,
			this.subscriptionService
		)
		analyticsAlertsCallback(this.bot)
		premiumCallback(this.bot, this.subscriptionService)

		hideMessageCallback(this.bot)

		this.bot.callbackQuery('go_home', async ctx => {
			const stack = ctx.session.navigationStack ?? []
			stack.pop()
			ctx.session.navigationStack = stack
			;(ctx.session as any).editingCurrency = false
			;(ctx.session as any).editingMainCurrency = false
			ctx.session.editingField = undefined

			const account = ctx.state.activeAccount
			if (!account) return
			const mainCurrency = (ctx.state.user as any).mainCurrency ?? 'USD'
			const balance = await this.accountsService.getBalance({
				userId: ctx.state.user.id,
				mainCurrency
			})

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				homeText(account, balance),
				{
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance, mainCurrency)
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

			const account = ctx.state.activeAccount
			if (!account) return
			const mainCurrency = (ctx.state.user as any).mainCurrency ?? 'USD'
			const balance = await this.accountsService.getBalance({
				userId: ctx.state.user.id,
				mainCurrency
			})

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				homeText(account, balance),
				{
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance, mainCurrency)
				}
			)
		})

		this.bot.callbackQuery('view_accounts', async ctx => {
			await this.closeTemp(ctx)

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
				user.defaultAccountId
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
						user.accounts,
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
			// @ts-ignore
			const account = user.accounts.find(a => a.id === accountId)

			if (!account) return

			const frozen = await this.subscriptionService.getFrozenItems(user.id)
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			await ctx.editMessageText(accountInfoText(account), {
				parse_mode: 'HTML',
				// @ts-ignore
				reply_markup: accountSwitchKeyboard(
					user.accounts,
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
			const account = await this.accountsService.getOneWithAssets(
				accountId,
				user.id
			)
			if (!account) return

			ctx.session.accountsViewSelectedId = accountId
			const page = ctx.session.accountsViewPage ?? 0
			const frozen = await this.subscriptionService.getFrozenItems(user.id)
			const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			const mainCurrency = user.mainCurrency ?? 'USD'
			const text = await accountDetailsText(
				account,
				mainCurrency,
				this.exchangeService,
				account.id === user.defaultAccountId
			)

			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				text,
				{
					parse_mode: 'HTML',
					reply_markup: accountSwitchKeyboard(
						user.accounts,
						user.activeAccountId,
						page,
						accountId,
						user.defaultAccountId,
						frozenAccountIds
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
			const text = await viewAccountsListText(
				accountsWithAssets,
				user.mainCurrency ?? 'USD',
				this.exchangeService,
				user.defaultAccountId
			)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				text,
				{
					parse_mode: 'HTML',
					reply_markup: accountSwitchKeyboard(
						user.accounts,
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
			ctx.session.editingAccountDetailsId = selectedId
			const msg = await ctx.reply(
				'Режим Jarvis-редактирования счёта.\n\nОпишите, что изменить: название, добавить/удалить валюты, изменить суммы.',
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

		this.bot.callbackQuery('add_account', async ctx => {
			// заглушка, реальная логика вынесена в addAccountCallback
		})

		this.bot.callbackQuery('view_settings', async ctx => {
			await this.closeTemp(ctx)

			ctx.session.navigationStack = [...(ctx.session.navigationStack ?? []), 'home']

			const user: any = ctx.state.user
			const mainCode = user?.mainCurrency ?? 'USD'
			const defaultAccount =
				user.accounts.find(a => a.id === user.defaultAccountId) ??
				user.accounts[0]
			const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
			const tariffStr = ctx.state.isPremium
				? user.premiumUntil
					? `Premium (до ${new Date(user.premiumUntil).toLocaleDateString('ru-RU')})`
					: 'Premium (навсегда)'
				: 'Free'
			const settingsText = `<b>⚙️ Настройки</b>\n\nВаш тариф: ${tariffStr}\nОсновная валюта: ${mainCode}\nОсновной счёт: ${defaultAccountName}`
			const kb = new InlineKeyboard()
				.text('Основная валюта', 'main_currency_open')
				.row()
				.text('Основной счёт', 'default_account_open')
				.row()
				.text('Категории', 'view_categories')
				.row()
				.text('Теги', 'view_tags')
				.row()
				.text('🠐 Назад', 'go_home')

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				settingsText,
				{ parse_mode: 'HTML', reply_markup: kb }
			)
		})

		this.bot.callbackQuery('main_currency_open', async ctx => {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				'Введите одну валюту, например: USD, доллар, $, евро, UAH.',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'back_to_settings')
				}
			)
			;(ctx.session as any).editingMainCurrency = true
			ctx.session.editMessageId = ctx.callbackQuery.message!.message_id
		})
		this.bot.callbackQuery('back_to_settings', async ctx => {
			;(ctx.session as any).editingMainCurrency = false
			const user: any = ctx.state.user
			const mainCode = user?.mainCurrency ?? 'USD'
			const defaultAccount =
				user.accounts.find(a => a.id === user.defaultAccountId) ??
				user.accounts[0]
			const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
			const tariffStr = ctx.state.isPremium
				? user.premiumUntil
					? `Premium (до ${new Date(user.premiumUntil).toLocaleDateString('ru-RU')})`
					: 'Premium (навсегда)'
				: 'Free'
			const settingsText = `<b>⚙️ Настройки</b>\n\nВаш тариф: ${tariffStr}\nОсновная валюта: ${mainCode}\nОсновной счёт: ${defaultAccountName}`
			const kb = new InlineKeyboard()
				.text('Основная валюта', 'main_currency_open')
				.row()
				.text('Основной счёт', 'default_account_open')
				.row()
				.text('Категории', 'view_categories')
				.row()
				.text('Теги', 'view_tags')
				.row()
				.text('🠐 Назад', 'go_home')
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				settingsText,
				{ parse_mode: 'HTML', reply_markup: kb }
			)
		})
		this.bot.callbackQuery(/^main_currency_set:/, async ctx => {
			const code = ctx.callbackQuery.data.replace('main_currency_set:', '')
			await this.usersService.setMainCurrency(ctx.state.user.id, code)
			const user: any = { ...ctx.state.user, mainCurrency: code }
			const defaultAccount =
				user.accounts.find(a => a.id === user.defaultAccountId) ??
				user.accounts[0]
			const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
			const tariffStr = ctx.state.isPremium
				? user.premiumUntil
					? `Premium (до ${new Date(user.premiumUntil).toLocaleDateString('ru-RU')})`
					: 'Premium (навсегда)'
				: 'Free'
			const settingsText = `<b>⚙️ Настройки</b>\n\nВаш тариф: ${tariffStr}\nОсновная валюта: ${code}\nОсновной счёт: ${defaultAccountName}`
			const kb = new InlineKeyboard()
				.text('Основная валюта', 'main_currency_open')
				.row()
				.text('Основной счёт', 'default_account_open')
				.row()
				.text('Категории', 'view_categories')
				.row()
				.text('Теги', 'view_tags')
				.row()
				.text('🠐 Назад', 'go_home')
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				settingsText,
				{ parse_mode: 'HTML', reply_markup: kb }
			)
		})

		this.bot.callbackQuery('default_account_open', async ctx => {
			const user: any = ctx.state.user
			if (!user) return
			;(ctx.session as any).defaultAccountPage = 0
			const kb = new InlineKeyboard()
			const accounts = user.accounts as { id: string; name: string }[]
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
				.text('🠐 Назад', 'back_to_settings')
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
			const accounts = user.accounts as { id: string; name: string }[]
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
				.text('🠐 Назад', 'back_to_settings')
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
			const mainCode = user.mainCurrency ?? 'USD'
			const defaultAccount =
				user.accounts.find(a => a.id === user.defaultAccountId) ??
				user.accounts[0]
			const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
			const tariffStr = ctx.state.isPremium
				? user.premiumUntil
					? `Premium (до ${new Date(user.premiumUntil).toLocaleDateString('ru-RU')})`
					: 'Premium (навсегда)'
				: 'Free'
			const settingsText = `<b>⚙️ Настройки</b>\n\nВаш тариф: ${tariffStr}\nОсновная валюта: ${mainCode}\nОсновной счёт: ${defaultAccountName}`
			const kb = new InlineKeyboard()
				.text('Основная валюта', 'main_currency_open')
				.row()
				.text('Основной счёт', 'default_account_open')
				.row()
				.text('🠐 Назад', 'go_home')
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id,
				settingsText,
				{ parse_mode: 'HTML', reply_markup: kb }
			)
		})

		this.bot.on('message:text', async ctx => {
			const text = ctx.message.text.trim()

			if (ctx.session.awaitingTagInput && ctx.session.draftTransactions) {
				const drafts = ctx.session.draftTransactions
				if (!drafts.length) return
				const index = ctx.session.currentTransactionIndex ?? 0
				const current = drafts[index] as any
				const raw = text.trim()
				if (raw.length > 15) {
					await ctx.reply(
						'Название тега не должно превышать 15 символов. Введите короче.',
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
				const similar = await this.tagsService.findSimilar(
					ctx.state.user.id,
					normalized
				)
				const best = similar[0]
				if (best && best.similarity >= 0.85) {
					current.tagId = best.tag.id
					current.tagName = best.tag.name
					current.tagIsNew = false
				} else {
					current.tagId = undefined
					current.tagName = normalized
					current.tagIsNew = true
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

					default:
						break
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
					await ctx.reply('Не удалось распознать валюту, попробуйте ещё раз.', {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
					return
				}

				await this.usersService.setMainCurrency(ctx.state.user.id, code)

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

				const user: any = await this.usersService.getOrCreateByTelegramId(
					String(ctx.from!.id)
				)
				const mainCode = user.mainCurrency ?? 'USD'
				const defaultAccount =
					user.accounts.find(a => a.id === user.defaultAccountId) ??
					user.accounts[0]
				const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
				const isPrem =
					user.isPremium &&
					(!user.premiumUntil || new Date(user.premiumUntil) > new Date())
				const tariffStr = isPrem
					? user.premiumUntil
						? `Premium (до ${new Date(user.premiumUntil).toLocaleDateString('ru-RU')})`
						: 'Premium (навсегда)'
					: 'Free'
				const settingsText = `<b>⚙️ Настройки</b>\n\nВаш тариф: ${tariffStr}\nОсновная валюта: ${mainCode}\nОсновной счёт: ${defaultAccountName}`
				const kb = new InlineKeyboard()
					.text('Основная валюта', 'main_currency_open')
					.row()
					.text('Основной счёт', 'default_account_open')
					.row()
					.text('🠐 Назад', 'go_home')
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.homeMessageId,
					settingsText,
					{ parse_mode: 'HTML', reply_markup: kb }
				)
				;(ctx.session as any).editingMainCurrency = false
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
				const current = {
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
							`👑 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Free. Разблокируйте безлимит с Premium!`,
							{
								reply_markup: new InlineKeyboard().text(
									'👑 Premium',
									'view_premium'
								)
							}
						)
						return
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
					const detailsText = await accountDetailsText(
						freshAccount,
						mainCurrency,
						this.exchangeService,
						freshAccount.id === user.defaultAccountId
					)
					const page = ctx.session.accountsViewPage ?? 0
					const [freshUser, frozen] = await Promise.all([
						this.usersService.getOrCreateByTelegramId(
							String(ctx.from!.id)
						),
						this.subscriptionService.getFrozenItems(user.id)
					])
					const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
					await ctx.api.editMessageText(
						ctx.chat!.id,
						ctx.session.homeMessageId,
						detailsText,
						{
							parse_mode: 'HTML',
							reply_markup: accountSwitchKeyboard(
								freshUser.accounts,
								freshUser.activeAccountId,
								page,
								accountId,
								freshUser.defaultAccountId ?? undefined,
								frozenAccountIds
							)
						}
					)
				}
				ctx.session.editingAccountDetailsId = undefined
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
						drafts[index] = parsed[0]
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
				try {
					result = await this.llmService.parseTagEdit(currentTagNames, text)
					for (const name of result.delete) {
						const normalized = this.tagsService.normalizeTag(name)
						const tag = tags.find(t => t.name === normalized)
						if (tag) await this.tagsService.delete(tag.id, userId)
					}
					for (const { from, to } of result.rename) {
						const fromNorm = this.tagsService.normalizeTag(from)
						const tag = tags.find(t => t.name === fromNorm)
						if (tag) {
							await this.tagsService.rename(tag.id, userId, to)
							tags = await this.tagsService.getAllByUserId(userId)
						}
					}
					if (result.add.length > 0) {
						const limitTag = await this.subscriptionService.canCreateTag(userId)
						if (
							!limitTag.allowed ||
							limitTag.current + result.add.length > limitTag.limit
						) {
							await ctx.reply(
								'👑 10 кастомных тегов — лимит Free. Разблокируйте безлимит с Premium!',
								{
									reply_markup: new InlineKeyboard().text(
										'👑 Premium',
										'view_premium'
									)
								}
							)
							return
						}
					}
					for (const name of result.add) {
						await this.tagsService.create(userId, name)
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
				if (result.rename?.length) {
					summaryLines.push(
						'Переименовано: ' +
							result.rename.map(r => `«${r.from}» → «${r.to}»`).join(', ')
					)
				}
				if (result.delete?.length) {
					summaryLines.push('Удалено: ' + result.delete.join(', '))
				}
				if (result.add?.length) {
					summaryLines.push('Создано: ' + result.add.join(', '))
				}
				const summaryText =
					summaryLines.length > 0
						? '✅ Изменения применены.\n\n' + summaryLines.join('\n')
						: '✅ Изменения применены.'
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
						const limitCat = await this.subscriptionService.canCreateCategory(userId)
						if (!limitCat.allowed) {
							await this.subscriptionService.trackEvent(
								userId,
								PremiumEventType.limit_hit,
								'categories'
							)
							await ctx.reply(
								'👑 3 кастомных категории — это лимит Free. Premium = безлимитная кастомизация!',
								{
									reply_markup: new InlineKeyboard().text(
										'👑 Premium',
										'view_premium'
									)
								}
							)
							return
						}
						const created = await this.categoriesService.create(
							userId,
							nameInput
						)
						createdName = created.name
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
					await ctx.reply(
						`Успешное добавление новой категории под названием «${createdName}».`,
						{
							reply_markup: successKb
						}
					)
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
				const userCategories = await this.categoriesService.getAllByUserId(
					user.id
				)
				const categoryNames = userCategories.map(c => c.name)
				const existingTags = await this.tagsService.getNamesAndAliases(user.id)
				const userAccounts =
					await this.accountsService.getAllByUserIdIncludingHidden(user.id)
				const accountNames = userAccounts.map((a: any) => a.name)

				try {
					parsed = await this.llmService.parseTransaction(
						text,
						categoryNames,
						existingTags,
						accountNames
					)
				} catch {
					await ctx.reply(
						'Прости, я не смог понять, что ты имеешь в виду 😕\n' +
							'Попробуй, например:\n\n' +
							'• Купил кофе за 120 грн\n' +
							'• Зарплата 1500 USD\n' +
							'• Купил 5 монет BTC'
					)
					return
				}

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

				const defaultAccountId =
					user.defaultAccountId || ctx.state.activeAccount?.id || null
				const defaultAccount = defaultAccountId
					? await this.accountsService.getOneWithAssets(
							defaultAccountId,
							user.id
						)
					: null

				if (
					defaultAccount &&
					(!defaultAccount.assets || defaultAccount.assets.length === 0)
				) {
					await ctx.reply(
						'В связанном счёте отсутствуют активы. Добавьте валюты в счёт.',
						{
							reply_markup: new InlineKeyboard().text(
								'Закрыть',
								'hide_message'
							)
						}
					)
					return
				}

				for (const tx of parsed as any[]) {
					const parsedAccountStr =
						(tx.account && String(tx.account).trim()) || ''
					let matchedAccountId: string | null = null
					if (parsedAccountStr && userAccounts.length) {
						const lower = parsedAccountStr.toLowerCase()
						for (const acc of userAccounts as any[]) {
							const accLower = acc.name.toLowerCase()
							if (
								accLower === lower ||
								accLower.includes(lower) ||
								lower.includes(accLower)
							) {
								matchedAccountId = acc.id
								break
							}
						}
					}
					tx.accountId = matchedAccountId ?? defaultAccountId
					const acc = matchedAccountId
						? userAccounts.find((a: any) => a.id === matchedAccountId)
						: defaultAccount
					tx.account = acc?.name ?? defaultAccount?.name ?? null
					if (!tx.category || !categoryNames.includes(tx.category)) {
						tx.category = 'Не выбрано'
					}
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
								tx.convertedAmount = await this.exchangeService.convert(
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

				const first = parsed[0]
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

				ctx.session.awaitingTransaction = false
				ctx.session.confirmingTransaction = true
				ctx.session.draftTransactions = parsed
				ctx.session.currentTransactionIndex = 0

				const accountCurrencies = defaultAccount
					? Array.from(
							new Set(
								defaultAccount.assets?.map(
									a => a.currency || defaultAccount.currency
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
					renderConfirmMessage(first, 0, parsed.length, user.defaultAccountId),
					{
						parse_mode: 'HTML',
						reply_markup: confirmKeyboard(
							parsed.length,
							0,
							showConversion,
							first?.direction === 'transfer',
							false
						)
					}
				)

				ctx.session.tempMessageId = msg.message_id
				return
			}

			if (ctx.session.awaitingAccountInput) {
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

					if (ctx.session.tempMessageId != null) {
						try {
							await ctx.api.deleteMessage(
								ctx.chat!.id,
								ctx.session.tempMessageId
							)
						} catch {}
						ctx.session.tempMessageId = undefined
					}

					await refreshAccountsPreview(ctx as any)
				} catch (e: any) {
					await ctx.reply('Не удалось распознать счёт, попробуйте ещё раз')
				}
				return
			}
		})

		this.bot.start()
	}

	async closeTemp(ctx) {
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
	}
}
