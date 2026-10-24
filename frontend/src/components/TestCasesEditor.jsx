import React, { useState } from 'react';
import { Plus, Trash2, Wand2, CheckCircle2, AlertTriangle, ClipboardPaste } from 'lucide-react';
import api from '../api';
import { buildReferenceDraft, formatOutput, sameAsOutput, parseBulkTests } from '../utils/problemForm';

// The test-case section of the Add/Edit Problem pages (JUDGE_FIX_PLAN Phase 6).
//
// Authors type inputs; "Generate expected outputs" runs the reference solution on every input
// and writes what it produces into each empty expected field. A field the author already filled
// is left alone, but if the reference solution disagrees it is flagged with the reference's
// value and a one-click fix, so a typo cannot make correct student code fail. Saving re-checks
// every test on the server anyway.

const labelStyle = { display: 'block', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: '600' };
const monoStyle = { fontSize: '0.85rem', fontFamily: "'JetBrains Mono', monospace", resize: 'vertical' };

const TestCasesEditor = ({ formData, onChange, fieldError, fieldClassName }) => {
  const stdin = formData.problemType === 'stdin';
  const testCases = formData.testCases || [];
  // Per row: { output, matches, error } from the last generate, until that row is edited.
  const [checks, setChecks] = useState({});
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const setRows = (rows, keepChecks = false) => {
    if (!keepChecks) setChecks({});
    onChange(rows);
  };

  const updateRow = (index, field, value) => {
    const next = testCases.map((tc, i) => (i === index ? { ...tc, [field]: value } : tc));
    setChecks((prev) => {
      const copy = { ...prev };
      delete copy[index];
      return copy;
    });
    onChange(next);
  };

  const addRow = () => setRows([...testCases, { inputs: stdin ? '' : '[]', expected: '', isSample: testCases.length < 2 }], true);
  const removeRow = (index) => {
    if (testCases.length <= 1) return;
    setRows(testCases.filter((_, i) => i !== index));
  };

  const generate = async () => {
    setGenerateError('');
    const { draft, indexes } = buildReferenceDraft(formData);
    if (!draft.referenceSolution || !draft.referenceSolution.trim()) {
      setGenerateError('Write the reference solution first: expected outputs are computed from it.');
      return;
    }
    if (indexes.length === 0) {
      setGenerateError(stdin ? 'Add at least one test input first.' : 'Add at least one test input (a JSON array) first.');
      return;
    }
    setGenerating(true);
    try {
      const res = await api.post('/api/v1/problems/reference-outputs', draft);
      const results = res.data.tests || [];
      const next = testCases.map((tc) => ({ ...tc }));
      const nextChecks = {};
      results.forEach((r, k) => {
        const row = indexes[k];
        nextChecks[row] = r;
        if (!r.error && String(next[row].expected ?? '').trim() === '') {
          next[row].expected = formatOutput(formData.problemType, r.output);
          nextChecks[row] = { ...r, matches: true, filled: true };
        }
      });
      onChange(next);
      setChecks(nextChecks);
    } catch (err) {
      const data = err.response?.data;
      const detail = data?.compileOutput ? `\n${data.compileOutput}` : '';
      setGenerateError((data?.msg || data?.error || 'Could not run the reference solution.') + detail);
    } finally {
      setGenerating(false);
    }
  };

  const applyReference = (index) => {
    const r = checks[index];
    if (!r) return;
    const next = testCases.map((tc, i) => (i === index ? { ...tc, expected: formatOutput(formData.problemType, r.output) } : tc));
    setChecks((prev) => ({ ...prev, [index]: { ...r, matches: true } }));
    onChange(next);
  };

  const addBulk = () => {
    const rows = parseBulkTests(formData.problemType, bulkText);
    if (rows.length === 0) return;
    // Replace a single untouched starter row instead of keeping it.
    const untouched = testCases.length === 1 && String(testCases[0].inputs).trim() === (stdin ? '' : '[]') && !String(testCases[0].expected).trim();
    const base = untouched ? [] : testCases;
    if (base.every((tc) => !tc.isSample) && rows.length > 0) rows[0].isSample = true;
    setRows([...base, ...rows], true);
    setBulkText('');
    setShowBulk(false);
  };

  const mismatches = Object.values(checks).filter((r) => r && (r.error || r.matches === false)).length;

  return (
    <div>
      <h3 className="mb-2">Test Cases</h3>
      <p className="form-hint mt-2 mb-4">
        {stdin
          ? 'Each test is the exact text the program reads. '
          : 'Each test is a JSON array of the function\'s arguments. '}
        Type the inputs, then use <strong>Generate expected outputs</strong>: the reference solution fills them in, so
        they cannot contain typos. Mark 1-2 tests as samples; students see those.
      </p>

      <div className="flex-center gap-4 mb-4" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        <button type="button" onClick={generate} className="button" disabled={generating} data-testid="generate-outputs">
          <Wand2 size={16} /> {generating ? 'Running the reference solution...' : 'Generate expected outputs'}
        </button>
        <button type="button" onClick={() => setShowBulk((v) => !v)} className="button button-outline">
          <ClipboardPaste size={16} /> Paste many inputs
        </button>
        {Object.keys(checks).length > 0 && (
          mismatches === 0
            ? <span className="success-text flex-center gap-2"><CheckCircle2 size={16} /> Every expected output matches the reference solution</span>
            : <span className="error-text flex-center gap-2" style={{ marginTop: 0 }}><AlertTriangle size={16} /> {mismatches} test{mismatches > 1 ? 's' : ''} disagree with the reference solution</span>
        )}
      </div>

      {generateError && <pre className="error-box mb-4" style={{ whiteSpace: 'pre-wrap' }}>{generateError}</pre>}

      {showBulk && (
        <div className="problem-card mb-6">
          <label style={labelStyle}>{stdin ? 'Inputs, separated by a line containing only ---' : 'Inputs, one JSON array per line'}</label>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={stdin ? '3\n1 2 3\n---\n2\n10 20' : '[[2,7,11,15], 9]\n[[3,2,4], 6]'}
            style={{ ...monoStyle, minHeight: '140px' }}
            data-testid="bulk-input"
          />
          <p className="form-hint">Expected outputs are optional: generate them afterwards. Two columns copied from a spreadsheet (input, expected) also work.</p>
          <button type="button" onClick={addBulk} className="button button-outline mt-2" data-testid="bulk-add">
            <Plus size={16} /> Add {parseBulkTests(formData.problemType, bulkText).length} test cases
          </button>
        </div>
      )}

      {fieldError('testCases') && <div className="error-text mb-6">{fieldError('testCases')}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '24px' }}>
        {testCases.map((tc, i) => {
          const check = checks[i];
          const bad = check && (check.error || check.matches === false);
          return (
            <div key={i} data-testid={`test-case-${i}`} style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', border: `1px solid ${bad ? 'var(--error)' : 'var(--border)'}`, overflow: 'hidden' }}>
              <div className="flex-between" style={{ padding: '12px 16px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
                <div className="flex-center gap-4">
                  <h4 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text)' }}>Test Case {i + 1}</h4>
                  <label className="flex-center gap-2" style={{ cursor: 'pointer', margin: 0 }}>
                    <input type="checkbox" checked={!!tc.isSample} onChange={(e) => updateRow(i, 'isSample', e.target.checked)} style={{ width: 'auto', margin: 0 }} />
                    <span style={{ fontSize: '0.85rem', color: tc.isSample ? 'var(--success)' : 'var(--text-muted)', fontWeight: tc.isSample ? '600' : '400' }}>Public Sample</span>
                  </label>
                  {check && !bad && <span className="success-text flex-center gap-1" style={{ fontSize: '0.8rem' }}><CheckCircle2 size={14} /> {check.filled ? 'generated' : 'matches reference'}</span>}
                </div>
                {testCases.length > 1 && (
                  <button type="button" onClick={() => removeRow(i)} className="button button-outline" style={{ padding: '6px', color: 'var(--text-muted)', borderColor: 'transparent' }} title="Delete Test Case">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>

              <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
                <div>
                  <label style={labelStyle}>{stdin ? 'Input (stdin)' : 'Inputs (JSON Array)'}</label>
                  <textarea
                    placeholder={stdin ? '3\n1 2 3' : 'e.g. [[2,7,11,15], 9]'}
                    value={tc.inputs}
                    onChange={(e) => updateRow(i, 'inputs', e.target.value)}
                    style={{ ...monoStyle, minHeight: stdin ? '80px' : '60px' }}
                    className={fieldClassName(`testCases.${i}.inputs`) || fieldClassName(`testCases.${i}`)}
                  />
                  {fieldError(`testCases.${i}.inputs`) && <div className="error-text">{fieldError(`testCases.${i}.inputs`)}</div>}
                  {fieldError(`testCases.${i}`) && <div className="error-text">{fieldError(`testCases.${i}`)}</div>}
                </div>
                <div>
                  <label style={labelStyle}>{stdin ? 'Expected Output (stdout)' : 'Expected Output (JSON)'}</label>
                  <textarea
                    placeholder={stdin ? 'Leave empty and generate it' : 'Leave empty and generate it, e.g. [0, 1]'}
                    value={tc.expected}
                    onChange={(e) => updateRow(i, 'expected', e.target.value)}
                    style={{ ...monoStyle, minHeight: stdin ? '60px' : '40px' }}
                  />
                  {check?.error && (
                    <div className="error-text" data-testid={`check-error-${i}`}>The reference solution failed on this input: {check.error}</div>
                  )}
                  {check && !check.error && check.matches === false && (
                    <div className="error-text flex-center gap-2" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }} data-testid={`mismatch-${i}`}>
                      <span>The reference solution gives <code>{formatOutput(formData.problemType, check.output)}</code></span>
                      {!sameAsOutput(formData.problemType, tc.expected, check.output) && (
                        <button type="button" className="button button-outline" style={{ padding: '2px 10px', fontSize: '0.8rem' }} onClick={() => applyReference(i)}>
                          Use this
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={addRow} className="button button-outline" style={{ width: '100%', padding: '12px' }}>
        <Plus size={16} /> Add Test Case
      </button>
    </div>
  );
};

export default TestCasesEditor;
