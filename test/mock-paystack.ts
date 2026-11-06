import { createServer, IncomingMessage, Server } from 'node:http';

interface Tx {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  email: string;
}

/**
 * Minimal in-memory stand-in for the Paystack REST API used in e2e tests.
 * `outcome` lets a test decide what verify returns for a reference.
 */
export class MockPaystack {
  private server?: Server;
  // Paystack ids are globally unique; start from the clock so re-runs never collide.
  private seq = Date.now();
  readonly transactions = new Map<string, Tx>();
  readonly outcome = new Map<string, { status: string; amount?: number; currency?: string }>();
  readonly refunds: { id: number; transaction: string; amount?: number }[] = [];
  verifyCalls = 0;

  start(port: number): Promise<void> {
    this.server = createServer(async (req, res) => {
      const body = await readJson(req);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${process.env.PAYSTACK_SECRET_KEY}`) return send(401, { status: false, message: 'Invalid key' });

      if (req.method === 'POST' && req.url === '/transaction/initialize') {
        const tx: Tx = { id: ++this.seq, reference: body.reference, amount: body.amount, currency: body.currency, email: body.email };
        this.transactions.set(tx.reference, tx);
        return send(200, { status: true, message: 'Authorization URL created', data: { authorization_url: `https://checkout.paystack.test/${tx.reference}`, access_code: `ac_${tx.id}`, reference: tx.reference } });
      }
      const verify = req.url?.match(/^\/transaction\/verify\/(.+)$/);
      if (req.method === 'GET' && verify) {
        this.verifyCalls++;
        const tx = this.transactions.get(decodeURIComponent(verify[1]));
        if (!tx) return send(400, { status: false, message: 'Transaction reference not found' });
        const o = this.outcome.get(tx.reference) ?? { status: 'success' };
        return send(200, {
          status: true,
          message: 'Verification successful',
          data: { id: tx.id, status: o.status, reference: tx.reference, amount: o.amount ?? tx.amount, currency: o.currency ?? tx.currency, channel: 'card', gateway_response: o.status === 'success' ? 'Successful' : 'Declined', paid_at: new Date().toISOString(), fees: 1500 },
        });
      }
      if (req.method === 'POST' && req.url === '/charge') {
        const tx = this.transactions.get(body.reference);
        return send(200, { status: true, message: 'Charge attempted', data: { status: tx ? 'success' : 'failed', reference: body.reference } });
      }
      if (req.method === 'POST' && req.url === '/refund') {
        const r = { id: ++this.seq, transaction: body.transaction, amount: body.amount };
        this.refunds.push(r);
        return send(200, { status: true, message: 'Refund has been queued', data: { id: r.id, status: 'pending', amount: r.amount, currency: 'NGN' } });
      }
      const refund = req.url?.match(/^\/refund\/(\d+)$/);
      if (req.method === 'GET' && refund) {
        const r = this.refunds.find((x) => x.id === Number(refund[1]));
        return r ? send(200, { status: true, message: 'ok', data: { id: r.id, status: 'pending', amount: r.amount, currency: 'NGN' } }) : send(404, { status: false, message: 'Not found' });
      }
      send(404, { status: false, message: 'Not found' });
    });
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve()));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}
