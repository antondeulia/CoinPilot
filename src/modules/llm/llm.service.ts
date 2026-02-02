import { Injectable } from '@nestjs/common'
import { LlmTransactionSchema } from './schemas/transaction.schema'
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

	async parseTransaction(text: string) {
		const response = await this.openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0,
			messages: [
				{
					role: 'system',
					content:
						'Ты парсер финансовых операций. Верни только JSON согласно схеме.'
				},
				{
					role: 'user',
					content: text
				}
			],
			functions: [
				{
					name: 'create_transaction',
					description: 'Создать финансовую транзакцию',
					parameters: {
						type: 'object',
						properties: {
							action: { type: 'string', enum: ['create_transaction'] },
							amount: { type: 'number' },
							currency: { type: 'string' },
							direction: { type: 'string', enum: ['income', 'expense'] },
							category: { type: 'string' },
							description: { type: 'string' }
						},
						required: ['action', 'direction']
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

		return LlmTransactionSchema.parse(parsedJson)
	}
}
