import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { drives, assessments } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';
import { validateDriveForm, buildDrivePayload, emptyRound } from '../utils/driveForm';
import DriveForm from './DriveForm';

const initialFormData = {
  companyName: '',
  description: '',
  eligibilitySections: '',
  eligibilityNotes: '',
  rounds: [emptyRound()],
  status: 'Draft'
};

const AddDrivePage = () => {
  const navigate = useNavigate();
  const [assessmentsList, setAssessmentsList] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    assessments.list().then((res) => setAssessmentsList(res.data)).catch(() => {});
  }, []);

  const handleSubmit = async (formData) => {
    const validationErrors = validateDriveForm(formData);
    if (validationErrors.length > 0) {
      setError(validationErrors.join('. '));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await drives.create(buildDrivePayload(formData));
      navigate('/admin/drives');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to create drive'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container assessment-page">
      <h2>Create New Placement Drive</h2>
      <DriveForm
        initialData={initialFormData}
        assessmentsList={assessmentsList}
        onSubmit={handleSubmit}
        submitLabel="Create Drive"
        saving={saving}
        error={error}
      />
    </div>
  );
};

export default AddDrivePage;
