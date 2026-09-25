import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { emptyRound } from '../utils/driveForm';

const DriveForm = ({ initialData, assessmentsList, onSubmit, submitLabel, saving, error }) => {
  const [formData, setFormData] = useState(initialData);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const updateRound = (idx, field, value) => {
    const rounds = formData.rounds.map((r, i) => (i === idx ? { ...r, [field]: value } : r));
    setFormData({ ...formData, rounds });
  };

  const addRound = () => {
    setFormData({ ...formData, rounds: [...formData.rounds, emptyRound()] });
  };

  const removeRound = (idx) => {
    setFormData({ ...formData, rounds: formData.rounds.filter((_, i) => i !== idx) });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit}>
      {error && <div className="error-box">{error}</div>}

      <div className="problem-card" style={{ marginBottom: '20px' }}>
        <h3>Basic Information</h3>
        <div className="form-group">
          <label>Company Name:</label>
          <input type="text" name="companyName" value={formData.companyName} onChange={handleChange} required />
        </div>
        <div className="form-group">
          <label>Description:</label>
          <textarea name="description" value={formData.description} onChange={handleChange} />
        </div>
        <div className="form-group">
          <label>Status:</label>
          <select name="status" value={formData.status} onChange={handleChange}>
            <option value="Draft">Draft</option>
            <option value="Active">Active</option>
            <option value="Closed">Closed</option>
          </select>
        </div>
      </div>

      <div className="problem-card" style={{ marginBottom: '20px' }}>
        <h3>Eligibility</h3>
        <div className="form-group">
          <label>Eligible Sections (comma-separated, leave blank for all):</label>
          <input
            type="text"
            name="eligibilitySections"
            placeholder="CSE-A, CSE-B"
            value={formData.eligibilitySections}
            onChange={handleChange}
          />
        </div>
        <div className="form-group">
          <label>Other eligibility notes (not auto-enforced, for reference only):</label>
          <textarea
            name="eligibilityNotes"
            placeholder="e.g. Min CGPA 7.0, no active backlogs"
            value={formData.eligibilityNotes}
            onChange={handleChange}
          />
        </div>
      </div>

      <div className="problem-card" style={{ marginBottom: '20px' }}>
        <div className="flex-between mb-2">
          <h3 style={{ margin: 0 }}>Rounds</h3>
          <button type="button" className="button button-outline" onClick={addRound}>
            <Plus size={16} /> Add Round
          </button>
        </div>

        {formData.rounds.map((round, idx) => (
          <div
            key={idx}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 2fr 2fr auto',
              gap: '10px',
              alignItems: 'flex-end',
              marginBottom: '12px',
              paddingBottom: '12px',
              borderBottom: '1px dashed var(--border)'
            }}
          >
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Round {idx + 1} Name:</label>
              <input type="text" value={round.name} onChange={(e) => updateRound(idx, 'name', e.target.value)} required />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Type:</label>
              <select value={round.type} onChange={(e) => updateRound(idx, 'type', e.target.value)}>
                <option value="interview">Interview</option>
                <option value="assessment">Assessment</option>
              </select>
            </div>
            {round.type === 'assessment' ? (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Linked Assessment:</label>
                <select value={round.assessmentId} onChange={(e) => updateRound(idx, 'assessmentId', e.target.value)}>
                  <option value="">Choose an assessment...</option>
                  {assessmentsList.map((a) => (
                    <option key={a._id} value={a._id}>{a.title}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div />
            )}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Pass Criteria (free text):</label>
              <input
                type="text"
                placeholder="e.g. Score >= 40%"
                value={round.passCriteria}
                onChange={(e) => updateRound(idx, 'passCriteria', e.target.value)}
              />
            </div>
            <button
              type="button"
              className="button button-outline"
              style={{ color: 'var(--error)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
              onClick={() => removeRound(idx)}
              disabled={formData.rounds.length === 1}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-20">
        <button type="submit" className="button button-primary" style={{ padding: '12px 36px' }} disabled={saving}>
          {saving ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
};

export default DriveForm;
