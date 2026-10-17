import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getLanguageStats = vi.fn();
vi.mock('../api', () => ({ admin: { getLanguageStats: (...a) => getLanguageStats(...a) } }));

import LanguageStatsCard from './LanguageStatsCard';

const sample = {
  windowDays: 30,
  totalSubmissions: 1500,
  totalPerDay: 50,
  languages: [
    { language: 'cpp', submissions: 900, perDay: 30, share: 60, p50ElapsedMs: 700, p95ElapsedMs: 2400, totalComputeMs: 900000, computeShare: 75, statuses: { 'Compilation Error': 12 } },
    { language: 'python', submissions: 600, perDay: 20, share: 40, p50ElapsedMs: 120, p95ElapsedMs: 300, totalComputeMs: 300000, computeShare: 25, statuses: {} },
  ],
};

const asRole = (role) => localStorage.setItem('user', JSON.stringify({ role }));

describe('LanguageStatsCard', () => {
  beforeEach(() => {
    getLanguageStats.mockReset();
    localStorage.clear();
  });

  it('renders nothing and makes no request for non-superadmins', () => {
    asRole('admin');
    const { container } = render(<LanguageStatsCard />);
    expect(container.innerHTML).toBe('');
    expect(getLanguageStats).not.toHaveBeenCalled();
  });

  it('shows one row per language with run times and judge time', async () => {
    asRole('superadmin');
    getLanguageStats.mockResolvedValue({ data: sample });
    render(<LanguageStatsCard />);

    await waitFor(() => expect(screen.getByText('cpp')).toBeDefined());
    expect(getLanguageStats).toHaveBeenCalledWith(30);
    expect(screen.getByText('python')).toBeDefined();
    expect(screen.getByText('2.4 s')).toBeDefined(); // cpp p95
    expect(screen.getByText('15 min (75%)')).toBeDefined(); // 900,000 ms of judge time
    expect(screen.getByText('12')).toBeDefined(); // cpp compile errors
  });

  it('refetches when the window changes', async () => {
    asRole('superadmin');
    getLanguageStats.mockResolvedValue({ data: sample });
    render(<LanguageStatsCard />);
    await waitFor(() => expect(getLanguageStats).toHaveBeenCalledWith(30));

    fireEvent.click(screen.getByText('7 days'));
    await waitFor(() => expect(getLanguageStats).toHaveBeenCalledWith(7));
  });
});
