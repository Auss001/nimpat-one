import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AccessService } from '../../modules/access/access.service';
import { IS_PUBLIC_KEY, OPTIONAL_AUTH_KEY, PERMISSIONS_KEY, STAFF_ONLY_KEY } from '../decorators/auth.decorators';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

/**
 * Global guard: authenticates the bearer token on every route unless marked
 * @Public, then enforces @RequirePermissions. Authorization is always decided
 * here on the backend — never trust role claims from the client.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly access: AccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets);
    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    const token = this.extractToken(req);

    if (isPublic && !optional) return true;
    if (!token) {
      if (isPublic || optional) return true;
      throw new UnauthorizedException('Authentication required');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      if (optional) return true;
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (payload.typ !== 'access') throw new UnauthorizedException('Invalid token type');

    const user = await this.access.load(payload.sub, payload.sid);
    req.user = user;

    const staffOnly = this.reflector.getAllAndOverride<boolean>(STAFF_ONLY_KEY, targets);
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    if (staffOnly && !user.isStaff) throw new ForbiddenException('Staff access only');
    if (required?.length && !required.some((p) => user.hasAny(p as any))) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }

  private extractToken(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
  }
}
