import { useEffect, useState } from 'react';

// Step 0 shell: shows the API health status. Dashboard pages are out of scope.
export default function App() {
  const [health, setHealth] = useState({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => setHealth({ state: 'done', httpStatus: res.status, body: await res.json() }))
      .catch((err) => {
        if (err.name !== 'AbortError') setHealth({ state: 'error', message: err.message });
      });
    return () => controller.abort();
  }, []);

  const status = health.state === 'done' ? health.body.status : health.state;
  const ok = status === 'ok';

  return (
    <main className="mx-auto max-w-xl p-6 font-sans">
      <h1 className="text-2xl font-semibold">FPL Radar</h1>
      <p className="mt-4">
        API status:{' '}
        <span
          data-testid="health-status"
          className={`rounded px-2 py-0.5 font-mono ${ok ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}
        >
          {status}
        </span>
      </p>
      {health.state === 'error' && <p className="mt-2 text-sm text-red-700">{health.message}</p>}
    </main>
  );
}
