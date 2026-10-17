import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { drives, assessments } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';
import { validateDriveForm, buildDrivePayload } from '../utils/driveForm';
import DriveForm from './DriveForm';

const toFormData = (drive) => ({
  companyName: drive.companyName || '',
  description: drive.description || '',
  eligibilitySections: (drive.eligibility?.sections || []).join(', '),
  eligibilityNotes: drive.eligibility?.notes || '',
  rounds: (drive.rounds || []).map((r) => ({
    name: r.name || '',
    type: r.type || 'interview',
    assessmentId: r.assessmentId?._id || r.assessmentId || '',
    passCriteria: r.passCriteria || ''
  })),
  status: drive.status || 'Draft'
});

const EditDrivePage = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const [assessmentsList, setAssessmentsList] = useState([]);
  const [initialData, setInitialData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([drives.get(id), assessments.list()])
      .then(([driveRes, assessmentsRes]) => {
        setInitialData(toFormData(driveRes.data));
        setAssessmentsList(assessmentsRes.data);
      })
      .catch((err) => setError(getApiErrorMessage(err, 'Failed to load drive')))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSubmit = async (formData) => {
    const validationErrors = validateDriveForm(formData);
    if (validationErrors.length > 0) {
      setError(validationErrors.join('. '));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await drives.update(id, buildDrivePayload(formData));
      navigate('/admin/drives');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to update drive'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="container">Loading drive...</div>;
  if (!initialData) return <div className="container error-box">{error || 'Drive not found'}</div>;

  return (
    <div className="container assessment-page">
      <h2>Edit Placement Drive</h2>
      <DriveForm
        initialData={initialData}
        assessmentsList={assessmentsList}
        onSubmit={handleSubmit}
        submitLabel="Save Changes"
        saving={saving}
        error={error}
      />
    </div>
  );
};

export default EditDrivePage;
