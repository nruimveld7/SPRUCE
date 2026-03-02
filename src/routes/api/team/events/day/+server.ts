import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
type EventScopeType = 'global' | 'shift' | 'user';
type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';

type ScheduleEventsCapabilities = {
	hasShiftId: boolean;
	hasEmployeeTypeId: boolean;
	hasCustomColumns: boolean;
};

type ScheduleAssignmentsCapabilities = {
	hasShiftId: boolean;
	hasEmployeeTypeId: boolean;
};

function roleRank(role: ScheduleRole | null): number {
	if (role === 'Manager') return 3;
	if (role === 'Maintainer') return 2;
	if (role === 'Member') return 1;
	return 0;
}

function cleanDateOnly(value: string | null, label: string): string {
	if (!value) throw error(400, `${label} is required`);
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		throw error(400, `${label} must be in YYYY-MM-DD format`);
	}
	return trimmed;
}

async function getScheduleEventsCapabilities(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<ScheduleEventsCapabilities> {
	const result = await pool.request().query(
		`SELECT COLUMN_NAME
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'ScheduleEvents';`
	);
	const columns = new Set<string>(
		(result.recordset as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME)
	);
	return {
		hasShiftId: columns.has('ShiftId'),
		hasEmployeeTypeId: columns.has('EmployeeTypeId'),
		hasCustomColumns:
			columns.has('CustomCode') &&
			columns.has('CustomName') &&
			columns.has('CustomDisplayMode') &&
			columns.has('CustomColor')
	};
}

async function getScheduleAssignmentsCapabilities(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<ScheduleAssignmentsCapabilities> {
	const result = await pool.request().query(
		`SELECT COLUMN_NAME
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'ScheduleAssignments';`
	);
	const columns = new Set<string>(
		(result.recordset as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME)
	);
	return {
		hasShiftId: columns.has('ShiftId'),
		hasEmployeeTypeId: columns.has('EmployeeTypeId')
	};
}

function toDateOnly(value: Date | string | null): string {
	if (!value) return '';
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return value.slice(0, 10);
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const day = cleanDateOnly(url.searchParams.get('day'), 'day');
	const scheduleId = await getActiveScheduleId(cookies);
	if (!scheduleId) {
		throw error(400, 'No active schedule selected');
	}

	const pool = await GetPool();
	const accessResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('userOid', currentUser.id)
		.query(
			`SELECT TOP (1) r.RoleName
			 FROM dbo.ScheduleUsers su
			 INNER JOIN dbo.Roles r
			   ON r.RoleId = su.RoleId
			 WHERE su.ScheduleId = @scheduleId
			   AND su.UserOid = @userOid
			   AND su.IsActive = 1
			   AND su.DeletedAt IS NULL
			 ORDER BY
			   CASE r.RoleName
				 WHEN 'Manager' THEN 3
				 WHEN 'Maintainer' THEN 2
				 WHEN 'Member' THEN 1
				 ELSE 0
			   END DESC;`
		);

	const role = (accessResult.recordset?.[0]?.RoleName as ScheduleRole | undefined) ?? null;
	if (roleRank(role) < roleRank('Member')) {
		throw error(403, 'Insufficient permissions');
	}

	const capabilities = await getScheduleEventsCapabilities(pool);
	const assignmentsCapabilities = await getScheduleAssignmentsCapabilities(pool);
	const shiftSelect = capabilities.hasShiftId
		? 'se.ShiftId'
		: capabilities.hasEmployeeTypeId
			? 'se.EmployeeTypeId AS ShiftId'
		: 'CAST(NULL AS int) AS ShiftId';
	const customCodeSelect = capabilities.hasCustomColumns
		? 'se.CustomCode'
		: 'CAST(NULL AS nvarchar(16)) AS CustomCode';
	const customNameSelect = capabilities.hasCustomColumns
		? 'se.CustomName'
		: 'CAST(NULL AS nvarchar(100)) AS CustomName';
	const customDisplayModeSelect = capabilities.hasCustomColumns
		? 'se.CustomDisplayMode'
		: 'CAST(NULL AS nvarchar(30)) AS CustomDisplayMode';
	const customColorSelect = capabilities.hasCustomColumns
		? 'se.CustomColor'
		: 'CAST(NULL AS nvarchar(20)) AS CustomColor';

	const eventsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('day', day)
		.query(
			`SELECT
				se.EventId,
				se.UserOid,
				${shiftSelect},
				se.StartDate,
				se.EndDate,
				se.Notes,
				se.EventCodeId,
				${customCodeSelect},
				${customNameSelect},
				${customDisplayModeSelect},
				${customColorSelect},
				cc.Code AS CoverageCode,
				cc.Label AS CoverageLabel,
				cc.DisplayMode AS CoverageDisplayMode,
				cc.Color AS CoverageColor
			 FROM dbo.ScheduleEvents se
			 LEFT JOIN dbo.EventCodes cc
			   ON cc.ScheduleId = se.ScheduleId
			  AND cc.EventCodeId = se.EventCodeId
			  AND cc.DeletedAt IS NULL
			 WHERE se.ScheduleId = @scheduleId
			   AND se.IsActive = 1
			   AND se.DeletedAt IS NULL
			   AND se.StartDate <= @day
			   AND se.EndDate >= @day
			 ORDER BY se.StartDate ASC, se.EndDate ASC, se.EventId ASC;`
		);

	const assignmentShiftSelect = assignmentsCapabilities.hasShiftId
		? 'sa.ShiftId'
		: assignmentsCapabilities.hasEmployeeTypeId
			? 'sa.EmployeeTypeId'
		: 'CAST(NULL AS int)';

	const assignmentsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('day', day)
		.query(
			`SELECT
				sa.UserOid,
				${assignmentShiftSelect} AS ShiftId,
				et.Name AS ShiftName,
				COALESCE(
					NULLIF(u.DisplayName, ''),
					NULLIF(u.Email, ''),
					sa.UserOid
				) AS UserName
			 FROM dbo.ScheduleAssignments sa
			 INNER JOIN dbo.Shifts et
			   ON et.ScheduleId = sa.ScheduleId
			  AND et.ShiftId = ${assignmentShiftSelect}
			  AND et.IsActive = 1
			  AND et.DeletedAt IS NULL
			 LEFT JOIN dbo.Users u
			   ON u.UserOid = sa.UserOid
			 WHERE sa.ScheduleId = @scheduleId
			   AND sa.IsActive = 1
			   AND sa.DeletedAt IS NULL
			   AND sa.StartDate <= @day
			   AND (sa.EndDate IS NULL OR sa.EndDate >= @day)
			 ORDER BY et.Name ASC, UserName ASC;`
		);

	const shiftById = new Map<number, string>();
	const userByOid = new Map<string, { name: string; shiftIds: Set<number> }>();
	for (const row of assignmentsResult.recordset as Array<{
		UserOid: string;
		ShiftId: number;
		ShiftName: string;
		UserName: string;
	}>) {
		const shiftId = Number(row.ShiftId);
		const userOid = row.UserOid?.trim();
		if (!Number.isInteger(shiftId) || !userOid) continue;
		shiftById.set(shiftId, row.ShiftName?.trim() || `Shift ${shiftId}`);
		const existing = userByOid.get(userOid) ?? {
			name: row.UserName?.trim() || userOid,
			shiftIds: new Set<number>()
		};
		existing.shiftIds.add(shiftId);
		userByOid.set(userOid, existing);
	}

	// Ensure scope selectors can resolve users/shifts already referenced by day events,
	// even when they are not in active assignment rows for the selected day.
	for (const row of eventsResult.recordset as Array<{ UserOid: string | null; ShiftId: number | null }>) {
		const userOid = row.UserOid?.trim();
		const shiftId = row.ShiftId === null || row.ShiftId === undefined ? null : Number(row.ShiftId);
		if (shiftId !== null && Number.isInteger(shiftId) && !shiftById.has(shiftId)) {
			shiftById.set(shiftId, `Shift ${shiftId}`);
		}
		if (!userOid) continue;
		const existing = userByOid.get(userOid) ?? { name: userOid, shiftIds: new Set<number>() };
		if (shiftId !== null && Number.isInteger(shiftId)) {
			existing.shiftIds.add(shiftId);
		}
		userByOid.set(userOid, existing);
	}

	const userOidsNeedingName = [...userByOid.entries()]
		.filter(([userOid, value]) => value.name.trim().toLowerCase() === userOid.trim().toLowerCase())
		.map(([userOid]) => userOid);
	if (userOidsNeedingName.length > 0) {
		const nameRequest = pool.request().input('scheduleId', scheduleId);
		const oidParams: string[] = [];
		for (let index = 0; index < userOidsNeedingName.length; index += 1) {
			const param = `userOid${index}`;
			nameRequest.input(param, userOidsNeedingName[index]);
			oidParams.push(`@${param}`);
		}
		const usersResult = await nameRequest.query(
			`SELECT
				u.UserOid,
				COALESCE(
					NULLIF(u.DisplayName, ''),
					NULLIF(u.Email, ''),
					u.UserOid
				) AS UserName
			 FROM dbo.Users u
			 INNER JOIN dbo.ScheduleUsers su
			   ON su.ScheduleId = @scheduleId
			  AND su.UserOid = u.UserOid
			  AND su.IsActive = 1
			  AND su.DeletedAt IS NULL
			 WHERE u.UserOid IN (${oidParams.join(', ')});`
		);
		for (const row of usersResult.recordset as Array<{ UserOid: string; UserName: string | null }>) {
			const userOid = row.UserOid?.trim();
			if (!userOid) continue;
			const existing = userByOid.get(userOid);
			if (!existing) continue;
			existing.name = row.UserName?.trim() || existing.name;
			userByOid.set(userOid, existing);
		}
	}

	const shifts = [...shiftById.entries()]
		.map(([employeeTypeId, name]) => ({ employeeTypeId, name }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const users = [...userByOid.entries()]
		.map(([userOid, value]) => ({
			userOid,
			name: value.name,
			employeeTypeIds: [...value.shiftIds].sort((a, b) => a - b)
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const events = (eventsResult.recordset as Array<{
		EventId: number;
		UserOid: string | null;
		ShiftId: number | null;
		StartDate: Date | string;
		EndDate: Date | string;
		Notes: string | null;
		EventCodeId: number | null;
		CustomCode: string | null;
		CustomName: string | null;
		CustomDisplayMode: EventDisplayMode | null;
		CustomColor: string | null;
		CoverageCode: string | null;
		CoverageLabel: string | null;
		CoverageDisplayMode: EventDisplayMode | null;
		CoverageColor: string | null;
	}>).map((row) => {
		const userOid = row.UserOid?.trim() || null;
		const employeeTypeId =
			row.ShiftId === null || row.ShiftId === undefined ? null : Number(row.ShiftId);
		const scopeType: EventScopeType = userOid
			? 'user'
			: employeeTypeId !== null
				? 'shift'
				: 'global';
		const hasCoverageCode = row.EventCodeId !== null;
		const eventCodeCode = (hasCoverageCode ? row.CoverageCode : row.CustomCode)?.trim() || 'EVT';
		const eventCodeName =
			(hasCoverageCode ? row.CoverageLabel : row.CustomName)?.trim() || eventCodeCode;
		return {
			eventId: Number(row.EventId),
			eventCodeCode,
			eventCodeName,
			scopeType,
			employeeTypeId,
			userOid,
			eventDisplayMode:
				(hasCoverageCode ? row.CoverageDisplayMode : row.CustomDisplayMode) ?? 'Schedule Overlay',
			eventCodeColor: (hasCoverageCode ? row.CoverageColor : row.CustomColor)?.trim() || '#22c55e',
			startDate: toDateOnly(row.StartDate),
			endDate: toDateOnly(row.EndDate),
			comments: row.Notes?.trim() || ''
		};
		});

	return json({ events, shifts, users });
};
