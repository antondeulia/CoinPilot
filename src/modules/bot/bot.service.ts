import { Injectable, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Bot, session } from 'grammy'
import { UsersService } from '../users/users.service'
import { TransactionsService } from '../transactions/transactions.service'
import { LLMService } from '../llm/llm.service'
import { LlmTransaction } from '../llm/schemas/transaction.schema'
import { BotContext, userContextMiddleware } from './core/bot.middleware'
import { PrismaService } from '../prisma/prisma.service'
import { AccountsService } from '../accounts/accounts.service'
import { accountInfoText } from 'src/utils'
import { accountSwitchKeyboard, transactionsKeyboard } from 'src/shared/keyboards'
import { homeKeyboard, homeText } from 'src/shared/keyboards/home'
import { startCommand } from './commands/start.command'
import { confirmKeyboard, confirmTxCallback } from './callbacks/confirm-tx'
import { addTxCallback } from './callbacks/add-transaction.command'
import { cancelTxCallback } from './callbacks/cancel-tx'
import { editTxCallback } from './callbacks'
import { renderConfirmMessage } from './elements/tx-confirm-msg'
import { hideMessageCallback } from './callbacks/hide-message.callback'

@Injectable()
export class BotService implements OnModuleInit {
	private readonly bot: Bot<BotContext>

	constructor(
		private readonly config: ConfigService,
		private readonly usersService: UsersService,
		private readonly transactionsService: TransactionsService,
		private readonly llmService: LLMService,
		private readonly prisma: PrismaService,
		private readonly accountsService: AccountsService
	) {
		const token = this.config.getOrThrow<string>('BOT_TOKEN')
		this.bot = new Bot<BotContext>(token)
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

		this.bot.use(userContextMiddleware(this.usersService, this.prisma))

		// Commands
		startCommand(this.bot, this.accountsService)

		// Callbacks
		addTxCallback(this.bot)
		confirmTxCallback(this.bot, this.transactionsService, this.accountsService)
		cancelTxCallback(this.bot, this.accountsService)
		editTxCallback(this.bot, this.accountsService)

		hideMessageCallback(this.bot)

		this.bot.callbackQuery('go_home', async ctx => {
			const account = ctx.state.activeAccount
			if (!account) return

			const balance = await this.accountsService.getBalance({
				userId: ctx.state.user.id
			})

			await ctx.api.editMessageText(
				// @ts-ignore
				ctx.chat.id,
				// @ts-ignore
				ctx.session.homeMessageId,
				homeText(account, balance),
				{
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance)
				}
			)
		})

		this.bot.callbackQuery('view_accounts', async ctx => {
			await ctx.answerCallbackQuery()

			await this.closeTemp(ctx)

			const user = ctx.state.user
			const account = ctx.state.activeAccount
			if (!account) return

			const msg = await ctx.reply(accountInfoText(account), {
				parse_mode: 'HTML',
				// @ts-ignore
				reply_markup: accountSwitchKeyboard(user.accounts, user.activeAccountId)
			})

			// @ts-ignore
			ctx.session.tempMessageId = msg.message_id
		})

		this.bot.callbackQuery('view_transactions', async ctx => {
			await ctx.answerCallbackQuery()

			await this.closeTemp(ctx)

			const account = ctx.state.activeAccount
			if (!account) return

			const txs = await this.prisma.transaction.findMany({
				where: { accountId: account.id },
				orderBy: { createdAt: 'desc' },
				take: 10
			})

			const msg = await ctx.reply('<b>Транзакции</b>', {
				parse_mode: 'HTML',
				reply_markup: transactionsKeyboard(txs)
			})

			// @ts-ignore
			ctx.session.tempMessageId = msg.message_id
		})

		this.bot.callbackQuery(/^tx:/, async ctx => {
			const txId = ctx.callbackQuery.data.split(':')[1]

			const tx = await this.prisma.transaction.findUnique({
				where: { id: txId }
			})
			if (!tx) return

			await ctx.answerCallbackQuery()

			await ctx.reply(
				`
<b>Транзакция</b>

Тип: ${tx.direction === 'expense' ? 'Расход' : 'Доход'}
Сумма: ${tx.amount} ${tx.currency}
Категория: ${tx.category ?? '—'}
Описание: ${tx.description ?? '—'}
Дата: ${new Date(tx.createdAt).toLocaleString('ru-RU')}
`,
				{ parse_mode: 'HTML' }
			)
		})

		this.bot.callbackQuery(/^current_account:/, async ctx => {
			const accountId = ctx.callbackQuery.data.split(':')[1]

			const user = ctx.state.user
			// @ts-ignore
			const account = user.accounts.find(a => a.id === accountId)

			if (!account) return

			await ctx.editMessageText(accountInfoText(account), {
				parse_mode: 'HTML',
				// @ts-ignore
				reply_markup: accountSwitchKeyboard(user.accounts, user.activeAccountId)
			})

			await ctx.answerCallbackQuery()
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
			const accountId = ctx.callbackQuery.data.split(':')[1]

			await this.accountsService.setActive(ctx.state.user.id, accountId)
			await ctx.answerCallbackQuery()

			// @ts-ignore
			await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id)

			const user = await this.usersService.getOrCreateByTelegramId(
				String(ctx.from!.id)
			)

			const account = user.accounts.find(a => a.id === user.activeAccountId)!
			const balance = await this.accountsService.getBalance({ userId: user.id })

			try {
				await ctx.api.editMessageText(
					// @ts-ignore
					ctx.chat.id,
					// @ts-ignore
					ctx.session.homeMessageId,
					homeText(account, balance),
					{
						parse_mode: 'HTML',
						reply_markup: homeKeyboard(account, balance)
					}
				)
			} catch {
				const msg = await ctx.reply(homeText(account, balance), {
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance)
				})
				// @ts-ignore
				ctx.session.homeMessageId = msg.message_id
			}
		})

		this.bot.callbackQuery('add_account', async ctx => {
			// @ts-ignore
			ctx.session.awaitingAccount = true
			await ctx.reply('Введите: Название Валюта\nПример: Bank EUR', {})
		})

		this.bot.on('message:text', async ctx => {
			const text = ctx.message.text.trim()

			if (ctx.session.editingField && ctx.session.draftTransaction) {
				const field = ctx.session.editingField
				const value = text

				switch (field) {
					case 'description':
						ctx.session.draftTransaction.description = value
						break

					case 'amount': {
						const amount = Number(value.replace(',', '.'))
						if (isNaN(amount)) {
							await ctx.reply('Введите корректную сумму')
							return
						}
						ctx.session.draftTransaction.amount = amount
						break
					}

					case 'category':
						ctx.session.draftTransaction.category = value
						break

					case 'date': {
						const date = new Date(value)
						if (isNaN(date.getTime())) {
							await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ')
							return
						}
						break
					}
				}

				ctx.session.editingField = undefined

				await ctx.reply(renderConfirmMessage(ctx.session.draftTransaction), {
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard
				})

				return
			}

			if (ctx.session.awaitingTransaction) {
				let parsed: LlmTransaction

				try {
					parsed = await this.llmService.parseTransaction(text)
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

				const hasAnyField =
					typeof parsed.amount === 'number' ||
					(typeof parsed.description === 'string' &&
						parsed.description.trim().length > 0)

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
				ctx.session.draftTransaction = parsed

				const msg = await ctx.reply(renderConfirmMessage(parsed), {
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard
				})

				ctx.session.tempMessageId = msg.message_id
				return
			}

			await ctx.reply(
				'Пока я умею только добавлять транзакции через кнопку «+ Создать транзакцию».'
			)
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
