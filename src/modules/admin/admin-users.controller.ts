import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AssignRoleDto, CreateStaffDto, UpdateUserStatusDto, UserQueryDto } from './admin-users.dto';
import { AdminUsersService } from './admin-users.service';

@ApiTags('Admin · Users & Roles')
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get('users')
  @RequirePermissions(P.customersRead, P.staffManage)
  @ApiOperation({ summary: 'Search customers and staff' })
  list(@CurrentUser() user: AuthUser, @Query() q: UserQueryDto) {
    return this.service.list(user, q);
  }

  @Get('users/:id')
  @RequirePermissions(P.customersRead, P.staffManage)
  @ApiOperation({ summary: 'Get a user with roles' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post('staff')
  @RequirePermissions(P.staffManage, P.rolesAssign)
  @ApiOperation({ summary: 'Create a staff account and email an invitation' })
  createStaff(@CurrentUser() user: AuthUser, @Body() dto: CreateStaffDto) {
    return this.service.createStaff(user, dto);
  }

  @Post('users/:id/invite')
  @RequirePermissions(P.staffManage, P.rolesAssign)
  @ApiOperation({ summary: 'Send a new invitation to staff who have never signed in' })
  invite(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.resendInvite(user, id);
  }

  @Post('users/:id/roles')
  @RequirePermissions(P.rolesAssign)
  @ApiOperation({ summary: 'Grant a role (optionally scoped to a division)' })
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignRoleDto) {
    return this.service.assignRole(user, id, dto);
  }

  @Delete('users/:id/roles/:userRoleId')
  @RequirePermissions(P.rolesAssign)
  @ApiOperation({ summary: 'Revoke a role assignment' })
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userRoleId', ParseUUIDPipe) userRoleId: string,
  ) {
    return this.service.revokeRole(user, id, userRoleId);
  }

  @Patch('users/:id/status')
  @RequirePermissions(P.staffManage)
  @ApiOperation({ summary: 'Suspend, deactivate or reactivate an account' })
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserStatusDto) {
    return this.service.updateStatus(user, id, dto);
  }

  @Get('roles')
  @RequirePermissions(P.rolesAssign, P.staffManage)
  @ApiOperation({ summary: 'List roles and their permissions' })
  roles() {
    return this.service.listRoles();
  }

  @Get('departments')
  @RequirePermissions(P.rolesAssign, P.staffManage)
  @ApiOperation({ summary: 'List departments' })
  departments() {
    return this.service.listDepartments();
  }
}
