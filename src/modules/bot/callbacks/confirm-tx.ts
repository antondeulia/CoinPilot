import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TransactionsService } from 'src/modules/transactions/transactions.service'
import { renderHome } from '../utils/render-home'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { LlmTransaction } from 'src/modules/llm/schemas/transaction.schema'

export const confirmTxCallback = (
	bot: Bot<BotContext>,
	transactionsService: TransactionsService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('confirm_tx', async ctx => {
		await ctx.answerCallbackQuery()

		const draft = ctx.session.draftTransaction
		const account = ctx.state.activeAccount

		if (!draft || !account) {
			// если что-то странное — просто вернёмся в режим ввода
			ctx.session.awaitingTransaction = true
			return
		}

		await transactionsService.create({
			accountId: account.id,
			amount: draft.amount!,
			currency: draft.currency!,
			direction: draft.direction,
			category: draft.category,
			description: draft.description,
			rawText: draft.rawText || '',
			userId: ctx.state.user.id
		})

		// 🧹 чистим confirm-состояние
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransaction = undefined
		ctx.session.editingField = undefined

		// ❗ ВАЖНО
		// остаёмся в режиме добавления
		ctx.session.awaitingTransaction = true

		// удаляем confirm-сообщение
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}

		// 🟢 success-сообщение
		const msg = await ctx.reply(successText, {
			parse_mode: 'HTML',
			reply_markup: successKeyboard
		})

		ctx.session.tempMessageId = msg.message_id
	})
}

const successKeyboard = {
	inline_keyboard: [[{ text: '🙈 Закрыть', callback_data: 'hide_message' }]]
}

const successText = `
✅ <b>Транзакция успешно создана!</b>

Можешь добавить ещё одну — просто напиши сообщение.
`

export function renderConfirmMessage(tx: LlmTransaction) {
	return `
<b>Проверь транзакцию</b>

Название: ${tx.description ?? '— не указано'}
Сумма: ${tx.amount ?? '—'} ${tx.currency ?? ''}
Дата: ${new Date().toLocaleDateString('ru-RU')}
Категория: ${tx.category ?? '— не указана'}
`
}

export const confirmKeyboard = {
	inline_keyboard: [
		[
			{ text: '✏️ Название', callback_data: 'edit:description' },
			{ text: '✏️ Сумма', callback_data: 'edit:amount' }
		],
		[
			{ text: '✏️ Дата', callback_data: 'edit:date' },
			{ text: '✏️ Категория', callback_data: 'edit:category' }
		],
		[{ text: '✅ Подтвердить', callback_data: 'confirm_tx' }],
		[{ text: '❌ Отмена', callback_data: 'cancel_tx' }]
	]
}
