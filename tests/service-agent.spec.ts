import { expect } from "chai";
import sinon from "sinon";
import serviceAgent from '../src';
import { IRequest } from '../src/models/IRequest'
import { Request } from "express";
import axios, { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { createRequest, MockRequest } from 'node-mocks-http'

describe('axios serviceAgent Middleware', () => {
  let req: MockRequest<IRequest<Request>> 

  beforeEach(() => {
    req = createRequest()
    req.traceId = 'foobar'
  });

  it('injects the X-Request-Id header outbound', () => {
    const client = serviceAgent()(req)
        
    expect(client.defaults.headers['X-Request-Id']).to.equal('foobar')
  })

  it('does not overwrite passed in headers', () => {
    const client = serviceAgent(
      {
        axiosConfig: { 
          headers: {
            'X-Custom-Header': "Hello World"
          } 
        }
      }
    )(req)
        
    expect(client.defaults.headers['X-Custom-Header']).to.equal('Hello World')
    expect(client.defaults.headers['X-Request-Id']).to.equal('foobar')
  })

  it('sets the baseURL of the returned instance', () => {
    const client = serviceAgent(
      {
        axiosConfig: { 
          baseURL: "https://some-domain.com/api/"
        }
      }
    )(req)
        
    expect(client.defaults.baseURL).to.equal('https://some-domain.com/api/')
    expect(client.defaults.headers['X-Request-Id']).to.equal('foobar')
  })

  it('injects the X-svc2svc-Id header outbound', () => {
    const client: AxiosInstance = serviceAgent()(req)
    //@ts-expect-error handlers will be there when the test runs
    const axiosRequest = client.interceptors.request.handlers[0].fulfilled({
      headers: new axios.AxiosHeaders(client.defaults.headers)
    })

    expect(axiosRequest.headers['X-svc2svc-Id']).to.not.equal(undefined)
    expect(client.defaults.headers['X-Request-Id']).to.equal('foobar')
  })

  it('uses the generator to create spanId', async () => {
    const generator = sinon.stub().returns('test-span-id');
    let sentConfig: InternalAxiosRequestConfig | undefined;
    const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      sentConfig = config;
      return { data: { message: 'ok' }, status: 200, statusText: 'OK', headers: {}, config };
    };
    const client = serviceAgent({ generator, axiosConfig: { adapter } })(req);

    await client.post('https://some-domain.com/api/some-endpoint');
    expect(sentConfig?.headers['X-svc2svc-Id']).to.equal('test-span-id');
    expect(generator.calledOnceWith(req)).to.be.true;
  });

  it('propagates the correct error type from interceptors', async () => {
    // Mock a network error in the transport
    const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config);
    };
    const client = serviceAgent({ axiosConfig: { adapter } })(req);

    const err = await client.post('https://some-domain.com/api/test').then(
      () => expect.fail('expected the request to reject'),
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(AxiosError);
    expect((err as AxiosError).message).to.equal('Network Error');
  });

  it('handles server-side errors gracefully', async () => {
    // Mock a 500 error response
    const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      throw new AxiosError('Server Error', 'ERR_BAD_RESPONSE', config, null, {
        data: {},
        status: 500,
        statusText: 'Internal Server Error',
        headers: {},
        config,
      });
    };
    const client = serviceAgent({ axiosConfig: { adapter } })(req);

    const err = await client.post('https://some-domain.com/api/test').then(
      () => expect.fail('expected the request to reject'),
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(AxiosError);
    expect((err as AxiosError).response?.status).to.equal(500);
  });
}) 
