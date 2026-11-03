import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { adminApi, billingApi } = vi.hoisted(() => ({
  adminApi: { listApiClients: vi.fn(), createApiClient: vi.fn(), revokeApiClient: vi.fn(), getApiClientUsage: vi.fn() },
  billingApi: { listColleges: vi.fn(), createCollege: vi.fn() }
}));
vi.mock('../api', () => ({ admin: adminApi, billing: billingApi }));

import ApiKeysPage from './ApiKeysPage';

const key = (over = {}) => ({
  _id: 'c1', name: 'partner', keyPrefix: 'abcd1234', collegeId: 'col1', scopes: ['codeassess'],
  rateLimitPerMin: 0, monthlyQuota: 0, active: true, lastUsedAt: null, ...over
});

describe('ApiKeysPage', () => {
  beforeEach(() => {
    Object.values(adminApi).forEach((f) => f.mockReset());
    Object.values(billingApi).forEach((f) => f.mockReset());
  });

  it('an admin creates a key and sees it once, without picking a college', async () => {
    adminApi.listApiClients.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [key({ name: 'loadtest' })] });
    adminApi.createApiClient.mockResolvedValue({ data: { client: key({ name: 'loadtest' }), key: 'ak_abcd1234_secret' } });
    render(<ApiKeysPage user={{ role: 'admin' }} />);

    await screen.findByText('No keys yet.');
    expect(billingApi.listColleges).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/e.g. loadtest/), { target: { value: 'loadtest' } });
    fireEvent.click(screen.getByText('Create key'));

    await screen.findByTestId('issued-key');
    expect(adminApi.createApiClient).toHaveBeenCalledWith({ name: 'loadtest', scopes: ['codeassess'], rateLimitPerMin: 0, monthlyQuota: 0 });
    expect(screen.getByText('ak_abcd1234_secret')).toBeDefined();
    // The table only ever shows the prefix.
    await screen.findByTestId('api-keys-table');
    expect(screen.getByText('ak_abcd1234_…')).toBeDefined();
  });

  it('a superadmin with no colleges adds one, and the key is issued to it', async () => {
    adminApi.listApiClients.mockResolvedValue({ data: [] });
    billingApi.listColleges.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [{ _id: 'col9', name: 'Load test' }] });
    billingApi.createCollege.mockResolvedValue({ data: { _id: 'col9', name: 'Load test' } });
    adminApi.createApiClient.mockResolvedValue({ data: { client: key(), key: 'ak_x_y' } });
    render(<ApiKeysPage user={{ role: 'superadmin' }} />);

    await screen.findByText(/There are no colleges yet/);
    // No college yet: a key cannot be created.
    fireEvent.change(screen.getByPlaceholderText(/e.g. loadtest/), { target: { value: 'loadtest' } });
    expect(screen.getByText('Create key').closest('button').disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('New college name'), { target: { value: 'Load test' } });
    fireEvent.click(screen.getByText('Add college'));
    await waitFor(() => expect(screen.getByText('Create key').closest('button').disabled).toBe(false));
    expect(billingApi.createCollege).toHaveBeenCalledWith('Load test');

    fireEvent.click(screen.getByText('Create key'));
    await screen.findByTestId('issued-key');
    expect(adminApi.createApiClient.mock.calls[0][0]).toMatchObject({ name: 'loadtest', collegeId: 'col9' });
  });

  it('shows the server error when creation is refused', async () => {
    adminApi.listApiClients.mockResolvedValue({ data: [] });
    adminApi.createApiClient.mockRejectedValue({ response: { data: { error: 'At least one scope is required' } } });
    render(<ApiKeysPage user={{ role: 'admin' }} />);
    await screen.findByText('No keys yet.');
    fireEvent.change(screen.getByPlaceholderText(/e.g. loadtest/), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Create key'));
    await screen.findByText('At least one scope is required');
  });
});
