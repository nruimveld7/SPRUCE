import { describe, expect, it } from 'vitest';
import { storedUserDisplayNameSql } from './user-name-sql';

describe('storedUserDisplayNameSql', () => {
	it('uses every locally cached identity field before the OID fallback', () => {
		const sql = storedUserDisplayNameSql('u');
		expect(sql.indexOf('u.DisplayName')).toBeLessThan(sql.indexOf('u.FullName'));
		expect(sql.indexOf('u.FullName')).toBeLessThan(sql.indexOf('u.EntraFirstName'));
		expect(sql.indexOf('u.EntraLastName')).toBeLessThan(sql.indexOf('u.Email'));
		expect(sql.indexOf('u.Email')).toBeLessThan(sql.lastIndexOf('u.UserOid'));
	});

	it('supports a caller-specific final fallback', () => {
		expect(storedUserDisplayNameSql('actor', '@actorUserOid')).toContain('@actorUserOid');
	});

	it('rejects unsafe aliases', () => {
		expect(() => storedUserDisplayNameSql('u; DROP TABLE dbo.Users')).toThrow();
	});
});
