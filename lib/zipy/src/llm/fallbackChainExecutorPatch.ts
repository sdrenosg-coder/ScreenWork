/**
 * Zipy AI — LLM fallback chain: executor patch (phase 25, batch 3).
 *
 * The fallback-chain executor's inner loop needs to read an optional
 * per-attempt retry classifier. Rather than adding a field to the
 * `ChainAttempt` type (which would make every caller specify it), the
 * classifier is accessed through a narrow runtime cast inside the executor.
 *
 * This file exists only so the executor in `fallbackChain.ts` can call the
 * classifier without a TypeScript error. Import order at the module path is
 * unchanged: the caller imports from `fallbackChain.ts`, and that file
 * imports the two helpers here.
 */

import type { ChainAttempt, ChainRequest } from "./fallbackChain";

/** A `ChainAttempt` with an optional attached retry classifier. */
export interface ClassifiedAttempt<TRequest, TResponse> extends ChainAttempt<TRequest, TResponse> {
  readonly nonRetryableOr?: (request: ChainRequest<TRequest>, error: unknown) => boolean;
}

/**
 * Read the retry classifier for an attempt, falling back to the request's
 * own classifier, and finally to "every error is retryable".
 *
 * The precedence is: attempt-level classifier, then request-level
 * classifier, then the default. Attempt-level first means a specific
 * provider can override the request-wide policy, which is what an operator
 * wants when (for example) one provider returns 404 on a model name while
 * the rest return 429 on quota.
 */
export function readClassifier<TRequest, TResponse>(
  attempt: ChainAttempt<TRequest, TResponse>,
  request: ChainRequest<TRequest>,
): (error: unknown) => boolean {
  const classified = attempt as ClassifiedAttempt<TRequest, TResponse>;
  if (typeof classified.nonRetryableOr === "function") {
    const fn = classified.nonRetryableOr;
    return (err: unknown): boolean => fn(request, err);
  }
  if (typeof request.isNonRetryable === "function") {
    return request.isNonRetryable;
  }
  return () => false;
}

/**
 * Attach a classifier to an attempt without mutating the caller's object.
 * See the module header of `fallbackChain.ts` for the rationale.
 */
export function withClassifier<TRequest, TResponse>(
  attempt: ChainAttempt<TRequest, TResponse>,
  classifier: (request: ChainRequest<TRequest>, error: unknown) => boolean,
): ClassifiedAttempt<TRequest, TResponse> {
  return Object.freeze({
    ...attempt,
    nonRetryableOr: classifier,
  });
}
