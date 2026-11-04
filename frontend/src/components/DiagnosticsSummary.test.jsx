import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import DiagnosticsSummary from './DiagnosticsSummary';
import SubmissionOutput from './SubmissionOutput';
import { applyDiagnosticMarkers, diagnosticsOf } from '../utils/editorDiagnostics';

const missingSemicolon = { line: 17, column: 24, kind: 'compile', message: "expected ',' or ';' before 'pritnf'", hint: 'Missing `;` at the end of this line.' };

describe('DiagnosticsSummary', () => {
  it('shows the line, the message and the hint, with code marked up', () => {
    render(<DiagnosticsSummary diagnostics={[missingSemicolon]} />);
    expect(screen.getByText('Compile error')).toBeDefined();
    expect(screen.getByText('Line 17, column 24')).toBeDefined();
    expect(screen.getByText("expected ',' or ';' before 'pritnf'")).toBeDefined();
    expect(screen.getByText(';').tagName).toBe('CODE');
  });

  it('jumps to the line when it is clicked', () => {
    const onJump = vi.fn();
    render(<DiagnosticsSummary diagnostics={[missingSemicolon]} onJumpToLine={onJump} />);
    fireEvent.click(screen.getByText('Line 17, column 24'));
    expect(onJump).toHaveBeenCalledWith(17, 24);
  });

  it('a crash without a line has no line button', () => {
    render(<DiagnosticsSummary diagnostics={[{ line: null, column: null, kind: 'runtime', message: 'Segmentation fault (exit code 139)', hint: 'Memory you don’t own.' }]} onJumpToLine={() => {}} />);
    expect(screen.getByText('Runtime error')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing without diagnostics', () => {
    const { container } = render(<DiagnosticsSummary diagnostics={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('SubmissionOutput with diagnostics', () => {
  it('puts the summary first and folds the raw compiler output away', () => {
    const output = { status: 'Compilation Error', stderr: 'main.c:18:5: error: expected \',\' or \';\' before \'pritnf\'\n' + 'x\n'.repeat(80), diagnostics: [missingSemicolon] };
    render(<SubmissionOutput output={output} />);
    expect(screen.getByTestId('diagnostics-summary')).toBeDefined();
    expect(screen.getByText('Full compiler output').closest('details').open).toBe(false);
  });

  it('reads diagnostics from a submission’s testResult', () => {
    expect(diagnosticsOf({ status: 'Fail', testResult: { diagnostics: [missingSemicolon] } })).toEqual([missingSemicolon]);
    expect(diagnosticsOf(null)).toEqual([]);
  });
});

describe('applyDiagnosticMarkers', () => {
  it('sets one error marker per located diagnostic', () => {
    const setModelMarkers = vi.fn();
    const monaco = { MarkerSeverity: { Error: 8 }, editor: { setModelMarkers } };
    const model = { getLineCount: () => 20, getLineFirstNonWhitespaceColumn: () => 5, getLineMaxColumn: () => 30 };
    applyDiagnosticMarkers(monaco, { getModel: () => model }, [missingSemicolon, { line: null, message: 'crash' }]);
    const [, owner, markers] = setModelMarkers.mock.calls[0];
    expect(owner).toBe('judge');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ severity: 8, startLineNumber: 17, startColumn: 24, endColumn: 30 });
    expect(markers[0].message).toBe("expected ',' or ';' before 'pritnf'\n\nMissing ; at the end of this line.");
  });
});
