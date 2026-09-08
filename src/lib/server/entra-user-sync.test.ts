import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));

vi.mock('$lib/server/db', () => ({ GetPool: getPool }));

import { updateStoredUserFromEntra } from './entra-user-sync';

describe('updateStoredUserFromEntra', () => {
	beforeEach(() => {
		getPool.mockReset();
	});

	it('preserves the historical snapshot when the OID no longer exists in Entra', async () => {
		await updateStoredUserFromEntra('former-user', {
			found: false,
			email: null,
			fullName: null,
			givenName: null,
			surname: null
		});

		expect(getPool).not.toHaveBeenCalled();
	});

	it('updates both the durable user and session identity caches', async () => {
		const queries: string[] = [];
		const pool = {
			request: () => {
				const request = {
					input: vi.fn(() => request),
					query: vi.fn(async (sql: string) => {
						queries.push(sql);
					})
				};
				return request;
			}
		};
		getPool.mockResolvedValue(pool);

		await updateStoredUserFromEntra('active-user', {
			found: true,
			email: 'updated@example.com',
			fullName: 'Updated User',
			givenName: 'Updated',
			surname: 'User'
		});

		expect(queries).toHaveLength(2);
		expect(queries[0]).toContain('UPDATE dbo.Users');
		expect(queries[0]).toContain('SET DisplayName = CASE');
		expect(queries[1]).toContain('UPDATE dbo.UserSessions');
	});
});
