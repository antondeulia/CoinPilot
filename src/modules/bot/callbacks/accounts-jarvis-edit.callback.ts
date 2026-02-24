import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { LLMService } from '../../../modules/llm/llm.service'
import { activateInputMode } from '../core/input-mode'

export const accountsJarvisEditCallback = (
	bot: Bot<BotContext>,
	llmService: LLMService
) => {
	bot.callbackQuery('accounts_jarvis_edit', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		activateInputMode(ctx, 'account_jarvis_edit', {
			editingAccountField: 'jarvis'
		})

		const msg = await ctx.reply(
			`Режим Jarvis-редактирования.

Опишите, что нужно изменить в этом счёте.
Например: убери доллары и замени грн на 50к грн.`,
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
			'Отправьте новое название счёта (текст или голос).',
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

		const msg = await ctx.reply(
			`➕ <b>Добавь счёт</b>

Например:
monobank 3k EUR 500k UAH and 30k usd, Wise 1000 GBP`,
			{
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_account')
			}
		)

		;(ctx.session as any).accountInputHintMessageId = msg.message_id
		ctx.session.tempMessageId = undefined
	})
}
