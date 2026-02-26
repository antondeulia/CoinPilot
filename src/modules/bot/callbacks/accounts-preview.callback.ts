import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	formatAccountName,
	formatExactAmount,
	getCurrencySymbol,
	isCryptoCurrency
} from '../../../utils/format'

function normalizePreviewCurrency(raw: string): string {
	const compact = String(raw ?? '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '')
	const aliases: Record<string, string> = {
		'$': 'USD',
		USD: 'USD',
		'€': 'EUR',
		EUR: 'EUR',
		ЕВРО: 'EUR',
		'₴': 'UAH',
		UAH: 'UAH',
		ГРН: 'UAH',
		ГРИВНА: 'UAH',
		'₽': 'RUB',
		RUB: 'RUB',
		RUR: 'RUB',
		'£': 'GBP',
		GBP: 'GBP',
		BYN: 'BYN',
		BYP: 'BYN',
		BYR: 'BYN',
		USDT: 'USDT'
	}
	return aliases[compact] ?? compact
}

function normalizePreviewName(value: string): string {
	const base = String(value ?? '').trim()
	if (!base) return 'Счёт'
	const letters = base.replace(/[^A-Za-zА-Яа-яЁё]/g, '')
	if (letters && letters === letters.toUpperCase()) {
		return base
	}
	const chars = Array.from(base)
	return `${chars[0].toUpperCase()}${chars.slice(1).join('')}`
}

function renderAccountPreview(
	account: any,
	index: number,
	total: number,
	isDefault: boolean
) {
	const header =
		total > 1
			? `💼 <b>Предпросмотр счетов</b> ${index + 1}/${total}`
			: '💼 <b>Предпросмотр счёта</b>'
	const title = `🎨 Название: <code>${formatAccountName(normalizePreviewName(account.name), isDefault)}</code>`
	const assetLines = (account.assets ?? []).map((asset: any) => {
		const code = normalizePreviewCurrency(asset.currency)
		const symbol = getCurrencySymbol(code)
		const displayCurrency = symbol === code ? code : `${symbol} (${code})`
		const amount = formatExactAmount(Number(asset.amount ?? 0), code, {
			maxFractionDigits: isCryptoCurrency(code) ? 18 : 2
		})
		const amountWithoutCode = amount.replace(/\s+[^\s]+$/u, '')
		return `• ${amountWithoutCode} ${displayCurrency}`
	})
	const quoteTag = assetLines.length > 3 ? 'blockquote expandable' : 'blockquote'

	return `${header}

${title}

📊 Активы:
<${quoteTag}>${assetLines.length ? assetLines.join('\n') : '• нет активов'}</blockquote>

🗂 Всего активов: ${(account.assets ?? []).length}`
}

function accountPreviewKeyboard(total: number, index: number) {
	const hasPagination = total > 1
	const kb = new InlineKeyboard()
		.text('✏️ Изменить активы', 'accounts_jarvis_edit')
		.text('🎨 Править название', 'accounts_rename')

	if (total > 1) {
		kb.row()
			.text('💾 Сохранить', 'confirm_1_accounts')
			.text('🗑 Удалить', 'cancel_1_accounts')
	}

	if (hasPagination) {
		kb.row()
			.text('« Назад', 'pagination_back_accounts')
			.text(`${index + 1}/${total}`, 'pagination_preview_accounts')
			.text('Вперёд »', 'pagination_forward_accounts')
		kb.row()
			.text('💾 Сохранить все', 'confirm_all_accounts')
			.text('🗑 Удалить все', 'cancel_all_accounts')
	} else {
		kb.row().text('💾 Сохранить', 'confirm_1_accounts').text('🗑 Удалить', 'cancel_1_accounts')
	}

	kb.row().text('🔁 Повторить', 'repeat_parse_accounts')
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
			ctx.session.resultMessageIds = [
				...((ctx.session.resultMessageIds ?? []) as number[]),
				msg.message_id
			]
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

