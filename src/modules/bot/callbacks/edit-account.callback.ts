import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard } from './confirm-tx'
import { formatAccountName } from '../../../utils/format'
import { persistPreviewTransactionIfNeeded } from '../utils/persist-preview-transaction'

function buildAccountsKeyboard(
	accounts: { id: string; name: string }[],
	page: number,
	currentId?: string | null,
	defaultAccountId?: string
) {
	const pageSize = 9
	const start = page * pageSize
	const slice = accounts.slice(start, start + pageSize)

	const rows: any[] = []

	for (let i = 0; i < slice.length; i += 3) {
		const chunk = slice.slice(i, i + 3)
		rows.push(
			chunk.map(a => {
				const isDefault = a.id === defaultAccountId
				const isSelected = a.id === currentId
				const label = isSelected ? `✅ ${a.name}` : a.name
				const displayName = formatAccountName(label, isDefault)
				return {
					text: displayName,
					callback_data: `set_account:${a.id}`
				}
			})
		)
	}

	const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))

	if (accounts.length > pageSize) {
		rows.push([
			{ text: '« Назад', callback_data: 'accounts_page:prev' },
			{ text: `${page + 1}/${totalPages}`, callback_data: 'accounts_page:noop' },
			{ text: 'Вперёд »', callback_data: 'accounts_page:next' }
		])
	}

	rows.push([{ text: '← Назад', callback_data: 'back_to_preview' }])

	return { inline_keyboard: rows }
}

export const editAccountCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	transactionsService: TransactionsService
) => {
	bot.callbackQuery('edit:account', async ctx => {
		const userId = ctx.state.user.id
		const allAccounts = await accountsService.getAllByUserIdIncludingHidden(userId)

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		const isTransfer = current?.direction === 'transfer'
		const accounts = isTransfer
			? allAccounts
			: allAccounts.filter(a => a.name !== 'Вне Wallet')
		if (!accounts.length) return

		ctx.session.accountsPage = 0

		const kb = buildAccountsKeyboard(
			accounts.map(a => ({ id: a.id, name: a.name })),
			0,
			current?.accountId ?? null,
			ctx.state.user.defaultAccountId ?? undefined
		)

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.tempMessageId,
					'Выберите счёт для транзакции:',
					{ reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^accounts_page:/, async ctx => {
		if (ctx.session.tempMessageId == null) return

		const userId = ctx.state.user.id

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		const isTransfer = current?.direction === 'transfer'
		const allAccounts = await accountsService.getAllByUserIdIncludingHidden(userId)
		const accounts = isTransfer
			? allAccounts
			: allAccounts.filter(a => a.name !== 'Вне Wallet')
		if (!accounts.length) return
		let page = ctx.session.accountsPage ?? 0
		const totalPages = Math.max(1, Math.ceil(accounts.length / 9))
		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		if (page >= totalPages) page = 0
		ctx.session.accountsPage = page

		const kb = buildAccountsKeyboard(
			accounts.map(a => ({ id: a.id, name: a.name })),
			page,
			current?.accountId ?? null
		)

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

	bot.callbackQuery(/^set_account:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		const accountId = ctx.callbackQuery.data.split(':')[1]
		const user = ctx.state.user as any
		const account = await accountsService.getOneWithAssets(accountId, user.id)
		if (!account) return
		if (current?.direction !== 'transfer' && account.name === 'Вне Wallet') {
			await ctx.reply('Счёт «Вне Wallet» доступен только для переводов.', {
				reply_markup: { inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]] }
			})
			return
		}

		current.accountId = accountId
		current.account = account.name
		if (current?.direction === 'transfer' && account.name === 'Вне Wallet') {
			const allAccounts = await accountsService.getAllByUserIdIncludingHidden(user.id)
			const fallback = allAccounts.find(
				a => !a.isHidden && a.name !== 'Вне Wallet'
			)
			if (current.toAccountId === account.id && fallback) {
				current.toAccountId = fallback.id
				current.toAccount = fallback.name
			}
		}

		const accountCurrencies = Array.from(
			new Set(account.assets?.map(a => a.currency || account.currency) ?? [])
		)
		const showConversion = !accountCurrencies.includes(current.currency)
		if (!showConversion) {
			current.convertToCurrency = undefined
			current.convertedAmount = undefined
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
	})
}
