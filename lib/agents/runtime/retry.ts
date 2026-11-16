import { isRetryableAgentError } from "./agent-errors.ts";

export type RetryOptions = {
  maxRetries: number;
  backoffMs: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => Promise<void> | void;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetries<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<{ value: T; attempts: number }> {
  const maxRetries = Math.max(0, Math.min(Math.trunc(options.maxRetries), 2));
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      const canRetry = attempt <= maxRetries && (options.shouldRetry?.(error) ?? isRetryableAgentError(error));
      if (!canRetry) throw error;
      await options.onRetry?.(attempt, error);
      const backoff = Math.max(0, options.backoffMs) * attempt;
      if (backoff > 0) await wait(backoff);
    }
  }
  throw new Error("Retry loop ended unexpectedly");
}
