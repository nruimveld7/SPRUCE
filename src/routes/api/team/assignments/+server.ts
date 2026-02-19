import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';
import sql from 'mssql';
import { sendShiftChangeNotification } from '$lib/server/mail/notifications';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

type AssignmentRow = {
	DisplayOrder: number;
	UserOid: string;
	EmployeeTypeId: number;
	StartDate: Date | string;
	EndDate: Date | string | null;
	UserName: string | null;
	ShiftName: string | null;
};

type ShiftEmailContext = {
	scheduleName: string;
	scheduleThemeJson: string | null;
	targetDisplayName: string;
	actorDisplayName: string;
};

function cleanRequiredText(value: unknown, maxLength: number, label: string): string {
	if (typeof value !== 'string') {
		throw error(400, `${label} is required`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw error(400, `${label} is required`);
	}
	return trimmed.slice(0, maxLength);
}

function cleanRequiredInt(value: unknown, label: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, `${label} is invalid`);
	}
	return parsed;
}

function cleanOptionalSortOrder(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, 'Sort order must be a positive whole number');
	}
	return parsed;
}

function cleanDateOnly(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw error(400, `${label} is required`);
	}
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		throw error(400, `${label} must be in YYYY-MM-DD format`);
	}
	const parsed = new Date(`${trimmed}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, `${label} is invalid`);
	}
	return trimmed;
}

function toDateOnly(value: Date | string | null): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') return value.slice(0, 10);
	return null;
}

function minusOneDay(dateOnly: string): string {
	const utcDate = new Date(`${dateOnly}T00:00:00Z`);
	return toDateOnly(new Date(utcDate.getTime() - 24 * 60 * 60 * 1000)) ?? dateOnly;
}

function cleanAsOfDate(value: string | null): string | null {
	if (!value) return null;
	return cleanDateOnly(value, 'asOf');
}

async function getShiftEmailContext(params: {
	pool: sql.ConnectionPool;
	scheduleId: number;
	targetUserOid: string;
	actorUserOid: string;
}): Promise<ShiftEmailContext | null> {
	const result = await params.pool
		.request()
		.input('scheduleId', params.scheduleId)
		.input('targetUserOid', params.targetUserOid)
		.input('actorUserOid', params.actorUserOid)
		.query(
			`SELECT TOP (1)
				s.Name AS ScheduleName,
				s.ThemeJson AS ScheduleThemeJson,
				COALESCE(NULLIF(tu.DisplayName, ''), NULLIF(tu.FullName, ''), @targetUserOid) AS TargetDisplayName,
				COALESCE(NULLIF(au.DisplayName, ''), NULLIF(au.FullName, ''), @actorUserOid) AS ActorDisplayName
			 FROM dbo.Schedules s
			 LEFT JOIN dbo.Users tu
				ON tu.UserOid = @targetUserOid
			   AND tu.DeletedAt IS NULL
			 LEFT JOIN dbo.Users au
				ON au.UserOid = @actorUserOid
			   AND au.DeletedAt IS NULL
			 WHERE s.ScheduleId = @scheduleId
			   AND s.DeletedAt IS NULL;`
		);
	const row = result.recordset?.[0];
	if (!row) return null;
	return {
		scheduleName: String(row.ScheduleName ?? ''),
		scheduleThemeJson: (row.ScheduleThemeJson as string | null) ?? null,
		targetDisplayName: String(row.TargetDisplayName ?? params.targetUserOid),
		actorDisplayName: String(row.ActorDisplayName ?? params.actorUserOid)
	};
}

async function getEffectiveShiftNameForDate(
	request: sql.Request,
	scheduleId: number,
	userOid: string,
	date: string
): Promise<string> {
	const result = await request
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.input('date', date)
		.query(
			`SELECT TOP (1)
				COALESCE(NULLIF(et.Name, ''), 'Unknown shift') AS ShiftName
			 FROM dbo.ScheduleUserTypes sut
			 LEFT JOIN dbo.EmployeeTypes et
				ON et.ScheduleId = sut.ScheduleId
			   AND et.EmployeeTypeId = sut.EmployeeTypeId
			   AND et.IsActive = 1
			   AND et.DeletedAt IS NULL
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.UserOid = @userOid
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL
			   AND sut.StartDate <= @date
			   AND (sut.EndDate IS NULL OR sut.EndDate >= @date)
			 ORDER BY sut.StartDate DESC;`
		);
	return String(result.recordset?.[0]?.ShiftName ?? 'Unassigned');
}

async function getActorContext(localsUserOid: string, cookies: Cookies) {
	const scheduleId = await getActiveScheduleId(cookies);
	if (!scheduleId) {
		throw error(400, 'No active schedule selected');
	}

	const pool = await GetPool();
	const accessResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('userOid', localsUserOid)
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

	const role = accessResult.recordset?.[0]?.RoleName as ScheduleRole | undefined;
	if (role !== 'Manager' && role !== 'Maintainer') {
		throw error(403, 'Insufficient permissions');
	}

	return { pool, scheduleId, actorOid: localsUserOid };
}

async function normalizeAssignmentOrder(tx: sql.Transaction, scheduleId: number) {
	await new sql.Request(tx).input('scheduleId', scheduleId).query(
		`WITH Ordered AS (
				SELECT
					ScheduleId,
					EmployeeTypeId,
					UserOid,
					StartDate,
					ROW_NUMBER() OVER (
						PARTITION BY ScheduleId, EmployeeTypeId
						ORDER BY DisplayOrder ASC, UserOid ASC, EmployeeTypeId ASC, StartDate ASC
					) AS NextDisplayOrder
				FROM dbo.ScheduleUserTypes
				WHERE ScheduleId = @scheduleId
				  AND IsActive = 1
				  AND DeletedAt IS NULL
			)
			UPDATE sut
			   SET DisplayOrder = o.NextDisplayOrder
			FROM dbo.ScheduleUserTypes sut
			INNER JOIN Ordered o
			  ON o.ScheduleId = sut.ScheduleId
			 AND o.EmployeeTypeId = sut.EmployeeTypeId
			 AND o.UserOid = sut.UserOid
			 AND o.StartDate = sut.StartDate
			WHERE sut.ScheduleId = @scheduleId
			  AND sut.IsActive = 1
			  AND sut.DeletedAt IS NULL
			  AND sut.DisplayOrder <> o.NextDisplayOrder;`
	);
}

async function ensureAssignmentReferencesValid(
	tx: sql.Transaction,
	scheduleId: number,
	userOid: string,
	employeeTypeId: number
) {
	const userResult = await new sql.Request(tx)
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.query(
			`SELECT TOP (1) 1 AS HasUser
			 FROM dbo.ScheduleUsers
			 WHERE ScheduleId = @scheduleId
			   AND UserOid = @userOid
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
	if (!userResult.recordset?.[0]?.HasUser) {
		throw error(400, 'Selected user does not have access to this schedule');
	}

	const shiftResult = await new sql.Request(tx)
		.input('scheduleId', scheduleId)
		.input('employeeTypeId', employeeTypeId)
		.query(
			`SELECT TOP (1) 1 AS HasShift
			 FROM dbo.EmployeeTypes
			 WHERE ScheduleId = @scheduleId
			   AND EmployeeTypeId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
	if (!shiftResult.recordset?.[0]?.HasShift) {
		throw error(400, 'Selected shift does not exist');
	}
}

async function applyEffectiveAssignmentChange(params: {
	tx: sql.Transaction;
	scheduleId: number;
	actorOid: string;
	userOid: string;
	employeeTypeId: number;
	startDate: string;
	sortOrder: number;
}) {
	const { tx, scheduleId, actorOid, userOid, employeeTypeId, startDate, sortOrder } = params;

	const timelineResult = await new sql.Request(tx)
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.input('effectiveStartDate', startDate)
		.query(
			`SELECT
				(SELECT TOP (1) StartDate
				 FROM dbo.ScheduleUserTypes
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate > @effectiveStartDate
				 ORDER BY StartDate ASC) AS NextStartDate,
				(SELECT TOP (1) StartDate
				 FROM dbo.ScheduleUserTypes
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate = @effectiveStartDate
				 ORDER BY EmployeeTypeId ASC) AS ExactStartDate,
				(SELECT TOP (1) StartDate
				 FROM dbo.ScheduleUserTypes
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate < @effectiveStartDate
				   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
				 ORDER BY StartDate DESC, EmployeeTypeId ASC) AS ContainingStartDate;`
		);

	const nextStartDate = toDateOnly(timelineResult.recordset?.[0]?.NextStartDate);
	const exactStartDate = toDateOnly(timelineResult.recordset?.[0]?.ExactStartDate);
	const containingStartDate = toDateOnly(timelineResult.recordset?.[0]?.ContainingStartDate);
	const targetEndDate = nextStartDate
		? toDateOnly(new Date(new Date(`${nextStartDate}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000))
		: null;

	if (containingStartDate) {
		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('containingStartDate', containingStartDate)
			.input('effectiveStartDate', startDate)
			.input('actorOid', actorOid)
			.query(
				`UPDATE dbo.ScheduleUserTypes
				 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
					 EndedAt = SYSUTCDATETIME(),
					 EndedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND StartDate = @containingStartDate
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
	}

	if (exactStartDate) {
		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('effectiveStartDate', startDate)
			.input('employeeTypeId', employeeTypeId)
			.input('sortOrder', sortOrder)
			.input('targetEndDate', targetEndDate)
			.input('actorOid', actorOid)
			.query(
				`UPDATE dbo.ScheduleUserTypes
				 SET EmployeeTypeId = @employeeTypeId,
					 DisplayOrder = @sortOrder,
					 EndDate = @targetEndDate,
					 EndedAt = CASE WHEN @targetEndDate IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
					 EndedBy = CASE WHEN @targetEndDate IS NULL THEN NULL ELSE @actorOid END
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND StartDate = @effectiveStartDate
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		return;
	}

	await new sql.Request(tx)
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.input('employeeTypeId', employeeTypeId)
		.input('effectiveStartDate', startDate)
		.input('targetEndDate', targetEndDate)
		.input('sortOrder', sortOrder)
		.input('actorOid', actorOid)
		.query(
			`INSERT INTO dbo.ScheduleUserTypes (
				ScheduleId,
				UserOid,
				EmployeeTypeId,
				StartDate,
				EndDate,
				DisplayOrder,
				CreatedBy
			)
			VALUES (
				@scheduleId,
				@userOid,
				@employeeTypeId,
				@effectiveStartDate,
				@targetEndDate,
				@sortOrder,
				@actorOid
			);`
		);
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const asOf = cleanAsOfDate(url.searchParams.get('asOf'));
	const asOfDate = asOf ?? new Date().toISOString().slice(0, 10);

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('asOfDate', asOfDate)
		.query(
			`SELECT
				sut.DisplayOrder,
				sut.UserOid,
				sut.EmployeeTypeId,
				sut.StartDate,
				sut.EndDate,
				COALESCE(NULLIF(u.DisplayName, ''), NULLIF(u.FullName, ''), sut.UserOid) AS UserName,
				et.Name AS ShiftName
			 FROM dbo.ScheduleUserTypes sut
			 LEFT JOIN dbo.Users u
				ON u.UserOid = sut.UserOid
			   AND u.DeletedAt IS NULL
			 LEFT JOIN dbo.EmployeeTypes et
				ON et.ScheduleId = sut.ScheduleId
			   AND et.EmployeeTypeId = sut.EmployeeTypeId
			   AND et.IsActive = 1
			   AND et.DeletedAt IS NULL
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL
			   AND sut.StartDate <= @asOfDate
			   AND (sut.EndDate IS NULL OR sut.EndDate >= @asOfDate)
			 ORDER BY sut.DisplayOrder ASC, sut.UserOid ASC, sut.EmployeeTypeId ASC, sut.StartDate ASC;`
		);

	const assignments = (result.recordset as AssignmentRow[]).map((row) => {
		const startDate = toDateOnly(row.StartDate) ?? '';
		const assignmentId = `${row.UserOid}|${row.EmployeeTypeId}|${startDate}`;
		return {
			assignmentId,
			sortOrder: Number(row.DisplayOrder),
			userOid: row.UserOid,
			shiftEmployeeTypeId: Number(row.EmployeeTypeId),
			startDate,
			endDate: toDateOnly(row.EndDate),
			userName: row.UserName?.trim() || row.UserOid,
			shiftName: row.ShiftName?.trim() || 'Unknown shift'
		};
	});

	const historyResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			`SELECT
			sut.DisplayOrder,
			sut.UserOid,
			sut.EmployeeTypeId,
			sut.StartDate,
			sut.EndDate,
			COALESCE(NULLIF(u.DisplayName, ''), NULLIF(u.FullName, ''), sut.UserOid) AS UserName,
			et.Name AS ShiftName
		 FROM dbo.ScheduleUserTypes sut
		 LEFT JOIN dbo.Users u
			ON u.UserOid = sut.UserOid
		   AND u.DeletedAt IS NULL
		 LEFT JOIN dbo.EmployeeTypes et
			ON et.ScheduleId = sut.ScheduleId
		   AND et.EmployeeTypeId = sut.EmployeeTypeId
		   AND et.IsActive = 1
		   AND et.DeletedAt IS NULL
		 WHERE sut.ScheduleId = @scheduleId
		   AND sut.IsActive = 1
		   AND sut.DeletedAt IS NULL
		 ORDER BY sut.UserOid ASC, sut.StartDate ASC;`
		);
	const historyByUser = new Map<
		string,
		Array<{
			assignmentId: string;
			sortOrder: number;
			userOid: string;
			shiftEmployeeTypeId: number;
			startDate: string;
			endDate: string | null;
			userName: string;
			shiftName: string;
		}>
	>();
	for (const row of historyResult.recordset as AssignmentRow[]) {
		const startDate = toDateOnly(row.StartDate) ?? '';
		const assignmentId = `${row.UserOid}|${row.EmployeeTypeId}|${startDate}`;
		const existing = historyByUser.get(row.UserOid) ?? [];
		existing.push({
			assignmentId,
			sortOrder: Number(row.DisplayOrder),
			userOid: row.UserOid,
			shiftEmployeeTypeId: Number(row.EmployeeTypeId),
			startDate,
			endDate: toDateOnly(row.EndDate),
			userName: row.UserName?.trim() || row.UserOid,
			shiftName: row.ShiftName?.trim() || 'Unknown shift'
		});
		historyByUser.set(row.UserOid, existing);
	}

	const assignmentsWithHistory = assignments.map((assignment) => ({
		...assignment,
		changes: historyByUser.get(assignment.userOid) ?? [
			{
				assignmentId: assignment.assignmentId,
				sortOrder: assignment.sortOrder,
				userOid: assignment.userOid,
				shiftEmployeeTypeId: assignment.shiftEmployeeTypeId,
				startDate: assignment.startDate,
				endDate: assignment.endDate ?? null,
				userName: assignment.userName,
				shiftName: assignment.shiftName
			}
		]
	}));

	return json({ assignments: assignmentsWithHistory });
};

async function upsertAssignment({
	locals,
	cookies,
	request
}: {
	locals: { user?: { id: string } | null };
	cookies: Cookies;
	request: Request;
}) {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const mode =
		typeof body?.editMode === 'string' && body.editMode.trim().toLowerCase() === 'history'
			? 'history'
			: 'create_or_effective';

	const userOid = cleanRequiredText(body?.userOid, 64, 'User');
	const employeeTypeId = cleanRequiredInt(body?.shiftEmployeeTypeId, 'Shift');
	const startDate = cleanDateOnly(body?.startDate, 'Effective start date');
	const historyStartDate =
		mode === 'history'
			? cleanDateOnly(
					body?.changeStartDate ?? body?.historyStartDate ?? body?.startDate,
					'Change start date'
				)
			: null;
	const requestedSortOrder = cleanOptionalSortOrder(body?.sortOrder ?? body?.displayOrder);

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		await ensureAssignmentReferencesValid(tx, scheduleId, userOid, employeeTypeId);
		await normalizeAssignmentOrder(tx, scheduleId);
		const previousShift = await getEffectiveShiftNameForDate(
			new sql.Request(tx),
			scheduleId,
			userOid,
			startDate
		);

		if (mode === 'history') {
			if (!historyStartDate) {
				throw error(400, 'Change start date is required for history edits');
			}

			const existingRowResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('historyStartDate', historyStartDate)
				.query(
					`SELECT TOP (1) EmployeeTypeId, DisplayOrder
						 FROM dbo.ScheduleUserTypes
						 WHERE ScheduleId = @scheduleId
						   AND UserOid = @userOid
						   AND StartDate = @historyStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
				);
			const existingRow = existingRowResult.recordset?.[0];
			if (!existingRow) {
				throw error(404, 'Assignment change entry not found');
			}

			const currentEmployeeTypeId = Number(existingRow.EmployeeTypeId ?? 0);
			const currentSortOrder = Number(existingRow.DisplayOrder ?? 0);
			if (!currentEmployeeTypeId || !currentSortOrder) {
				throw error(404, 'Assignment change entry not found');
			}

			const timelineContext = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('historyStartDate', historyStartDate)
				.input('targetStartDate', startDate)
				.query(
					`SELECT
						(SELECT TOP (1) StartDate
						 FROM dbo.ScheduleUserTypes
						 WHERE ScheduleId = @scheduleId
						   AND UserOid = @userOid
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @historyStartDate
						 ORDER BY StartDate DESC) AS PreviousStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.ScheduleUserTypes
						 WHERE ScheduleId = @scheduleId
						   AND UserOid = @userOid
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate > @historyStartDate
						 ORDER BY StartDate ASC) AS NextStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.ScheduleUserTypes
						 WHERE ScheduleId = @scheduleId
						   AND UserOid = @userOid
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate = @targetStartDate
						   AND StartDate <> @historyStartDate) AS ConflictingStartDate;`
				);
			const previousStartDate = toDateOnly(
				timelineContext.recordset?.[0]?.PreviousStartDate ?? null
			);
			const nextStartDate = toDateOnly(timelineContext.recordset?.[0]?.NextStartDate ?? null);
			const conflictingStartDate = toDateOnly(
				timelineContext.recordset?.[0]?.ConflictingStartDate ?? null
			);

			if (conflictingStartDate) {
				throw error(400, 'An assignment change already exists with that effective start date');
			}
			if (previousStartDate && startDate <= previousStartDate) {
				throw error(400, 'Change effective date must be after the previous assignment change');
			}
			if (nextStartDate && startDate >= nextStartDate) {
				throw error(400, 'Change effective date must be before the next assignment change');
			}

			const previousEndDate = previousStartDate ? minusOneDay(startDate) : null;
			const currentEndDate = nextStartDate ? minusOneDay(nextStartDate) : null;

			const targetCountResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('userOid', userOid)
				.input('historyStartDate', historyStartDate)
				.query(
					`SELECT COUNT(*) AS AssignmentCount
						 FROM dbo.ScheduleUserTypes
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND NOT (UserOid = @userOid AND StartDate = @historyStartDate);`
				);
			const targetCount = Number(targetCountResult.recordset?.[0]?.AssignmentCount ?? 0);
			const maxSortOrder = Math.max(targetCount + 1, 1);
			const targetSortOrder = requestedSortOrder ?? currentSortOrder;
			if (targetSortOrder < 1 || targetSortOrder > maxSortOrder) {
				throw error(400, `Sort order must be between 1 and ${maxSortOrder}`);
			}

			if (employeeTypeId === currentEmployeeTypeId) {
				if (targetSortOrder < currentSortOrder) {
					await new sql.Request(tx)
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', employeeTypeId)
						.input('userOid', userOid)
						.input('historyStartDate', historyStartDate)
						.input('targetSortOrder', targetSortOrder)
						.input('currentSortOrder', currentSortOrder)
						.query(
							`UPDATE dbo.ScheduleUserTypes
								 SET DisplayOrder = DisplayOrder + 1
								 WHERE ScheduleId = @scheduleId
								   AND EmployeeTypeId = @employeeTypeId
								   AND IsActive = 1
								   AND DeletedAt IS NULL
								   AND DisplayOrder >= @targetSortOrder
								   AND DisplayOrder < @currentSortOrder
								   AND NOT (UserOid = @userOid AND StartDate = @historyStartDate);`
						);
				} else if (targetSortOrder > currentSortOrder) {
					await new sql.Request(tx)
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', employeeTypeId)
						.input('userOid', userOid)
						.input('historyStartDate', historyStartDate)
						.input('targetSortOrder', targetSortOrder)
						.input('currentSortOrder', currentSortOrder)
						.query(
							`UPDATE dbo.ScheduleUserTypes
								 SET DisplayOrder = DisplayOrder - 1
								 WHERE ScheduleId = @scheduleId
								   AND EmployeeTypeId = @employeeTypeId
								   AND IsActive = 1
								   AND DeletedAt IS NULL
								   AND DisplayOrder > @currentSortOrder
								   AND DisplayOrder <= @targetSortOrder
								   AND NOT (UserOid = @userOid AND StartDate = @historyStartDate);`
						);
				}
			} else {
				await new sql.Request(tx)
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', currentEmployeeTypeId)
					.input('currentSortOrder', currentSortOrder)
					.query(
						`UPDATE dbo.ScheduleUserTypes
							 SET DisplayOrder = DisplayOrder - 1
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND DisplayOrder > @currentSortOrder;`
					);

				await new sql.Request(tx)
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('targetSortOrder', targetSortOrder)
					.query(
						`UPDATE dbo.ScheduleUserTypes
							 SET DisplayOrder = DisplayOrder + 1
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND DisplayOrder >= @targetSortOrder;`
					);
			}

				const updatePreviousWindow = async () => {
					if (!previousStartDate) return;
					await new sql.Request(tx)
						.input('scheduleId', scheduleId)
						.input('userOid', userOid)
						.input('previousStartDate', previousStartDate)
						.input('previousEndDate', previousEndDate)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.ScheduleUserTypes
							 SET EndDate = @previousEndDate,
								 EndedAt = CASE WHEN @previousEndDate IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
								 EndedBy = CASE WHEN @previousEndDate IS NULL THEN NULL ELSE @actorOid END
							 WHERE ScheduleId = @scheduleId
							   AND UserOid = @userOid
							   AND StartDate = @previousStartDate
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
						);
				};

				const updateCurrentWindow = async () => {
					await new sql.Request(tx)
						.input('scheduleId', scheduleId)
						.input('userOid', userOid)
						.input('historyStartDate', historyStartDate)
						.input('targetStartDate', startDate)
						.input('employeeTypeId', employeeTypeId)
						.input('sortOrder', targetSortOrder)
						.input('currentEndDate', currentEndDate)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.ScheduleUserTypes
								 SET StartDate = @targetStartDate,
									 EndDate = @currentEndDate,
									 EmployeeTypeId = @employeeTypeId,
									 DisplayOrder = @sortOrder,
									 EndedAt = CASE WHEN @currentEndDate IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
									 EndedBy = CASE WHEN @currentEndDate IS NULL THEN NULL ELSE @actorOid END
								 WHERE ScheduleId = @scheduleId
								   AND UserOid = @userOid
								   AND StartDate = @historyStartDate
								   AND IsActive = 1
								   AND DeletedAt IS NULL;`
						);
				};

				if (startDate > historyStartDate) {
					await updateCurrentWindow();
					await updatePreviousWindow();
				} else {
					await updatePreviousWindow();
					await updateCurrentWindow();
				}
			const newShift = await getEffectiveShiftNameForDate(
				new sql.Request(tx),
				scheduleId,
				userOid,
				startDate
			);
			await tx.commit();
			const emailContext = await getShiftEmailContext({
				pool,
				scheduleId,
				targetUserOid: userOid,
				actorUserOid: actorOid
			});
			if (emailContext) {
				try {
					await sendShiftChangeNotification({
						scheduleName: emailContext.scheduleName,
						themeJson: emailContext.scheduleThemeJson,
						targetMemberName: emailContext.targetDisplayName,
						date: startDate,
						previousShift,
						newShift,
						triggeringUserName: emailContext.actorDisplayName
					});
				} catch (notificationError) {
					console.error('Shift change notification failed:', notificationError);
				}
			}
			return json({ success: true });
		}

		const countResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`SELECT COUNT(*) AS AssignmentCount
			 FROM dbo.ScheduleUserTypes
			 WHERE ScheduleId = @scheduleId
			   AND EmployeeTypeId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
			);
		const assignmentCount = Number(countResult.recordset?.[0]?.AssignmentCount ?? 0);
		const maxSortOrder = assignmentCount + 1;
		const targetSortOrder = requestedSortOrder ?? maxSortOrder;
		if (targetSortOrder < 1 || targetSortOrder > maxSortOrder) {
			throw error(400, `Sort order must be between 1 and ${maxSortOrder}`);
		}

		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('targetSortOrder', targetSortOrder)
			.query(
				`UPDATE dbo.ScheduleUserTypes
				 SET DisplayOrder = DisplayOrder + 1
				 WHERE ScheduleId = @scheduleId
				   AND EmployeeTypeId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND DisplayOrder >= @targetSortOrder;`
			);

		await applyEffectiveAssignmentChange({
			tx,
			scheduleId,
			actorOid,
			userOid,
			employeeTypeId,
			startDate,
			sortOrder: targetSortOrder
		});

		const newShift = await getEffectiveShiftNameForDate(
			new sql.Request(tx),
			scheduleId,
			userOid,
			startDate
		);
		await tx.commit();
		const emailContext = await getShiftEmailContext({
			pool,
			scheduleId,
			targetUserOid: userOid,
			actorUserOid: actorOid
		});
		if (emailContext) {
			try {
				await sendShiftChangeNotification({
					scheduleName: emailContext.scheduleName,
					themeJson: emailContext.scheduleThemeJson,
					targetMemberName: emailContext.targetDisplayName,
					date: startDate,
					previousShift,
					newShift,
					triggeringUserName: emailContext.actorDisplayName
				});
			} catch (notificationError) {
				console.error('Shift change notification failed:', notificationError);
			}
		}
	} catch (e) {
		try {
			await tx.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw e;
	}

	return json({ success: true });
}

export const POST: RequestHandler = async ({ locals, cookies, request }) =>
	upsertAssignment({ locals, cookies, request });

export const PATCH: RequestHandler = async ({ locals, cookies, request }) =>
	upsertAssignment({ locals, cookies, request });

type RemoveAssignmentPayload = {
	userOid?: unknown;
	editMode?: unknown;
	changeStartDate?: unknown;
};

export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = (await request.json().catch(() => null)) as RemoveAssignmentPayload | null;
	const userOid = cleanRequiredText(body?.userOid, 64, 'User');
	const editMode =
		typeof body?.editMode === 'string' && body.editMode.trim().toLowerCase() === 'history'
			? 'history'
			: 'timeline';
	const changeStartDate =
		editMode === 'history' && typeof body?.changeStartDate === 'string'
			? cleanDateOnly(body.changeStartDate, 'Change start date')
			: null;

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		if (editMode === 'history') {
			if (!changeStartDate) {
				throw error(400, 'Change start date is required for history edits');
			}

			const rowResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('changeStartDate', changeStartDate)
				.query(
					`SELECT TOP (1) EmployeeTypeId
					 FROM dbo.ScheduleUserTypes
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @userOid
					   AND StartDate = @changeStartDate
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);
			const currentEmployeeTypeId = Number(rowResult.recordset?.[0]?.EmployeeTypeId ?? 0);
			if (!currentEmployeeTypeId) {
				throw error(404, 'Assignment change entry not found');
			}

			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('changeStartDate', changeStartDate)
				.query(
					`DELETE FROM dbo.ScheduleUserTypes
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @userOid
					   AND StartDate = @changeStartDate
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);

			await normalizeAssignmentOrder(tx, scheduleId);
			await tx.commit();
			return json({ success: true, removalMode: 'history_removed' });
		}

		const serverDateResult = await new sql.Request(tx).query(
			`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`
		);
		const today = toDateOnly(serverDateResult.recordset?.[0]?.Today) ?? '';
		if (!today) {
			throw error(500, 'Could not resolve current server date');
		}

		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('today', today)
			.input('actorOid', actorOid)
			.query(
				`UPDATE dbo.ScheduleUserTypes
				 SET EndDate = CASE
					 WHEN EndDate IS NULL OR EndDate > @today THEN @today
					 ELSE EndDate
				 END,
				 EndedAt = SYSUTCDATETIME(),
				 EndedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate <= @today
				   AND (EndDate IS NULL OR EndDate >= @today);

				 UPDATE dbo.ScheduleUserTypes
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate > @today;`
			);

		await normalizeAssignmentOrder(tx, scheduleId);
		await tx.commit();
		return json({ success: true, removalMode: 'timeline_removed' });
	} catch (e) {
		try {
			await tx.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw e;
	}
};
