import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { currentRequest } from '../request-context';

/**
 * Converts known database errors into clean HTTP errors and makes sure no
 * internal details (SQL, stack traces) leak to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentRequest()?.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { statusCode: status, message: body } : body;
      res.status(status).json({ ...(payload as object), requestId });
      return;
    }

    const mapped = mapDbError(exception);
    if (mapped) {
      res.status(mapped.status).json({ statusCode: mapped.status, error: mapped.error, message: mapped.message, requestId });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      requestId,
    });
  }
}

/**
 * True when a booking insert lost a race. PostgreSQL reports overlapping
 * ranges as 23P01, but two *simultaneous* conflicting inserts under an
 * exclusion constraint can instead abort one transaction with a deadlock
 * (40P01) — documented PostgreSQL behaviour. Both mean "slot taken".
 */
export function isExclusionViolation(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  return msg.includes('23P01') || msg.includes('exclusion constraint') || isConcurrencyConflict(e);
}

export function isConcurrencyConflict(e: unknown): boolean {
  const msg = (e as Error)?.message ?? '';
  const code = (e as { code?: string })?.code;
  return code === 'P2034' || msg.includes('40P01') || msg.includes('deadlock detected') || msg.includes('40001') || msg.includes('could not serialize');
}

export function isCheckViolation(e: unknown, constraint?: string): boolean {
  const msg = (e as Error)?.message ?? '';
  return (msg.includes('23514') || msg.includes('check constraint')) && (!constraint || msg.includes(constraint));
}

function mapDbError(e: unknown): { status: number; error: string; message: string } | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2002':
        return { status: 409, error: 'Conflict', message: `A record with this ${fields(e)} already exists` };
      case 'P2025':
        return { status: 404, error: 'Not Found', message: 'Record not found' };
      case 'P2003':
        return { status: 422, error: 'Unprocessable Entity', message: 'A referenced record does not exist' };
      case 'P2034':
        return { status: 409, error: 'Conflict', message: 'Concurrent update conflict, please retry' };
    }
  }
  if (isConcurrencyConflict(e)) {
    return { status: 409, error: 'Conflict', message: 'The resource was modified concurrently. Please retry.' };
  }
  if (isExclusionViolation(e)) {
    return { status: 409, error: 'Conflict', message: 'The requested time slot is no longer available' };
  }
  if (isCheckViolation(e)) {
    return { status: 422, error: 'Unprocessable Entity', message: 'The request violates a data integrity rule' };
  }
  return null;
}

function fields(e: Prisma.PrismaClientKnownRequestError): string {
  const target = (e.meta?.target as string[] | string | undefined) ?? 'value';
  return Array.isArray(target) ? target.join(', ') : target;
}
