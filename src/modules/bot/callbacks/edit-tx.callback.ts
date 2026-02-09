import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'

export const editTxCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	// legacy handler отключён, новые edit-callback'и реализованы отдельно
}
