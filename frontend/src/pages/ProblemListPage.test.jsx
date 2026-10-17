import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test: the list refetches whenever a filter changes, and requests can finish out of
// order. Before the fix, a slow earlier request (the unfiltered list) could arrive AFTER the
// filtered one and overwrite it, so searching sometimes showed the wrong problems. Found by the
// Playwright E2E "Two Sum" test, which searched for a problem outside the unfiltered first page.
const get = vi.fn();
vi.mock('../api', () => ({ default: { get: (...args) => get(...args) } }));

import ProblemListPage from './ProblemListPage';

const problem = (id, title) => ({
  _id: id.padEnd(24, '0'),
  title,
  difficulty: 'Easy',
  tags: [],
  submissionCount: 0,
  acceptedCount: 0,
});

// A promise we resolve by hand, so the test controls the order responses arrive in.
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('ProblemListPage', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('shows the newest search results even if an older request finishes last', async () => {
    const unfiltered = deferred();
    const filtered = deferred();
    get.mockImplementation((_url, { params }) => (params.search ? filtered.promise : unfiltered.promise));

    render(
      <MemoryRouter>
        <ProblemListPage user={null} />
      </MemoryRouter>
    );

    // The initial, unfiltered request is still in flight when the user types a search.
    fireEvent.change(document.querySelector('input[name="search"]'), { target: { name: 'search', value: 'Two Sum' } });

    // The filtered request answers first...
    await act(async () => {
      filtered.resolve({ data: [problem('b', 'Two Sum (Certification)')] });
    });
    await waitFor(() => expect(screen.getByText('Two Sum (Certification)')).toBeDefined());

    // ...then the stale unfiltered one arrives late and must NOT replace it.
    await act(async () => {
      unfiltered.resolve({ data: [problem('a', 'Some Unrelated Problem')] });
    });

    expect(screen.getByText('Two Sum (Certification)')).toBeDefined();
    expect(screen.queryByText('Some Unrelated Problem')).toBeNull();
  });
});
