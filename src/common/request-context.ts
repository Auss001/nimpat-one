import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export interface RequestContextData {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContextData>();

/** Express middleware: assigns a request id and stores ip/UA for audit logs. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId, ip: req.ip, userAgent: req.header('user-agent')?.slice(0, 512) }, () => next());
}

export function currentRequest(): RequestContextData | undefined {
  return requestContext.getStore();
}
