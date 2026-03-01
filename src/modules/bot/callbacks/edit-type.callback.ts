import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { persistPreviewTransactionIfNeeded } from '../utils/persist-preview-transaction'

function typeLabel(
	current: string | undefined,
	value: 'expense' | 'income' | 'transfer',
	text: string
) {
	const isCurrent = current === value
	return `${isCurrent ? '✅ ' : ''}${text}`
}

export const editTypeCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	transactionsService: TransactionsService
) => {
	bot.callbackQuery('edit:type', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any

		if (!drafts || !current) {
			return
		}

		const kb = new InlineKeyboard()
			.text(typeLabel(current.direction, 'expense', 'Расход'), 'set_type:expense')
			.text(typeLabel(current.direction, 'income', 'Доход'), 'set_type:income')
			.text(
				typeLabel(current.direction, 'transfer', 'Перевод'),
				'set_type:transfer'
			)
			.row()
			.text('← Назад', 'back_to_preview')

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
		const current = drafts?.[index] as any

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
				current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
			if (type === 'transfer') {
				const allAccounts = await accountsService.getAllByUserIdIncludingHidden(
					ctx.state.user.id
				)
				const outside = allAccounts.find(a => a.name === 'Вне Wallet')
				const visibleAccounts = allAccounts.filter(a => !a.isHidden)
				const fallbackId =
					user.defaultAccountId &&
					visibleAccounts.some(a => a.id === user.defaultAccountId)
						? user.defaultAccountId
						: visibleAccounts[0]?.id
				const fallbackAccount =
					(fallbackId &&
						(await accountsService.getOneWithAssets(
							fallbackId,
							ctx.state.user.id
						))) ||
					null
				if (accountId && !current.accountId) {
					current.accountId = accountId
				}
				if (current.accountId && !current.account) {
					const fromAccount = await accountsService.getOneWithAssets(
					current.accountId,
					ctx.state.user.id
				)
				if (fromAccount) current.account = fromAccount.name
				}
				if (!current.toAccountId) {
					if (outside) {
						current.toAccountId = outside.id
						current.toAccount = outside.name
					}
				}
				if (
					outside &&
					current.accountId === outside.id &&
					current.toAccountId === outside.id
				) {
					current.accountId = fallbackAccount?.id
					current.account = fallbackAccount?.name
				}
			} else {
				current.toAccountId = undefined
				current.toAccount = undefined
				const selectedAccount = current.accountId
					? await accountsService.getOneWithAssets(
							current.accountId,
							ctx.state.user.id
						)
					: null
				if (selectedAccount?.isHidden) {
					const visible = await accountsService.getAllByUserId(ctx.state.user.id)
					const nextAccount =
						visible.find(a => a.id === user.defaultAccountId) || visible[0] || null
					current.accountId = nextAccount?.id
					current.account = nextAccount?.name
				}
			}
		const showConversion = await getShowConversion(
			current,
			accountId ?? null,
			ctx.state.user.id,
			accountsService
		)
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
						current?.direction === 'transfer',
						!!ctx.session.editingTransactionId
					)
				}
			)
		} catch {}
	})
}
