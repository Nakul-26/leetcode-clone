import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import SubmissionOutput from './SubmissionOutput';
import React from 'react';

describe('SubmissionOutput Component', () => {
  it('renders "Accepted" status correctly', () => {
    const output = {
      status: 'Accepted',
      passedCount: 2,
      totalCount: 2,
      maxTimeMs: 150,
      details: [
        { test: 1, passed: true, inputs: [1, 2], output: 3, expected: 3 },
        { test: 2, passed: true, inputs: [5, 5], output: 10, expected: 10 }
      ]
    };

    render(<SubmissionOutput output={output} />);
    
    expect(screen.getByText('Accepted')).toBeDefined();
    expect(screen.getByText('2 / 2')).toBeDefined();
    expect(screen.getByText('150 ms')).toBeDefined();
    expect(screen.getByText('Case 1')).toBeDefined();
    expect(screen.getByText('Case 2')).toBeDefined();
  });

  it('renders "Wrong Answer" status with details', () => {
    const output = {
      status: 'Wrong Answer',
      passedCount: 1,
      totalCount: 2,
      details: [
        { test: 1, passed: true, inputs: [1, 2], output: 3, expected: 3 },
        { test: 2, passed: false, inputs: [5, 5], output: 9, expected: 10 }
      ]
    };

    render(<SubmissionOutput output={output} />);
    
    expect(screen.getByText('Wrong Answer')).toBeDefined();
    expect(screen.getByText('1 / 2')).toBeDefined();
    expect(screen.getByText('Case 2')).toBeDefined();
  });

  it('renders Compilation Error correctly', () => {
    const output = {
      status: 'Compilation Error',
      error: 'Syntax error at line 1'
    };

    render(<SubmissionOutput output={output} />);
    
    expect(screen.getAllByText('Compilation Error').length).toBeGreaterThan(0);
    expect(screen.getByText('Syntax error at line 1')).toBeDefined();
  });

  it('returns null when no output is provided', () => {
    const { container } = render(<SubmissionOutput output={null} />);
    expect(container.firstChild).toBeNull();
  });
  it('shows tests after the first failure as not run, not failed', () => {
    const output = {
      status: 'Time Limit Exceeded',
      passedCount: 1,
      totalCount: 4,
      details: [
        { test: 1, passed: true, inputs: [1], output: 1, expected: 1 },
        { test: 2, passed: false, error: 'Time Limit Exceeded', errorType: 'timeout', inputs: [2], expected: 2 },
        { test: 3, passed: false, error: 'Not Run', errorType: 'not_run', isHidden: true },
        { test: 4, passed: false, error: 'Not Run', errorType: 'not_run', isHidden: true }
      ]
    };

    const { container } = render(<SubmissionOutput output={output} />);

    expect(screen.getByText('1 / 4')).toBeDefined();
    expect(screen.getAllByText('Not run')).toHaveLength(2);
    expect(container.querySelectorAll('.testcase-not-run')).toHaveLength(2);
    // Only the real failure shows an error box.
    expect(screen.queryAllByText('Not Run')).toHaveLength(0);
    expect(screen.getAllByText('Time Limit Exceeded').length).toBeGreaterThan(0);
  });
  it('shows a test with no expected output as ran, not failed', () => {
    const output = {
      status: 'Finished',
      passedCount: 0,
      totalCount: 0,
      details: [{ test: 1, passed: null, noExpected: true, inputs: ['5\n'], output: '10\n' }]
    };
    const { container } = render(<SubmissionOutput output={output} />);
    expect(screen.getByText(/ran, no expected output/)).toBeDefined();
    expect(container.querySelectorAll('.testcase-header.unjudged')).toHaveLength(1);
    expect(container.querySelectorAll('.testcase-header.failed')).toHaveLength(0);
  });
});
