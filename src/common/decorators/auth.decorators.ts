import { createParamDecorator, ExecutionContext, SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthUser } from '../../modules/access/auth-user';
import { PermissionCode } from '../../modules/access/permissions';

export const IS_PUBLIC_KEY = 'isPublic';
export const OPTIONAL_AUTH_KEY = 'optionalAuth';
export const PERMISSIONS_KEY = 'permissions';
export const STAFF_ONLY_KEY = 'staffOnly';

/** Endpoint needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Endpoint works anonymously but attaches the user if a valid token is sent. */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

/**
 * Requires a staff account holding ANY of the listed permissions in at least
 * one scope. Division-level checks happen in services via AuthUser.assertCan.
 */
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(STAFF_ONLY_KEY, true),
    ApiBearerAuth(),
    ApiForbiddenResponse({ description: `Requires one of: ${permissions.join(', ')}` }),
  );

export const Authenticated = () =>
  applyDecorators(ApiBearerAuth(), ApiUnauthorizedResponse({ description: 'Missing or invalid access token' }));

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest().user;
});
