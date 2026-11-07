import { AppConfig } from '../../config/app-config.service';
import { MailService } from './mail.service';

const KEY = 're_test_placeholder_not_a_real_key';

function service(env: Record<string, unknown>) {
  const config = { get: (k: string) => env[k], isProduction: true } as unknown as AppConfig;
  return new MailService(config);
}

describe('MailService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('only logs in console mode, and calls nobody', async () => {
    const fetch = jest.fn();
    global.fetch = fetch as unknown as typeof global.fetch;
    await service({ MAIL_TRANSPORT: 'console' }).send({ to: 'a@b.test', subject: 'Hi', text: 'Hello' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends through Resend with the key, the sender and a clickable link', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'email_1' }) });
    global.fetch = fetch as unknown as typeof global.fetch;
    await service({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'Nimpat One <no-reply@notify.nimpatgroup.com>' })
      .send({ to: 'a@b.test', subject: 'Reset', text: 'Open https://app.example/reset?token=x&y=1 <now>' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: 'Nimpat One <no-reply@notify.nimpatgroup.com>', to: ['a@b.test'], subject: 'Reset' });
    expect(body.html).toContain('<a href="https://app.example/reset?token=x&amp;y=1">');
    expect(body.html).toContain('&lt;now&gt;');
  });

  it('reports a refused email without ever including the key', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '{"message":"The domain is not verified"}' }) as unknown as typeof global.fetch;
    const sending = service({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'x@y.test' }).send({ to: 'a@b.test', subject: 'S', text: 'T' });
    await expect(sending).rejects.toThrow('Resend refused the email (403)');
    await expect(sending).rejects.not.toThrow(KEY);
  });

  it('refuses to send without a key', async () => {
    await expect(service({ MAIL_TRANSPORT: 'resend' }).send({ to: 'a@b.test', subject: 'S', text: 'T' })).rejects.toThrow('RESEND_API_KEY is not set');
  });
});
