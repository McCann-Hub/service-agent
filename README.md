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

Returns a function that accepts an IRequest object and returns an Axios instance.
