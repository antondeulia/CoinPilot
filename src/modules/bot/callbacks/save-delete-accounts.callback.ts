import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { UsersService } from 'src/modules/users/users.service'
import { refreshAccountsPreview } from './accounts-preview.callback'
import { homeKeyboard, homeText } from 'src/shared/keyboards/home'

export const saveDeleteAccountsCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	usersService: UsersService
) => {
	bot.callbackQuery('confirm_1_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		const index = ctx.session.currentAccountIndex ?? 0

		if (!drafts || !drafts.length) return

		const draft = drafts[index]

		await accountsService.createAccountWithAssets(ctx.state.user.id, draft)

		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftAccounts = undefined
			ctx.session.currentAccountIndex = undefined
			ctx.session.confirmingAccounts = false
			ctx.session.awaitingAccountInput = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}

			await ctx.reply('Счёт сохранён.')

			const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
			const account = user.accounts.find(a => a.id === user.activeAccountId)
			if (account) {
				const mainCurrency = (user as any).mainCurrency ?? 'USD'
				const balance = await accountsService.getBalance({
					userId: user.id,
					mainCurrency
				})
				const homeMsg = await ctx.reply(homeText(account, balance), {
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance, mainCurrency)
				})
				ctx.session.homeMessageId = homeMsg.message_id
			}
			return
		}

		ctx.session.currentAccountIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('cancel_1_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		const index = ctx.session.currentAccountIndex ?? 0

		if (!drafts || !drafts.length) return

		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftAccounts = undefined
			ctx.session.currentAccountIndex = undefined
			ctx.session.confirmingAccounts = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}

			return
		}

		ctx.session.currentAccountIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('confirm_all_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		for (const draft of drafts) {
			await accountsService.createAccountWithAssets(ctx.state.user.id, draft)
		}

		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false
		ctx.session.awaitingAccountInput = false

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}

		await ctx.reply('Все счета сохранены.')

		const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
		const account = user.accounts.find(a => a.id === user.activeAccountId)
		if (account) {
			const mainCurrency = (user as any).mainCurrency ?? 'USD'
			const balance = await accountsService.getBalance({
				userId: user.id,
				mainCurrency
			})
			const homeMsg = await ctx.reply(homeText(account, balance), {
				parse_mode: 'HTML',
				reply_markup: homeKeyboard(account, balance, mainCurrency)
			})
			ctx.session.homeMessageId = homeMsg.message_id
		}
	})

	bot.callbackQuery('cancel_all_accounts', async ctx => {
		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
	})
}
