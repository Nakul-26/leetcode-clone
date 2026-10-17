import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Save, Trash2, AlertTriangle, CheckCircle2, ChevronLeft, Info, Settings } from 'lucide-react';
import api from '../api';
import { buildProblemPayload, buildMcqPayload, buildSubjectivePayload, collectErrorMessages } from '../utils/problemForm';
import { PROBLEM_TEMPLATES } from '../utils/problemTemplates';

const AddProblemPage = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    problemType: 'function',
    title: '',
    description: '',
    difficulty: 'Easy',
    tags: '',
    isPremium: false,
    functionName: '',
    parameters: [{ name: '', type: '' }],
    returnType: '',
    compareConfig: {
      mode: 'EXACT',
      floatTolerance: 0,
      orderInsensitive: false
    },
    testCases: [{ inputs: '[]', expected: '', isSample: true }],
    referenceSolution: '',
    solutionLanguage: 'javascript',
    // mcq-only
    options: [{ text: '', isCorrect: false }, { text: '', isCorrect: false }],
    allowMultipleAnswers: false,
    // subjective-only
    maxWords: '',
    rubricNotes: ''
  });
  const [apiError, setApiError] = useState('');
  const [apiErrors, setApiErrors] = useState([]);
  const [formErrors, setFormErrors] = useState({});
  const [validationReport, setValidationReport] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isValidated, setIsValidated] = useState(false);

  const fieldError = (key) => formErrors[key];
  const fieldClassName = (key) => fieldError(key) ? 'input-error' : '';

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({ ...formData, [name]: type === 'checkbox' ? checked : value });
    setIsValidated(false);
  };

  const handleTestCaseChange = (index, e) => {
    const { name, value, type, checked } = e.target;
    const next = [...formData.testCases];
    next[index][name] = type === 'checkbox' ? checked : value;
    setFormData({ ...formData, testCases: next });
    setIsValidated(false);
  };

  const removeTestCase = (index) => {
    if (formData.testCases.length <= 1) return;
    setFormData({ ...formData, testCases: formData.testCases.filter((_, i) => i !== index) });
    setIsValidated(false);
  };

  const handleParamChange = (index, e) => {
    const { name, value } = e.target;
    const next = [...formData.parameters];
    next[index][name] = value;
    setFormData({ ...formData, parameters: next });
    setIsValidated(false);
  };

  const removeParameter = (index) => {
    if (formData.parameters.length <= 1) return;
    setFormData({ ...formData, parameters: formData.parameters.filter((_, i) => i !== index) });
    setIsValidated(false);
  };

  const addTestCase = () => {
    const nextIsSample = formData.testCases.length < 2;
    setFormData({
      ...formData,
      testCases: [...formData.testCases, { inputs: '[]', expected: '', isSample: nextIsSample }]
    });
    setIsValidated(false);
  };

  const addParameter = () => {
    setFormData({ ...formData, parameters: [...formData.parameters, { name: '', type: '' }] });
    setIsValidated(false);
  };

  const handleOptionChange = (index, e) => {
    const { name, value, type, checked } = e.target;
    const next = [...formData.options];
    next[index] = { ...next[index], [name]: type === 'checkbox' ? checked : value };
    if (name === 'isCorrect' && checked && !formData.allowMultipleAnswers) {
      next.forEach((o, i) => { if (i !== index) o.isCorrect = false; });
    }
    setFormData({ ...formData, options: next });
    setIsValidated(false);
  };

  const addOption = () => {
    setFormData({ ...formData, options: [...formData.options, { text: '', isCorrect: false }] });
    setIsValidated(false);
  };

  const removeOption = (index) => {
    if (formData.options.length <= 2) return;
    setFormData({ ...formData, options: formData.options.filter((_, i) => i !== index) });
    setIsValidated(false);
  };

  const handleCompareConfigChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({
      ...formData,
      compareConfig: {
        ...formData.compareConfig,
        [name]: type === 'checkbox' ? checked : value
      }
    });
    setIsValidated(false);
  };

  const payloadBuilderFor = (problemType) => {
    if (problemType === 'mcq') return buildMcqPayload;
    if (problemType === 'subjective') return buildSubjectivePayload;
    return buildProblemPayload;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Coding problems must be Validated first (deep judge-based check); mcq/subjective
    // have no judge step at all, so there's nothing to gate on.
    if (formData.problemType === 'function' && !isValidated) return;
    setApiError('');
    setApiErrors([]);

    const { errors, payload } = payloadBuilderFor(formData.problemType)(formData);
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setFormErrors({});

    try {
      const res = await api.post('/api/v1/problems', payload);
      const newProblemId = res.data.problem?._id || res.data._id;
      navigate(`/problems/${newProblemId}`, { state: { successMessage: 'Problem created successfully!' } });
    } catch (err) {
      const data = err.response?.data;
      setApiError(data?.error || 'Failed to create problem');
      setApiErrors(Array.isArray(data?.errors) ? data.errors : []);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleValidate = async () => {
    if (formData.problemType !== 'function') return;
    setApiError('');
    setApiErrors([]);
    setValidationReport(null);
    setIsValidating(true);
    setIsValidated(false);

    const { errors, payload } = buildProblemPayload(formData);
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      setIsValidating(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setFormErrors({});

    try {
      const resp = await api.post('/api/v1/preview/validate', payload);
      setValidationReport(resp.data);
      if (resp.data.schemaValid && resp.data.typeValidation && resp.data.wrapperGeneration && resp.data.referenceSolutionPassed) {
        setIsValidated(true);
      }
    } catch (err) {
      const data = err.response?.data;
      setApiError(data?.error || 'Validation request failed');
      setApiErrors(Array.isArray(data?.errors) ? data.errors : []);
    } finally {
      setIsValidating(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleTemplateSelect = (e) => {
    const templateId = e.target.value;
    if (!templateId) return;

    const template = PROBLEM_TEMPLATES.find(t => t.id === templateId);
    if (!template) return;

    if (window.confirm(`Applying template "${template.label}" will overwrite current function, parameters, and test cases. Continue?`)) {
      setFormData({
        ...formData,
        ...template.data
      });
      setIsValidated(false);
    }
    e.target.value = "";
  };

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <button onClick={() => navigate(-1)} className="button button-outline" style={{ padding: '8px 12px' }}>
          <ChevronLeft size={18} /> Back
        </button>
        <h1 style={{ fontSize: '1.75rem' }}>Create New Problem</h1>
        <div style={{ width: '80px' }}></div>
      </div>

      {collectErrorMessages(formErrors).length > 0 && (
        <div className="error-box mb-8">
          <div className="flex-center gap-2 mb-2" style={{ justifyContent: 'flex-start' }}>
            <AlertTriangle size={18} />
            <strong>Fix the following before submitting:</strong>
          </div>
          <ul style={{ paddingLeft: '24px' }}>
            {collectErrorMessages(formErrors).map((error, index) => <li key={index}>{error}</li>)}
          </ul>
        </div>
      )}

      {apiError && (
        <div className="error-box mb-8">
          <div className="flex-center gap-2 mb-2" style={{ justifyContent: 'flex-start' }}>
            <AlertTriangle size={18} />
            <strong>Error:</strong>
          </div>
          <div>{apiError}</div>
          {apiErrors.length > 0 && (
            <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
              {apiErrors.map((error, index) => <li key={index}>{error}</li>)}
            </ul>
          )}
        </div>
      )}

      {validationReport && (
        <div className={`report-box ${validationReport.schemaValid && validationReport.typeValidation && validationReport.wrapperGeneration && validationReport.referenceSolutionPassed ? 'success' : 'failure'}`}>
          <div className="flex-center gap-2 mb-4" style={{ justifyContent: 'flex-start' }}>
            <Info size={20} />
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Validation Report</h3>
          </div>
          <ul className="report-list">
            <li>{validationReport.schemaValid ? <CheckCircle2 size={16} color="var(--success)" /> : <AlertTriangle size={16} color="var(--error)" />} Schema Validation</li>
            <li>{validationReport.typeValidation ? <CheckCircle2 size={16} color="var(--success)" /> : <AlertTriangle size={16} color="var(--error)" />} Type Conversion Validation</li>
            <li>{validationReport.wrapperGeneration ? <CheckCircle2 size={16} color="var(--success)" /> : <AlertTriangle size={16} color="var(--error)" />} Wrapper Generation (JS, TS, PY, Java, Go, C#, C++, C)</li>
            <li>{validationReport.referenceSolutionPassed ? <CheckCircle2 size={16} color="var(--success)" /> : <AlertTriangle size={16} color="var(--error)" />} Reference Solution Verification</li>
          </ul>
          {validationReport.errors.length > 0 && (
            <div className="mt-4 p-4" style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
              <strong>Details:</strong>
              <ul style={{ paddingLeft: '20px', marginTop: '8px', fontSize: '0.85rem' }}>
                {validationReport.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </div>
          )}
          {validationReport.schemaValid && validationReport.typeValidation && validationReport.wrapperGeneration && validationReport.referenceSolutionPassed && (
            <div className="mt-4 success-text flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
              <CheckCircle2 size={18} />
              <span>This problem is valid and ready to be published.</span>
            </div>
          )}
        </div>
      )}

      <div className="problem-card mb-8">
        <div className="flex-center gap-2 mb-4" style={{ justifyContent: 'flex-start' }}>
          <Settings size={20} color="var(--primary)" />
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Problem Type</h3>
        </div>
        <div className="form-group">
          <select
            name="problemType"
            value={formData.problemType}
            onChange={(e) => { handleChange(e); setValidationReport(null); }}
            style={{ marginTop: '8px' }}
          >
            <option value="function">Coding (function + test cases)</option>
            <option value="mcq">Multiple Choice</option>
            <option value="subjective">Subjective (free-text, manually graded)</option>
          </select>
          <p className="form-hint">
            {formData.problemType === 'mcq' && 'Auto-graded: correct iff the student picks exactly the marked option(s).'}
            {formData.problemType === 'subjective' && 'Ungraded on submit — a faculty/admin manually scores each answer afterward.'}
            {formData.problemType === 'function' && 'Executed and graded by the judge against your test cases.'}
          </p>
        </div>
      </div>

      {formData.problemType === 'function' && (
        <div className="problem-card mb-8">
          <div className="flex-center gap-2 mb-4" style={{ justifyContent: 'flex-start' }}>
            <Settings size={20} color="var(--primary)" />
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Templates</h3>
          </div>
          <div className="form-group">
            <label>Start from a template:</label>
            <select onChange={handleTemplateSelect} defaultValue="" style={{ marginTop: '8px' }}>
              <option value="" disabled>Select a template...</option>
              {PROBLEM_TEMPLATES.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <p className="form-hint">Selecting a template auto-fills the function name, parameters, and return type.</p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mb-12">
        <h3 className="mb-4">Basic Information</h3>
        <div className="form-group mb-4">
          <label>Title</label>
          <input type="text" name="title" value={formData.title} onChange={handleChange} className={fieldClassName('title')} placeholder="e.g. Two Sum" required />
          {fieldError('title') && <div className="error-text">{fieldError('title')}</div>}
        </div>
        <div className="form-group mb-4">
          <label>Description</label>
          <textarea name="description" value={formData.description} onChange={handleChange} className={fieldClassName('description')} placeholder="Markdown supported..." style={{ height: '150px' }} required />
          {fieldError('description') && <div className="error-text">{fieldError('description')}</div>}
        </div>
        <div className="grid grid-cols-2 gap-6" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          <div className="form-group">
            <label>Difficulty</label>
            <select name="difficulty" value={formData.difficulty} onChange={handleChange}>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
            </select>
          </div>
          <div className="form-group">
            <label>Tags (comma-separated)</label>
            <input type="text" name="tags" value={formData.tags} onChange={handleChange} placeholder="array, string, dp" />
          </div>
        </div>
        <div className="form-group mt-4 mb-8">
          <label className="flex-center gap-2" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" name="isPremium" checked={formData.isPremium} onChange={handleChange} style={{ width: 'auto' }} />
            <span style={{ fontSize: '0.9rem' }}>Premium Problem</span>
          </label>
        </div>

        {formData.problemType === 'function' && (<>
        <h3 className="mb-4">Signature & Types</h3>
        <div className="grid grid-cols-2 gap-6 mb-6" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          <div className="form-group">
            <label>Function Name</label>
            <input type="text" name="functionName" value={formData.functionName} onChange={handleChange} className={fieldClassName('functionName')} placeholder="e.g. solve" required />
            {fieldError('functionName') && <div className="error-text">{fieldError('functionName')}</div>}
          </div>
          <div className="form-group">
            <label>Return Type</label>
            <input type="text" name="returnType" value={formData.returnType} onChange={handleChange} className={fieldClassName('returnType')} placeholder="e.g. number or array<number>" required />
            {fieldError('returnType') && <div className="error-text">{fieldError('returnType')}</div>}
          </div>
        </div>

        <h4 className="mb-4" style={{ fontSize: '1rem' }}>Parameters</h4>
        {formData.parameters.map((p, i) => (
          <div key={i} className="flex-center gap-4 mb-4">
            <div style={{ flex: 1 }}>
              <input
                type="text"
                name="name"
                placeholder="Name"
                value={p.name}
                onChange={(e) => handleParamChange(i, e)}
                className={fieldClassName(`parameters.${i}.name`)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <input
                type="text"
                name="type"
                placeholder="Type (e.g. array<number>)"
                value={p.type}
                onChange={(e) => handleParamChange(i, e)}
                className={fieldClassName(`parameters.${i}.type`)}
              />
            </div>
            <button type="button" onClick={() => removeParameter(i)} className="button button-outline" style={{ color: 'var(--error)', padding: '10px' }}>
              <Trash2 size={18} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addParameter} className="button button-outline mb-8" style={{ width: '100%' }}>
          <Plus size={16} /> Add Parameter
        </button>

        <h3 className="mb-4">Compare Configuration</h3>
        <div className="grid grid-cols-2 gap-6 mb-4" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          <div className="form-group">
            <label>Comparison Mode</label>
            <select name="mode" value={formData.compareConfig.mode} onChange={handleCompareConfigChange}>
              <option value="EXACT">EXACT</option>
              <option value="STRUCTURAL">STRUCTURAL</option>
            </select>
          </div>
          <div className="form-group">
            <label>Float Tolerance</label>
            <input type="number" step="0.000001" name="floatTolerance" value={formData.compareConfig.floatTolerance} onChange={handleCompareConfigChange} />
          </div>
        </div>
        <div className="form-group mb-8">
          <label className="flex-center gap-2" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" name="orderInsensitive" checked={!!formData.compareConfig.orderInsensitive} onChange={handleCompareConfigChange} style={{ width: 'auto' }} />
            <span style={{ fontSize: '0.9rem' }}>Order Insensitive Arrays (Useful for "any order" results)</span>
          </label>
        </div>

        <h3 className="mb-4">Reference Solution (Certification)</h3>
        <p className="form-hint mb-4">Provide a working solution to verify that your test cases are correct and solvable.</p>
        <div className="form-group mb-4">
          <label>Solution Language</label>
          <select name="solutionLanguage" value={formData.solutionLanguage} onChange={handleChange}>
            <option value="javascript">JavaScript</option>
                          <option value="typescript">TypeScript</option>
                          <option value="python">Python</option>

            <option value="java">Java</option>
            <option value="go">Go</option>
            <option value="cpp">C++</option>
            <option value="c">C</option>
            <option value="csharp">C#</option>
          </select>
        </div>
        <div className="form-group mb-8">
          <label>Reference Code</label>
          <textarea
            name="referenceSolution"
            value={formData.referenceSolution}
            onChange={handleChange}
            placeholder="Write a correct solution here..."
            style={{ height: '200px', fontFamily: "'JetBrains Mono', monospace" }}
            className={fieldClassName('referenceSolution')}
            required
          />
          {fieldError('referenceSolution') && <div className="error-text">{fieldError('referenceSolution')}</div>}
        </div>

        <h3 className="mb-2">Test Cases</h3>
        <p className="form-hint mt-2 mb-6">Mark the first 1-2 test cases as sample so students can see example inputs and outputs.</p>
        
        <div>
          {fieldError('testCases') && <div className="error-text mb-6">{fieldError('testCases')}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '24px' }}>
              {formData.testCases.map((tc, i) => (
                <div key={i} style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  {/* Test Case Header */}
                  <div className="flex-between" style={{ padding: '12px 16px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
                    <div className="flex-center gap-4">
                      <h4 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)' }}>Test Case {i + 1}</h4>
                      <label className="flex-center gap-2" style={{ cursor: 'pointer', margin: 0 }}>
                        <input type="checkbox" name="isSample" checked={!!tc.isSample} onChange={(e) => handleTestCaseChange(i, e)} style={{ width: 'auto', margin: 0 }} />
                        <span style={{ fontSize: '0.85rem', color: tc.isSample ? 'var(--success)' : 'var(--text-muted)', fontWeight: tc.isSample ? '600' : '400' }}>
                          Public Sample
                        </span>
                      </label>
                    </div>
                    {formData.testCases.length > 1 && (
                      <button type="button" onClick={() => removeTestCase(i)} className="button button-outline" style={{ padding: '6px', color: 'var(--text-muted)', borderColor: 'transparent' }} title="Delete Test Case">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  
                  {/* Test Case Body */}
                  <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '600' }}>Inputs (JSON Array)</label>
                      <textarea
                        name="inputs"
                        placeholder='e.g. [[2,7,11,15], 9]'
                        value={tc.inputs}
                        onChange={(e) => handleTestCaseChange(i, e)}
                        style={{ minHeight: '60px', height: '60px', fontSize: '0.85rem', fontFamily: "'JetBrains Mono', monospace", resize: 'vertical' }}
                        className={fieldClassName(`testCases.${i}.inputs`) || fieldClassName(`testCases.${i}`)}
                        required
                      />
                      {fieldError(`testCases.${i}.inputs`) && <div className="error-text">{fieldError(`testCases.${i}.inputs`)}</div>}
                      {fieldError(`testCases.${i}`) && <div className="error-text">{fieldError(`testCases.${i}`)}</div>}
                    </div>
                    
                    <div>
                      <label style={{ display: 'block', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '600' }}>Expected Output (JSON)</label>
                      <input
                        type="text"
                        name="expected"
                        placeholder='e.g. [0, 1]'
                        value={tc.expected}
                        onChange={(e) => handleTestCaseChange(i, e)}
                        style={{ fontSize: '0.85rem', fontFamily: "'JetBrains Mono', monospace" }}
                        required
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addTestCase} className="button button-outline" style={{ width: '100%', padding: '12px' }}>
              <Plus size={16} /> Add Test Case
            </button>
        </div>
        </>)}

        {formData.problemType === 'mcq' && (
          <div className="mb-8">
            <h3 className="mb-2">Options</h3>
            {fieldError('options') && <div className="error-text mb-4">{fieldError('options')}</div>}
            <div className="form-group mb-4">
              <label className="flex-center gap-2" style={{ justifyContent: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formData.allowMultipleAnswers}
                  onChange={(e) => setFormData({ ...formData, allowMultipleAnswers: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                <span style={{ fontSize: '0.9rem' }}>Allow multiple correct answers</span>
              </label>
            </div>
            {formData.options.map((o, i) => (
              <div key={i} className="flex-center gap-4 mb-4">
                <label className="flex-center gap-2" style={{ cursor: 'pointer' }}>
                  <input
                    type={formData.allowMultipleAnswers ? 'checkbox' : 'radio'}
                    name="isCorrect"
                    checked={!!o.isCorrect}
                    onChange={(e) => handleOptionChange(i, e)}
                    style={{ width: 'auto' }}
                  />
                </label>
                <div style={{ flex: 1 }}>
                  <input type="text" name="text" placeholder={`Option ${i + 1}`} value={o.text} onChange={(e) => handleOptionChange(i, e)} />
                </div>
                <button type="button" onClick={() => removeOption(i)} className="button button-outline" style={{ color: 'var(--error)', padding: '10px' }} disabled={formData.options.length <= 2}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            <button type="button" onClick={addOption} className="button button-outline" style={{ width: '100%' }}>
              <Plus size={16} /> Add Option
            </button>
          </div>
        )}

        {formData.problemType === 'subjective' && (
          <div className="mb-8">
            <h3 className="mb-4">Grading Guidance</h3>
            <div className="form-group mb-4">
              <label>Max Words (optional)</label>
              <input type="number" min="1" value={formData.maxWords} onChange={(e) => setFormData({ ...formData, maxWords: e.target.value })} className={fieldClassName('maxWords')} placeholder="e.g. 200" />
              {fieldError('maxWords') && <div className="error-text">{fieldError('maxWords')}</div>}
            </div>
            <div className="form-group mb-4">
              <label>Rubric Notes (faculty-only, never shown to students)</label>
              <textarea value={formData.rubricNotes} onChange={(e) => setFormData({ ...formData, rubricNotes: e.target.value })} placeholder="What should a full-score answer cover?" style={{ height: '120px' }} />
            </div>
          </div>
        )}

        <div className="flex-between gap-4 mt-8">
          {formData.problemType === 'function' && (
            <button type="button" onClick={handleValidate} className="button button-outline" style={{ flex: 1, padding: '14px' }} disabled={isValidating}>
              {isValidating ? 'Validating...' : 'Validate Problem'}
            </button>
          )}
          <button type="submit" className="button" style={{ flex: 1, padding: '14px' }} disabled={(formData.problemType === 'function' && (!isValidated || isValidating))}>
            <Save size={20} /> Create Problem
          </button>
        </div>
      </form>
    </div>
  );
};

export default AddProblemPage;
