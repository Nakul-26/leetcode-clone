import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Circle, XCircle, LogOut } from 'lucide-react';
import { drives } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

const ROUND_ICON = {
  Pass: <CheckCircle2 size={18} color="var(--success)" />,
  Fail: <XCircle size={18} color="var(--error)" />,
  pending: <Circle size={18} color="var(--text-muted)" />
};

const DriveDetailPage = () => {
  const { id } = useParams();
  const [drive, setDrive] = useState(null);
  const [candidacy, setCandidacy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [driveRes, candidacyRes] = await Promise.all([
        drives.get(id),
        drives.getMyCandidacy(id)
      ]);
      setDrive(driveRes.data);
      setCandidacy(candidacyRes.data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load drive'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleWithdraw = async () => {
    if (!window.confirm('Withdraw from this drive? You cannot re-enroll yourself once withdrawn.')) return;
    setWithdrawing(true);
    try {
      await drives.withdraw(candidacy._id);
      fetchData();
    } catch (err) {
      alert(getApiErrorMessage(err, 'Failed to withdraw'));
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading) return <div className="container">Loading drive...</div>;
  if (error) return <div className="container error-box">{error}</div>;
  if (!drive) return null;

  const resultForRound = (roundIndex) => {
    if (!candidacy) return null;
    const entries = (candidacy.roundHistory || []).filter((h) => h.roundIndex === roundIndex);
    return entries[entries.length - 1] || null;
  };

  const canWithdraw = candidacy && !['Selected', 'Rejected', 'Withdrawn'].includes(candidacy.status);

  return (
    <div className="container fade-in">
      <Link to="/drives" className="flex-center gap-2 text-muted mb-4" style={{ justifyContent: 'flex-start' }}>
        <ArrowLeft size={16} /> Back to Drives
      </Link>

      <h1 className="mb-2">{drive.companyName}</h1>
      {drive.description && <p className="text-muted mb-8">{drive.description}</p>}

      {candidacy ? (
        <div className="problem-card mb-8" style={{ padding: '20px' }}>
          <div className="flex-between">
            <div>
              <div className="text-muted" style={{ fontSize: '0.85rem' }}>Your status</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{candidacy.status}</div>
            </div>
            {canWithdraw && (
              <button className="button button-outline" onClick={handleWithdraw} disabled={withdrawing}>
                <LogOut size={16} /> {withdrawing ? 'Withdrawing...' : 'Withdraw'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="problem-card mb-8" style={{ padding: '20px' }}>
          <p className="text-muted">You are not enrolled in this drive yet. The placement cell adds eligible students.</p>
        </div>
      )}

      <div className="problem-card" style={{ padding: '24px' }}>
        <h3 className="mb-4">Rounds</h3>
        {drive.rounds.map((round, idx) => {
          const outcome = resultForRound(idx);
          const isCurrent = candidacy && candidacy.currentRoundIndex === idx && !['Selected', 'Rejected', 'Withdrawn'].includes(candidacy.status);
          return (
            <div
              key={idx}
              className="flex-center gap-3"
              style={{
                justifyContent: 'flex-start',
                padding: '12px',
                borderRadius: 'var(--radius-md)',
                background: isCurrent ? 'var(--primary-glow)' : 'transparent',
                marginBottom: '8px'
              }}
            >
              {outcome ? ROUND_ICON[outcome.result] : ROUND_ICON.pending}
              <div>
                <div style={{ fontWeight: 600 }}>Round {idx + 1}: {round.name}</div>
                <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                  {round.type === 'assessment' ? 'Online Assessment' : 'Interview'}
                  {round.passCriteria ? ` · ${round.passCriteria}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DriveDetailPage;
