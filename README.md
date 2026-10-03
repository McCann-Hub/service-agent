# Service Agent

A custom Axios client for streamlined debugging and tracing in distributed microservices environments. This library facilitates the propagation of correlation IDs, trace IDs, and span IDs across service boundaries, enhancing observability and troubleshooting.

## Features

- Automatic injection of `correlationId`, `traceId`, and `spanId` into HTTP headers.
- Customizable span ID generation for service-to-service calls.
- Robust logging for request and response lifecycles.
- Extendable via custom Axios configurations.

## Installation

```bash
npm install @mccann-hub/service-agent
```

or

```bash
yarn add @mccann-hub/service-agent
```

## Usage

### Basic Setup

```typescript
import serviceAgent from "@mccann-hub/service-agent";

const req = {
  correlationId: "abc123",
  traceId: "xyz789",
  logger: console,
};

const client = serviceAgent()(req);

client
  .get("/endpoint")
  .then((response) => console.log(response.data))
  .catch((err) => console.error(err));
```

### Custom Configurations

```typescript
const client = serviceAgent({
  correlationIdHeader: "X-Correlation-Id",
  traceIdHeader: "X-Trace-Id",
  spanIdHeader: "X-Span-Id",
  axiosConfig: {
    baseURL: "https://api.example.com",
    timeout: 5000,
  },
})(req);
```

### Integration with Express

```typescript
import express from "express";
import serviceAgent from "@mccann-hub/service-agent";

const app = express();

app.get("/api", (req, res) => {
  const client = serviceAgent()(req);
  client
    .get("/other-service")
    .then((data) => res.send(data))
    .catch((err) => res.status(500).send(err.message));
});
```

## API

### serviceAgent(config?)

- **config (optional):** Configuration object:
  - **correlationIdHeader:** Header name for correlation IDs (default: X-Correlation-Id).
  - **traceIdHeader:** Header name for trace IDs (default: X-Request-Id).
  - **spanIdHeader:** Header name for span IDs (default: X-svc2svc-Id).
  - **generator:** Function to generate span IDs.
  - **axiosConfig:** Custom Axios configuration.
  - **redactHeaders:** Header names to redact from logged requests and responses, compared case-insensitively. Defaults to `DEFAULT_REDACT_HEADERS`: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, and `x-api-key`. Passing a list replaces the defaults, so spread `DEFAULT_REDACT_HEADERS` to add to it.
  - **redactFields:** Field name fragments to redact from logged bodies and URL query strings. A field matches if its name contains a fragment, ignoring case, so `key` also matches `api_key` and `apiKey`. Defaults to `DEFAULT_REDACT_FIELDS`: `secret`, `password`, `token`, `key`, `authorization`, `auth`, and `cookie`, the same fragments json-logger redacts. Passing a list replaces the defaults, so spread `DEFAULT_REDACT_FIELDS` to add to it.

Returns a function that accepts an IRequest object and returns an Axios instance.

### Logging

If the IRequest has a `logger`, the client logs each request and response:

- `info` gets the span ID, base URL, and path on the way out, and the span ID and status on the way back.
- `debug` gets the method, base URL, path, headers, and body of each request, and the status, status text, headers, and body of each response. For basic auth, only the username is logged.
- `error` gets the error message and code, the request that failed, and the response if the server sent one.

Before anything reaches the logger, the client replaces these values with `***REDACTED***`:

- headers named in `redactHeaders`
- body fields whose names match `redactFields`, in objects, arrays, JSON strings, and form-encoded strings
- query values whose names match `redactFields`, such as `?token=...`
- the password in a URL such as `https://user:password@host`

Binary bodies such as Buffers and streams show as their type, for example `[Buffer]`.
