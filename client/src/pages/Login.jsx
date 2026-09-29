import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, Radar } from 'lucide-react';
import { endpoints, setShareToken } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Button, ErrorBox, Field, inputClass } from '../components/ui.jsx';

// Admin sign-in with the app's own password (never an FPL login). The session
// is an HttpOnly cookie set by the server; nothing is stored here.
export default function Login() {
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (session.role === 'admin') return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.login(password);
      setShareToken(null);
      setPassword('');
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center pt-6 sm:pt-12">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand text-brand-ink shadow-lg"><Radar size={28} aria-hidden="true" /></span>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-center text-sm text-muted">Sign in to manage your mini-league groups.</p>
      <form onSubmit={submit} className="mt-6 w-full space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
        <Field label="Password" hint="Viewers open the share link the admin sends instead.">
          <input type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorBox error={error} title="Sign-in failed" />
        <Button type="submit" icon={Lock} className="w-full" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </div>
  );
}
