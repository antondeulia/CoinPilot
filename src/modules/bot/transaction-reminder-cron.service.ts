import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { BotService } from './bot.service'

function parseOffsetMinutes(tz: string): number | null {
	const m = tz.match(/^([+-])(\d{2}):(\d{2})$/)
	if (!m) return null
	const sign = m[1] === '-' ? -1 : 1
	return sign * (Number(m[2]) * 60 + Number(m[3]))
}

function localDateParts(date: Date, timezone: string): {
	year: number
	month: number
	day: number
	hour: number
	minute: number
} {
	const offset = parseOffsetMinutes(timezone)
	if (offset != null) {
		const shifted = new Date(date.getTime() + offset * 60_000)
		return {
			year: shifted.getUTCFullYear(),
			month: shifted.getUTCMonth() + 1,
			day: shifted.getUTCDate(),
			hour: shifted.getUTCHours(),
			minute: shifted.getUTCMinutes()
		}
	}
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone || 'UTC',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	})
	const parts = fmt.formatToParts(date)
	const get = (type: string) =>
		Number(parts.find(p => p.type === type)?.value ?? '0')
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		hour: get('hour'),
		minute: get('minute')
	}
}

function sameLocalDay(a: Date, b: Date, timezone: string): boolean {
	const pa = localDateParts(a, timezone)
	const pb = localDateParts(b, timezone)
	return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day
}

@Injectable()
export class TransactionReminderCronService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly botService: BotService
	) {}

	@Cron('*/10 * * * *')
	async sendDailyTransactionReminder() {
		const prismaAny = this.prisma as any
		const users = await prismaAny.user.findMany({
			select: {
				id: true,
				telegramId: true,
				timezone: true,
				lastDailyReminderAt: true
			}
		})
		const now = new Date()
		for (const user of users) {
			const alertsEnabled = await this.prisma.alertConfig.count({
				where: { userId: user.id, enabled: true }
			})
			if (!alertsEnabled) continue
			const timezone = user.timezone || 'UTC'
			const local = localDateParts(now, timezone)
			if (local.hour !== 20 || local.minute > 9) continue
			if (
				user.lastDailyReminderAt &&
				sameLocalDay(user.lastDailyReminderAt, now, timezone)
			) {
				continue
			}
			const lastTx = await prismaAny.transaction.findFirst({
				where: { userId: user.id },
				orderBy: { createdAt: 'desc' },
				select: { createdAt: true }
			})
			if (lastTx && now.getTime() - lastTx.createdAt.getTime() < 8 * 60 * 60 * 1000) {
				continue
			}
			await this.botService.sendToUser(
				user.telegramId,
				'📝 Напоминание: добавьте сегодняшние операции, чтобы аналитика оставалась точной.'
			)
			await prismaAny.user.update({
				where: { id: user.id },
				data: { lastDailyReminderAt: now }
			})
		}
	}
}
