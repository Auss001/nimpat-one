import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Reads the optional `Idempotency-Key` header (8–100 URL-safe characters).
 * Re-sending a request with the same key returns the original result
 * instead of creating a duplicate order / booking / payment.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const value = ctx.switchToHttp().getRequest().header('idempotency-key') as string | undefined;
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(value)) {
    throw new BadRequestException('Idempotency-Key must be 8-100 characters: letters, digits, _ - : .');
  }
  return value;
});
