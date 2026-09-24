import { FplError, FplErrorKind } from './errors.js';

// closed    -> requests flow; consecutive upstream failures are counted
// open      -> requests are rejected immediately until resetTimeoutMs elapses
// half_open -> one probe request is allowed; success closes, failure re-opens

export const CircuitState = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

export const DEFAULT_BREAKER = Object.freeze({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

export class CircuitBreaker {
  #state = CircuitState.CLOSED;
  #failures = 0;
  #openedAt = 0;
  #probeInFlight = false;

  constructor(
    { failureThreshold, resetTimeoutMs } = DEFAULT_BREAKER,
    { now = Date.now, isFailure = (err) => err?.upstreamFailure === true, onStateChange } = {},
  ) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.now = now;
    this.isFailure = isFailure;
    this.onStateChange = onStateChange;
  }

  get state() {
    if (this.#state === CircuitState.OPEN && this.now() - this.#openedAt >= this.resetTimeoutMs) {
      this.#transition(CircuitState.HALF_OPEN);
    }
    return this.#state;
  }

  #transition(next) {
    if (next === this.#state) return;
    const prev = this.#state;
    this.#state = next;
    if (next === CircuitState.OPEN) this.#openedAt = this.now();
    if (next === CircuitState.CLOSED) this.#failures = 0;
    this.onStateChange?.({ from: prev, to: next });
  }

  async execute(fn) {
    const state = this.state;
    if (state === CircuitState.OPEN || (state === CircuitState.HALF_OPEN && this.#probeInFlight)) {
      throw new FplError(FplErrorKind.CIRCUIT_OPEN, 'FPL circuit breaker is open');
    }

    const isProbe = state === CircuitState.HALF_OPEN;
    if (isProbe) this.#probeInFlight = true;

    try {
      const result = await fn();
      this.#failures = 0;
      this.#transition(CircuitState.CLOSED);
      return result;
    } catch (err) {
      if (this.isFailure(err)) {
        this.#failures += 1;
        if (isProbe || this.#failures >= this.failureThreshold) this.#transition(CircuitState.OPEN);
      } else if (isProbe) {
        // Upstream answered (e.g. 404): it is reachable, so close the circuit.
        this.#transition(CircuitState.CLOSED);
      }
      throw err;
    } finally {
      if (isProbe) this.#probeInFlight = false;
    }
  }
}
