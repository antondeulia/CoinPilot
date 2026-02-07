import { Module } from '@nestjs/common'
import { UsersService } from './users.service'
import { UsersRepo } from './users.repo'
import { CategoriesModule } from '../categories/categories.module'
import { TagsModule } from '../tags/tags.module'

@Module({
	imports: [CategoriesModule, TagsModule],
	providers: [UsersService, UsersRepo],
	exports: [UsersService]
})
export class UsersModule {}
