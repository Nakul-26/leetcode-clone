import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Edit2, Trash2, Users, Building2, AlertCircle } from 'lucide-react';
import { drives } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

const STATUS_STYLES = {
  Draft: { color: 'var(--warning)', bg: 'rgba(245, 158, 11, 0.1)' },
  Active: { color: 'var(--success)', bg: 'rgba(16, 185, 129, 0.1)' },
  Closed: { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' }
};

const DriveManagementPage = () => {
  const [driveList, setDriveList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDrives = async () => {
    try {
      const res = await drives.list();
      setDriveList(res.data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to fetch drives'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDrives();
  }, []);

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this drive? This cannot be undone.')) {
      try {
        await drives.delete(id);
        fetchDrives();
      } catch (err) {
        alert(getApiErrorMessage(err, 'Failed to delete drive'));
      }
    }
  };

  if (loading) return <div className="container">Loading drives...</div>;
  if (error) return <div className="container error-box">{error}</div>;

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <div>
          <h1 className="mb-2">Placement Drives</h1>
          <p className="text-muted">Create and run placement drives, track candidates round by round.</p>
        </div>
        <Link to="/admin/drives/add" className="button">
          <Plus size={18} />
          Create Drive
        </Link>
      </div>

      <div className="problem-card-grid" style={{ gridTemplateColumns: '1fr' }}>
        {driveList.map((d) => {
          const statusStyle = STATUS_STYLES[d.status] || STATUS_STYLES.Closed;
          return (
            <div key={d._id} className="problem-card" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: '24px' }}>
              <div style={{ flex: 1 }}>
                <div className="flex-center gap-2 mb-2" style={{ justifyContent: 'flex-start' }}>
                  <span style={{
                    padding: '4px 10px',
                    borderRadius: '100px',
                    fontSize: '0.7rem',
                    fontWeight: '700',
                    color: statusStyle.color,
                    backgroundColor: statusStyle.bg,
                    letterSpacing: '0.05em'
                  }}>
                    {d.status.toUpperCase()}
                  </span>
                </div>

                <h3 style={{ margin: '0 0 8px 0', fontSize: '1.25rem' }}>{d.companyName}</h3>

                <div className="flex-center gap-6 text-muted" style={{ fontSize: '0.85rem', justifyContent: 'flex-start' }}>
                  <span className="flex-center gap-2"><Building2 size={14} /> {d.rounds?.length || 0} rounds</span>
                </div>
              </div>

              <div className="flex-center gap-3">
                <Link to={`/admin/drives/${d._id}/pipeline`} className="button button-outline" style={{ padding: '8px 16px', color: 'var(--primary)', borderColor: 'var(--primary-glow)', backgroundColor: 'var(--primary-glow)' }}>
                  <Users size={16} /> Pipeline
                </Link>
                <Link to={`/admin/drives/${d._id}/edit`} className="button button-outline" style={{ padding: '8px 16px' }}>
                  <Edit2 size={16} /> Edit
                </Link>
                <button onClick={() => handleDelete(d._id)} className="button button-outline" style={{ padding: '8px 16px', color: 'var(--error)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                  <Trash2 size={16} /> Delete
                </button>
              </div>
            </div>
          );
        })}
        {driveList.length === 0 && (
          <div style={{ textAlign: 'center', padding: '80px', background: 'var(--surface)', borderRadius: 'var(--radius-xl)', border: '1px dashed var(--border)' }}>
            <AlertCircle size={48} className="text-muted mb-4" style={{ margin: '0 auto' }} />
            <p className="text-muted" style={{ fontSize: '1.1rem' }}>No placement drives found.</p>
            <Link to="/admin/drives/add" className="button mt-4">Create your first drive</Link>
          </div>
        )}
      </div>
    </div>
  );
};

export default DriveManagementPage;
