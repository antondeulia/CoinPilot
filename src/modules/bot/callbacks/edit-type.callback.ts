import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { persistPreviewTransactionIfNeeded } from '../utils/persist-preview-transaction'
import { attachTradeMeta, stripTradeMeta } from '../utils/trade-meta'

function typeLabel(
	currentDirection: string | undefined,
	currentTradeType: 'buy' | 'sell' | undefined,
	value: 'expense' | 'income' | 'transfer' | 'buy' | 'sell',
	text: string
) {
	const isCurrent =
		value === 'buy' || value === 'sell'
			? currentTradeType === value
			: currentDirection === value && !currentTradeType
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
			.text(
				typeLabel(current.direction, current.tradeType, 'expense', 'Расход'),
				'set_type:expense'
			)
			.text(
				typeLabel(current.direction, current.tradeType, 'income', 'Доход'),
				'set_type:income'
			)
			.text(
				typeLabel(current.direction, current.tradeType, 'transfer', 'Перевод'),
				'set_type:transfer'
			)
			.row()
			.text(
				typeLabel(current.direction, current.tradeType, 'buy', '📥 Покупка'),
				'set_type:buy'
			)
			.text(
				typeLabel(current.direction, current.tradeType, 'sell', '📤 Продажа'),
				'set_type:sell'
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
			| 'buy'
			| 'sell'

		const previousTradeType = current.tradeType as 'buy' | 'sell' | undefined
		const backups = ((current as any).__tradeBackups ?? {}) as Record<
			string,
			{
				tradeBaseCurrency?: string
				tradeBaseAmount?: number
				tradeQuoteCurrency?: string
				tradeQuoteAmount?: number
				executionPrice?: number
				tradeFeeCurrency?: string
				tradeFeeAmount?: number
				rawText?: string
			}
		>
		if (previousTradeType && previousTradeType !== type) {
			backups[previousTradeType] = {
				tradeBaseCurrency: current.tradeBaseCurrency,
				tradeBaseAmount: current.tradeBaseAmount,
				tradeQuoteCurrency: current.tradeQuoteCurrency,
				tradeQuoteAmount: current.tradeQuoteAmount,
				executionPrice: current.executionPrice,
				tradeFeeCurrency: current.tradeFeeCurrency,
				tradeFeeAmount: current.tradeFeeAmount,
				rawText: current.rawText
			}
			;(current as any).__tradeBackups = backups
		}

		const isTrade = type === 'buy' || type === 'sell'
		current.direction = isTrade ? 'transfer' : type
		if (!isTrade) {
			current.tradeType = undefined
			current.tradeBaseCurrency = undefined
			current.tradeBaseAmount = undefined
			current.tradeQuoteCurrency = undefined
			current.tradeQuoteAmount = undefined
			current.executionPrice = undefined
			current.tradeFeeCurrency = undefined
			current.tradeFeeAmount = undefined
			if (typeof current.rawText === 'string') {
				current.rawText = stripTradeMeta(current.rawText)
			}
		} else {
			current.tradeType = type
			const backup = backups[type]
			if (backup) {
				current.tradeBaseCurrency = backup.tradeBaseCurrency
				current.tradeBaseAmount = backup.tradeBaseAmount
				current.tradeQuoteCurrency = backup.tradeQuoteCurrency
				current.tradeQuoteAmount = backup.tradeQuoteAmount
				current.executionPrice = backup.executionPrice
				current.tradeFeeCurrency = backup.tradeFeeCurrency
				current.tradeFeeAmount = backup.tradeFeeAmount
				if (backup.rawText) current.rawText = backup.rawText
			}
			if (
				current.tradeBaseCurrency &&
				typeof current.tradeBaseAmount === 'number' &&
				current.tradeQuoteCurrency &&
				typeof current.tradeQuoteAmount === 'number' &&
				typeof current.executionPrice === 'number'
			) {
				current.rawText = attachTradeMeta(stripTradeMeta(String(current.rawText ?? '')), {
					type,
					baseCurrency: current.tradeBaseCurrency,
					baseAmount: current.tradeBaseAmount,
					quoteCurrency: current.tradeQuoteCurrency,
					quoteAmount: current.tradeQuoteAmount,
					executionPrice: current.executionPrice,
					feeCurrency: current.tradeFeeCurrency,
					feeAmount: current.tradeFeeAmount
				})
			}
		}

		const user = ctx.state.user as any
		const allAccounts = await accountsService.getAllByUserIdIncludingHidden(
			ctx.state.user.id
		)
		const outside = allAccounts.find(a => a.name === 'Вне Wallet')
		const defaultVisible =
			allAccounts.find(a => a.id === user.defaultAccountId && !a.isHidden) ??
			allAccounts.find(a => !a.isHidden && a.name !== 'Вне Wallet') ??
			null
		const accountId =
			current.accountId || defaultVisible?.id || ctx.state.activeAccount?.id
		if (type === 'transfer' || isTrade) {
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
			if (isTrade) {
				current.toAccountId = current.accountId
				current.toAccount = current.account
			} else if (!current.toAccountId && outside) {
				current.toAccountId = outside.id
				current.toAccount = outside.name
			}
			if (
				!isTrade &&
				outside &&
				current.accountId === outside.id &&
				current.toAccountId === outside.id
			) {
				if (defaultVisible) {
					current.accountId = defaultVisible.id
					current.account = defaultVisible.name
				}
			}
		} else {
			if (outside && current.accountId === outside.id && defaultVisible) {
				current.accountId = defaultVisible.id
				current.account = defaultVisible.name
			}
			current.toAccountId = undefined
			current.toAccount = undefined
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
						current?.direction === 'transfer' && !current?.tradeType,
						!!ctx.session.editingTransactionId,
						current?.tradeType
					)
				}
			)
		} catch {}
	})
}
