import axios, {
  AxiosHeaders,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosRequestHeaders,
  AxiosResponse,
  CreateAxiosDefaults,
  InternalAxiosRequestConfig,
  isAxiosError,
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

/**
 * Header names whose values are replaced with `***REDACTED***` in logs.
 * Compared case-insensitively.
 */
export const DEFAULT_REDACT_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

const REDACTED = '***REDACTED***';

function formatHeaders(headers: unknown, redact: ReadonlySet<string>) {
  if (!headers) return undefined;
  const plain = AxiosHeaders.from(
    headers as Parameters<typeof AxiosHeaders.from>[0],
  ).toJSON();
  return Object.fromEntries(
    Object.entries(plain).map(([name, value]) => [
      name,
      redact.has(name.toLowerCase()) ? REDACTED : value,
    ]),
  );
}

function formatLoggerRequest(
  req: AxiosRequestConfig,
  redact: ReadonlySet<string>,
) {
  return {
    base_url: req.baseURL,
    uri_path: req.url,
    http_method: req.method?.toUpperCase(),
    // Keep the username for debugging; the password never reaches the logger
    authentication: req.auth
      ? { username: req.auth.username, password: REDACTED }
      : undefined,
    headers: formatHeaders(req.headers, redact),
    data: req.data,
  };
}

function formatLoggerResponse(
  res: AxiosResponse,
  redact: ReadonlySet<string>,
) {
  return {
    status: res.status,
    status_text: res.statusText,
    headers: formatHeaders(res.headers, redact),
    data: res.data,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatError(err: unknown, redact: ReadonlySet<string>) {
  if (isAxiosError(err)) {
    return {
      message: err.message,
      code: err.code,
      // err.request is the raw ClientRequest/XMLHttpRequest; the config is
      // what describes the request we sent
      request: err.config ? formatLoggerRequest(err.config, redact) : undefined,
      response: err.response
        ? formatLoggerResponse(err.response, redact)
        : undefined,
    };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { error: String(err) };
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
 * @param {string[]} [config.redactHeaders=DEFAULT_REDACT_HEADERS] - Header names to redact from logged requests and responses. Passing a list replaces the defaults.
 * @returns {function(IRequest): AxiosInstance} - A function that accepts an `IRequest` object and returns a custom Axios instance.
 */
export default function serviceAgent({
  correlationIdHeader = 'X-Correlation-Id',
  traceIdHeader = 'X-Request-Id',
  spanIdHeader = 'X-svc2svc-Id',
  generator = defaultSpanIdGenerator,
  axiosConfig = {} as CreateAxiosDefaults,
  redactHeaders = DEFAULT_REDACT_HEADERS,
} = {}): AxiosFactory {
  const redact: ReadonlySet<string> = new Set(
    redactHeaders.map((name) => name.toLowerCase()),
  );

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
          axios: formatLoggerRequest(req, redact),
        });

        return req;
      },
      (err: unknown) => {
        logger.error(
          `Request error: ${errorMessage(err)}`,
          formatError(err, redact),
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
          axios: formatLoggerResponse(res, redact),
        });

        return res;
      },
      (err: unknown) => {
        const spanId = isAxiosError(err)
          ? err.config?.headers?.[spanIdHeader]
          : undefined;

        logger.error(`Response error: ${errorMessage(err)}`, {
          spanId,
          axios: formatError(err, redact),
        });
        //return Promise.reject(err);
        throw err;
      },
    );

    return client;
  };
}
