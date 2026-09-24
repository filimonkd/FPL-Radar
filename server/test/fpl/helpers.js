// Shared test doubles for the FPL client. Payloads are synthetic, not real FPL data.

export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// fetch double that replays a script of responses (functions, Responses or Errors).
export function scriptedFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.length > 1 ? script.shift() : script[0];
    const out = typeof step === 'function' ? await step(url, init) : step;
    if (out instanceof Error) throw out;
    return out instanceof Response ? out.clone() : out;
  };
  fn.calls = calls;
  return fn;
}

export const minimalBootstrap = () => ({
  events: [
    { id: 1, name: 'Gameweek 1', deadline_time: '2000-01-01T00:00:00Z', finished: false, is_current: true, is_next: false },
  ],
  teams: [{ id: 1, name: 'Team A', short_name: 'TMA' }],
  elements: [{ id: 1, web_name: 'Player', team: 1, element_type: 3, now_cost: 50 }],
  element_types: [{ id: 3, singular_name_short: 'MID' }],
});

// Client options that make tests deterministic: fake time, no jitter, no throttling.
export function testOptions(clock, overrides = {}) {
  return {
    baseUrl: 'https://fpl.test/api',
    now: clock.now,
    sleep: clock.sleep,
    random: () => 1,
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    ...overrides,
  };
}
