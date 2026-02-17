import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import {
	setThemePreference,
	type ThemePreference
} from '$lib/server/schedule-ui-state';

function parseThemePreference(value: unknown): ThemePreference {
	if (value === 'system' || value === 'dark' || value === 'light') {
		return value;
	}
	throw error(400, 'A valid themePreference is required');
}

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const body = await request.json().catch(() => null);
	const themePreference = parseThemePreference(body?.themePreference);

	const pool = await GetPool();
	const userResult = await pool
		.request()
		.input('userOid', user.id)
		.query(
			`SELECT TOP (1) ScheduleUiStateJson
			 FROM dbo.Users
			 WHERE UserOid = @userOid
			   AND DeletedAt IS NULL;`
		);

	const currentJson = (userResult.recordset?.[0]?.ScheduleUiStateJson as string | null) ?? null;
	const nextJson = setThemePreference({
		currentJson,
		themePreference
	});

	await pool
		.request()
		.input('userOid', user.id)
		.input('stateJson', nextJson)
		.query(
			`MERGE dbo.Users AS target
			 USING (SELECT @userOid AS UserOid, @stateJson AS ScheduleUiStateJson) AS source
			 ON target.UserOid = source.UserOid
			 WHEN MATCHED THEN
			   UPDATE SET ScheduleUiStateJson = source.ScheduleUiStateJson,
						  IsActive = 1,
						  DeletedAt = NULL,
						  DeletedBy = NULL,
						  UpdatedAt = SYSUTCDATETIME()
			 WHEN NOT MATCHED THEN
			   INSERT (UserOid, ScheduleUiStateJson)
			   VALUES (source.UserOid, source.ScheduleUiStateJson);`
		);

	return json({ ok: true, themePreference });
};
