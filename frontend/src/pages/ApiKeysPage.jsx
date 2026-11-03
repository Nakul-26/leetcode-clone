import React, { useEffect, useState } from 'react';
import { KeyRound, AlertCircle, Copy, Check, Ban, BarChart3, Plus } from 'lucide-react';
import { admin, billing } from '../api';

// API keys for the public judge APIs (codeAssess, integration, Arventiq), so issuing one,
// such as the long-lived key the load test uses, takes a form instead of a console snippet.
// The key itself is shown once, right after it is created; the server only keeps its hash.

const SCOPES = [
  { id: 'codeassess', label: 'codeAssess', hint: 'run code (Judge0-style API, used by the load test)' },
  { id: 'integration', label: 'integration', hint: 'assessments and submissions for partner portals' },
  { id: 'arventiq', label: 'arventiq', hint: 'Arventiq partner API' }
];

const errorText = (err, fallback) => {
  const d = err?.response?.data;
  return d?.error || d?.message || d?.msg || fallback;
};

const limitText = (n) => (n ? n.toLocaleString() : 'none');

const ApiKeysPage = ({ user }) => {
  const isSuperadmin = user?.role === 'superadmin';
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [colleges, setColleges] = useState([]);
  const [collegeId, setCollegeId] = useState('');
  const [newCollege, setNewCollege] = useState('');

  const [form, setForm] = useState({ name: '', scopes: ['codeassess'], rateLimitPerMin: 0, monthlyQuota: 0 });
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState(null);
  const [copied, setCopied] = useState(false);
  const [usage, setUsage] = useState({});

  const loadClients = async () => {
    setLoading(true);
    try {
      const res = await admin.listApiClients();
      setClients(res.data);
    } catch (err) {
      setError(errorText(err, 'Failed to load API keys.'));
    } finally {
      setLoading(false);
    }
  };

  const loadColleges = async () => {
    try {
      const res = await billing.listColleges();
      setColleges(res.data);
      setCollegeId((current) => current || res.data[0]?._id || '');
    } catch (err) {
      setError(errorText(err, 'Failed to load colleges.'));
    }
  };

  useEffect(() => {
    loadClients();
    if (isSuperadmin) loadColleges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const collegeName = (id) => colleges.find((c) => String(c._id) === String(id))?.name;

  const handleCreateCollege = async () => {
    if (!newCollege.trim()) return;
    setError(null);
    try {
      const res = await billing.createCollege(newCollege.trim());
      setNewCollege('');
      await loadColleges();
      setCollegeId(res.data._id);
    } catch (err) {
      setError(errorText(err, 'Failed to create the college.'));
    }
  };

  const toggleScope = (id) => {
    setForm((f) => ({ ...f, scopes: f.scopes.includes(id) ? f.scopes.filter((s) => s !== id) : [...f.scopes, id] }));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await admin.createApiClient({
        name: form.name,
        scopes: form.scopes,
        rateLimitPerMin: Number(form.rateLimitPerMin) || 0,
        monthlyQuota: Number(form.monthlyQuota) || 0,
        ...(isSuperadmin ? { collegeId } : {})
      });
      setIssued(res.data);
      setCopied(false);
      setForm({ name: '', scopes: ['codeassess'], rateLimitPerMin: 0, monthlyQuota: 0 });
      await loadClients();
    } catch (err) {
      setError(errorText(err, 'Failed to create the API key.'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleRevoke = async (client) => {
    if (!window.confirm(`Revoke "${client.name}"? Anything using this key stops working immediately.`)) return;
    setError(null);
    try {
      await admin.revokeApiClient(client._id);
      await loadClients();
    } catch (err) {
      setError(errorText(err, 'Failed to revoke the key.'));
    }
  };

  const handleUsage = async (id) => {
    try {
      const res = await admin.getApiClientUsage(id);
      setUsage((u) => ({ ...u, [id]: res.data.usage }));
    } catch (err) {
      setError(errorText(err, 'Failed to load usage.'));
    }
  };

  const needsCollege = isSuperadmin && !collegeId;

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <div>
          <h1 className="mb-2">API Keys</h1>
          <p className="text-muted">Keys for the public judge APIs: partner platforms, and the load test.</p>
        </div>
      </div>

      {error && (
        <div className="error-box mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {issued && (
        <div className="problem-card mb-6" data-testid="issued-key" style={{ borderColor: 'var(--success)' }}>
          <h3 className="flex-center gap-2 mb-2" style={{ justifyContent: 'flex-start' }}>
            <KeyRound size={20} /> Key for "{issued.client.name}"
          </h3>
          <p className="text-muted mb-4">Copy it now. It is shown only this once and cannot be retrieved later.</p>
          <div className="flex-center gap-3" style={{ justifyContent: 'flex-start' }}>
            <code style={{ wordBreak: 'break-all', padding: '10px 12px', background: 'var(--bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-bright)', flex: '1 1 260px' }}>
              {issued.key}
            </code>
            <button type="button" className="button button-outline" onClick={handleCopy}>
              {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy</>}
            </button>
          </div>
          <p className="text-muted mt-4" style={{ fontSize: '0.85rem' }}>
            For the load test, save it as <code>LOADTEST_KEY=…</code> in <code>loadtest/.env</code> (see <code>loadtest/README.md</code>).
          </p>
        </div>
      )}

      <form className="problem-card mb-8" onSubmit={handleCreate}>
        <h3 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}><Plus size={20} /> New key</h3>

        {isSuperadmin && (
          <div className="form-group mb-4">
            <label>College (the key's usage is billed to it)</label>
            {colleges.length > 0 ? (
              <select value={collegeId} onChange={(e) => setCollegeId(e.target.value)}>
                {colleges.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
              </select>
            ) : (
              <p className="text-muted mb-2">There are no colleges yet. Create one to own the key, such as "Load test".</p>
            )}
            <div className="flex-center gap-2 mt-2" style={{ justifyContent: 'flex-start' }}>
              <input type="text" placeholder="New college name" value={newCollege} onChange={(e) => setNewCollege(e.target.value)} style={{ flex: '1 1 200px' }} />
              <button type="button" className="button button-outline" onClick={handleCreateCollege} disabled={!newCollege.trim()}>
                Add college
              </button>
            </div>
          </div>
        )}

        <div className="form-group mb-4">
          <label>Name</label>
          <input type="text" required placeholder="e.g. loadtest, Acme exam portal" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>

        <div className="form-group mb-4">
          <label>Scopes</label>
          {SCOPES.map((s) => (
            <label key={s.id} className="flex-center gap-2" style={{ justifyContent: 'flex-start', fontWeight: 400, textTransform: 'none' }}>
              <input type="checkbox" checked={form.scopes.includes(s.id)} onChange={() => toggleScope(s.id)} style={{ width: 16, height: 16 }} />
              <span><strong>{s.label}</strong> <span className="text-muted">: {s.hint}</span></span>
            </label>
          ))}
        </div>

        <div className="grid-2-col-equal mb-6" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '16px' }}>
          <div className="form-group">
            <label>Requests per minute (0 = no limit)</label>
            <input type="number" min="0" value={form.rateLimitPerMin} onChange={(e) => setForm({ ...form, rateLimitPerMin: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Runs per month (0 = no limit)</label>
            <input type="number" min="0" value={form.monthlyQuota} onChange={(e) => setForm({ ...form, monthlyQuota: e.target.value })} />
          </div>
        </div>

        <button type="submit" className="button button-primary" disabled={creating || !form.name.trim() || form.scopes.length === 0 || needsCollege}>
          <KeyRound size={16} /> {creating ? 'Creating...' : 'Create key'}
        </button>
      </form>

      <h3 className="mb-4">Keys</h3>
      {loading ? (
        <p className="text-muted">Loading...</p>
      ) : clients.length === 0 ? (
        <p className="text-muted">No keys yet.</p>
      ) : (
        <div className="table-container">
          <table className="table" data-testid="api-keys-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Limits</th>
                <th>Last used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c._id} style={{ opacity: c.active ? 1 : 0.55 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    {isSuperadmin && collegeName(c.collegeId) && <div className="text-muted" style={{ fontSize: '0.8rem' }}>{collegeName(c.collegeId)}</div>}
                  </td>
                  <td><code>ak_{c.keyPrefix}_…</code></td>
                  <td>{(c.scopes || []).join(', ')}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                    {limitText(c.rateLimitPerMin)} / min<br />{limitText(c.monthlyQuota)} / month
                    {usage[c._id] && (
                      <div className="text-muted" style={{ fontSize: '0.8rem' }} data-testid={`usage-${c._id}`}>
                        used {usage[c._id].usedThisMonth.toLocaleString()} in {usage[c._id].month}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: '0.85rem' }}>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : 'never'}</td>
                  <td>
                    <span style={{ color: c.active ? 'var(--success)' : 'var(--text-muted)', fontWeight: 600, fontSize: '0.85rem' }}>
                      {c.active ? 'Active' : 'Revoked'}
                    </span>
                  </td>
                  <td>
                    <div className="flex-center gap-2" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button type="button" className="button button-outline" style={{ padding: '6px 10px' }} onClick={() => handleUsage(c._id)} title="Usage this month">
                        <BarChart3 size={14} />
                      </button>
                      {c.active && (
                        <button type="button" className="button button-outline" style={{ padding: '6px 10px', color: 'var(--error)' }} onClick={() => handleRevoke(c)}>
                          <Ban size={14} /> Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ApiKeysPage;
