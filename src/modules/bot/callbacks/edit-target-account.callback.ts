import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard } from './confirm-tx'
import { formatAccountName } from 'src/utils/format'

function buildTargetAccountsKeyboard(
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
					callback_data: `set_target_account:${a.id}`
				}
			})
		)
	}
	const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))
	if (accounts.length > pageSize) {
		rows.push([
			{ text: '« Назад', callback_data: 'target_accounts_page:prev' },
			{
				text: `${page + 1}/${totalPages}`,
				callback_data: 'target_accounts_page:noop'
			},
			{ text: 'Вперёд »', callback_data: 'target_accounts_page:next' }
		])
	}
	rows.push([{ text: '🠐 Назад', callback_data: 'back_to_preview' }])
	return { inline_keyboard: rows }
}

export const editTargetAccountCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	bot.callbackQuery('edit:target_account', async ctx => {
		const userId = ctx.state.user.id
		const accounts = await accountsService.getAllByUserIdIncludingHidden(userId)
		if (!accounts.length) return

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || current.direction !== 'transfer') return
		;(ctx.session as any).targetAccountsPage = 0
		const kb = buildTargetAccountsKeyboard(
			accounts.map(a => ({ id: a.id, name: a.name })),
			0,
			current?.toAccountId ?? null,
			ctx.state.user.defaultAccountId ?? undefined
		)
		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.tempMessageId,
					'Выберите счёт «На счёт» (куда переводим):',
					{ reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^target_accounts_page:/, async ctx => {
		if (ctx.session.tempMessageId == null) return
		const userId = ctx.state.user.id
		const accounts = await accountsService.getAllByUserIdIncludingHidden(userId)
		if (!accounts.length) return

		const totalPages = Math.max(1, Math.ceil(accounts.length / 9))
		let page = (ctx.session as any).targetAccountsPage ?? 0
		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		;(ctx.session as any).targetAccountsPage = page

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		const kb = buildTargetAccountsKeyboard(
			accounts.map(a => ({ id: a.id, name: a.name })),
			page,
			current?.toAccountId ?? null,
			ctx.state.user.defaultAccountId ?? undefined
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

	bot.callbackQuery(/^set_target_account:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		const accountId = ctx.callbackQuery.data.split(':')[1]
		const user = ctx.state.user as any
		const account = await accountsService.getOneWithAssets(accountId, user.id)
		if (!account) return

		current.toAccountId = accountId
		current.toAccount = account.name

		const accountCurrencies = Array.from(
			new Set(account.assets?.map(a => a.currency || account.currency) ?? [])
		)
		const showConversion = !accountCurrencies.includes(current.currency)

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
						true,
						!!ctx.session.editingTransactionId
					)
				}
			)
		} catch {}
	})
}
