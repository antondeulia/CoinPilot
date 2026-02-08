import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

function typeLabel(current: string | undefined, value: 'expense' | 'income' | 'transfer', text: string) {
	const isCurrent = current === value
	return `${isCurrent ? '✅ ' : ''}${text}`
}

export const editTypeCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	bot.callbackQuery('edit:type', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index]

		if (!drafts || !current) {
			return
		}

		const kb = new InlineKeyboard()
			.text(typeLabel(current.direction, 'expense', 'Расход'), 'set_type:expense')
			.text(typeLabel(current.direction, 'income', 'Доход'), 'set_type:income')
			.text(typeLabel(current.direction, 'transfer', 'Перевод'), 'set_type:transfer')
			.row()
			.text('🠐 Назад', 'back_to_preview')

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.tempMessageId,
					'Выбери тип транзакции:',
					{ reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^set_type:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index]

		if (!drafts || !current || ctx.session.tempMessageId == null) {
			return
		}

		const type = ctx.callbackQuery.data.split(':')[1] as
			| 'expense'
			| 'income'
			| 'transfer'

		current.direction = type

		const user = ctx.state.user as any
		const accountId =
			current.accountId ||
			user.defaultAccountId ||
			ctx.state.activeAccount?.id
		const showConversion = await getShowConversion(
			current,
			accountId ?? null,
			ctx.state.user.id,
			accountsService
		)

		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
				{
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard(drafts.length, index, showConversion, current?.direction === 'transfer', !!ctx.session.editingTransactionId)
				}
			)
		} catch {}
	})
}

