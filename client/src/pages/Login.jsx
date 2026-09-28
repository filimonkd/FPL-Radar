import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { endpoints, setShareToken } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Button, Card, ErrorBox, Field, inputClass } from '../components/ui.jsx';

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
    <div className="mx-auto max-w-sm">
      <Card title="Admin sign-in">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Password" hint="Viewers open the share link the admin sends instead.">
            <input type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <ErrorBox error={error} title="Sign-in failed" />
          <Button type="submit" className="w-full" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
      </Card>
    </div>
  );
}
