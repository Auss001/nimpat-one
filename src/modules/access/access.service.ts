import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, GROUP_SCOPE } from './auth-user';

interface CacheEntry {
  user: AuthUser;
  expires: number;
}

/**
 * Builds the AuthUser (roles → permission scopes) from the database.
 * A very short cache keeps hot paths fast while role/suspension changes
 * still apply within seconds; revoking a session applies immediately.
 */
@Injectable()
export class AccessService {
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly TTL_MS = 10_000;

  constructor(private readonly prisma: PrismaService) {}

  invalidate(userId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${userId}:`)) this.cache.delete(key);
  }

  async load(userId: string, sessionId: string): Promise<AuthUser> {
    const key = `${userId}:${sessionId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.user;

    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
      }),
      this.prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, revokedAt: true, expiresAt: true } }),
    ]);

    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Account is not active');
    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session has ended');
    }

    const permissions = new Map<string, Set<string>>();
    for (const ur of user.roles) {
      const scope = ur.role.isDivisionScoped ? ur.divisionId : GROUP_SCOPE;
      if (!scope) continue; // a scoped role without a division grants nothing
      for (const rp of ur.role.permissions) {
        const set = permissions.get(rp.permission.code) ?? new Set<string>();
        set.add(scope);
        permissions.set(rp.permission.code, set);
      }
    }

    const authUser = new AuthUser(
      user.id,
      // A guest is reached at their real address, not the internal sign-in placeholder.
      user.isGuest ? (user.contactEmail ?? user.email) : user.email,
      user.type,
      !!user.emailVerifiedAt,
      sessionId,
      user.roles.map((r) => ({ code: r.role.code, divisionId: r.divisionId })),
      permissions,
      user.isGuest,
    );
    this.cache.set(key, { user: authUser, expires: Date.now() + AccessService.TTL_MS });
    if (this.cache.size > 5000) this.cache.clear();
    return authUser;
  }
}
