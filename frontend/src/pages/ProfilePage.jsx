import React, { useEffect, useState } from 'react';
import { UserCircle, ShieldCheck, Building2, RefreshCw } from 'lucide-react';
import { auth } from '../api';
import { roleInfo } from '../utils/roles';

// Who is signed in, as the server sees it: handy when switching between test accounts.
const ProfilePage = () => {
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await auth.me();
      setMe(res.data.user);
      setError('');
      setCheckedAt(new Date());
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your account.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !me) return <div className="container"><p className="text-muted">Loading…</p></div>;
  if (error && !me) return <div className="container"><p style={{ color: 'var(--error)' }}>{error}</p></div>;

  const role = roleInfo(me.role);
  const rows = [
    ['Email', me.email],
    ['College', me.college ? me.college.name : (me.role === 'superadmin' ? 'All colleges' : '—')],
    me.college?.planId && ['Plan', me.college.planId],
    me.usn && ['USN', me.usn],
    me.section && ['Section', me.section],
    ['Account id', <code key="id">{me.id}</code>],
    me.createdAt && ['Created', new Date(me.createdAt).toLocaleString()]
  ].filter(Boolean);

  return (
    <div className="container fade-in profile-page">
      <div className="profile-card">
        <div className="profile-head">
          <UserCircle size={56} className="text-muted" />
          <div>
            <h1 className="profile-name">{me.name}</h1>
            <span className="role-badge role-badge-lg" style={{ '--role-color': role.color }}>
              <ShieldCheck size={16} /> {role.label}
            </span>
          </div>
        </div>

        <dl className="profile-rows">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </React.Fragment>
          ))}
        </dl>

        {role.can.length > 0 && (
          <div className="profile-section">
            <h2><Building2 size={18} /> What a {role.label.toLowerCase()} can do</h2>
            <ul>{role.can.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        )}

        <div className="profile-foot text-muted">
          <span>Checked with the server{checkedAt ? ` at ${checkedAt.toLocaleTimeString()}` : ''}.</span>
          <button type="button" className="button button-outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
