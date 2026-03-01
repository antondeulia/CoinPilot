import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { activateInputMode } from '../core/input-mode'
import { buildAddAccountPrompt } from './add-account.callback'

export const accountsJarvisEditCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('accounts_jarvis_edit', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		activateInputMode(ctx, 'account_jarvis_edit', {
			editingAccountField: 'jarvis'
		})

		const msg = await ctx.reply(
			`✏️ Меняются только валюта и сумма. Укажите валюту и действие: добавить, убрать или изменить.`,
			{
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard().text('Закрыть', 'close_edit_account')
			}
		)

		ctx.session.editMessageId = msg.message_id
	})

	bot.callbackQuery('accounts_rename', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		activateInputMode(ctx, 'account_rename', {
			editingAccountField: 'name'
		})

		const msg = await ctx.reply(
			'Отправьте новое название счёта.',
			{
				reply_markup: new InlineKeyboard().text('Закрыть', 'close_edit_account')
			}
		)

		ctx.session.editMessageId = msg.message_id
	})

	bot.callbackQuery('repeat_parse_accounts', async ctx => {
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
		}

		activateInputMode(ctx, 'account_parse', {
			awaitingAccountInput: true,
			confirmingAccounts: false,
			draftAccounts: undefined,
			currentAccountIndex: undefined
		})

		const prompt = await buildAddAccountPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(prompt, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_account')
		})

		;(ctx.session as any).accountInputHintMessageId = msg.message_id
		ctx.session.hintMessageId = msg.message_id
		ctx.session.tempMessageId = undefined
	})
}
