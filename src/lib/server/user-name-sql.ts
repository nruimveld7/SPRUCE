/**
 * Builds the SQL expression used whenever an application-owned user must be shown by name.
 * Callers supply only static SQL identifiers from source code, never request data.
 */
export function storedUserDisplayNameSql(
	userAlias: string,
	fallbackSql = `${userAlias}.UserOid`
): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(userAlias)) {
		throw new Error('Invalid SQL alias for stored user name');
	}

	return `COALESCE(
		NULLIF(LTRIM(RTRIM(${userAlias}.DisplayName)), ''),
		NULLIF(LTRIM(RTRIM(${userAlias}.FullName)), ''),
		NULLIF(
			LTRIM(RTRIM(CONCAT(
				NULLIF(LTRIM(RTRIM(${userAlias}.EntraFirstName)), ''),
				CASE
					WHEN NULLIF(LTRIM(RTRIM(${userAlias}.EntraFirstName)), '') IS NOT NULL
					 AND NULLIF(LTRIM(RTRIM(${userAlias}.EntraLastName)), '') IS NOT NULL
					THEN ' '
					ELSE ''
				END,
				NULLIF(LTRIM(RTRIM(${userAlias}.EntraLastName)), '')
			))),
			''
		),
		NULLIF(LTRIM(RTRIM(${userAlias}.Email)), ''),
		${fallbackSql}
	)`;
}
