import { Module } from '@nestjs/common'
import { UsersService } from './users.service'
import { UsersRepo } from './users.repo'

@Module({
	providers: [UsersService, UsersRepo],
	exports: [UsersService]
})
export class UsersModule {}
