import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class TransactionsService {
	constructor(private prisma: PrismaService) {}

	async create(params: {
		userId: string
		accountId: string
		amount: number
		currency: string
		direction: 'income' | 'expense'
		category?: string
		description?: string
		rawText: string
	}) {
		return this.prisma.transaction.create({
			data: params
		})
	}
}
