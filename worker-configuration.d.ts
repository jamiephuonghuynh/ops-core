interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: { changes?: number; [key: string]: unknown };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}
interface Message<T = unknown> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
interface MessageBatch<T = unknown> {
  messages: Message<T>[];
}
interface WorkflowInstance {
  id: string;
  status(): Promise<unknown>;
}
interface Workflow<T = unknown> {
  create(options?: { id?: string; params?: T }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}
interface ExportedHandler<Env = unknown, QueueBody = unknown> {
  fetch?(request: Request, env: Env, ctx?: unknown): Promise<Response> | Response;
  queue?(batch: MessageBatch<QueueBody>, env: Env, ctx?: unknown): Promise<void> | void;
}
declare module "cloudflare:workers" {
  export interface WorkflowEvent<T = unknown> { payload: T }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: { retries?: { limit?: number; delay?: string; backoff?: "constant" | "linear" | "exponential" } }, callback: () => Promise<T>): Promise<T>;
  }
  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
