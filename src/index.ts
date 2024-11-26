import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestHeaders,
  CreateAxiosDefaults,
} from 'axios';
import ShortUniqueId from 'short-unique-id';
import { IRequest } from '@models/IRequest';
import { ILogger } from '@models/ILogger';

const suid = new ShortUniqueId({ dictionary: 'hex' });

// eslint-disable-next-line
function defaultSpanIdGenerator(_request: IRequest): string | undefined {
  return suid.formattedUUID('$r4-$r2-$r2-$r2-$r6');
}

function createLogger(logger?: ILogger): ILogger {
  const noop = () => {}; // No-op logger
  return {
    debug: logger?.debug || noop,
    info: logger?.info || noop,
    warn: logger?.warn || noop,
    error: logger?.error || noop,
  };
}

function formatError(err: AxiosError) {
  return err.response
    ? {
      status: err.response.status,
      statusText: err.response.statusText,
      headers: err.response.headers,
      data: err.response.data,
    }
    : err.toJSON
    ? err.toJSON()
    : { message: err.message };
}

export default function serviceAgent({
  correlationIdHeader = 'X-Correlation-Id',
  traceIdHeader = 'X-Request-Id',
  spanIdHeader = 'X-svc2svc-Id',
  generator = defaultSpanIdGenerator,
  axiosConfig = {} as CreateAxiosDefaults,
} = {}) {
  return function <T = object>(_request: IRequest<T>): AxiosInstance {
    const logger = createLogger(_request.logger);

    const headers: Record<string, string> = {
      ...axiosConfig.headers as AxiosRequestHeaders,
      [correlationIdHeader]: _request.correlationId || '',
      [traceIdHeader]: _request.traceId || '',
    };

    const client = axios.create({
      ...axiosConfig,
      headers,
    });

    client.interceptors.request.use(
      (req) => {
        const spanId = generator(_request);
        if (spanId) req.headers[spanIdHeader] = spanId;

        logger.info(`Sending request`, { spanId, url: req.url });
        logger.debug('Request details', { axios: req });

        return req;
      },
      (err) => {
        logger.error(`Request error: ${err.message}`, formatError(err));
        return Promise.reject(err);
      },
    );

    client.interceptors.response.use(
      (res) => {
        const spanId = res.headers[spanIdHeader] ||
          res.config.headers?.[spanIdHeader];

        logger.info(`Received response`, { spanId, status: res.status });
        logger.debug('Response details', {
          axios: {
            request: res.config,
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
            data: res.data,
          },
        });

        return res;
      },
      (err) => {
        logger.error(`Response error: ${err.message}`, formatError(err));
        return Promise.reject(err);
      },
    );

    return client;
  };
}
