import { Body, Controller, Headers, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { StripeService } from './stripe.service'

@Controller('stripe')
export class StripeController {
	constructor(private readonly stripeService: StripeService) {}

	@Post('webhook')
	async handleWebhook(
		@Req() req: Request,
		@Headers('stripe-signature') signature: string | undefined,
		@Body() _body: any // тело берём из rawBody, выставленного в main.ts
	) {
		const raw = (req as any).rawBody as Buffer
		await this.stripeService.handleWebhook(raw, signature)
		return { received: true }
	}
}

