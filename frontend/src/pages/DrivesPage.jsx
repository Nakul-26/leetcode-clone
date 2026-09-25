import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Building2, AlertCircle } from 'lucide-react';
import { drives } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

const DrivesPage = () => {
  const [driveList, setDriveList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    drives.list()
      .then((res) => setDriveList(res.data))
      .catch((err) => setError(getApiErrorMessage(err, 'Failed to fetch drives')))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="container">Loading drives...</div>;
  if (error) return <div className="container error-box">{error}</div>;

  return (
    <div className="container fade-in">
      <h1 className="mb-2">Placement Drives</h1>
      <p className="text-muted mb-8">Companies currently hiring through the placement cell.</p>

      <div className="problem-card-grid" style={{ gridTemplateColumns: '1fr' }}>
        {driveList.map((d) => (
          <Link to={`/drives/${d._id}`} key={d._id} className="problem-card" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: '24px', textDecoration: 'none' }}>
            <div>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '1.25rem' }}>{d.companyName}</h3>
              <div className="flex-center gap-2 text-muted" style={{ fontSize: '0.85rem', justifyContent: 'flex-start' }}>
                <Building2 size={14} /> {d.rounds?.length || 0} rounds
              </div>
            </div>
          </Link>
        ))}
        {driveList.length === 0 && (
          <div style={{ textAlign: 'center', padding: '80px', background: 'var(--surface)', borderRadius: 'var(--radius-xl)', border: '1px dashed var(--border)' }}>
            <AlertCircle size={48} className="text-muted mb-4" style={{ margin: '0 auto' }} />
            <p className="text-muted" style={{ fontSize: '1.1rem' }}>No active drives right now. Check back later.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DrivesPage;
