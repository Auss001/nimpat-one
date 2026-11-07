import { ForbiddenException } from '@nestjs/common';
import { RoleCode, UserType } from '@prisma/client';
import { PermissionCode } from './permissions';

export const GROUP_SCOPE = '*';

/**
 * The authenticated principal attached to each request. Permissions map to
 * the set of division ids they apply to; '*' means group-wide.
 */
export class AuthUser {
  constructor(
    readonly id: string,
    readonly email: string,
    readonly type: UserType,
    readonly emailVerified: boolean,
    readonly sessionId: string,
    readonly roles: { code: RoleCode; divisionId: string | null }[],
    readonly permissions: Map<string, Set<string>>,
    /** Bought without an account: no Royalty points, and no email check before paying. */
    readonly isGuest = false,
  ) {}

  get isStaff(): boolean {
    return this.type === UserType.STAFF;
  }

  hasRole(code: RoleCode): boolean {
    return this.roles.some((r) => r.code === code);
  }

  /** True if the permission is held anywhere (any division or group-wide). */
  hasAny(permission: PermissionCode): boolean {
    return (this.permissions.get(permission)?.size ?? 0) > 0;
  }

  /** True if the permission applies to the given division. */
  can(permission: PermissionCode, divisionId: string | null | undefined): boolean {
    const scopes = this.permissions.get(permission);
    if (!scopes) return false;
    if (scopes.has(GROUP_SCOPE)) return true;
    return !!divisionId && scopes.has(divisionId);
  }

  assertCan(permission: PermissionCode, divisionId: string | null | undefined): void {
    if (!this.can(permission, divisionId)) {
      throw new ForbiddenException(`Missing permission ${permission} for this division`);
    }
  }

  /**
   * Division filter for list queries: undefined = no restriction (group-wide),
   * otherwise the ids this user may see for that permission.
   */
  divisionFilter(permission: PermissionCode): string[] | undefined {
    const scopes = this.permissions.get(permission);
    if (!scopes || scopes.size === 0) return [];
    if (scopes.has(GROUP_SCOPE)) return undefined;
    return [...scopes];
  }
}
