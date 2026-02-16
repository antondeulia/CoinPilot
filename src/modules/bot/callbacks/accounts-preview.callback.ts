import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	formatAccountName,
	getCurrencySymbol,
	isCryptoCurrency
} from '../../../utils/format'

function renderAccountPreview(account, index: number, total: number, isDefault: boolean) {
	const header = `💼 <b>Предпросмотр счёта</b>${total > 1 ? ` ${index + 1}/${total}` : ''}`
	const title = `Название: <b>${formatAccountName(account.name, isDefault)}</b>`
	const assets: string[] = ['\nАктивы:']
	account.assets.forEach((asset, i) => {
		const code = String(asset.currency ?? '').toUpperCase()
		const symbol = getCurrencySymbol(code)
		const displayCurrency = symbol === code ? code : `${symbol} (${code})`
		const amount = Number(asset.amount ?? 0).toLocaleString('ru-RU', {
			minimumFractionDigits: isCryptoCurrency(code) ? 0 : 2,
			maximumFractionDigits: isCryptoCurrency(code) ? 8 : 2
		})
		assets.push(`${i + 1}. ${amount} ${displayCurrency}`)
	})
	return `${header}\n\n${title}\n${assets.join('\n')}\n\nВсего активов: ${account.assets.length}`
}

function accountPreviewKeyboard(total: number, index: number) {
	const hasPagination = total > 1

	const kb = new InlineKeyboard().text('Jarvis-редактирование', 'accounts_jarvis_edit')

	if (total > 1) {
		kb.row()
			.text('Сохранить 1', 'confirm_1_accounts')
			.text('Удалить 1', 'cancel_1_accounts')
	}

	if (hasPagination) {
		kb.row()
			.text('« Назад', 'pagination_back_accounts')
			.text(`${index + 1}/${total}`, 'pagination_preview_accounts')
			.text('Вперёд »', 'pagination_forward_accounts')
	}

	kb.row()
		.text('Сохранить все', 'confirm_all_accounts')
		.text('Удалить все', 'cancel_all_accounts')

	kb.row().text('Повторить', 'repeat_parse_accounts')

	return kb
}

export async function refreshAccountsPreview(ctx: BotContext) {
	const drafts = ctx.session.draftAccounts
	const index = ctx.session.currentAccountIndex ?? 0

	if (!drafts || !drafts.length) return

	const current = drafts[index]
	const isDefault = (current as any)?.id === ctx.state.user?.defaultAccountId
	const text = renderAccountPreview(current, index, drafts.length, isDefault)
	const replyMarkup = accountPreviewKeyboard(drafts.length, index)

	try {
		if (ctx.session.tempMessageId == null) {
			const msg = await ctx.reply(text, {
				parse_mode: 'HTML',
				reply_markup: replyMarkup
			})
			ctx.session.tempMessageId = msg.message_id
		} else {
			await ctx.api.editMessageText(ctx.chat!.id, ctx.session.tempMessageId, text, {
				parse_mode: 'HTML',
				reply_markup: replyMarkup
			})
		}
	} catch {}
}

export const accountsPreviewCallbacks = (bot: Bot<BotContext>) => {
	bot.callbackQuery('pagination_back_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		const total = drafts.length
		let index = ctx.session.currentAccountIndex ?? 0
		index = index <= 0 ? total - 1 : index - 1
		ctx.session.currentAccountIndex = index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('pagination_forward_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		const total = drafts.length
		let index = ctx.session.currentAccountIndex ?? 0
		index = index >= total - 1 ? 0 : index + 1
		ctx.session.currentAccountIndex = index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('pagination_preview_accounts', async () => {})
}
