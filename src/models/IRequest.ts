import { ILogger } from '@models/ILogger';

export type IRequest<T = object> = T & {
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  logger?: ILogger;
};
