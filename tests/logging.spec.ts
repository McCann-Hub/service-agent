import { expect } from "chai";
import sinon from "sinon";
import serviceAgent from '../src';
import { IRequest } from '../src/models/IRequest'
import { ILogger } from '../src/models/ILogger'
import { Request } from "express";
import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { createRequest, MockRequest } from 'node-mocks-http'

type Adapter = (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>;

const ok: Adapter = async (config) => ({
  data: { message: 'ok' },
  status: 200,
  statusText: 'OK',
  headers: { 'set-cookie': ['session=abc123; HttpOnly'], 'content-type': 'application/json' },
  config,
});

// Returns the metadata of the first call to a logger method with this message
function metadata(method: sinon.SinonSpy, message: string) {
  const call = method.getCalls().find((c) => String(c.args[0]).startsWith(message));
  expect(call, `no "${message}" log`).to.not.equal(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return call!.args[1] as any;
}

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => expect.fail('expected the request to reject'),
    (e: unknown) => e,
  );
}

describe('serviceAgent logging', () => {
  let req: MockRequest<IRequest<Request>>
  let logger: { [K in keyof ILogger]: sinon.SinonSpy }

  beforeEach(() => {
    logger = {
      debug: sinon.spy(),
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    }
    req = createRequest()
    req.traceId = 'foobar'
    req.logger = logger
  });

  it('redacts credential headers and auth in request details', async () => {
    const client = serviceAgent({ axiosConfig: { adapter: ok } })(req);

    await client.get('https://some-domain.com/api/thing', {
      headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'k-123', Accept: 'text/plain' },
      auth: { username: 'svc-user', password: 'hunter22' },
    });

    const details = metadata(logger.debug, 'Request details').axios;
    expect(details.http_method).to.equal('GET');
    expect(details.uri_path).to.equal('https://some-domain.com/api/thing');
    expect(details.headers.Authorization).to.equal('***REDACTED***');
    expect(details.headers['X-Api-Key']).to.equal('***REDACTED***');
    expect(details.headers.Accept).to.equal('text/plain');
    expect(details.headers['X-Request-Id']).to.equal('foobar');
    expect(details.authentication).to.deep.equal({ username: 'svc-user', password: '***REDACTED***' });
    expect(JSON.stringify(logger.debug.args)).to.not.include('secret-token');
    expect(JSON.stringify(logger.debug.args)).to.not.include('hunter22');
  });

  it('redacts set-cookie in response details', async () => {
    const client = serviceAgent({ axiosConfig: { adapter: ok } })(req);

    await client.get('https://some-domain.com/api/thing');

    const details = metadata(logger.debug, 'Response details').axios;
    expect(details.status).to.equal(200);
    expect(details.headers['set-cookie']).to.equal('***REDACTED***');
    expect(details.headers['content-type']).to.equal('application/json');
  });

  it('logs the request config, not the raw transport request, on network errors', async () => {
    const adapter: Adapter = async (config) => {
      // The real http adapter attaches a ClientRequest here
      throw new AxiosError('Network Error', 'ERR_NETWORK', config, { socket: 'raw' });
    };
    const client = serviceAgent({ axiosConfig: { adapter } })(req);

    await rejection(client.post('https://some-domain.com/api/test', { a: 1 }, {
      headers: { Authorization: 'Bearer secret-token' },
    }));

    const logged = metadata(logger.error, 'Response error: Network Error');
    expect(logged.spanId).to.be.a('string');
    expect(logged.axios.code).to.equal('ERR_NETWORK');
    expect(logged.axios.request.http_method).to.equal('POST');
    expect(logged.axios.request.uri_path).to.equal('https://some-domain.com/api/test');
    expect(logged.axios.request.headers.Authorization).to.equal('***REDACTED***');
    expect(logged.axios.response).to.equal(undefined);
    expect(JSON.stringify(logged)).to.not.include('socket');
  });

  it('logs both request and response on server errors', async () => {
    const adapter: Adapter = async (config) => {
      throw new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', config, null, {
        data: { error: 'boom' },
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'set-cookie': ['session=abc123'] },
        config,
      });
    };
    const client = serviceAgent({ axiosConfig: { adapter } })(req);

    await rejection(client.get('https://some-domain.com/api/test'));

    const logged = metadata(logger.error, 'Response error').axios;
    expect(logged.request.http_method).to.equal('GET');
    expect(logged.response.status).to.equal(500);
    expect(logged.response.data).to.deep.equal({ error: 'boom' });
    expect(logged.response.headers['set-cookie']).to.equal('***REDACTED***');
  });

  it('accepts a custom redactHeaders list, matched case-insensitively', async () => {
    const client = serviceAgent({
      axiosConfig: { adapter: ok },
      redactHeaders: ['X-Internal-Secret'],
    })(req);

    await client.get('https://some-domain.com/api/thing', {
      headers: { 'x-internal-secret': 's3cr3t', Authorization: 'Bearer visible' },
    });

    const headers = metadata(logger.debug, 'Request details').axios.headers;
    expect(headers['x-internal-secret']).to.equal('***REDACTED***');
    expect(headers.Authorization).to.equal('Bearer visible');
  });

  it('logs errors that are not AxiosErrors', async () => {
    const failures: unknown[] = [new TypeError('adapter blew up'), 'plain string failure'];
    for (const failure of failures) {
      const adapter: Adapter = async () => {
        throw failure;
      };
      const client = serviceAgent({ axiosConfig: { adapter } })(req);

      const err = await rejection(client.get('https://some-domain.com/api/thing'));
      expect(err).to.equal(failure);
    }

    const [typeError, plain] = logger.error.args;
    expect(typeError[0]).to.equal('Response error: adapter blew up');
    expect(typeError[1].axios).to.include({ name: 'TypeError', message: 'adapter blew up' });
    expect(plain[0]).to.equal('Response error: plain string failure');
    expect(plain[1].axios).to.deep.equal({ error: 'plain string failure' });
  });
})
