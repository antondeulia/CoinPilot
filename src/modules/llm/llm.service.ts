import { Injectable } from '@nestjs/common'
import { LlmTransactionListSchema } from './schemas/transaction.schema'
import { LlmAccountListSchema } from './schemas/account.schema'
import OpenAI from 'openai'
import { ConfigService } from '@nestjs/config'
import { toFile } from 'openai/uploads'

@Injectable()
export class LLMService {
	private readonly openai: OpenAI

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

	async parseTransaction(
		text: string,
		categoryNames: string[] = [],
		existingTags: string[] = [],
		accountNames: string[] = [],
		timezone: string = 'UTC+02:00'
	) {
		const { systemContent } = this.buildTransactionParseInstructions(
			categoryNames,
			existingTags,
			accountNames,
			timezone
		)
		const response = await this.withRetry(() =>
			this.openai.chat.completions.create({
				model: 'gpt-4o-mini',
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
													'Название операции: максимум 1–2 слова. Максимально упрощать: убирать суффиксы //город/страна, Fil. XXXX, GmbH и др.; переводить на русский (Apotheke→Аптека, Rundfunk/Radio→Радио, Kursbuch→Книга); бренды — короткое имя (DB Vertrieb GmbH→DB, TEDi Fil. 4032→TEDi); из URL/домена — бренд (LINK.COM, ALPACAJOBS→Alpaca); аббревиатуры сохранять (RVM Ticket→RVM, Regionalverkehr Muensterland GmbH→RVM). Не сырой заголовок.'
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
											}
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
		)

		const call = response.choices[0].message.function_call

		if (!call?.arguments) {
			throw new Error('LLM did not return function arguments')
		}

		const parsedJson = JSON.parse(call.arguments)
		const { transactions } = LlmTransactionListSchema.parse(parsedJson)

		return transactions
	}

	private buildTransactionParseInstructions(
		categoryNames: string[],
		existingTags: string[],
		accountNames: string[],
		timezone: string
	) {
		const categoryList =
			categoryNames.length > 0
				? categoryNames.filter(n => n !== 'Не выбрано').join(', ')
				: ''
		const categoryInstruction =
			categoryList.length > 0
				? ` Для каждой транзакции выбери одну категорию по описанию/названию из списка: ${categoryList}. Категория обязательна: если не можешь определить, укажи "📦Другое". Для цифровых услуг и подписок приоритетна категория про платежи (если в списке есть релевантная).`
				: ' Для категории укажи "📦Другое".'
		const tagList = existingTags.length > 0 ? existingTags.join(', ') : ''
		const tagInstruction =
			tagList.length > 0
				? ` Тег: при наличии подсказки в названии/мерчанте — укажи один тег, обязательно из существующих: ${tagList}; выбирай самый подходящий по смыслу (если несколько подходят — тот, что точнее описывает операцию). DB/Deutsche Bahn → проездной, поезд; сайт/онлайн в названии → онлайн-покупка; TEDi/магазин канцелярии → канцелярия; Apotheke/аптека → аптека. Если категория ясна по мерчанту, но вид транспорта не указан (только Hauptbahnhof без DB) — тег пустой. Одна общая сумма — один общий тег; разделённые суммы — отдельные теги. tag_confidence 0–1.`
				: ' Тег не обязателен; при отсутствии подсказки о типе операции — пусто; иначе один тег, normalized_tag в lowercase, tag_confidence 0–1.'
		const accountInstruction =
			accountNames.length > 0
				? ` У пользователя есть счета: ${accountNames.join(', ')}. Текст/подпись пользователя к фото имеет приоритет над скриншотом: счёт и другие указания из текста учитывай в первую очередь. Для переводов (direction=transfer): "перевёл с X на Y", "с X на Y", "вывел с X в нал", "перекинул с X на Y", "снял в нал" → fromAccount: X, toAccount: Y/Наличные. Если источник или цель не указаны явно, для transfer ставь "Вне Wallet" в недостающее поле (прочерк запрещён). Поле account для переводов не заполняй. Нормализуй разговорные названия счетов: "нал"→"Наличные", "байбит"→"Bybit", "мех"→"MEXC". Сопоставляй неточные написания с реальными счетами (мекс → MEXC, бингх → BingX, тинь → Тинькофф). Для income/expense: если в тексте упоминается счёт (предлог "с", "из", "на", "для" + название) — укажи в поле account соответствующее название из списка. На скриншоте без подсказки в тексте: указывай account только если на изображении явно видно название счёта или банка; не выводи счёт из аббревиатур в номерах операций (MO и т.п.). Если названия счёта нет — поле account не заполняй. Сопоставляй слова даже при неточном написании (например "для Sparkasse" → Sparkasse). Счёт "Вне Wallet" — только для переводов в toAccount. Для income/expense поле account никогда не должно быть "Вне Wallet".`
				: ''
		const cryptoInstruction =
			' Распознавай криптовалюты по коду: BTC, ETH, USDT, USDC, BNB, SOL, XRP, ADA, DOGE и другие популярные тикеры. Указывай currency в верхнем регистре (BTC, ETH).'
		const todayIso = new Date().toISOString().split('T')[0]
		const directionInstruction =
			` Direction (тип транзакции): определяй по тексту или визуальным подсказкам. Сегодня: ${todayIso}. Часовой пояс пользователя: ${timezone}. В тексте: "перевёл", "перевод", "перевел", "вывел", "перекинул", "send", "sent", "снял в нал" = transfer. Если текст явно указывает перевод, знак суммы не должен менять transfer на expense. На скриншоте: знак «+» или зелёный цвет суммы = income; знак «-» или красный цвет суммы = expense.`
		const parsingRules =
			' Правила парсинга: (0) Если критично не хватает суммы — не выдумывай сумму. (1) Description всегда с заглавной буквы, максимум 1-2 слова, без общих слов "Перевод/Доход/Расход", если можно выделить более конкретную сущность. (2) Категория обязательна: если неуверен — "📦Другое". (3) Для digital services/subscriptions/stars/донатов выбирай платежную категорию, если она есть. (4) Подпись к изображению используй как слой уточнений к данным скриншота, а не как замену скриншоту.'
		return {
			systemContent:
				'Ты парсер финансовых операций. Верни только JSON согласно схеме.' +
				directionInstruction +
				categoryInstruction +
				tagInstruction +
				accountInstruction +
				cryptoInstruction +
				parsingRules
		}
	}

	async parseTransactionFromImage(
		imageBase64DataUrl: string,
		categoryNames: string[] = [],
		existingTags: string[] = [],
		accountNames: string[] = [],
		userCaption?: string,
		timezone: string = 'UTC+02:00'
	) {
		const { systemContent } = this.buildTransactionParseInstructions(
			categoryNames,
			existingTags,
			accountNames,
			timezone
		)
		const captionTrimmed = userCaption?.trim() || ''
		const userTextParts: string[] = [
			'Извлеки все транзакции с этого скриншота и верни JSON по схеме.'
		]
			if (captionTrimmed) {
				userTextParts.push(
					`Подпись пользователя к фото (уточнение к скриншоту): «${captionTrimmed}». Счёт и доп. поля можно уточнять по подписи, но суммы и факт операций извлекай со скриншота.`
				)
			}
		userTextParts.push(
			'По скриншоту не выводи категорию и тег только если нет мерчанта/примечания. По названию мерчанта всегда выбирай категорию и тег из списка пользователя: DB Vertrieb / Deutsche Bahn → Транспорт, тег проездной/поезд. LINK.COM, сайт в названии → Платежи или Покупки, тег онлайн-покупка. TEDi → Покупки, тег канцелярия. Apotheke/аптека → Покупки (не Здоровье), тег аптека. REWE → Еда и напитки. Hauptbahnhof/Regionalverkehr без DB → Транспорт, тег пустой. Суммы всегда положительные числа (8, 63). Тип транзакции (расход/доход) определяется полем direction, а не знаком суммы.'
		)
		const response = await this.withRetry(() =>
			this.openai.chat.completions.create({
				model: 'gpt-4o-mini',
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
													'Название операции: максимум 1–2 слова. Максимально упрощать: убирать суффиксы //город/страна, Fil. XXXX, GmbH и др.; переводить на русский (Apotheke→Аптека, Rundfunk/Radio→Радио, Kursbuch→Книга); бренды — короткое имя (DB Vertrieb GmbH→DB, TEDi Fil. 4032→TEDi); из URL/домена — бренд (LINK.COM, ALPACAJOBS→Alpaca); аббревиатуры сохранять (RVM Ticket→RVM, Regionalverkehr Muensterland GmbH→RVM). Не сырой заголовок.'
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
											tag_confidence: { type: 'number' }
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
		)

		const call = response.choices[0].message.function_call
		if (!call?.arguments) {
			throw new Error('LLM did not return function arguments')
		}
		const parsedJson = JSON.parse(call.arguments)
		const { transactions } = LlmTransactionListSchema.parse(parsedJson)
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
						'Поддерживай нормализацию названий на кириллице/сокращениях: "абанк" -> банк, "байбит"/"bybit" -> exchange, "мекс"/"mexc" -> exchange.\n' +
						'Верни релевантный emoji из фиксированного списка:\n' +
						'bank: 🏦, 💳, 💶, 💵, 💷, 🏛, 💼, 💰, 🧾\n' +
						'exchange: 🏦, 🏢, 📊, ⚡, 🪙\n' +
						'crypto_wallet: 🪙, ₿, 💎, 🔐, 🧊, 🔥, 📈\n' +
						'cash: 💵, 💶, 👛, 👜\n' +
						'online_service: 💼, 🏢, 💳\n' +
						'other: 💼\n' +
						'Если в названии уже есть emoji в начале, верни его же в поле emoji.\n' +
							'Суммы и валюты НИКОГДА не включай в name счёта. Сумма/валюта — только в assets.\n' +
							'Название счёта сохраняй максимально близко к исходному тексту пользователя (после удаления валют и сумм), не заменяй на обобщения вроде "Банк".\n' +
							'Цифры в названии счёта сохраняй, если они не относятся к суммам активов.\n' +
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

		return accounts
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
							'Ты редактор счёта. Текущее состояние счёта передаётся в запросе.\nПравила:\n- Если указана валюта и сумма без глагола действия (например "EUR 4.26") — ЗАМЕНИТЬ текущую сумму этой валюты на указанную.\n- Если указан глагол "минус", "вычесть", "убавить" — вычесть из текущей суммы.\n- Если указан глагол "плюс", "прибавить", "добавить" — прибавить к текущей сумме.\n- Если нужно добавить новую валюту — добавь актив.\n- В ответе ОБЯЗАТЕЛЬНО сохрани все существующие активы, даже если пользователь их не упомянул.\n- Удаляй валюту только при ЯВНОМ запросе удаления (удали/убери/удалить).\n- Минимум один актив должен остаться.\nВерни обновлённый счёт в JSON.'
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
		return parsed.accounts[0]
	}

	async parseDate(text: string, timezone: string = 'UTC+02:00'): Promise<Date | null> {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
						content:
							`Ты парсер дат. Пользователь пишет дату на русском или в виде числа. Используй локальное время пользователя в часовом поясе ${timezone}. Для относительных формулировок ("сегодня", "вчера") вычисляй дату в этом часовом поясе. Верни только JSON вида {"date": "ISO_8601"}.`
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

	async transcribeAudio(
		audioBuffer: Buffer,
		opts?: {
			fileName?: string
			mimeType?: string
			language?: string
		}
	): Promise<string> {
		const fileName = opts?.fileName ?? 'voice.ogg'
		const mimeType = opts?.mimeType ?? 'audio/ogg'
		const file = await toFile(audioBuffer, fileName, { type: mimeType })
		const resp = await this.withRetry(() =>
			this.openai.audio.transcriptions.create({
				file,
				model: 'gpt-4o-mini-transcribe',
				language: opts?.language ?? 'ru',
				response_format: 'text'
			})
		)
		return typeof resp === 'string' ? resp.trim() : String((resp as any)?.text ?? '').trim()
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
