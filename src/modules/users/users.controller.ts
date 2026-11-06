import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { AuthUser } from '../access/auth-user';
import { CreateAddressDto, UpdateAddressDto, UpdateProfileDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Account')
@Authenticated()
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Patch('profile')
  @ApiOperation({ summary: 'Update my customer profile' })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Get('addresses')
  @ApiOperation({ summary: 'List my delivery addresses' })
  listAddresses(@CurrentUser() user: AuthUser) {
    return this.users.listAddresses(user.id);
  }

  @Post('addresses')
  @ApiOperation({ summary: 'Add a delivery address' })
  createAddress(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    return this.users.createAddress(user.id, dto);
  }

  @Patch('addresses/:id')
  @ApiOperation({ summary: 'Update a delivery address' })
  updateAddress(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAddressDto) {
    return this.users.updateAddress(user.id, id, dto);
  }

  @Delete('addresses/:id')
  @ApiOperation({ summary: 'Remove a delivery address' })
  deleteAddress(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.deleteAddress(user.id, id);
  }
}
