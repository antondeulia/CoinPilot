import { Injectable } from '@nestjs/common'
import { LlmTransactionListSchema } from './schemas/transaction.schema'
import { LlmAccountListSchema } from './schemas/account.schema'
import OpenAI, { toFile } from 'openai'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class LLMService {
	private readonly openai: OpenAI
	private readonly txModelFast = 'gpt-4.1-mini'
	private readonly txModelQuality = 'gpt-4.1'

	constructor(private readonly config: ConfigService) {
		this.openai = new OpenAI({
			apiKey: config.getOrThrow<string>('OPENAI_API_KEY')
		})
	}

	private static isRetryableError(e: unknown): boolean {
		const msg = e instanceof Error ? e.message : String(e)
		return (
			msg.includes('Connection error') ||
			msg.includes('ECONNRESET') ||
			msg.includes('ETIMEDOUT')
		)
	}

	private async withRetry<T>(
		fn: () => Promise<T>,
		retries = 2,
		delayMs = 1000
	): Promise<T> {
		let last: unknown
		for (let i = 0; i <= retries; i++) {
			try {
				return await fn()
			} catch (e) {
				last = e
				if (i < retries && LLMService.isRetryableError(e)) {
					await new Promise(r => setTimeout(r, delayMs))
					continue
				}
				throw e
			}
		}
		throw last
	}

	private shouldEscalateTxParse(transactions: any[], sourceText: string): boolean {
		if (!transactions.length) return true
		const lowered = sourceText.toLowerCase()
		const hasExplicitDateHint =
			/\bсегодня\b|\bвчера\b|\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/u.test(
				lowered
			)
		const badCount = transactions.filter(tx => {
			const desc = String(tx.description ?? '').trim().toLowerCase()
			const category = String(tx.category ?? '').trim()
			const weakDesc = !desc || desc === 'транзакция'
			const weakCategory = !category || category === '📦Другое'
			return weakDesc || weakCategory
		}).length
		const weakShare = badCount / Math.max(1, transactions.length)
		if (weakShare >= 0.6) return true
		if (hasExplicitDateHint && transactions.some(tx => !tx.transactionDate)) return true
		return false
	}

	async parseTransaction(
		text: string,
		categoryNames: string[] = [],
		existingTags: string[] = [],
		accountNames: string[] = [],
		memoryHints: string[] = []
	) {
		const { systemContent } = this.buildTransactionParseInstructions(
			categoryNames,
			existingTags,
			accountNames,
			memoryHints
		)
		const callParser = async (model: string) =>
			this.openai.chat.completions.create({
				model,
				temperature: 0,
				messages: [
					{ role: 'system', content: systemContent },
					{ role: 'user', content: text }
				],
				functions: [
					{
						name: 'create_transaction',
						description: 'Создать одну или несколько финансовых транзакций',
						parameters: {
							type: 'object',
							properties: {
								transactions: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											action: {
												type: 'string',
												enum: ['create_transaction']
											},
											amount: { type: 'number' },
											currency: { type: 'string' },
											direction: {
												type: 'string',
												enum: ['income', 'expense', 'transfer']
											},
											fromAccount: { type: 'string' },
											toAccount: { type: 'string' },
											account: { type: 'string' },
											transactionDate: { type: 'string' },
											category: { type: 'string' },
											description: {
												type: 'string',
												description:
													'Название операции: максимум 1–2 слова. Максимально упрощать: убирать суффиксы //город/страна, Fil. XXXX, GmbH и др.; переводить на русский (Apotheke→Аптека, Rundfunk/Radio→Радио, Kursbuch→Книга); бренды — короткое имя (DB Vertrieb GmbH→DB, TEDi Fil. 4032→TEDi); из URL/домена — бренд (LINK.COM, ALPACAJOBS→Alpaca); аббревиатуры сохранять (RVM Ticket→RVM, Regionalverkehr Muensterland GmbH→RVM). Не сырой заголовок. Для transfer не используй "Перевод/Transfer" как название, если есть получатель/источник (например "Папе", "Binance", "Наличные").'
											},
											rawText: { type: 'string' },
											tag_text: {
												type: 'string',
												description:
													'Один тег при явной подсказке в транзакции; иначе пусто. Не угадывать: если тип не указан (только "Транспорт" без вида) — оставить пустым. Ближайший из существующих или общий новый (книги, канцелярия); не повторять категорию.'
											},
											normalized_tag: {
												type: 'string',
												description:
													'Тег в lowercase; пусто, если tag_text пустой. Тот же язык, что в списке существующих.'
											},
											tag_confidence: {
												type: 'number',
												description: 'Уверенность 0–1 в выборе тега'
											},
											tradeType: {
												type: 'string',
												enum: ['buy', 'sell']
											},
												tradeBaseCurrency: { type: 'string' },
												tradeBaseAmount: { type: 'number' },
												tradeQuoteCurrency: { type: 'string' },
												tradeQuoteAmount: { type: 'number' },
												executionPrice: { type: 'number' },
												tradeFeeCurrency: { type: 'string' },
												tradeFeeAmount: { type: 'number' }
											},
										required: ['action', 'direction']
									}
								}
							},
							required: ['transactions']
						}
					}
				],
				function_call: { name: 'create_transaction' }
			})
		const response = await this.withRetry(() => callParser(this.txModelFast))

		const call = response.choices[0].message.function_call

		if (!call?.arguments) {
			throw new Error('LLM did not return function arguments')
		}

		const parsedJson = JSON.parse(call.arguments)
		const { transactions: fastTransactions } = LlmTransactionListSchema.parse(parsedJson)
		if (!this.shouldEscalateTxParse(fastTransactions as any[], text)) {
			return fastTransactions
		}
		const qualityResponse = await this.withRetry(() =>
			callParser(this.txModelQuality)
		)
		const qualityCall = qualityResponse.choices[0].message.function_call
		if (!qualityCall?.arguments) return fastTransactions
		const qualityJson = JSON.parse(qualityCall.arguments)
		const { transactions } = LlmTransactionListSchema.parse(qualityJson)
		return transactions
	}

	private static mimeToVoiceExtension(mimeType?: string): string {
		switch ((mimeType || '').toLowerCase()) {
			case 'audio/ogg':
				return 'ogg'
			case 'audio/mpeg':
				return 'mp3'
			case 'audio/mp4':
			case 'audio/x-m4a':
				return 'm4a'
			case 'audio/wav':
			case 'audio/x-wav':
				return 'wav'
			case 'audio/webm':
				return 'webm'
			default:
				return 'ogg'
		}
	}

	async transcribeVoice(
		audioBuffer: Buffer,
		mimeType?: string,
		prompt?: string
	): Promise<string> {
		const ext = LLMService.mimeToVoiceExtension(mimeType)
		const file = await toFile(audioBuffer, `telegram-voice.${ext}`, {
			type: mimeType || 'audio/ogg'
		})
		const response = await this.withRetry(() =>
			this.openai.audio.transcriptions.create({
				file,
				model: 'gpt-4o-mini-transcribe',
				language: 'ru',
				...(prompt ? { prompt } : {})
			})
		)
		return String(response.text ?? '').trim()
	}

	private buildTransactionParseInstructions(
		categoryNames: string[],
		existingTags: string[],
		accountNames: string[],
		memoryHints: string[] = []
	) {
		const categoryList =
			categoryNames.length > 0
				? categoryNames.filter(n => n !== 'Не выбрано').join(', ')
				: ''
		const categoryInstruction =
			categoryList.length > 0
				? ` Для каждой транзакции выбери одну категорию по описанию/названию из списка: ${categoryList}. Категория обязательна: если не можешь определить, укажи "📦Другое". Выбирай наиболее релевантную категорию из списка пользователя по смыслу: если есть и широкая, и узкая категория, предпочитай более узкую/специализированную (например для кофе в кофейне — категория про кафе/рестораны, а не общая еда/продукты).`
				: ' Для категории укажи "📦Другое".'
		const tagList = existingTags.length > 0 ? existingTags.join(', ') : ''
		const tagInstruction =
			tagList.length > 0
				? ` Тег: при наличии подсказки в названии/мерчанте — укажи один тег, обязательно из существующих: ${tagList}; выбирай самый подходящий по смыслу (если несколько подходят — тот, что точнее описывает операцию). DB/Deutsche Bahn → проездной, поезд; сайт/онлайн в названии → онлайн-покупка; TEDi/магазин канцелярии → канцелярия; Apotheke/аптека → аптека. Если категория ясна по мерчанту, но вид транспорта не указан (только Hauptbahnhof без DB) — тег пустой. Одна общая сумма — один общий тег; разделённые суммы — отдельные теги. tag_confidence 0–1.`
				: ' Тег не обязателен; при отсутствии подсказки о типе операции — пусто; иначе один тег, normalized_tag в lowercase, tag_confidence 0–1.'
		const accountInstruction =
			accountNames.length > 0
				? ` У пользователя есть счета: ${accountNames.join(', ')}. Для счёта и реквизитов операции учитывай текст/подпись пользователя в первую очередь. Для переводов (direction=transfer): "перевёл с X на Y", "с X на Y", "вывел с X в нал", "перекинул с X на Y", "снял в нал" → fromAccount: X, toAccount: Y/Наличные. Если источник или цель не указаны явно, для transfer ставь "Вне Wallet" только в недостающее поле (прочерк запрещён). Поле account для переводов не заполняй. Разговорные названия счетов нормализуй только при явном упоминании счёта в тексте (например "с моно", "на нал", "в байбит"). Если явного упоминания счёта нет — не угадывай счёт и не подставляй "Наличные"/другой счёт по умолчанию. Для income/expense: если в тексте упоминается счёт (предлог "с", "из", "на", "для" + название) — укажи в поле account соответствующее название из списка. На скриншоте без подсказки в тексте: указывай account только если на изображении явно видно название счёта или банка; не выводи счёт из аббревиатур в номерах операций (MO и т.п.). Если названия счёта нет — поле account не заполняй. Сопоставляй слова даже при неточном написании (например "для Sparkasse" → Sparkasse). Счёт "Вне Wallet" — только для переводов в toAccount. Для income/expense поле account никогда не должно быть "Вне Wallet".`
				: ''
		const cryptoInstruction =
			' Распознавай криптовалюты по коду: BTC, ETH, USDT, USDC, BNB, SOL, XRP, ADA, DOGE и другие популярные тикеры. Указывай currency в верхнем регистре (BTC, ETH).'
		const todayIso = new Date().toISOString().split('T')[0]
			const directionInstruction =
				` Direction (тип транзакции): определяй по тексту или визуальным подсказкам. Сегодня: ${todayIso}. В тексте: "перевёл", "перевод", "перевел", "с X на Y" (между счетами), "вывел", "перекинул", "снял в нал", "send", "sent" = transfer. Если в тексте явно указаны два счета/кармана пользователя ("со шпаркассе в нал", "с биржи на карту"), это transfer, не expense. Для криптоторговли: если есть buy/sell-контекст и криптовалюта ("купил 11 TON", "продал BTC"), это trade-перевод: direction=transfer + tradeType=buy/sell. Для таких операций обязательно извлекай tradeBaseCurrency/tradeBaseAmount, tradeQuoteCurrency/tradeQuoteAmount, executionPrice. Пары вида LABUSDT, TONUSDT, BTCUSDT нужно раскладывать: tradeBaseCurrency=LAB/BTC/TON, tradeQuoteCurrency=USDT. Для buy/sell tradeBaseAmount обязателен. Если есть торговая комиссия на скрине или в тексте — извлеки tradeFeeAmount/tradeFeeCurrency. Если комиссия не указана явно, НЕ вычисляй её и не заполняй. Важно: фразы вида "потратил X TON на звёзды/подписку/услугу" — это expense (платёж), не trade. Слова "купил/продал" для обычных товаров/услуг (не крипта) остаются expense/income. Ключевые слова "доход", "прибыль", "получение", "получил", "receive", "received", "income" = income. Ключевые слова "расход", "списание", "оплата", "purchase", "debit" = expense. На скриншоте: знак «+» или зелёный цвет суммы = income (доход); знак «-» или красный цвет суммы = expense (расход). Если сумма отображена со знаком или цветом — direction задавай строго по нему, не по догадке.`
			const parsingRules =
				' Правила парсинга: (0) Нет описания на скриншоте: если на изображении только идентификаторы (F17..., MO 56...), числа и суммы, без названия мерчанта, примечания и названия банка/счёта — категория "📦Другое", тег пустой, description нейтральное (например "Транзакция"). (1) Description всегда с заглавной буквы, максимум 1-2 слова, предпочтительно 1 слово. (2) Категория обязательна всегда: если неуверен — "📦Другое". (3) Категория первична, тег уточняет. Если описание однозначное (продукты, мороженое, такси и т.п.) — обязательно выбери подходящий тег из списка пользователя. (4) Для бытовых/сленговых слов определяй по контексту (например "шкары" => обувь => категория "🛒Покупки"). (5) Мерчант по названию: DB/Deutsche Bahn => транспорт, LINK.COM/онлайн => платежи/покупки, TEDi => покупки, Apotheke => покупки, REWE => еда/продукты. Telegram Stars/подписки/цифровые услуги => Платежи (если категория доступна). Всегда выбирай максимально специализированную категорию, если она есть в пользовательском списке. (6) Не выбирай "📦Другое" и description "Транзакция", если по названию/мерчанту можно дать более точную классификацию. (7) Для изображений дата со скриншота приоритетна; дату из текста/подписи используй только если она указана явно как дата (например "23 февраля", "23.02.2026"). Формат суммы вроде "11.1 TON" не трактуй как дату. (8) Для transfer: если есть получатель/источник, description делай по нему ("Папе", "Наличные", "Bybit"), не "Перевод". Для вывода без явной цели ("вывел 50 евро") description = "Вывод". (9) Для income/expense description не должен быть общим типом ("Доход", "Расход", "Транзакция", "Платёж"), если можно извлечь получателя/мерчанта/назначение из текста или скриншота. (10) Для tradeType=buy/sell description делай по базовому активу (например "TON", "BTC"), не "Покупка/Продажа". (11) Для tradeType=buy/sell торговую комиссию заполняй только если она явно есть в тексте/скриншоте (например "Торговая комиссия 0.12 USDT"). (12) Пару trade извлекай даже если она записана слитно (LABUSDT, TONUSDT). (13) Если в тексте есть явная конструкция "с/из <счёт>", заполняй account именно этим счётом из списка пользователя.'
		const memoryInstruction =
			memoryHints.length > 0
				? ` Персональные правила пользователя (высокий приоритет): ${memoryHints.join(
						' | '
					)}.`
				: ''
		return {
			systemContent:
				'Ты парсер финансовых операций. Верни только JSON согласно схеме.' +
				directionInstruction +
				categoryInstruction +
				tagInstruction +
				accountInstruction +
				cryptoInstruction +
				parsingRules +
				memoryInstruction
		}
	}

	async parseTransactionFromImage(
		imageBase64DataUrl: string,
		categoryNames: string[] = [],
		existingTags: string[] = [],
		accountNames: string[] = [],
		userCaption?: string,
		memoryHints: string[] = []
	) {
		const { systemContent } = this.buildTransactionParseInstructions(
			categoryNames,
			existingTags,
			accountNames,
			memoryHints
		)
		const captionTrimmed = userCaption?.trim() || ''
		const userTextParts: string[] = [
			'Извлеки все транзакции с этого скриншота и верни JSON по схеме.'
		]
		if (captionTrimmed) {
			userTextParts.push(
				`Подпись пользователя к фото: «${captionTrimmed}». Счёт и текстовые уточнения определяй в первую очередь из подписи; с скриншота не выводи счёт по аббревиатурам в номерах операций. Для даты: если на скриншоте есть явная дата операции, используй её; дату из подписи используй только при явном формате даты (например "23 февраля", "23.02.2026"). Формат "11.1 TON" трактуй как сумму, не как дату.`
			)
		}
			userTextParts.push(
				'По скриншоту не выводи категорию и тег только если нет мерчанта/примечания. По названию мерчанта всегда выбирай категорию и тег из списка пользователя: DB Vertrieb / Deutsche Bahn → Транспорт, тег проездной/поезд. LINK.COM, сайт в названии → Платежи или Покупки, тег онлайн-покупка. TEDi → Покупки, тег канцелярия. Apotheke/аптека → Покупки (не Здоровье), тег аптека. REWE → Еда и напитки. Hauptbahnhof/Regionalverkehr без DB → Транспорт, тег пустой. Direction определяй по визуальным приоритетам: «-»/красный = expense, «+»/зелёный = income, send/sent/перевёл/с X на Y = transfer, receive/received/доход/прибыль = income. Для trade-пар извлекай base/quote/executionPrice и торговую комиссию, если она явно есть на скриншоте. Пары вида LABUSDT нужно раскладывать в base=LAB, quote=USDT и обязательно заполнять baseAmount. Суммы возвращай положительными числами (без знака).'
			)
		const callParser = async (model: string) =>
			this.openai.chat.completions.create({
				model,
				temperature: 0,
				messages: [
					{ role: 'system', content: systemContent },
					{
						role: 'user',
						content: [
							{
								type: 'image_url',
								image_url: { url: imageBase64DataUrl }
							},
							{
								type: 'text',
								text: userTextParts.join(' ')
							}
						]
					}
				],
				functions: [
					{
						name: 'create_transaction',
						description: 'Создать одну или несколько финансовых транзакций',
						parameters: {
							type: 'object',
							properties: {
								transactions: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											action: {
												type: 'string',
												enum: ['create_transaction']
											},
											amount: { type: 'number' },
											currency: { type: 'string' },
											direction: {
												type: 'string',
												enum: ['income', 'expense', 'transfer']
											},
											fromAccount: { type: 'string' },
											toAccount: { type: 'string' },
											account: { type: 'string' },
											transactionDate: { type: 'string' },
											category: { type: 'string' },
											description: {
												type: 'string',
												description:
													'Название операции: максимум 1–2 слова. Максимально упрощать: убирать суффиксы //город/страна, Fil. XXXX, GmbH и др.; переводить на русский (Apotheke→Аптека, Rundfunk/Radio→Радио, Kursbuch→Книга); бренды — короткое имя (DB Vertrieb GmbH→DB, TEDi Fil. 4032→TEDi); из URL/домена — бренд (LINK.COM, ALPACAJOBS→Alpaca); аббревиатуры сохранять (RVM Ticket→RVM, Regionalverkehr Muensterland GmbH→RVM). Не сырой заголовок. Для transfer не используй "Перевод/Transfer" как название, если есть получатель/источник.'
											},
											rawText: { type: 'string' },
											tag_text: {
												type: 'string',
												description:
													'Тег при явной подсказке; иначе пусто. Не угадывать по сумме/названию; если тип не указан — пусто. Ближайший из существующих или общий (книги, канцелярия).'
											},
											normalized_tag: {
												type: 'string',
												description:
													'Тег в lowercase; пусто, если tag_text пустой.'
											},
											tag_confidence: { type: 'number' },
											tradeType: {
												type: 'string',
												enum: ['buy', 'sell']
											},
												tradeBaseCurrency: { type: 'string' },
												tradeBaseAmount: { type: 'number' },
												tradeQuoteCurrency: { type: 'string' },
												tradeQuoteAmount: { type: 'number' },
												executionPrice: { type: 'number' },
												tradeFeeCurrency: { type: 'string' },
												tradeFeeAmount: { type: 'number' }
											},
										required: ['action', 'direction']
									}
								}
							},
							required: ['transactions']
						}
					}
				],
				function_call: { name: 'create_transaction' }
			})
		const response = await this.withRetry(() => callParser(this.txModelFast))

		const call = response.choices[0].message.function_call
		if (!call?.arguments) {
			throw new Error('LLM did not return function arguments')
		}
		const parsedJson = JSON.parse(call.arguments)
		const { transactions: fastTransactions } = LlmTransactionListSchema.parse(parsedJson)
		const qualitySource = `${captionTrimmed} image-parse`
		if (!this.shouldEscalateTxParse(fastTransactions as any[], qualitySource)) {
			return fastTransactions
		}
		const qualityResponse = await this.withRetry(() =>
			callParser(this.txModelQuality)
		)
		const qualityCall = qualityResponse.choices[0].message.function_call
		if (!qualityCall?.arguments) return fastTransactions
		const qualityJson = JSON.parse(qualityCall.arguments)
		const { transactions } = LlmTransactionListSchema.parse(qualityJson)
		return transactions
	}

	async parseAccount(text: string) {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						'Ты парсер мультивалютных счетов.\n' +
						'Определи accountType по названию счёта: bank | exchange | crypto_wallet | cash | online_service | other.\n' +
						'Верни релевантный emoji из фиксированного списка:\n' +
						'bank: 🏦, 💳, 💶, 💵, 💷, 🏛, 💼, 💰, 🧾\n' +
						'exchange: 🏦, 🏢, 📊, ⚡, 🪙\n' +
						'crypto_wallet: 🪙, ₿, 💎, 🔐, 🧊, 🔥, 📈\n' +
						'cash: 💵, 💶, 👛, 👜\n' +
						'online_service: 💼, 🏢, 💳\n' +
						'other: 💼\n' +
						'Если в названии уже есть emoji в начале, верни его же в поле emoji.\n' +
						'Название счёта сохраняй максимально близко к вводу пользователя. Не заменяй бренды/слова на синонимы и не удаляй цифры в названии (например "Trust Wallet 2").\n' +
						'Суммы и валюты НИКОГДА не включай в name счёта. Сумма/валюта — только в assets.\n' +
						'Верни только JSON согласно схеме.'
				},
				{
					role: 'user',
					content: text
				}
			],
			functions: [
				{
					name: 'create_account',
					description: 'Создать один или несколько финансовых счетов',
					parameters: {
						type: 'object',
						properties: {
							accounts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										name: { type: 'string' },
										emoji: { type: 'string' },
										accountType: {
											type: 'string',
											enum: [
												'bank',
												'exchange',
												'crypto_wallet',
												'cash',
												'online_service',
												'other'
											]
										},
										assets: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													currency: { type: 'string' },
													amount: { type: 'number' }
												},
												required: ['currency', 'amount']
											}
										},
										rawText: { type: 'string' }
									},
									required: ['name', 'assets', 'emoji', 'accountType']
								}
							}
						},
						required: ['accounts']
					}
				}
			],
			function_call: { name: 'create_account' }
		})

		const call = response.choices[0].message.function_call

		if (!call?.arguments) {
			throw new Error('LLM did not return function arguments for account')
		}

		const parsedJson = JSON.parse(call.arguments)
		const { accounts } = LlmAccountListSchema.parse(parsedJson)
		return accounts.map(acc => ({
			...acc,
			name: this.normalizeParsedAccountName(acc.name, acc.assets, text)
		}))
	}

	private sanitizeAccountName(name: string): string {
		const compact = String(name ?? '')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[.,;:!?]+$/g, '')
		if (!compact) return 'Счёт'
		return compact.charAt(0).toUpperCase() + compact.slice(1)
	}

	private normalizeParsedAccountName(
		name: string,
		assets: { currency: string; amount: number }[],
		sourceText: string
	): string {
		const normalized = this.sanitizeAccountName(name)
		const trailingNumberMatch = normalized.match(/\s(\d+(?:[.,]\d+)?)$/u)
		if (!trailingNumberMatch) return normalized
		const trailingRaw = trailingNumberMatch[1]
		const trailingAmount = Number(trailingRaw.replace(',', '.'))
		if (!Number.isFinite(trailingAmount)) return normalized
		const hasSameAssetAmount = assets.some(
			asset => Math.abs(Number(asset.amount) - trailingAmount) < 1e-9
		)
		if (!hasSameAssetAmount) return normalized
		const source = ` ${String(sourceText ?? '').toLowerCase()} `
		const appearsAsAmountWithCurrency = assets.some(asset => {
			const currency = String(asset.currency ?? '')
				.toLowerCase()
				.trim()
			if (!currency) return false
			const amountEscaped = trailingRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			const currencyEscaped = currency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			const pairPattern = new RegExp(
				`\\b${amountEscaped}\\s*${currencyEscaped}\\b`,
				'iu'
			)
			return pairPattern.test(source)
		})
		if (!appearsAsAmountWithCurrency) return normalized
		const cleaned = normalized.replace(/\s\d+(?:[.,]\d+)?$/u, '').trim()
		return this.sanitizeAccountName(cleaned || normalized)
	}

	async parseAccountEdit(
		current: { name: string; assets: { currency: string; amount: number }[] },
		instruction: string
	) {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						'Ты редактор счёта. Текущее состояние счёта передаётся в запросе.\nПравила:\n- НАЗВАНИЕ СЧЁТА НЕ МЕНЯТЬ.\n- Если указана валюта и сумма без глагола действия (например "EUR 4.26") — ЗАМЕНИТЬ текущую сумму этой валюты на указанную.\n- Если указан глагол "минус", "вычесть", "убавить" — вычесть из текущей суммы.\n- Если указан глагол "плюс", "прибавить", "добавить" — прибавить к текущей сумме.\n- Если нужно добавить новую валюту — добавь актив.\n- В ответе ОБЯЗАТЕЛЬНО сохрани все существующие активы, даже если пользователь их не упомянул.\n- Удаляй валюту только при ЯВНОМ запросе удаления (удали/убери/удалить).\n- Минимум один актив должен остаться.\nВерни обновлённый счёт в JSON.'
				},
				{
					role: 'user',
					content: `Текущий счёт: название "${current.name}", активы: ${JSON.stringify(current.assets)}. Указание пользователя: ${instruction}`
				}
			],
			functions: [
				{
					name: 'update_account',
					description: 'Обновить счёт',
					parameters: {
						type: 'object',
						properties: {
							accounts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										name: { type: 'string' },
										assets: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													currency: { type: 'string' },
													amount: { type: 'number' }
												},
												required: ['currency', 'amount']
											}
										}
									},
									required: ['name', 'assets']
								}
							}
						},
						required: ['accounts']
					}
				}
			],
			function_call: { name: 'update_account' }
		})

		const call = response.choices[0].message.function_call
		if (!call?.arguments)
			throw new Error('LLM did not return function arguments for account edit')
		const parsedJson = JSON.parse(call.arguments) as { accounts: unknown[] }
		const parsed = LlmAccountListSchema.parse(parsedJson)
		if (!parsed.accounts.length) throw new Error('Empty account')
		return {
			...parsed.accounts[0],
			name: this.sanitizeAccountName(current.name)
		}
	}

	async parseDate(text: string): Promise<Date | null> {
		const currentYear = new Date().getFullYear()
		const response = await this.openai.chat.completions.create({
			model: this.txModelFast,
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						`Ты парсер дат. Пользователь пишет дату на русском или в виде числа. Всегда используй текущий год ${currentYear} для выражений вроде "Сегодня", "Вчера" и подобных относительных формулировок. Верни только JSON вида {"date": "ISO_8601"}.`
				},
				{
					role: 'user',
					content: text
				}
			],
			functions: [
				{
					name: 'set_date',
					description: 'Установить дату транзакции',
					parameters: {
						type: 'object',
						properties: {
							date: {
								type: 'string',
								description: 'Дата в формате ISO 8601'
							}
						},
						required: ['date']
					}
				}
			],
			function_call: { name: 'set_date' }
		})

		const call = response.choices[0].message.function_call
		if (!call?.arguments) return null

		try {
			const parsed = JSON.parse(call.arguments) as { date: string }
			const d = new Date(parsed.date)
			if (isNaN(d.getTime())) return null
			return d
		} catch {
			return null
		}
	}

	async parseTagEdit(
		currentTags: string[],
		instruction: string
	): Promise<{
		add: string[]
		delete: string[]
		rename: { from: string; to: string }[]
	}> {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						'Ты редактор списка тегов. Пользователь даёт команды: удалить теги, добавить теги, переименовать тег. Все названия тегов в ответе — в lowercase, исправляй опечатки. Верни JSON с полями add (массив новых тегов), delete (массив имён тегов на удаление), rename (массив объектов {from, to}).'
				},
				{
					role: 'user',
					content: `Текущие теги: ${currentTags.join(', ')}. Указание: ${instruction}`
				}
			],
			functions: [
				{
					name: 'edit_tags',
					description: 'Применить изменения к списку тегов',
					parameters: {
						type: 'object',
						properties: {
							add: {
								type: 'array',
								items: { type: 'string' },
								description: 'Новые теги для добавления'
							},
							delete: {
								type: 'array',
								items: { type: 'string' },
								description: 'Имена тегов для удаления'
							},
							rename: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										from: { type: 'string' },
										to: { type: 'string' }
									},
									required: ['from', 'to']
								},
								description: 'Переименования'
							}
						},
						required: ['add', 'delete', 'rename']
					}
				}
			],
			function_call: { name: 'edit_tags' }
		})

		const call = response.choices[0].message.function_call
		if (!call?.arguments) {
			return { add: [], delete: [], rename: [] }
		}
		const parsed = JSON.parse(call.arguments) as {
			add?: string[]
			delete?: string[]
			rename?: { from: string; to: string }[]
		}
		return {
			add: Array.isArray(parsed.add) ? parsed.add : [],
			delete: Array.isArray(parsed.delete) ? parsed.delete : [],
			rename: Array.isArray(parsed.rename) ? parsed.rename : []
		}
	}

	async generateFinancialTip(userData: {
		mainCurrency: string
		totalCapital: number
		fiatSharePct: number
		cryptoSharePct: number
		change7dPct: number
		change30dPct: number
		accountsCount: number
		daysWithoutTransactions: number
		monthlyUsage?: { used: number; limit: number }
		largestAsset?: { name: string; sharePct: number }
	}) {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0.3,
			messages: [
				{
					role: 'system',
					content:
						'Ты финансовый аналитик. Дай 1-2 коротких наблюдения и поведенческий совет по данным пользователя. ' +
						'НЕЛЬЗЯ давать инвестиционные рекомендации (не писать покупать/продавать активы). ' +
						'Пиши на русском, нейтрально, точно и персонализированно. ' +
						'Ответ в одну строку, начинающуюся с "💡 Совет:".'
				},
				{
					role: 'user',
					content: JSON.stringify(userData)
				}
			]
		})
		const tip = response.choices[0]?.message?.content?.trim() ?? ''
		if (!tip) return '💡 Совет: регулярно обновляйте транзакции для точной аналитики.'
		return tip.startsWith('💡 Совет:')
			? tip
			: `💡 Совет: ${tip.replace(/^[-•\s]+/, '')}`
	}
}
