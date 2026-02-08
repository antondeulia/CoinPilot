import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TagsService } from 'src/modules/tags/tags.service'

function tagsSettingsKeyboard() {
	return new InlineKeyboard()
		.text('Jarvis-редактирование', 'tags_jarvis_edit')
		.row()
		.text('← Назад', 'back_from_tags')
}

function tagsListText(tagNames: string[]) {
	const list = tagNames.length > 0 ? tagNames.join(', ') : '—'
	return `<b>Теги</b>\n\nСписок ваших тегов:\n<blockquote>${list}</blockquote>`
}

export const viewTagsCallback = (bot: Bot<BotContext>, tagsService: TagsService) => {
	bot.callbackQuery('view_tags', async ctx => {
		const userId = ctx.state.user.id
		const tags = await tagsService.getAllByUserId(userId)
		const tagNames = tags.map(t => t.name)
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		ctx.session.tagsSettingsMessageId = msgId
		await ctx.api.editMessageText(ctx.chat!.id, msgId, tagsListText(tagNames), {
			parse_mode: 'HTML',
			reply_markup: tagsSettingsKeyboard()
		})
	})

	bot.callbackQuery('tags_jarvis_edit', async ctx => {
		ctx.session.awaitingTagsJarvisEdit = true
		const msg = await ctx.reply(
			'Опишите изменения: удали теги X, Y; добавь A, B; переименуй C в D. После отправки сообщения изменения применятся.',
			{
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard().text('Закрыть', 'close_tags_jarvis')
			}
		)
		ctx.session.tagsSettingsHintMessageId = msg.message_id
	})

	bot.callbackQuery('close_tags_jarvis', async ctx => {
		if (ctx.session.tagsSettingsHintMessageId != null) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.session.tagsSettingsHintMessageId
				)
			} catch {}
			ctx.session.tagsSettingsHintMessageId = undefined
		}
		ctx.session.awaitingTagsJarvisEdit = false
	})

	bot.callbackQuery('back_from_tags', async ctx => {
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		const user: any = ctx.state.user
		const mainCode = user?.mainCurrency ?? 'USD'
		const defaultAccount =
			user.accounts?.find((a: any) => a.id === user.defaultAccountId) ??
			user.accounts?.[0]
		const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
		const settingsText = `<b>⚙️ Настройки</b>\n\nОсновная валюта: ${mainCode}\nОсновной счёт: ${defaultAccountName}`
		const kb = new InlineKeyboard()
			.text('Основная валюта', 'main_currency_open')
			.row()
			.text('Основной счёт', 'default_account_open')
			.row()
			.text('Категории', 'view_categories')
			.row()
			.text('Теги', 'view_tags')
			.row()
			.text('🠐 Назад', 'go_home')
		await ctx.api.editMessageText(ctx.chat!.id, msgId, settingsText, {
			parse_mode: 'HTML',
			reply_markup: kb
		})
		ctx.session.tagsSettingsMessageId = undefined
	})
}
