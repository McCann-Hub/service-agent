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

/**
 * Field name fragments whose values are replaced with `***REDACTED***` in
 * logged bodies and URL query strings. Matching is a case-insensitive
 * substring check, so `key` also catches `api_key` and `apiKey`. These are
 * the same fragments json-logger redacts by default.
 */
export const DEFAULT_REDACT_FIELDS: readonly string[] = Object.freeze([
  'secret',
  'password',
  'token',
  'key',
  'authorization',
  'auth',
  'cookie',
]);

const REDACTED = '***REDACTED***';

interface Redaction {
  headers: ReadonlySet<string>;
  isSensitiveField: (name: string) => boolean;
}

function formatHeaders(headers: unknown, redact: Redaction) {
  if (!headers) return undefined;
  const plain = AxiosHeaders.from(
    headers as Parameters<typeof AxiosHeaders.from>[0],
  ).toJSON();
  return Object.fromEntries(
    Object.entries(plain).map(([name, value]) => [
      name,
      redact.headers.has(name.toLowerCase()) ? REDACTED : value,
    ]),
  );
}

// Replaces sensitive values in a query or form string and leaves the rest as sent
function redactQuery(query: string, redact: Redaction): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      let name = pair.slice(0, eq);
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        // Malformed escapes: match against the raw name
      }
      return redact.isSensitiveField(name)
        ? `${pair.slice(0, eq)}=${REDACTED}`
        : pair;
    })
    .join('&');
}

function redactUrl(url: string | undefined, redact: Redaction) {
  if (!url) return url;
  // https://user:password@host keeps the user and drops the password
  const withoutPassword = url.replace(
    /^([a-z][a-z\d+.-]*:\/\/[^/?#@:]*):[^/?#@]*@/i,
    `$1:${REDACTED}@`,
  );
  const query = withoutPassword.indexOf('?');
  if (query < 0) return withoutPassword;
  const hash = withoutPassword.indexOf('#', query);
  const end = hash < 0 ? withoutPassword.length : hash;
  return withoutPassword.slice(0, query + 1) +
    redactQuery(withoutPassword.slice(query + 1, end), redact) +
    withoutPassword.slice(end);
}

function redactValue(
  value: unknown,
  redact: Redaction,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return '[Circular]';

  // Buffers, streams, FormData and the like: log the type, not the contents
  const proto = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) && proto !== Object.prototype && proto !== null
  ) {
    return `[${value.constructor?.name ?? 'Object'}]`;
  }

  ancestors.add(value);
  const redacted = Array.isArray(value)
    ? value.map((item) => redactValue(item, redact, ancestors))
    : Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redact.isSensitiveField(name)
          ? REDACTED
          : redactValue(item, redact, ancestors),
      ]),
    );
  ancestors.delete(value);
  return redacted;
}

const FORM_BODY = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*$/;

function formatBody(data: unknown, redact: Redaction): unknown {
  if (typeof data === 'string') {
    // Axios has already serialized the body by the time an error is logged
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return redactValue(JSON.parse(trimmed), redact, new Set());
      } catch {
        // Not JSON after all
      }
    }
    return FORM_BODY.test(data) ? redactQuery(data, redact) : data;
  }
  if (data instanceof URLSearchParams) {
    return redactQuery(data.toString(), redact);
  }
  return redactValue(data, redact, new Set());
}

function formatLoggerRequest(req: AxiosRequestConfig, redact: Redaction) {
  return {
    base_url: redactUrl(req.baseURL, redact),
    uri_path: redactUrl(req.url, redact),
    http_method: req.method?.toUpperCase(),
    // Keep the username for debugging; the password never reaches the logger
    authentication: req.auth
      ? { username: req.auth.username, password: REDACTED }
      : undefined,
    headers: formatHeaders(req.headers, redact),
    data: formatBody(req.data, redact),
  };
}

function formatLoggerResponse(res: AxiosResponse, redact: Redaction) {
  return {
    status: res.status,
    status_text: res.statusText,
    headers: formatHeaders(res.headers, redact),
    data: formatBody(res.data, redact),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatError(err: unknown, redact: Redaction) {
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
 * @param {string[]} [config.redactFields=DEFAULT_REDACT_FIELDS] - Field name fragments to redact from logged bodies and URL query strings. Passing a list replaces the defaults.
 * @returns {function(IRequest): AxiosInstance} - A function that accepts an `IRequest` object and returns a custom Axios instance.
 */
export default function serviceAgent({
  correlationIdHeader = 'X-Correlation-Id',
  traceIdHeader = 'X-Request-Id',
  spanIdHeader = 'X-svc2svc-Id',
  generator = defaultSpanIdGenerator,
  axiosConfig = {} as CreateAxiosDefaults,
  redactHeaders = DEFAULT_REDACT_HEADERS,
  redactFields = DEFAULT_REDACT_FIELDS,
} = {}): AxiosFactory {
  const fields = redactFields.map((field) => field.toLowerCase());
  const redact: Redaction = {
    headers: new Set(redactHeaders.map((name) => name.toLowerCase())),
    isSensitiveField: (name) =>
      fields.some((field) => name.toLowerCase().includes(field)),
  };

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
          base_url: redactUrl(req.baseURL, redact),
          uri_path: redactUrl(req.url, redact),
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
