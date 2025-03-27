import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosRequestHeaders,
  AxiosResponse,
  CreateAxiosDefaults,
  InternalAxiosRequestConfig,
} from 'axios';
import ShortUniqueId from 'short-unique-id';
import { IRequest } from '@models/IRequest';
import { ILogger } from '@models/ILogger';

const suid = new ShortUniqueId({ dictionary: 'hex' });

// eslint-disable-next-line
function defaultSpanIdGenerator(_request: IRequest): string | undefined {
  return suid.formattedUUID('$r4-$r2-$r2-$r2-$r6');
}

type AxiosFactory = (_request: IRequest) => AxiosInstance;

function createLogger(logger?: ILogger): ILogger {
  const noop = () => {}; // No-op logger
  return {
    debug: logger?.debug || noop,
    info: logger?.info || noop,
    warn: logger?.warn || noop,
    error: logger?.error || noop,
  };
}

function formatLoggerRequest(req: AxiosRequestConfig) {
  return {
    base_url: req.baseURL,
    uri_path: req.url,
    http_method: req.method,
    authentication: req.auth,
    headers: req.headers,
    data: req.data,
  };
}

function formatLoggerResponse(res: AxiosResponse) {
  return {
    status: res.status,
    status_text: res.statusText,
    headers: res.headers,
    data: res.data,
  };
}

function formatError(err: unknown) {
  if (err instanceof AxiosError) {
    if (err.response) {
      return formatLoggerResponse(err.response);
    } else if (err.request) {
      return formatLoggerRequest(err.request);
    }
    return err.toJSON();
  }
  return err.toJSON ? err.toJSON() : { err };
}
/**
 * Creates a custom Axios client configured for tracing and debugging in microservices.
 *
 * @param {Object} [config] - Configuration for the service agent.
 * @param {string} [config.correlationIdHeader="X-Correlation-Id"] - Header name for correlation IDs.
 * @param {string} [config.traceIdHeader="X-Request-Id"] - Header name for trace IDs.
 * @param {string} [config.spanIdHeader="X-svc2svc-Id"] - Header name for span IDs.
 * @param {function} [config.generator] - Function to generate span IDs. Defaults to a random hex-based ID generator.
 * @param {Object} [config.axiosConfig] - Additional Axios configuration.
 * @returns {function(IRequest): AxiosInstance} - A function that accepts an `IRequest` object and returns a custom Axios instance.
 */
export default function serviceAgent({
  correlationIdHeader = 'X-Correlation-Id',
  traceIdHeader = 'X-Request-Id',
  spanIdHeader = 'X-svc2svc-Id',
  generator = defaultSpanIdGenerator,
  axiosConfig = {} as CreateAxiosDefaults,
} = {}): AxiosFactory {
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
      (req: InternalAxiosRequestConfig) => {
        const spanId = generator(_request);
        if (spanId) req.headers[spanIdHeader] = spanId;

        logger.info(`Sending request`, {
          spanId,
          base_url: req.baseURL,
          uri_path: req.url,
        });
        logger.debug('Request details', {
          spanId,
          axios: formatLoggerRequest(req),
        });

        return req;
      },
      (err: unknown) => {
        logger.error(
          `Request error: ${(err as Error).message}`,
          formatError(err),
        );
        //return Promise.reject(err);
        throw err;
      },
    );

    client.interceptors.response.use(
      (res: AxiosResponse) => {
        const spanId = res.headers[spanIdHeader] ||
          res.config.headers?.[spanIdHeader];

        logger.info(`Received response`, {
          spanId,
          status: res.status,
        });
        logger.debug('Response details', {
          spanId,
          axios: formatLoggerResponse(res),
        });

        return res;
      },
      (err: unknown) => {
        logger.error(
          `Response error: ${(err as Error).message}`,
          formatError(err),
        );
        //return Promise.reject(err);
        throw err;
      },
    );

    return client;
  };
}
