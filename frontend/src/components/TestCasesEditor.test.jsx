import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseBulkTests, buildReferenceDraft } from '../utils/problemForm';

const post = vi.fn();
// failWith: when set, the next post rejects with it. Kept outside vi.fn on purpose: vitest
// reports an error thrown inside a vi.fn implementation as a test failure even when the
// caller catches it.
let failWith = null;
vi.mock('../api', () => ({
  default: {
    post: (...args) => {
      if (failWith) {
        const err = failWith;
        failWith = null;
        return Promise.reject(err);
      }
      return post(...args);
    }
  }
}));

import TestCasesEditor from './TestCasesEditor';

// Holds the form state the way Add/Edit Problem do, so edits round-trip through onChange.
function Harness({ initial }) {
  const [formData, setFormData] = useState(initial);
  return (
    <>
      <TestCasesEditor
        formData={formData}
        onChange={(testCases) => setFormData((prev) => ({ ...prev, testCases }))}
        fieldError={() => undefined}
        fieldClassName={() => ''}
      />
      <pre data-testid="state">{JSON.stringify(formData.testCases)}</pre>
    </>
  );
}

const stdinForm = (testCases) => ({
  problemType: 'stdin', title: 't', description: 'd', difficulty: 'Easy',
  referenceSolution: 'print(sum(...))', solutionLanguage: 'python', testCases
});
const state = () => JSON.parse(screen.getByTestId('state').textContent);

describe('TestCasesEditor (JUDGE_FIX_PLAN P6, P10)', () => {
  beforeEach(() => {
    post.mockReset();
    failWith = null;
  });

  it('fills empty expected outputs from the reference solution and flags a typed value that disagrees', async () => {
    post.mockResolvedValue({ data: { tests: [
      { output: '6\n', matches: null, error: null },
      { output: '5\n', matches: false, error: null }
    ] } });
    render(<Harness initial={stdinForm([
      { inputs: '3\n1 2 3\n', expected: '', isSample: true },
      { inputs: '1\n5\n', expected: '6\n', isSample: false }
    ])} />);

    fireEvent.click(screen.getByTestId('generate-outputs'));
    await waitFor(() => expect(state()[0].expected).toBe('6\n'));

    const [, draft] = post.mock.calls[0];
    expect(post.mock.calls[0][0]).toBe('/api/v1/problems/reference-outputs');
    expect(draft.testCases).toEqual([
      { inputs: ['3\n1 2 3\n'], isSample: true },
      { inputs: ['1\n5\n'], isSample: false, expected: '6\n' }
    ]);

    // The author's typo is kept, but flagged with a one-click fix.
    expect(state()[1].expected).toBe('6\n');
    expect(screen.getByTestId('mismatch-1').textContent).toMatch(/reference solution gives/);
    expect(screen.getByText(/1 test disagree/)).toBeDefined();
    fireEvent.click(screen.getByText('Use this'));
    expect(state()[1].expected).toBe('5\n');
    expect(screen.getByText(/Every expected output matches/)).toBeDefined();
  });

  it('shows why the reference solution could not run', async () => {
    // What axios rejects with: an Error carrying the response.
    failWith = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { msg: 'The reference solution does not compile.', compileOutput: 'SyntaxError: invalid syntax' } }
    });
    render(<Harness initial={stdinForm([{ inputs: '1\n', expected: '', isSample: true }])} />);
    fireEvent.click(screen.getByTestId('generate-outputs'));
    await waitFor(() => expect(screen.getByText(/does not compile/)).toBeDefined());
    expect(screen.getByText(/SyntaxError/)).toBeDefined();
  });

  it('adds many pasted inputs at once, replacing the empty starter row', () => {
    render(<Harness initial={stdinForm([{ inputs: '', expected: '', isSample: true }])} />);
    fireEvent.click(screen.getByText('Paste many inputs'));
    fireEvent.change(screen.getByTestId('bulk-input'), { target: { value: '3\n1 2 3\n---\n2\n10 20\n---\n1\n5' } });
    fireEvent.click(screen.getByTestId('bulk-add'));
    expect(state()).toEqual([
      { inputs: '3\n1 2 3\n', expected: '', isSample: true },
      { inputs: '2\n10 20\n', expected: '', isSample: false },
      { inputs: '1\n5\n', expected: '', isSample: false }
    ]);
  });
});

describe('form helpers', () => {
  it('parses function-mode lines, with an optional tab-separated expected column from a spreadsheet', () => {
    expect(parseBulkTests('function', '[[1,2], 3]\t[0]\n\n[[4], 5]\n')).toEqual([
      { inputs: '[[1,2], 3]', expected: '[0]', isSample: false },
      { inputs: '[[4], 5]', expected: '', isSample: false }
    ]);
  });

  it('builds a function draft, skipping rows whose inputs are not valid JSON', () => {
    const { draft, indexes } = buildReferenceDraft({
      problemType: 'function', functionName: 'add', returnType: 'number',
      parameters: [{ name: 'a', type: 'number' }, { name: '', type: '' }],
      referenceSolution: 'x', solutionLanguage: 'python',
      testCases: [{ inputs: '[1, 2]', expected: '3' }, { inputs: '[1,', expected: '' }, { inputs: '[5, 5]', expected: '' }]
    });
    expect(indexes).toEqual([0, 2]);
    expect(draft.parameters).toEqual([{ name: 'a', type: 'number' }]);
    expect(draft.testCases).toEqual([
      { inputs: [1, 2], isSample: false, expected: 3 },
      { inputs: [5, 5], isSample: false }
    ]);
  });
});
