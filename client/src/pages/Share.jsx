import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { endpoints, setShareToken, tokenFromHash, ApiError } from '../lib/api.js';
import { Card, ErrorBox, Spinner } from '../components/ui.jsx';

// /share#<token>: a viewer's entry point. The token stays in the URL fragment
// (never sent to the server's logs), is kept in localStorage and sent as
// X-Share-Token. The server decides which group it opens.
export default function Share() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState(null);

  useEffect(() => {
    const token = tokenFromHash(window.location.hash);
    window.history.replaceState(null, '', '/share'); // drop the token from the address bar
    if (!token) { setError(new ApiError(400, { error: { code: 'INVALID_LINK', message: 'This share link is incomplete.' } })); return; }
    setShareToken(token);
    endpoints.me()
      .then(async ({ principal }) => {
        if (principal.role === 'admin') throw new ApiError(409, { error: { code: 'SIGNED_IN_AS_ADMIN', message: 'You are signed in as the admin, which takes precedence over a share link. Sign out to open it as a viewer.' } });
        if (principal.role !== 'viewer') throw new ApiError(401, { error: { code: 'INVALID_LINK', message: 'This share link is not valid (it may have been revoked).' } });
        await qc.invalidateQueries({ queryKey: ['me'] });
        navigate(`/groups/${principal.groupId}/results`, { replace: true });
      })
      .catch((err) => {
        setShareToken(null);
        setError(err.status === 401 ? new ApiError(401, { error: { code: 'INVALID_LINK', message: 'This share link is not valid (it may have been revoked).' } }) : err);
      });
  }, [navigate, qc]);

  return error ? <Card title="Share link"><ErrorBox error={error} title="Cannot open this link" /></Card> : <Spinner label="Opening the shared group…" />;
}
