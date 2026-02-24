import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { ExchangeService } from '../../../modules/exchange/exchange.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { persistPreviewTransactionIfNeeded } from '../utils/persist-preview-transaction'

function buildCurrencyKeyboard(
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
				callback_data: `set_tx_currency:${code}`
			}))
		)
	}

	const totalPages = Math.max(1, Math.ceil(codes.length / pageSize))
	if (totalPages > 1) {
		rows.push([
			{ text: '« Назад', callback_data: 'tx_currency_page:prev' },
			{ text: `${page + 1}/${totalPages}`, callback_data: 'tx_currency_page:noop' },
			{ text: 'Вперёд »', callback_data: 'tx_currency_page:next' }
		])
	}

	rows.push([{ text: 'Закрыть', callback_data: 'back_to_preview' }])

	return { inline_keyboard: rows }
}

export const editCurrencyCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	exchangeService: ExchangeService,
	transactionsService: TransactionsService
) => {
	bot.callbackQuery('edit:currency', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return
		if (current.tradeType === 'buy' || current.tradeType === 'sell') {
			await ctx.answerCallbackQuery({
				text: 'Для покупки/продажи редактируйте поле «Пара».',
				show_alert: true
			})
			return
		}

		const user = ctx.state.user as any
		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
		if (!accountId) return

		const account = await accountsService.getOneWithAssets(accountId, user.id)
		if (!account) return

		const codes = Array.from(
			new Set(account.assets.map(a => a.currency || account.currency))
		)
		if (!codes.length) return

		ctx.session.accountsPage = 0
		const kb = buildCurrencyKeyboard(codes, 0, current.currency ?? null)

		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				'Выберите валюту для суммы или введите её вручную сообщением.',
				{ reply_markup: kb }
			)
		} catch {}

		;(ctx.session as any).editingCurrency = true
	})

	bot.callbackQuery(/^tx_currency_page:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		const user = ctx.state.user as any
		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
		if (!accountId) return

		const account = await accountsService.getOneWithAssets(accountId, user.id)
		if (!account) return

		const codes = Array.from(
			new Set(account.assets.map(a => a.currency || account.currency))
		)
		if (!codes.length) return

		const totalPages = Math.max(1, Math.ceil(codes.length / 9))
		let page = ctx.session.accountsPage ?? 0
		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		ctx.session.accountsPage = page

		const kb = buildCurrencyKeyboard(codes, page, current.currency ?? null)

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

	bot.callbackQuery(/^set_tx_currency:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		const user = ctx.state.user as any
		const code = ctx.callbackQuery.data.split(':')[1]
		current.currency = code
		current.convertToCurrency = undefined
		current.convertedAmount = undefined

		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
		const showConversion = await getShowConversion(
			current,
			accountId ?? null,
			ctx.state.user.id,
			accountsService
		)
		if (showConversion && accountId && typeof current.amount === 'number') {
			const account = await accountsService.getOneWithAssets(
				accountId,
				ctx.state.user.id
			)
			if (account?.assets?.length) {
				const codes = Array.from(
					new Set(
						account.assets.map((a: any) => a.currency || account.currency)
					)
				)
				if (codes.length) {
					current.convertToCurrency = codes[0]
					const converted = await exchangeService.convert(
						current.amount,
						current.currency,
						codes[0]
					)
					current.convertedAmount =
						converted == null
							? null
							: await exchangeService.roundByCurrency(converted, codes[0])
				}
			}
		}
		await persistPreviewTransactionIfNeeded(ctx, current, transactionsService)

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
						current?.direction === 'transfer' && !current?.tradeType,
						!!ctx.session.editingTransactionId,
						current?.tradeType
					)
				}
			)
		} catch {}

		;(ctx.session as any).editingCurrency = false
	})
}
