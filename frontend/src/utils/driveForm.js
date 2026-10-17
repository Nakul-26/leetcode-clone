export const emptyRound = () => ({ name: '', type: 'interview', assessmentId: '', passCriteria: '' });

export function validateDriveForm(formData) {
  const errors = [];
  if (!formData.companyName?.trim()) errors.push('Company name is required');

  if (!Array.isArray(formData.rounds) || formData.rounds.length === 0) {
    errors.push('Add at least one round');
  } else {
    formData.rounds.forEach((round, idx) => {
      if (!round.name?.trim()) errors.push(`Round ${idx + 1}: name is required`);
      if (!['assessment', 'interview'].includes(round.type)) {
        errors.push(`Round ${idx + 1}: type is required`);
      }
      if (round.type === 'assessment' && !round.assessmentId) {
        errors.push(`Round ${idx + 1}: select an assessment to link`);
      }
    });
  }

  return errors;
}

export function buildDrivePayload(formData) {
  return {
    companyName: formData.companyName.trim(),
    description: formData.description?.trim() || '',
    rounds: formData.rounds.map((r) => ({
      name: r.name.trim(),
      type: r.type,
      assessmentId: r.type === 'assessment' ? r.assessmentId : undefined,
      passCriteria: r.passCriteria?.trim() || undefined
    })),
    eligibility: {
      sections: (formData.eligibilitySections || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      notes: formData.eligibilityNotes?.trim() || ''
    },
    status: formData.status
  };
}
