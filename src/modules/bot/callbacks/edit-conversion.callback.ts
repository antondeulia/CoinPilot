import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { ExchangeService } from '../../../modules/exchange/exchange.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

function buildConversionKeyboard(
	codes: string[],
	page: number,
	currentCode?: string | null
) {
	const pageSize = 9
	const start = page * pageSize
	const slice = codes.slice(start, start + pageSize)

	const rows: any[] = []

	for (let i = 0; i < slice.length; i += 3) {
		const chunk = slice.slice(i, i + 3)
		rows.push(
			chunk.map(code => ({
				text: code === currentCode ? `✅ ${code}` : code,
				callback_data: `set_conversion:${code}`
			}))
		)
	}

	const totalPages = Math.max(1, Math.ceil(codes.length / pageSize))

	rows.push([
		{ text: '« Назад', callback_data: 'conversion_page:prev' },
		{ text: `${page + 1}/${totalPages}`, callback_data: 'conversion_page:noop' },
		{ text: 'Вперёд »', callback_data: 'conversion_page:next' }
	])

	rows.push([{ text: '🠐 Назад', callback_data: 'back_to_preview' }])

	return { inline_keyboard: rows }
}

export const editConversionCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	exchangeService: ExchangeService
) => {
	bot.callbackQuery('edit:conversion', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		if (!current.currency || typeof current.amount !== 'number') return

		const user = ctx.state.user as any
		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
		const showConversion = await getShowConversion(
			current,
			accountId,
			user.id,
			accountsService
		)
		if (!showConversion) {
			await ctx.answerCallbackQuery({
				text: 'Конвертация сейчас не используется для этой транзакции',
				show_alert: true
			})
			return
		}
		if (!accountId) return

		const account = await accountsService.getOneWithAssets(accountId, user.id)
		if (!account) return

		const codes = Array.from(
			new Set(account.assets.map(a => a.currency || account.currency))
		).filter(code => code !== current.currency)
		if (!codes.length) return

		ctx.session.accountsPage = 0
		if (!current.convertToCurrency) {
			current.convertToCurrency = codes[0]
			current.convertedAmount = await exchangeService.convert(
				current.amount,
				current.currency,
				current.convertToCurrency
			)
		}

		const kb = buildConversionKeyboard(codes, 0, current.convertToCurrency ?? null)

		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				'Выберите валюту для конвертации суммы.',
				{ reply_markup: kb }
			)
		} catch {}
	})

	bot.callbackQuery(/^conversion_page:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		if (!current.currency || typeof current.amount !== 'number') return

		const user = ctx.state.user as any
		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
		if (!accountId) return

		const account = await accountsService.getOneWithAssets(accountId, user.id)
		if (!account) return

		const codes = Array.from(
			new Set(account.assets.map(a => a.currency || account.currency))
		).filter(code => code !== current.currency)
		if (!codes.length) return

		const totalPages = Math.max(1, Math.ceil(codes.length / 9))
		let page = ctx.session.accountsPage ?? 0
		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		ctx.session.accountsPage = page

		const kb = buildConversionKeyboard(codes, page, current.convertToCurrency ?? null)

		try {
			await ctx.api.editMessageReplyMarkup(
				ctx.chat!.id,
				ctx.session.tempMessageId!,
				{
					reply_markup: kb
				}
			)
		} catch {}
	})

	bot.callbackQuery(/^set_conversion:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		if (!current.currency || typeof current.amount !== 'number') return

		const code = ctx.callbackQuery.data.split(':')[1]
		current.convertToCurrency = code
		current.convertedAmount = await exchangeService.convert(
			current.amount,
			current.currency,
			current.convertToCurrency
		)

		const user = ctx.state.user as any
		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
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
						!!ctx.session.editingTransactionId
					)
				}
			)
		} catch {}
	})
}
