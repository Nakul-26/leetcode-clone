import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Clock, MinusCircle, Info } from 'lucide-react';

const formatValue = (val) => {
    if (val === undefined || val === null) return 'null';
    if (typeof val === 'object') {
        try {
            return JSON.stringify(val);
        } catch {
            return String(val);
        }
    }
    return String(val);
};

const SubmissionOutput = ({ output }) => {
    if (!output) return null;

    let parsed = output;
    
    // If output is a string, it might be the JSON string from the judge
    if (typeof output === 'string') {
        try {
            parsed = JSON.parse(output);
        } catch {
            // If it's not JSON, it might be raw stderr/stdout
            return (
                <div className="testcase-box border-error">
                    <div className="testcase-header failed">
                        <div className="flex-center gap-2"><AlertTriangle size={16} /> Execution Error</div>
                    </div>
                    <div className="testcase-body">
                        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--error)' }}>{output}</pre>
                    </div>
                </div>
            );
        }
    }

    // Handle the case where we receive a full submission object instead of just the output
    // A submission object typically has status at the top level, and either output (string) or testResult (object)
    if (parsed.testResult && typeof parsed.testResult === 'object') {
        parsed = {
            ...parsed,
            ...parsed.testResult
        };
    }

    const isSuccess = parsed.status === 'Success' || parsed.status === 'Accepted';
    const isError = ['Fail', 'Error', 'Wrong Answer', 'Runtime Error', 'Compilation Error', 'Time Limit Exceeded', 'Memory Limit Exceeded'].includes(parsed.status);
    
    let verdictClass = 'verdict-warning';
    let VerdictIcon = AlertTriangle;

    if (isSuccess) {
        verdictClass = 'verdict-success';
        VerdictIcon = CheckCircle2;
    } else if (isError) {
        verdictClass = 'verdict-error';
        VerdictIcon = XCircle;
    }

    const rawDetails = Array.isArray(parsed.details) ? parsed.details : [];
    
    // Normalize details to ensure 'inputs' exists (fail-safe if API sanitization was bypassed)
    const normalizedDetails = rawDetails.map(detail => ({
        ...detail,
        inputs: detail.inputs ?? detail.input ?? detail.Input,
        expected: detail.expected ?? detail.Expected,
        output: detail.output ?? detail.Output,
        passed: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
    }));

    const passedTests = parsed.passedCount ?? parsed.passed ?? normalizedDetails.filter(d => d.passed).length;
    const totalTests = parsed.totalCount ?? parsed.total ?? Math.max(normalizedDetails.length, passedTests);
    
    const timeNum = Number(parsed.maxTimeMs || parsed.elapsedMs || parsed.time);
    const timeStr = !isNaN(timeNum) ? `${timeNum.toFixed(0)} ms` : 'N/A';

    return (
        <div className="submission-result fade-in">
            {parsed.status && (
                <div className={`verdict-banner ${verdictClass}`} style={{ marginBottom: '24px' }}>
                    <VerdictIcon size={24} />
                    <span style={{ fontSize: '1.25rem', fontWeight: '700' }}>{parsed.status}</span>
                </div>
            )}

            <div className="grid grid-cols-2 gap-4 mb-8" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px' }}>
                <div className="stat-card" style={{ padding: '16px', background: 'var(--surface)', borderRadius: '12px', border: '1px solid var(--border)' }}>
                    <span className="label" style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '4px' }}>Tests Passed</span>
                    <span className="value" style={{ fontSize: '1.5rem', fontWeight: '700', color: passedTests === totalTests && totalTests > 0 ? 'var(--success)' : (passedTests > 0 ? 'var(--warning)' : 'var(--error)') }}>
                        {passedTests} / {totalTests}
                    </span>
                </div>
                <div className="stat-card" style={{ padding: '16px', background: 'var(--surface)', borderRadius: '12px', border: '1px solid var(--border)' }}>
                    <span className="label" style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '4px' }}>Runtime</span>
                    <span className="value flex-center gap-2" style={{ justifyContent: 'flex-start', fontSize: '1.5rem', fontWeight: '700' }}>
                        <Clock size={20} className="text-muted" /> {timeStr}
                    </span>
                </div>
            </div>

            {(parsed.error || parsed.status === 'Compilation Error') && (
                <div className="testcase-box mb-8" style={{ border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', overflow: 'hidden' }}>
                    <div className="testcase-header failed" style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '12px 16px', borderBottom: '1px solid rgba(239, 68, 68, 0.2)' }}>
                        <div className="flex-center gap-2" style={{ color: 'var(--error)', fontWeight: '600' }}>
                            <AlertTriangle size={18} /> 
                            {parsed.status === 'Compilation Error' ? 'Compilation Error' : 'Global Error'}
                        </div>
                    </div>
                    <div className="testcase-body" style={{ padding: '16px', background: 'var(--bg)' }}>
                        <pre style={{ 
                            color: 'var(--error)', 
                            fontSize: '0.9rem', 
                            fontFamily: "'JetBrains Mono', monospace", 
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all'
                        }}>
                            {parsed.error || parsed.stderr || parsed.output}
                        </pre>
                    </div>
                </div>
            )}

            {normalizedDetails.length > 0 && (
                <div className="testcase-explorer">
                    <h4 className="text-muted" style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '16px' }}>Testcase Details</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {normalizedDetails.map((detail, idx) => {
                            const passed = detail.passed ?? detail.ok ?? false;
                            // A student's own Run test with no known answer: it ran, nothing to judge.
                            const unjudged = detail.noExpected === true;
                            const isHidden = detail.isHidden === true;
                            const testNumber = detail.test ?? detail.testIndex ?? idx + 1;

                            // Graded submissions stop at the first failed test; the rest are
                            // reported as not run rather than failed.
                            if (detail.errorType === 'not_run') {
                                return (
                                    <div key={idx} className="testcase-box testcase-not-run" style={{ background: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden', opacity: 0.7 }}>
                                        <div className="testcase-header" style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div className="flex-center gap-2" style={{ fontWeight: '600', color: 'var(--text-muted)' }}>
                                                <MinusCircle size={16} />
                                                <span>{isHidden ? 'Hidden Case' : `Case ${testNumber}`}</span>
                                            </div>
                                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Not run</span>
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div key={idx} className="testcase-box" style={{ background: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden' }}>
                                    <div className={`testcase-header ${unjudged ? 'unjudged' : passed ? 'passed' : 'failed'}`} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: unjudged ? 'transparent' : passed ? 'rgba(34, 197, 94, 0.05)' : 'rgba(239, 68, 68, 0.05)' }}>
                                        <div className="flex-center gap-2" style={{ fontWeight: '600', color: unjudged ? 'var(--text-muted)' : passed ? 'var(--success)' : 'var(--error)' }}>
                                            {unjudged ? <Info size={16} /> : passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                                            <span>{isHidden ? `Hidden Case` : `Case ${testNumber}`}</span>
                                            {unjudged && <span style={{ fontWeight: 400 }}>· ran, no expected output to compare</span>}
                                        </div>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                            {detail.timeMs ? `${detail.timeMs} ms` : (detail.time ? `${detail.time} ms` : '')}
                                        </span>
                                    </div>
                                    <div className="testcase-body" style={{ padding: '16px' }}>
                                        {isHidden && (
                                            <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'rgba(0,0,0,0.1)', borderRadius: '6px', fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <AlertTriangle size={14} /> Test case details are hidden.
                                            </div>
                                        )}
                                        {detail.error && (
                                            <div className="testcase-field mb-4">
                                                <span className="label" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--error)', fontWeight: '600', marginBottom: '4px' }}>Error</span>
                                                <pre style={{ 
                                                    background: 'rgba(239, 68, 68, 0.05)', 
                                                    padding: '12px', 
                                                    borderRadius: '6px', 
                                                    borderLeft: '3px solid var(--error)',
                                                    color: 'var(--error)',
                                                    fontSize: '0.85rem'
                                                }}>
                                                    {detail.error}
                                                </pre>
                                            </div>
                                        )}

                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                            {detail.inputs !== undefined && !isHidden && (
                                                <div className="testcase-field">
                                                    <span className="label" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Input</span>
                                                    <pre style={{ background: 'var(--bg)', padding: '8px 12px', borderRadius: '6px', fontSize: '0.85rem' }}>{formatValue(detail.inputs)}</pre>
                                                </div>
                                            )}
                                            
                                            {detail.expected !== undefined && !isHidden && (
                                                <div className="testcase-field">
                                                    <span className="label" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Expected Output</span>
                                                    <pre style={{ background: 'var(--bg)', padding: '8px 12px', borderRadius: '6px', fontSize: '0.85rem' }}>{formatValue(detail.expected)}</pre>
                                                </div>
                                            )}
                                        </div>
                                        
                                        {detail.output !== undefined && !isHidden && (
                                            <div className="testcase-field mt-4">
                                                <span className="label" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Your Output</span>
                                                <pre style={{ 
                                                    background: 'var(--bg)', 
                                                    padding: '12px', 
                                                    borderRadius: '6px', 
                                                    fontSize: '0.85rem',
                                                    borderLeft: unjudged ? '3px solid var(--border)' : passed ? '3px solid var(--success)' : '3px solid var(--error)',
                                                    color: unjudged || passed ? 'var(--text)' : 'var(--error)'
                                                }}>
                                                    {formatValue(detail.output)}
                                                </pre>
                                            </div>
                                        )}

                                        {(detail.stdout || detail.stderr || detail.traceback) && (
                                            <div className="testcase-field mt-4">
                                                <span className="label" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Console Logs</span>
                                                <pre style={{ 
                                                    background: 'rgba(0,0,0,0.2)', 
                                                    padding: '12px', 
                                                    borderRadius: '6px', 
                                                    color: 'var(--text-secondary)',
                                                    fontSize: '0.8rem',
                                                    maxHeight: '200px',
                                                    overflowY: 'auto'
                                                }}>
                                                    {detail.stdout && `${detail.stdout}\n`}
                                                    {detail.traceback && <span style={{ color: 'var(--error)' }}>{detail.traceback}\n</span>}
                                                    {detail.stderr && <span style={{ color: 'var(--error)' }}>{detail.stderr}</span>}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default SubmissionOutput;
