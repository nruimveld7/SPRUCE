import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import { setCollapsedGroupPreference } from '$lib/server/schedule-ui-state';

function parseScheduleId(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw error(400, 'A valid scheduleId is required');
	}
	return value;
}

function parseGroupKey(value: unknown): string {
	if (typeof value !== 'string') {
		throw error(400, 'A valid groupKey is required');
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw error(400, 'A valid groupKey is required');
	}
	return trimmed.slice(0, 200);
}

function parseCollapsed(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw error(400, 'A valid collapsed status is required');
	}
	return value;
}

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const body = await request.json().catch(() => null);
	const scheduleId = parseScheduleId(body?.scheduleId);
	const groupKey = parseGroupKey(body?.groupKey);
	const collapsed = parseCollapsed(body?.collapsed);

	const pool = await GetPool();
	const accessResult = await pool
		.request()
		.input('userOid', user.id)
		.input('scheduleId', scheduleId)
		.query(
			`SELECT TOP (1) 1 AS HasAccess
			 FROM dbo.ScheduleUsers su
			 INNER JOIN dbo.Schedules s
			   ON s.ScheduleId = su.ScheduleId
			 LEFT JOIN dbo.Roles r
			   ON r.RoleId = su.RoleId
			 WHERE su.UserOid = @userOid
			   AND su.ScheduleId = @scheduleId
			   AND su.IsActive = 1
			   AND su.DeletedAt IS NULL
			   AND s.DeletedAt IS NULL
			   AND (s.IsActive = 1 OR r.RoleName = 'Manager');`
		);

	if (!accessResult.recordset?.[0]?.HasAccess) {
		throw error(403, 'You do not have access to this schedule');
	}

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
	const nextJson = setCollapsedGroupPreference({
		currentJson,
		scheduleId,
		groupKey,
		collapsed
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

	return json({ ok: true, scheduleId, groupKey, collapsed });
};
