import { Injectable } from '@nestjs/common'
import { LlmTransactionListSchema } from './schemas/transaction.schema'
import { LlmAccountListSchema } from './schemas/account.schema'
import OpenAI from 'openai'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class LLMService {
	private readonly openai: OpenAI

	constructor(private readonly config: ConfigService) {
		this.openai = new OpenAI({
			apiKey: config.getOrThrow<string>('OPENAI_API_KEY')
		})
	}

	async parseTransaction(
		text: string,
		categoryNames: string[] = [],
		existingTags: string[] = [],
		accountNames: string[] = []
	) {
		const categoryList =
			categoryNames.length > 0
				? categoryNames.filter(n => n !== 'Не выбрано').join(', ')
				: ''
		const categoryInstruction =
			categoryList.length > 0
				? ` Для каждой транзакции выбери одну категорию по описанию из списка: ${categoryList}. Если ни одна не подходит — укажи категорию "Не выбрано". Категория обязательна.`
				: ' Для категории укажи "Не выбрано".'

		const tagList =
			existingTags.length > 0 ? existingTags.join(', ') : ''
		const tagInstruction =
			tagList.length > 0
				? ` Для каждой транзакции укажи ровно один самый точный тег. Всегда сначала проверяй существующие теги: ${tagList}. Если есть подходящий — используй его (tag_text и normalized_tag в lowercase). Выбирай самый конкретный тег по смыслу (например "кофе", а не "напитки"). Если пользователь не разделил суммы (одна общая сумма на несколько позиций) — одна транзакция с одним общим тегом (например "праздник"). Если пользователь явно указал отдельные суммы (вино 3€, торт 4€) — две транзакции с разными тегами (алкоголь, сладости). tag_confidence от 0 до 1 — уверенность в выборе тега.`
				: ' Тег не обязателен; если указываешь — один точный тег, normalized_tag в lowercase, tag_confidence 0–1.'

		const accountInstruction =
			accountNames.length > 0
				? ` У пользователя есть счета: ${accountNames.join(', ')}. Если в тексте упоминается счёт (предлог "с", "из", "на" + название) — укажи в поле account соответствующее название из списка. Сопоставляй слова даже при неточном написании (например "с революта" → Revolut).`
				: ''

		const cryptoInstruction =
			' Распознавай криптовалюты по коду: BTC, ETH, USDT, USDC, BNB, SOL, XRP, ADA, DOGE и другие популярные тикеры. Указывай currency в верхнем регистре (BTC, ETH).'

		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						'Ты парсер финансовых операций. Верни только JSON согласно схеме.' +
						categoryInstruction +
						tagInstruction +
						accountInstruction +
						cryptoInstruction
				},
				{
					role: 'user',
					content: text
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
										action: { type: 'string', enum: ['create_transaction'] },
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
												'Используйте основной предмет транзакции в качестве описания. Например: "Купил кофе за 120 грн", – описание будет "Кофе". Не отправляй длинные фразы, а выделяй сущности: "Кофе", "Термос", "Чай", "Продукты", "Одежда", "Netflix".'
										},
										rawText: { type: 'string' },
										tag_text: { type: 'string', description: 'Один точный тег для транзакции' },
										normalized_tag: { type: 'string', description: 'Тег в lowercase для сопоставления' },
										tag_confidence: { type: 'number', description: 'Уверенность 0–1 в выборе тега' }
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
						'Ты парсер мультивалютных счетов. Верни только JSON согласно схеме.'
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
									required: ['name', 'assets']
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
						'Ты редактор счёта. Пользователь даёт указания по изменению текущего счёта (название, добавление/удаление валют, изменение сумм). Применяй указания к текущему состоянию и верни один обновлённый счёт в JSON. Если сумма не указана — используй 0. Счёт должен содержать минимум один актив.'
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
		if (!call?.arguments) throw new Error('LLM did not return function arguments for account edit')
		const parsedJson = JSON.parse(call.arguments) as { accounts: unknown[] }
		const parsed = LlmAccountListSchema.parse(parsedJson)
		if (!parsed.accounts.length) throw new Error('Empty account')
		return parsed.accounts[0]
	}

	async parseDate(text: string): Promise<Date | null> {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						'Ты парсер дат. Пользователь пишет дату на русском или в виде числа. Всегда используй текущий год 2026 для выражений вроде "Сегодня", "Вчера" и подобных относительных формулировок. Верни только JSON вида {"date": "ISO_8601"}.'
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
							date: { type: 'string', description: 'Дата в формате ISO 8601' }
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
	): Promise<{ add: string[]; delete: string[]; rename: { from: string; to: string }[] }> {
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
}
