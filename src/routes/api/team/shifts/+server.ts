import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';
import sql from 'mssql';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

type ShiftRow = {
	EmployeeTypeId: number;
	DisplayOrder: number;
	Name: string;
	PatternId: number | null;
	PatternName: string | null;
	StartDate: Date | string;
	EndDate?: Date | string | null;
};

async function employeeTypesHasStartDate(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<boolean> {
	const columnResult = await pool.request().query(
		`SELECT TOP (1) 1 AS HasStartDate
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'EmployeeTypes'
		   AND COLUMN_NAME = 'StartDate';`
	);
	return Number(columnResult.recordset?.[0]?.HasStartDate ?? 0) === 1;
}

async function employeeTypeVersionsEnabled(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<boolean> {
	const result = await pool.request().query(
		`SELECT TOP (1) 1 AS HasTable
		 FROM INFORMATION_SCHEMA.TABLES
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'EmployeeTypeVersions';`
	);
	return Number(result.recordset?.[0]?.HasTable ?? 0) === 1;
}

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

function cleanOptionalPatternId(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const patternId = Number(value);
	if (!Number.isInteger(patternId) || patternId <= 0) {
		throw error(400, 'Pattern is invalid');
	}
	return patternId;
}

function cleanStartDate(value: unknown): string {
	if (typeof value !== 'string') {
		throw error(400, 'Start date is required');
	}
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		throw error(400, 'Start date must be in YYYY-MM-DD format');
	}
	const parsed = new Date(`${trimmed}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, 'Start date is invalid');
	}
	return trimmed;
}

function cleanSortOrder(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, 'Sort order must be a positive whole number');
	}
	return parsed;
}

function cleanEmployeeTypeIdList(value: unknown): number[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw error(400, 'orderedEmployeeTypeIds is required');
	}
	const parsed = value.map((entry) => Number(entry));
	if (parsed.some((entry) => !Number.isInteger(entry) || entry <= 0)) {
		throw error(400, 'orderedEmployeeTypeIds must contain valid shift IDs');
	}
	const unique = new Set(parsed);
	if (unique.size !== parsed.length) {
		throw error(400, 'orderedEmployeeTypeIds contains duplicates');
	}
	return parsed;
}

function cleanAsOfDate(value: string | null): string | null {
	if (!value) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw error(400, 'asOf must be in YYYY-MM-DD format');
	}
	const parsed = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, 'asOf is invalid');
	}
	return value;
}

function cleanBoolean(value: unknown): boolean {
	return value === true;
}

function toDateOnly(value: Date | string): string {
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}
	if (typeof value === 'string') {
		return value.slice(0, 10);
	}
	return '';
}

function minusOneDay(dateOnly: string): string {
	const utcDate = new Date(`${dateOnly}T00:00:00Z`);
	return toDateOnly(new Date(utcDate.getTime() - 24 * 60 * 60 * 1000));
}

function monthEndForDate(dateOnly: string): string {
	const parsed = new Date(`${dateOnly}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, 'Start date is invalid');
	}
	const year = parsed.getUTCFullYear();
	const month = parsed.getUTCMonth();
	return toDateOnly(new Date(Date.UTC(year, month + 1, 0)));
}

function monthStartForDate(dateOnly: string): string {
	const parsed = new Date(`${dateOnly}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, 'Start date is invalid');
	}
	const year = parsed.getUTCFullYear();
	const month = parsed.getUTCMonth();
	return toDateOnly(new Date(Date.UTC(year, month, 1)));
}

async function assertNoShiftNameConflictForMonth(params: {
	request: sql.Request;
	scheduleId: number;
	name: string;
	monthStart: string;
	monthEnd: string;
	excludeEmployeeTypeId?: number | null;
	message?: string;
}) {
	const {
		request,
		scheduleId,
		name,
		monthStart,
		monthEnd,
		excludeEmployeeTypeId = null,
		message = 'A shift with this name is already active in the selected month'
	} = params;
	const duplicateResult = await request
		.input('scheduleId', scheduleId)
		.input('name', name)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.input('excludeEmployeeTypeId', excludeEmployeeTypeId)
		.query(
			`SELECT TOP (1) etv.EmployeeTypeId
			 FROM dbo.EmployeeTypeVersions etv
			 INNER JOIN dbo.EmployeeTypes et
			   ON et.EmployeeTypeId = etv.EmployeeTypeId
			  AND et.ScheduleId = etv.ScheduleId
			  AND et.IsActive = 1
			  AND et.DeletedAt IS NULL
			 WHERE etv.ScheduleId = @scheduleId
			   AND etv.IsActive = 1
			   AND etv.DeletedAt IS NULL
			   AND UPPER(LTRIM(RTRIM(etv.Name))) = UPPER(LTRIM(RTRIM(@name)))
			   AND etv.StartDate <= @monthEnd
			   AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
			   AND (@excludeEmployeeTypeId IS NULL OR etv.EmployeeTypeId <> @excludeEmployeeTypeId);`
		);
	if (duplicateResult.recordset?.[0]?.EmployeeTypeId) {
		throw error(409, message);
	}
}

async function assertNoShiftNameConflictFromDate(params: {
	request: sql.Request;
	scheduleId: number;
	name: string;
	startDate: string;
	excludeEmployeeTypeId?: number | null;
	message?: string;
}) {
	const {
		request,
		scheduleId,
		name,
		startDate,
		excludeEmployeeTypeId = null,
		message = 'A shift with this name already exists in an overlapping effective window'
	} = params;
	const duplicateResult = await request
		.input('scheduleId', scheduleId)
		.input('name', name)
		.input('startDate', startDate)
		.input('excludeEmployeeTypeId', excludeEmployeeTypeId)
		.query(
			`SELECT TOP (1) etv.EmployeeTypeId
			 FROM dbo.EmployeeTypeVersions etv
			 INNER JOIN dbo.EmployeeTypes et
			   ON et.EmployeeTypeId = etv.EmployeeTypeId
			  AND et.ScheduleId = etv.ScheduleId
			  AND et.IsActive = 1
			  AND et.DeletedAt IS NULL
			 WHERE etv.ScheduleId = @scheduleId
			   AND etv.IsActive = 1
			   AND etv.DeletedAt IS NULL
			   AND UPPER(LTRIM(RTRIM(etv.Name))) = UPPER(LTRIM(RTRIM(@name)))
			   AND (etv.EndDate IS NULL OR etv.EndDate >= @startDate)
			   AND (@excludeEmployeeTypeId IS NULL OR etv.EmployeeTypeId <> @excludeEmployeeTypeId);`
		);
	if (duplicateResult.recordset?.[0]?.EmployeeTypeId) {
		throw error(409, message);
	}
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

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const hasStartDate = await employeeTypesHasStartDate(pool);
	const hasVersions = await employeeTypeVersionsEnabled(pool);
	const asOf = cleanAsOfDate(url.searchParams.get('asOf'));
	const asOfDate = asOf ?? new Date().toISOString().slice(0, 10);
	const startDateExpression = hasStartDate ? 'et.StartDate' : 'CAST(et.CreatedAt AS date)';

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('asOfDate', asOfDate)
		.query(
			hasVersions
				? `SELECT
					et.EmployeeTypeId,
					COALESCE(v.DisplayOrder, et.DisplayOrder) AS DisplayOrder,
					COALESCE(v.Name, et.Name) AS Name,
					COALESCE(v.PatternId, et.PatternId) AS PatternId,
					COALESCE(v.StartDate, ${startDateExpression}) AS StartDate,
					p.Name AS PatternName
				 FROM dbo.EmployeeTypes et
				 OUTER APPLY (
					SELECT TOP (1)
						etv.DisplayOrder,
						etv.Name,
						etv.PatternId,
						etv.StartDate
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = et.ScheduleId
					  AND etv.EmployeeTypeId = et.EmployeeTypeId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= @asOfDate
					  AND (etv.EndDate IS NULL OR etv.EndDate >= @asOfDate)
					ORDER BY etv.StartDate DESC
				 ) v
				 LEFT JOIN dbo.Patterns p
					ON p.PatternId = COALESCE(v.PatternId, et.PatternId)
				   AND p.ScheduleId = et.ScheduleId
				   AND p.IsActive = 1
				   AND p.DeletedAt IS NULL
				 WHERE et.ScheduleId = @scheduleId
				   AND et.IsActive = 1
				   AND et.DeletedAt IS NULL
				 ORDER BY et.DisplayOrder ASC, Name ASC, et.EmployeeTypeId ASC;`
				: `SELECT
					et.EmployeeTypeId,
					et.DisplayOrder,
					et.Name,
					et.PatternId,
					${startDateExpression} AS StartDate,
					p.Name AS PatternName
				 FROM dbo.EmployeeTypes et
				 LEFT JOIN dbo.Patterns p
					ON p.PatternId = et.PatternId
				   AND p.ScheduleId = et.ScheduleId
				   AND p.IsActive = 1
				   AND p.DeletedAt IS NULL
				 WHERE et.ScheduleId = @scheduleId
				   AND et.IsActive = 1
				   AND et.DeletedAt IS NULL
				 ORDER BY et.DisplayOrder ASC, et.Name ASC, et.EmployeeTypeId ASC;`
		);

	const shifts = (result.recordset as ShiftRow[]).map((row) => ({
		employeeTypeId: row.EmployeeTypeId,
		sortOrder: Number(row.DisplayOrder),
		name: row.Name,
		patternId: row.PatternId ?? null,
		pattern: row.PatternName?.trim() || '',
		startDate: toDateOnly(row.StartDate)
	}));

	let historyByShift = new Map<
		number,
		Array<{
			sortOrder?: number;
			startDate: string;
			endDate: string | null;
			name: string;
			patternId: number | null;
			pattern: string;
		}>
	>();
	if (hasVersions) {
		const historyResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.query(
				`SELECT
					etv.EmployeeTypeId,
					etv.DisplayOrder,
					etv.StartDate,
					etv.EndDate,
					etv.Name,
					etv.PatternId,
					p.Name AS PatternName
				 FROM dbo.EmployeeTypeVersions etv
				 LEFT JOIN dbo.Patterns p
					ON p.PatternId = etv.PatternId
				   AND p.ScheduleId = etv.ScheduleId
				   AND p.IsActive = 1
				   AND p.DeletedAt IS NULL
				 WHERE etv.ScheduleId = @scheduleId
				   AND etv.IsActive = 1
				   AND etv.DeletedAt IS NULL
				 ORDER BY etv.EmployeeTypeId ASC, etv.StartDate ASC;`
			);
		historyByShift = new Map();
		for (const row of historyResult.recordset as ShiftRow[]) {
			const employeeTypeId = Number(row.EmployeeTypeId);
			const existing = historyByShift.get(employeeTypeId) ?? [];
			existing.push({
				sortOrder: Number(row.DisplayOrder),
				startDate: toDateOnly(row.StartDate),
				endDate: row.EndDate ? toDateOnly(row.EndDate) : null,
				name: row.Name,
				patternId: row.PatternId ?? null,
				pattern: row.PatternName?.trim() || ''
			});
			historyByShift.set(employeeTypeId, existing);
		}
	}

	const shiftsWithHistory = shifts.map((shift) => ({
		...shift,
		changes: historyByShift.get(shift.employeeTypeId) ?? [
			{
				sortOrder: shift.sortOrder,
				startDate: shift.startDate,
				endDate: null,
				name: shift.name,
				patternId: shift.patternId,
				pattern: shift.pattern
			}
		]
	}));

	return json({ shifts: shiftsWithHistory });
};

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);

	const name = cleanRequiredText(body?.name, 50, 'Shift name');
	const patternId = cleanOptionalPatternId(body?.patternId);
	const startDate = cleanStartDate(body?.startDate);
	const requestedSortOrder = cleanSortOrder(body?.sortOrder ?? body?.displayOrder);
	const hasStartDate = await employeeTypesHasStartDate(pool);
	const hasVersions = await employeeTypeVersionsEnabled(pool);

	if (patternId !== null) {
		const patternResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('patternId', patternId)
			.query(
				`SELECT TOP (1) PatternId
				 FROM dbo.Patterns
				 WHERE ScheduleId = @scheduleId
				   AND PatternId = @patternId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		if (!patternResult.recordset?.[0]?.PatternId) {
			throw error(400, 'Selected pattern does not exist');
		}
	}

	if (hasVersions) {
		await assertNoShiftNameConflictFromDate({
			request: pool.request(),
			scheduleId,
			name,
			startDate,
			message: 'A shift with this name already exists in an overlapping effective window'
		});
	} else {
		const activeDuplicateResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('name', name)
			.query(
				`SELECT TOP (1) EmployeeTypeId
				 FROM dbo.EmployeeTypes
				 WHERE ScheduleId = @scheduleId
				   AND UPPER(LTRIM(RTRIM(Name))) = UPPER(LTRIM(RTRIM(@name)))
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		if (activeDuplicateResult.recordset?.[0]?.EmployeeTypeId) {
			throw error(409, 'A shift with this name already exists');
		}
	}
	const transaction = new sql.Transaction(pool);
	await transaction.begin();
	try {
		await transaction
			.request()
			.input('scheduleId', scheduleId)
			.query(
			`WITH Ordered AS (
				SELECT
					EmployeeTypeId,
					ROW_NUMBER() OVER (
						ORDER BY DisplayOrder ASC, Name ASC, EmployeeTypeId ASC
					) AS NextDisplayOrder
				FROM dbo.EmployeeTypes
				WHERE ScheduleId = @scheduleId
				  AND IsActive = 1
				  AND DeletedAt IS NULL
			)
			UPDATE et
			   SET DisplayOrder = o.NextDisplayOrder
			FROM dbo.EmployeeTypes et
			INNER JOIN Ordered o
			  ON o.EmployeeTypeId = et.EmployeeTypeId
			WHERE et.ScheduleId = @scheduleId
			  AND et.IsActive = 1
			  AND et.DeletedAt IS NULL
			  AND et.DisplayOrder <> o.NextDisplayOrder;`
			);

		const countResult = await transaction
			.request()
			.input('scheduleId', scheduleId)
			.query(
				`SELECT COUNT(*) AS ShiftCount
			 FROM dbo.EmployeeTypes
			 WHERE ScheduleId = @scheduleId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
			);
		const shiftCount = Number(countResult.recordset?.[0]?.ShiftCount ?? 0);
		const maxSortOrder = shiftCount + 1;
		const targetSortOrder = requestedSortOrder ?? maxSortOrder;
		if (targetSortOrder < 1 || targetSortOrder > maxSortOrder) {
			throw error(400, `Sort order must be between 1 and ${maxSortOrder}`);
		}

		await transaction
			.request()
			.input('scheduleId', scheduleId)
			.input('targetSortOrder', targetSortOrder)
			.query(
				`UPDATE dbo.EmployeeTypes
				 SET DisplayOrder = DisplayOrder + 1
				 WHERE ScheduleId = @scheduleId
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND DisplayOrder >= @targetSortOrder;`
			);

		const insertRequest = transaction
			.request()
			.input('scheduleId', scheduleId)
			.input('name', name)
			.input('displayOrder', targetSortOrder)
			.input('patternId', patternId)
			.input('actorOid', actorOid);

		if (hasStartDate) {
			insertRequest.input('startDate', startDate);
			await insertRequest.query(
				`INSERT INTO dbo.EmployeeTypes (
					ScheduleId,
					Name,
					StartDate,
					DisplayOrder,
					PatternId,
					CreatedBy
				)
				VALUES (
					@scheduleId,
					@name,
					@startDate,
					@displayOrder,
					@patternId,
					@actorOid
				);`
			);
		} else {
			await insertRequest.query(
				`INSERT INTO dbo.EmployeeTypes (
					ScheduleId,
					Name,
					DisplayOrder,
					PatternId,
					CreatedBy
				)
				VALUES (
					@scheduleId,
					@name,
					@displayOrder,
					@patternId,
					@actorOid
				);`
			);
		}

		const employeeResult = await transaction
			.request()
			.input('scheduleId', scheduleId)
			.input('name', name)
			.query(
				`SELECT TOP (1) EmployeeTypeId
				 FROM dbo.EmployeeTypes
				 WHERE ScheduleId = @scheduleId
				   AND UPPER(LTRIM(RTRIM(Name))) = UPPER(LTRIM(RTRIM(@name)))
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				 ORDER BY EmployeeTypeId DESC;`
			);
		const employeeTypeIdForVersion = Number(employeeResult.recordset?.[0]?.EmployeeTypeId ?? 0);
		if (!employeeTypeIdForVersion) {
			throw error(500, 'Failed to create shift');
		}

		if (hasVersions && employeeTypeIdForVersion > 0) {
			const timelineResult = await transaction
				.request()
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeIdForVersion)
				.input('effectiveStartDate', startDate)
				.query(
					`SELECT
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate > @effectiveStartDate
						 ORDER BY StartDate ASC) AS NextStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate = @effectiveStartDate) AS ExactStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @effectiveStartDate
						   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
						 ORDER BY StartDate DESC) AS ContainingStartDate;`
				);
			const nextStartDate = toDateOnly(timelineResult.recordset?.[0]?.NextStartDate ?? '');
			const exactStartDate = toDateOnly(timelineResult.recordset?.[0]?.ExactStartDate ?? '');
			const containingStartDate = toDateOnly(
				timelineResult.recordset?.[0]?.ContainingStartDate ?? ''
			);
			const targetEndDate = nextStartDate
				? toDateOnly(
						new Date(new Date(`${nextStartDate}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
					)
				: null;

			if (containingStartDate) {
				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeIdForVersion)
					.input('containingStartDate', containingStartDate)
					.input('effectiveStartDate', startDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.EmployeeTypeVersions
						 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
							 EndedAt = SYSUTCDATETIME(),
							 EndedBy = @actorOid,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorOid
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate = @containingStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
					);
			}

			if (exactStartDate) {
				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeIdForVersion)
					.input('effectiveStartDate', startDate)
					.input('name', name)
					.input('patternId', patternId)
					.input('targetEndDate', targetEndDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.EmployeeTypeVersions
						 SET Name = @name,
							 PatternId = @patternId,
							 EndDate = @targetEndDate,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorOid,
							 IsActive = 1,
							 DeletedAt = NULL,
							 DeletedBy = NULL
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate = @effectiveStartDate;`
					);
			} else {
				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeIdForVersion)
					.input('effectiveStartDate', startDate)
					.input('targetEndDate', targetEndDate)
					.input('name', name)
					.input('patternId', patternId)
					.input('actorOid', actorOid)
					.query(
						`INSERT INTO dbo.EmployeeTypeVersions (
							ScheduleId,
							EmployeeTypeId,
							StartDate,
							EndDate,
							Name,
							PatternId,
							CreatedBy
						)
						VALUES (
							@scheduleId,
							@employeeTypeId,
							@effectiveStartDate,
							@targetEndDate,
							@name,
							@patternId,
							@actorOid
						);`
					);
			}
		}
		await transaction.commit();
	} catch (err) {
		try {
			await transaction.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw err;
	}

	return json({ success: true }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const employeeTypeId = Number(body?.employeeTypeId);
	if (!Number.isInteger(employeeTypeId) || employeeTypeId <= 0) {
		throw error(400, 'Shift ID is required');
	}
	const reorderOnly = body?.reorderOnly === true;
	const requestedSortOrder = cleanSortOrder(body?.sortOrder ?? body?.displayOrder);
	if (reorderOnly) {
		const effectiveStartDate = cleanStartDate(body?.startDate);
		const effectiveMonthEnd = monthEndForDate(effectiveStartDate);
		const orderedEmployeeTypeIds = cleanEmployeeTypeIdList(body?.orderedEmployeeTypeIds);
		const hasVersions = await employeeTypeVersionsEnabled(pool);
		if (!hasVersions) {
			throw error(500, 'EmployeeTypeVersions table is required for month-based reorder');
		}

		const expectedCountResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('effectiveStartDate', effectiveStartDate)
			.input('effectiveMonthEnd', effectiveMonthEnd)
			.query(
				`SELECT COUNT(*) AS ExpectedCount
				 FROM dbo.EmployeeTypeVersions etv
				 INNER JOIN dbo.EmployeeTypes et
				   ON et.EmployeeTypeId = etv.EmployeeTypeId
				  AND et.ScheduleId = etv.ScheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				 WHERE etv.ScheduleId = @scheduleId
				   AND etv.IsActive = 1
				   AND etv.DeletedAt IS NULL
				   AND etv.StartDate <= @effectiveMonthEnd
				   AND (etv.EndDate IS NULL OR etv.EndDate >= @effectiveStartDate);`
			);
		const expectedCount = Number(expectedCountResult.recordset?.[0]?.ExpectedCount ?? 0);
		if (expectedCount !== orderedEmployeeTypeIds.length) {
			throw error(400, 'orderedEmployeeTypeIds must include all shifts active in the selected month');
		}

		const activeSetResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('effectiveStartDate', effectiveStartDate)
			.input('effectiveMonthEnd', effectiveMonthEnd)
			.query(
				`SELECT etv.EmployeeTypeId
				 FROM dbo.EmployeeTypeVersions etv
				 INNER JOIN dbo.EmployeeTypes et
				   ON et.EmployeeTypeId = etv.EmployeeTypeId
				  AND et.ScheduleId = etv.ScheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				 WHERE etv.ScheduleId = @scheduleId
				   AND etv.IsActive = 1
				   AND etv.DeletedAt IS NULL
				   AND etv.StartDate <= @effectiveMonthEnd
				   AND (etv.EndDate IS NULL OR etv.EndDate >= @effectiveStartDate);`
			);
		const activeIds = new Set(
			(activeSetResult.recordset as Array<{ EmployeeTypeId: number }>).map((row) =>
				Number(row.EmployeeTypeId)
			)
		);
		if (!orderedEmployeeTypeIds.every((id) => activeIds.has(id))) {
			throw error(400, 'orderedEmployeeTypeIds includes invalid shifts for the selected month');
		}

		const transaction = new sql.Transaction(pool);
		await transaction.begin();
		try {
			for (let index = 0; index < orderedEmployeeTypeIds.length; index += 1) {
				const orderedId = orderedEmployeeTypeIds[index];
				const targetSortOrder = index + 1;
				const context = await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', orderedId)
					.input('effectiveStartDate', effectiveStartDate)
					.input('effectiveMonthEnd', effectiveMonthEnd)
					.query(
						`SELECT
							(SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate = @effectiveStartDate) AS ExactStartDate,
							(SELECT TOP (1) Name
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate = @effectiveStartDate) AS ExactName,
							(SELECT TOP (1) PatternId
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate = @effectiveStartDate) AS ExactPatternId,
							(SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate < @effectiveStartDate
							   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
							 ORDER BY StartDate DESC) AS ContainingStartDate,
							(SELECT TOP (1) Name
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate < @effectiveStartDate
							   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
							 ORDER BY StartDate DESC) AS ContainingName,
							(SELECT TOP (1) PatternId
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate < @effectiveStartDate
							   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
							 ORDER BY StartDate DESC) AS ContainingPatternId,
							(SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate > @effectiveStartDate
							   AND StartDate <= @effectiveMonthEnd
							 ORDER BY StartDate ASC) AS NextStartDate,
							(SELECT TOP (1) et.Name
							 FROM dbo.EmployeeTypes et
							 WHERE et.ScheduleId = @scheduleId
							   AND et.EmployeeTypeId = @employeeTypeId
							   AND et.IsActive = 1
							   AND et.DeletedAt IS NULL) AS BaseName,
							(SELECT TOP (1) et.PatternId
							 FROM dbo.EmployeeTypes et
							 WHERE et.ScheduleId = @scheduleId
							   AND et.EmployeeTypeId = @employeeTypeId
							   AND et.IsActive = 1
							   AND et.DeletedAt IS NULL) AS BasePatternId;`
					);

				const exactStartDate = toDateOnly(context.recordset?.[0]?.ExactStartDate ?? '');
				const containingStartDate = toDateOnly(context.recordset?.[0]?.ContainingStartDate ?? '');
				const nextStartDate = toDateOnly(context.recordset?.[0]?.NextStartDate ?? '');
				const targetEndDate = nextStartDate ? minusOneDay(nextStartDate) : null;
				const resolvedName = cleanRequiredText(
					context.recordset?.[0]?.ExactName ??
						context.recordset?.[0]?.ContainingName ??
						context.recordset?.[0]?.BaseName,
					50,
					'Shift name'
				);
				const resolvedPatternId = cleanOptionalPatternId(
					context.recordset?.[0]?.ExactPatternId ??
						context.recordset?.[0]?.ContainingPatternId ??
						context.recordset?.[0]?.BasePatternId
				);

				if (!exactStartDate && containingStartDate) {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', orderedId)
						.input('containingStartDate', containingStartDate)
						.input('effectiveStartDate', effectiveStartDate)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.EmployeeTypeVersions
							 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
								 EndedAt = SYSUTCDATETIME(),
								 EndedBy = @actorOid,
								 UpdatedAt = SYSUTCDATETIME(),
								 UpdatedBy = @actorOid
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND StartDate = @containingStartDate
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
						);
				}

				if (exactStartDate) {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', orderedId)
						.input('effectiveStartDate', effectiveStartDate)
						.input('targetEndDate', targetEndDate)
						.input('displayOrder', targetSortOrder)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.EmployeeTypeVersions
							 SET DisplayOrder = @displayOrder,
								 EndDate = @targetEndDate,
								 UpdatedAt = SYSUTCDATETIME(),
								 UpdatedBy = @actorOid
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND StartDate = @effectiveStartDate
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
						);
				} else {
					if (!containingStartDate && nextStartDate) {
						await transaction
							.request()
							.input('scheduleId', scheduleId)
							.input('employeeTypeId', orderedId)
							.input('nextStartDate', nextStartDate)
							.input('displayOrder', targetSortOrder)
							.input('actorOid', actorOid)
							.query(
								`UPDATE dbo.EmployeeTypeVersions
								 SET DisplayOrder = @displayOrder,
									 UpdatedAt = SYSUTCDATETIME(),
									 UpdatedBy = @actorOid
								 WHERE ScheduleId = @scheduleId
								   AND EmployeeTypeId = @employeeTypeId
								   AND StartDate = @nextStartDate
								   AND IsActive = 1
								   AND DeletedAt IS NULL;`
							);
						continue;
					}
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', orderedId)
						.input('effectiveStartDate', effectiveStartDate)
						.input('targetEndDate', targetEndDate)
						.input('displayOrder', targetSortOrder)
						.input('name', resolvedName)
						.input('patternId', resolvedPatternId)
						.input('actorOid', actorOid)
						.query(
							`INSERT INTO dbo.EmployeeTypeVersions (
								ScheduleId,
								EmployeeTypeId,
								StartDate,
								EndDate,
								DisplayOrder,
								Name,
								PatternId,
								CreatedBy
							)
							VALUES (
								@scheduleId,
								@employeeTypeId,
								@effectiveStartDate,
								@targetEndDate,
								@displayOrder,
								@name,
								@patternId,
								@actorOid
							);`
						);
				}
			}

			await transaction.commit();
		} catch (err) {
			try {
				await transaction.rollback();
			} catch {
				// Preserve original SQL error when rollback fails due to aborted transaction.
			}
			throw err;
		}

		return json({ success: true });
	}

	const name = cleanRequiredText(body?.name, 50, 'Shift name');
	const patternId = cleanOptionalPatternId(body?.patternId);
	const startDate = cleanStartDate(body?.startDate);
	const editMode =
		typeof body?.editMode === 'string' ? body.editMode.trim().toLowerCase() : 'timeline';
	const changeStartDate =
		editMode === 'history' && typeof body?.changeStartDate === 'string'
			? cleanStartDate(body.changeStartDate)
			: null;

	const existsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('employeeTypeId', employeeTypeId)
		.query(
			`SELECT TOP (1) EmployeeTypeId
			 FROM dbo.EmployeeTypes
			 WHERE ScheduleId = @scheduleId
			   AND EmployeeTypeId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
	if (!existsResult.recordset?.[0]?.EmployeeTypeId) {
		throw error(404, 'Shift not found');
	}

	if (patternId !== null) {
		const patternResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('patternId', patternId)
			.query(
				`SELECT TOP (1) PatternId
				 FROM dbo.Patterns
				 WHERE ScheduleId = @scheduleId
				   AND PatternId = @patternId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		if (!patternResult.recordset?.[0]?.PatternId) {
			throw error(400, 'Selected pattern does not exist');
		}
	}

	const hasStartDate = await employeeTypesHasStartDate(pool);
	const hasVersions = await employeeTypeVersionsEnabled(pool);
	if (!hasVersions) {
		const duplicateResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('name', name)
			.query(
				`SELECT TOP (1) EmployeeTypeId
				 FROM dbo.EmployeeTypes
				 WHERE ScheduleId = @scheduleId
				   AND EmployeeTypeId <> @employeeTypeId
				   AND UPPER(LTRIM(RTRIM(Name))) = UPPER(LTRIM(RTRIM(@name)))
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		if (duplicateResult.recordset?.[0]?.EmployeeTypeId) {
			throw error(409, 'A shift with this name already exists');
		}
	}
	const transaction = new sql.Transaction(pool);
	await transaction.begin();
	try {
		await transaction
			.request()
			.input('scheduleId', scheduleId)
			.query(
				`WITH Ordered AS (
					SELECT
						EmployeeTypeId,
						ROW_NUMBER() OVER (
							ORDER BY DisplayOrder ASC, Name ASC, EmployeeTypeId ASC
						) AS NextDisplayOrder
					FROM dbo.EmployeeTypes
					WHERE ScheduleId = @scheduleId
					  AND IsActive = 1
					  AND DeletedAt IS NULL
				)
				UPDATE et
				   SET DisplayOrder = o.NextDisplayOrder
				FROM dbo.EmployeeTypes et
				INNER JOIN Ordered o
				  ON o.EmployeeTypeId = et.EmployeeTypeId
				WHERE et.ScheduleId = @scheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				  AND et.DisplayOrder <> o.NextDisplayOrder;`
			);

		const contextResult = await transaction
			.request()
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`SELECT
					(SELECT COUNT(*)
					 FROM dbo.EmployeeTypes
					 WHERE ScheduleId = @scheduleId
					   AND IsActive = 1
					   AND DeletedAt IS NULL) AS ShiftCount,
					(SELECT TOP (1) DisplayOrder
					 FROM dbo.EmployeeTypes
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId
					   AND IsActive = 1
					   AND DeletedAt IS NULL) AS CurrentSortOrder;`
			);
		const shiftCount = Number(contextResult.recordset?.[0]?.ShiftCount ?? 0);
		const currentSortOrder = Number(contextResult.recordset?.[0]?.CurrentSortOrder ?? 0);
		if (!currentSortOrder) {
			throw error(404, 'Shift not found');
		}
		const maxSortOrder = Math.max(shiftCount, 1);
		const targetSortOrder = requestedSortOrder ?? currentSortOrder;
		if (targetSortOrder < 1 || targetSortOrder > maxSortOrder) {
			throw error(400, `Sort order must be between 1 and ${maxSortOrder}`);
		}

		if (targetSortOrder < currentSortOrder) {
			await transaction
				.request()
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('targetSortOrder', targetSortOrder)
				.input('currentSortOrder', currentSortOrder)
				.query(
					`UPDATE dbo.EmployeeTypes
					 SET DisplayOrder = DisplayOrder + 1
					 WHERE ScheduleId = @scheduleId
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND EmployeeTypeId <> @employeeTypeId
					   AND DisplayOrder >= @targetSortOrder
					   AND DisplayOrder < @currentSortOrder;`
				);
		} else if (targetSortOrder > currentSortOrder) {
			await transaction
				.request()
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('targetSortOrder', targetSortOrder)
				.input('currentSortOrder', currentSortOrder)
				.query(
					`UPDATE dbo.EmployeeTypes
					 SET DisplayOrder = DisplayOrder - 1
					 WHERE ScheduleId = @scheduleId
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND EmployeeTypeId <> @employeeTypeId
					   AND DisplayOrder > @currentSortOrder
					   AND DisplayOrder <= @targetSortOrder;`
				);
		}

		const updateRequest = transaction
			.request()
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('name', name)
			.input('patternId', patternId)
			.input('displayOrder', targetSortOrder)
			.input('actorOid', actorOid);

		if (hasVersions) {
			const splitContextResult = await transaction
				.request()
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('effectiveStartDate', startDate)
				.query(
					`SELECT
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate = @effectiveStartDate) AS ExactStartDate,
						(SELECT TOP (1) Name
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate = @effectiveStartDate) AS ExactName,
						(SELECT TOP (1) PatternId
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate = @effectiveStartDate) AS ExactPatternId,
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @effectiveStartDate
						   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
						 ORDER BY StartDate DESC) AS ContainingStartDate,
						(SELECT TOP (1) Name
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @effectiveStartDate
						   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
						 ORDER BY StartDate DESC) AS ContainingName,
						(SELECT TOP (1) PatternId
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @effectiveStartDate
						   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
						 ORDER BY StartDate DESC) AS ContainingPatternId;`
				);
			const exactStartDateForSplit = toDateOnly(splitContextResult.recordset?.[0]?.ExactStartDate ?? '');
			const containingStartDateForSplit = toDateOnly(
				splitContextResult.recordset?.[0]?.ContainingStartDate ?? ''
			);
			const effectiveNameForSplit = cleanRequiredText(
				splitContextResult.recordset?.[0]?.ExactName ??
					splitContextResult.recordset?.[0]?.ContainingName ??
					name,
				50,
				'Shift name'
			);
			const effectivePatternIdForSplit = cleanOptionalPatternId(
				splitContextResult.recordset?.[0]?.ExactPatternId ??
					splitContextResult.recordset?.[0]?.ContainingPatternId ??
					patternId
			);
			const isRenameSplit =
				effectiveNameForSplit.localeCompare(name, undefined, { sensitivity: 'accent' }) !== 0;

			if (isRenameSplit) {
				if (!exactStartDateForSplit && !containingStartDateForSplit) {
					throw error(400, 'Cannot rename shift for a date where no active entry exists');
				}
				await assertNoShiftNameConflictForMonth({
					request: transaction.request(),
					scheduleId,
					name,
					monthStart: monthStartForDate(startDate),
					monthEnd: monthEndForDate(startDate),
					excludeEmployeeTypeId: employeeTypeId
				});

				const resolvedPatternId = patternId ?? effectivePatternIdForSplit;
				const insertNewShiftRequest = transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('name', name)
					.input('displayOrder', targetSortOrder)
					.input('patternId', resolvedPatternId)
					.input('actorOid', actorOid);
				if (hasStartDate) {
					insertNewShiftRequest.input('startDate', startDate);
				}
				const insertedShift = await insertNewShiftRequest.query(
					hasStartDate
						? `INSERT INTO dbo.EmployeeTypes (ScheduleId, Name, StartDate, DisplayOrder, PatternId, CreatedBy)
						   OUTPUT inserted.EmployeeTypeId AS EmployeeTypeId
						   VALUES (@scheduleId, @name, @startDate, @displayOrder, @patternId, @actorOid);`
						: `INSERT INTO dbo.EmployeeTypes (ScheduleId, Name, DisplayOrder, PatternId, CreatedBy)
						   OUTPUT inserted.EmployeeTypeId AS EmployeeTypeId
						   VALUES (@scheduleId, @name, @displayOrder, @patternId, @actorOid);`
				);
				const newEmployeeTypeId = Number(insertedShift.recordset?.[0]?.EmployeeTypeId ?? 0);
				if (!newEmployeeTypeId) {
					throw error(500, 'Failed to create renamed shift');
				}

				if (containingStartDateForSplit) {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', employeeTypeId)
						.input('containingStartDate', containingStartDateForSplit)
						.input('effectiveStartDate', startDate)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.EmployeeTypeVersions
							 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
								 EndedAt = SYSUTCDATETIME(),
								 EndedBy = @actorOid,
								 UpdatedAt = SYSUTCDATETIME(),
								 UpdatedBy = @actorOid
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND StartDate = @containingStartDate
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
						);
				}

				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('newEmployeeTypeId', newEmployeeTypeId)
					.input('effectiveStartDate', startDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.EmployeeTypeVersions
						 SET EmployeeTypeId = @newEmployeeTypeId,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorOid
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate >= @effectiveStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
					);

				const nextVersionResult = await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('newEmployeeTypeId', newEmployeeTypeId)
					.input('effectiveStartDate', startDate)
					.query(
						`SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @newEmployeeTypeId
						   AND StartDate > @effectiveStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						 ORDER BY StartDate ASC;`
					);
				const nextStartDateForSplit = toDateOnly(nextVersionResult.recordset?.[0]?.StartDate ?? '');
				const targetEndDateForSplit = nextStartDateForSplit ? minusOneDay(nextStartDateForSplit) : null;

				if (exactStartDateForSplit) {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('newEmployeeTypeId', newEmployeeTypeId)
						.input('effectiveStartDate', startDate)
						.input('name', name)
						.input('patternId', resolvedPatternId)
						.input('displayOrder', targetSortOrder)
						.input('targetEndDate', targetEndDateForSplit)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.EmployeeTypeVersions
							 SET Name = @name,
								 PatternId = @patternId,
								 DisplayOrder = @displayOrder,
								 EndDate = @targetEndDate,
								 UpdatedAt = SYSUTCDATETIME(),
								 UpdatedBy = @actorOid
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @newEmployeeTypeId
							   AND StartDate = @effectiveStartDate
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
						);
				} else {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('newEmployeeTypeId', newEmployeeTypeId)
						.input('effectiveStartDate', startDate)
						.input('name', name)
						.input('patternId', resolvedPatternId)
						.input('displayOrder', targetSortOrder)
						.input('targetEndDate', targetEndDateForSplit)
						.input('actorOid', actorOid)
						.query(
							`INSERT INTO dbo.EmployeeTypeVersions (
								ScheduleId,
								EmployeeTypeId,
								StartDate,
								EndDate,
								DisplayOrder,
								Name,
								PatternId,
								CreatedBy
							)
							VALUES (
								@scheduleId,
								@newEmployeeTypeId,
								@effectiveStartDate,
								@targetEndDate,
								@displayOrder,
								@name,
								@patternId,
								@actorOid
							);`
						);
				}

				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('newEmployeeTypeId', newEmployeeTypeId)
					.input('effectiveStartDate', startDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.ScheduleUserTypes
						 SET EmployeeTypeId = @newEmployeeTypeId
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate >= @effectiveStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;

						 DECLARE @AssignmentSplits TABLE (
							UserOid nvarchar(64) NOT NULL,
							EndDate date NULL,
							DisplayOrder int NOT NULL
						 );

						 INSERT INTO @AssignmentSplits (UserOid, EndDate, DisplayOrder)
						 SELECT sut.UserOid, sut.EndDate, sut.DisplayOrder
						 FROM dbo.ScheduleUserTypes sut
						 WHERE sut.ScheduleId = @scheduleId
						   AND sut.EmployeeTypeId = @employeeTypeId
						   AND sut.StartDate < @effectiveStartDate
						   AND (sut.EndDate IS NULL OR sut.EndDate >= @effectiveStartDate)
						   AND sut.IsActive = 1
						   AND sut.DeletedAt IS NULL
						   AND NOT EXISTS (
								SELECT 1
								FROM dbo.ScheduleUserTypes existing
								WHERE existing.ScheduleId = sut.ScheduleId
								  AND existing.UserOid = sut.UserOid
								  AND existing.EmployeeTypeId = @newEmployeeTypeId
								  AND existing.StartDate = @effectiveStartDate
								  AND existing.IsActive = 1
								  AND existing.DeletedAt IS NULL
						   );

						 UPDATE dbo.ScheduleUserTypes
						 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
							 EndedAt = SYSUTCDATETIME(),
							 EndedBy = @actorOid
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate < @effectiveStartDate
						   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
						   AND IsActive = 1
						   AND DeletedAt IS NULL;

						 INSERT INTO dbo.ScheduleUserTypes (
							ScheduleId,
							UserOid,
							EmployeeTypeId,
							StartDate,
							EndDate,
							DisplayOrder,
							CreatedBy,
							IsActive
						 )
						 SELECT
							@scheduleId,
							split.UserOid,
							@newEmployeeTypeId,
							@effectiveStartDate,
							split.EndDate,
							split.DisplayOrder,
							@actorOid,
							1
						 FROM @AssignmentSplits split;`
					);

				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('newEmployeeTypeId', newEmployeeTypeId)
					.input('effectiveStartDate', startDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.ScheduleEvents
						 SET EmployeeTypeId = @newEmployeeTypeId
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate >= @effectiveStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;

						 DECLARE @EventSplits TABLE (
							UserOid nvarchar(64) NULL,
							EndDate date NOT NULL,
							CoverageCodeId int NULL,
							CustomCode nvarchar(16) NULL,
							CustomName nvarchar(100) NULL,
							CustomDisplayMode nvarchar(30) NULL,
							CustomColor nvarchar(20) NULL,
							Title nvarchar(200) NULL,
							Notes nvarchar(max) NULL,
							CreatedBy nvarchar(64) NULL
						 );

						 INSERT INTO @EventSplits (
							UserOid,
							EndDate,
							CoverageCodeId,
							CustomCode,
							CustomName,
							CustomDisplayMode,
							CustomColor,
							Title,
							Notes,
							CreatedBy
						 )
						 SELECT
							se.UserOid,
							se.EndDate,
							se.CoverageCodeId,
							se.CustomCode,
							se.CustomName,
							se.CustomDisplayMode,
							se.CustomColor,
							se.Title,
							se.Notes,
							se.CreatedBy
						 FROM dbo.ScheduleEvents se
						 WHERE se.ScheduleId = @scheduleId
						   AND se.EmployeeTypeId = @employeeTypeId
						   AND se.StartDate < @effectiveStartDate
						   AND se.EndDate >= @effectiveStartDate
						   AND se.IsActive = 1
						   AND se.DeletedAt IS NULL;

						 UPDATE dbo.ScheduleEvents
						 SET EndDate = DATEADD(day, -1, @effectiveStartDate)
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate < @effectiveStartDate
						   AND EndDate >= @effectiveStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;

						 INSERT INTO dbo.ScheduleEvents (
							ScheduleId,
							UserOid,
							EmployeeTypeId,
							StartDate,
							EndDate,
							CoverageCodeId,
							CustomCode,
							CustomName,
							CustomDisplayMode,
							CustomColor,
							Title,
							Notes,
							CreatedBy,
							IsActive
						 )
						 SELECT
							@scheduleId,
							event_split.UserOid,
							@newEmployeeTypeId,
							@effectiveStartDate,
							event_split.EndDate,
							event_split.CoverageCodeId,
							event_split.CustomCode,
							event_split.CustomName,
							event_split.CustomDisplayMode,
							event_split.CustomColor,
							event_split.Title,
							event_split.Notes,
							COALESCE(event_split.CreatedBy, @actorOid),
							1
						 FROM @EventSplits event_split;`
					);

				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('actorOid', actorOid)
					.query(
						hasStartDate
							? `UPDATE et
								 SET et.Name = latest.Name,
									 et.StartDate = latest.StartDate,
									 et.PatternId = latest.PatternId,
									 et.UpdatedAt = SYSUTCDATETIME(),
									 et.UpdatedBy = @actorOid
								FROM dbo.EmployeeTypes et
								CROSS APPLY (
									SELECT TOP (1) etv.Name, etv.PatternId, etv.StartDate
									FROM dbo.EmployeeTypeVersions etv
									WHERE etv.ScheduleId = et.ScheduleId
									  AND etv.EmployeeTypeId = et.EmployeeTypeId
									  AND etv.IsActive = 1
									  AND etv.DeletedAt IS NULL
									ORDER BY etv.StartDate DESC
								) latest
								WHERE et.ScheduleId = @scheduleId
								  AND et.EmployeeTypeId = @employeeTypeId
								  AND et.IsActive = 1
								  AND et.DeletedAt IS NULL;`
							: `UPDATE et
								 SET et.Name = latest.Name,
									 et.PatternId = latest.PatternId,
									 et.UpdatedAt = SYSUTCDATETIME(),
									 et.UpdatedBy = @actorOid
								FROM dbo.EmployeeTypes et
								CROSS APPLY (
									SELECT TOP (1) etv.Name, etv.PatternId
									FROM dbo.EmployeeTypeVersions etv
									WHERE etv.ScheduleId = et.ScheduleId
									  AND etv.EmployeeTypeId = et.EmployeeTypeId
									  AND etv.IsActive = 1
									  AND etv.DeletedAt IS NULL
									ORDER BY etv.StartDate DESC
								) latest
								WHERE et.ScheduleId = @scheduleId
								  AND et.EmployeeTypeId = @employeeTypeId
								  AND et.IsActive = 1
								  AND et.DeletedAt IS NULL;`
					);

				await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', newEmployeeTypeId)
					.input('displayOrder', targetSortOrder)
					.input('actorOid', actorOid)
					.query(
						hasStartDate
							? `UPDATE et
								 SET et.Name = latest.Name,
									 et.StartDate = latest.StartDate,
									 et.DisplayOrder = @displayOrder,
									 et.PatternId = latest.PatternId,
									 et.UpdatedAt = SYSUTCDATETIME(),
									 et.UpdatedBy = @actorOid
								FROM dbo.EmployeeTypes et
								CROSS APPLY (
									SELECT TOP (1) etv.Name, etv.PatternId, etv.StartDate
									FROM dbo.EmployeeTypeVersions etv
									WHERE etv.ScheduleId = et.ScheduleId
									  AND etv.EmployeeTypeId = et.EmployeeTypeId
									  AND etv.IsActive = 1
									  AND etv.DeletedAt IS NULL
									ORDER BY etv.StartDate DESC
								) latest
								WHERE et.ScheduleId = @scheduleId
								  AND et.EmployeeTypeId = @employeeTypeId
								  AND et.IsActive = 1
								  AND et.DeletedAt IS NULL;`
							: `UPDATE et
								 SET et.Name = latest.Name,
									 et.DisplayOrder = @displayOrder,
									 et.PatternId = latest.PatternId,
									 et.UpdatedAt = SYSUTCDATETIME(),
									 et.UpdatedBy = @actorOid
								FROM dbo.EmployeeTypes et
								CROSS APPLY (
									SELECT TOP (1) etv.Name, etv.PatternId
									FROM dbo.EmployeeTypeVersions etv
									WHERE etv.ScheduleId = et.ScheduleId
									  AND etv.EmployeeTypeId = et.EmployeeTypeId
									  AND etv.IsActive = 1
									  AND etv.DeletedAt IS NULL
									ORDER BY etv.StartDate DESC
								) latest
								WHERE et.ScheduleId = @scheduleId
								  AND et.EmployeeTypeId = @employeeTypeId
								  AND et.IsActive = 1
								  AND et.DeletedAt IS NULL;`
					);

				await transaction.commit();
				return json({ success: true, mode: 'rename_split' });
			}

			await assertNoShiftNameConflictForMonth({
				request: transaction.request(),
				scheduleId,
				name,
				monthStart: monthStartForDate(startDate),
				monthEnd: monthEndForDate(startDate),
				excludeEmployeeTypeId: employeeTypeId
			});

			if (editMode === 'history') {
				if (!changeStartDate) {
					throw error(400, 'Change start date is required for history edits');
				}
				const historyExists = await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('changeStartDate', changeStartDate)
					.query(
						`SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND StartDate = @changeStartDate
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
					);
				if (!historyExists.recordset?.[0]?.StartDate) {
					throw error(404, 'Shift change entry not found');
				}

				const timelineContext = await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('changeStartDate', changeStartDate)
					.input('targetStartDate', startDate)
					.query(
						`SELECT
							(SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate < @changeStartDate
							 ORDER BY StartDate DESC) AS PreviousStartDate,
							(SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate > @changeStartDate
							 ORDER BY StartDate ASC) AS NextStartDate,
							(SELECT TOP (1) StartDate
							 FROM dbo.EmployeeTypeVersions
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL
							   AND StartDate = @targetStartDate
							   AND StartDate <> @changeStartDate) AS ConflictingStartDate;`
					);
				const previousStartDate = toDateOnly(
					timelineContext.recordset?.[0]?.PreviousStartDate ?? ''
				);
				const nextStartDate = toDateOnly(timelineContext.recordset?.[0]?.NextStartDate ?? '');
				const conflictingStartDate = toDateOnly(
					timelineContext.recordset?.[0]?.ConflictingStartDate ?? ''
				);

				if (conflictingStartDate) {
					throw error(400, 'A shift change already exists with that effective start date');
				}
				if (previousStartDate && startDate <= previousStartDate) {
					throw error(400, 'Change effective date must be after the previous change entry');
				}
				if (nextStartDate && startDate >= nextStartDate) {
					throw error(400, 'Change effective date must be before the next change entry');
				}

					const previousEndDate = previousStartDate ? minusOneDay(startDate) : null;
					const currentEndDate = nextStartDate ? minusOneDay(nextStartDate) : null;

					const updatePreviousWindow = async () => {
						if (!previousStartDate) return;
						await transaction
							.request()
							.input('scheduleId', scheduleId)
							.input('employeeTypeId', employeeTypeId)
							.input('previousStartDate', previousStartDate)
							.input('previousEndDate', previousEndDate)
							.input('actorOid', actorOid)
							.query(
								`UPDATE dbo.EmployeeTypeVersions
								 SET EndDate = @previousEndDate,
									 EndedAt = CASE WHEN @previousEndDate IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
									 EndedBy = CASE WHEN @previousEndDate IS NULL THEN NULL ELSE @actorOid END,
									 UpdatedAt = SYSUTCDATETIME(),
									 UpdatedBy = @actorOid
								 WHERE ScheduleId = @scheduleId
								   AND EmployeeTypeId = @employeeTypeId
								   AND StartDate = @previousStartDate
								   AND IsActive = 1
								   AND DeletedAt IS NULL;`
							);
					};

					const updateCurrentWindow = async () => {
						await transaction
							.request()
							.input('scheduleId', scheduleId)
							.input('employeeTypeId', employeeTypeId)
							.input('changeStartDate', changeStartDate)
							.input('targetStartDate', startDate)
							.input('name', name)
							.input('patternId', patternId)
							.input('currentEndDate', currentEndDate)
							.input('actorOid', actorOid)
							.query(
								`UPDATE dbo.EmployeeTypeVersions
									 SET StartDate = @targetStartDate,
										 EndDate = @currentEndDate,
										 Name = @name,
										 PatternId = @patternId,
										 UpdatedAt = SYSUTCDATETIME(),
										 UpdatedBy = @actorOid
									 WHERE ScheduleId = @scheduleId
									   AND EmployeeTypeId = @employeeTypeId
									   AND StartDate = @changeStartDate
									   AND IsActive = 1
									   AND DeletedAt IS NULL;`
							);
					};

					if (startDate > changeStartDate) {
						await updateCurrentWindow();
						await updatePreviousWindow();
					} else {
						await updatePreviousWindow();
						await updateCurrentWindow();
					}
			} else {
				const timelineResult = await transaction
					.request()
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('effectiveStartDate', startDate)
					.query(
						`SELECT
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate > @effectiveStartDate
						 ORDER BY StartDate ASC) AS NextStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate = @effectiveStartDate) AS ExactStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.EmployeeTypeVersions
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @effectiveStartDate
						   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
						 ORDER BY StartDate DESC) AS ContainingStartDate;`
					);

				const nextStartDate = toDateOnly(timelineResult.recordset?.[0]?.NextStartDate ?? '');
				const exactStartDate = toDateOnly(timelineResult.recordset?.[0]?.ExactStartDate ?? '');
				const containingStartDate = toDateOnly(
					timelineResult.recordset?.[0]?.ContainingStartDate ?? ''
				);

				const targetEndDate = nextStartDate
					? toDateOnly(
							new Date(new Date(`${nextStartDate}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
						)
					: null;

				if (containingStartDate) {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', employeeTypeId)
						.input('containingStartDate', containingStartDate)
						.input('effectiveStartDate', startDate)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.EmployeeTypeVersions
						 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
							 EndedAt = SYSUTCDATETIME(),
							 EndedBy = @actorOid,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorOid
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate = @containingStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
						);
				}

				if (exactStartDate) {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', employeeTypeId)
						.input('effectiveStartDate', startDate)
						.input('name', name)
						.input('patternId', patternId)
						.input('targetEndDate', targetEndDate)
						.input('actorOid', actorOid)
						.query(
							`UPDATE dbo.EmployeeTypeVersions
						 SET Name = @name,
							 PatternId = @patternId,
							 EndDate = @targetEndDate,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorOid
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate = @effectiveStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
						);
				} else {
					await transaction
						.request()
						.input('scheduleId', scheduleId)
						.input('employeeTypeId', employeeTypeId)
						.input('effectiveStartDate', startDate)
						.input('targetEndDate', targetEndDate)
						.input('name', name)
						.input('patternId', patternId)
						.input('actorOid', actorOid)
						.query(
							`INSERT INTO dbo.EmployeeTypeVersions (
							ScheduleId,
							EmployeeTypeId,
							StartDate,
							EndDate,
							Name,
							PatternId,
							CreatedBy
						)
						VALUES (
							@scheduleId,
							@employeeTypeId,
							@effectiveStartDate,
							@targetEndDate,
							@name,
							@patternId,
							@actorOid
						);`
						);
				}
			}

			await updateRequest.query(
				hasStartDate
					? `UPDATE et
						 SET et.Name = latest.Name,
							 et.StartDate = latest.StartDate,
							 et.DisplayOrder = @displayOrder,
							 et.PatternId = latest.PatternId,
							 et.UpdatedAt = SYSUTCDATETIME(),
							 et.UpdatedBy = @actorOid
						FROM dbo.EmployeeTypes et
						CROSS APPLY (
							SELECT TOP (1) etv.Name, etv.PatternId, etv.StartDate
							FROM dbo.EmployeeTypeVersions etv
							WHERE etv.ScheduleId = et.ScheduleId
							  AND etv.EmployeeTypeId = et.EmployeeTypeId
							  AND etv.IsActive = 1
							  AND etv.DeletedAt IS NULL
							ORDER BY etv.StartDate DESC
						) latest
						WHERE et.ScheduleId = @scheduleId
						  AND et.EmployeeTypeId = @employeeTypeId
						  AND et.IsActive = 1
						  AND et.DeletedAt IS NULL;`
					: `UPDATE et
						 SET et.Name = latest.Name,
							 et.DisplayOrder = @displayOrder,
							 et.PatternId = latest.PatternId,
							 et.UpdatedAt = SYSUTCDATETIME(),
							 et.UpdatedBy = @actorOid
						FROM dbo.EmployeeTypes et
						CROSS APPLY (
							SELECT TOP (1) etv.Name, etv.PatternId
							FROM dbo.EmployeeTypeVersions etv
							WHERE etv.ScheduleId = et.ScheduleId
							  AND etv.EmployeeTypeId = et.EmployeeTypeId
							  AND etv.IsActive = 1
							  AND etv.DeletedAt IS NULL
							ORDER BY etv.StartDate DESC
						) latest
						WHERE et.ScheduleId = @scheduleId
						  AND et.EmployeeTypeId = @employeeTypeId
						  AND et.IsActive = 1
						  AND et.DeletedAt IS NULL;`
			);
		} else if (hasStartDate) {
			updateRequest.input('startDate', startDate);
			await updateRequest.query(
				`UPDATE dbo.EmployeeTypes
				 SET Name = @name,
					 StartDate = @startDate,
					 DisplayOrder = @displayOrder,
					 PatternId = @patternId,
					 UpdatedAt = SYSUTCDATETIME(),
					 UpdatedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND EmployeeTypeId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		} else {
			await updateRequest.query(
				`UPDATE dbo.EmployeeTypes
				 SET Name = @name,
					 DisplayOrder = @displayOrder,
					 PatternId = @patternId,
					 UpdatedAt = SYSUTCDATETIME(),
					 UpdatedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND EmployeeTypeId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		}
		await transaction.commit();
	} catch (err) {
		try {
			await transaction.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw err;
	}

	return json({ success: true });
};

type RemoveShiftPayload = {
	employeeTypeId?: unknown;
	editMode?: unknown;
	changeStartDate?: unknown;
	confirmActiveAssignmentRemoval?: unknown;
};

export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = (await request.json().catch(() => null)) as RemoveShiftPayload | null;
	const employeeTypeId = Number(body?.employeeTypeId);
	if (!Number.isInteger(employeeTypeId) || employeeTypeId <= 0) {
		throw error(400, 'Shift ID is required');
	}
	const editMode =
		typeof body?.editMode === 'string' && body.editMode.trim().toLowerCase() === 'history'
			? 'history'
			: 'timeline';
	const changeStartDate =
		editMode === 'history' && typeof body?.changeStartDate === 'string'
			? cleanStartDate(body.changeStartDate)
			: null;
	const confirmActiveAssignmentRemoval = cleanBoolean(body?.confirmActiveAssignmentRemoval);

	const hasVersions = await employeeTypeVersionsEnabled(pool);
	const hasStartDate = await employeeTypesHasStartDate(pool);
	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const existsResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`SELECT TOP (1) EmployeeTypeId
				 FROM dbo.EmployeeTypes
				 WHERE ScheduleId = @scheduleId
				   AND EmployeeTypeId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		if (!existsResult.recordset?.[0]?.EmployeeTypeId) {
			throw error(404, 'Shift not found');
		}

		if (editMode === 'history') {
			if (!hasVersions) {
				throw error(400, 'Shift history edits are not available');
			}
			if (!changeStartDate) {
				throw error(400, 'Change start date is required for history edits');
			}

			const historyResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.query(
					`SELECT StartDate
					 FROM dbo.EmployeeTypeVersions
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					 ORDER BY StartDate ASC;`
				);
			const startDates = (historyResult.recordset ?? [])
				.map((row) => toDateOnly(row.StartDate as Date | string))
				.filter((value) => Boolean(value));
			if (!startDates.includes(changeStartDate)) {
				throw error(404, 'Shift change entry not found');
			}

			const targetIndex = startDates.findIndex((start) => start === changeStartDate);
			const previousStartDate = targetIndex > 0 ? startDates[targetIndex - 1] : null;
			const nextStartDate =
				targetIndex >= 0 && targetIndex < startDates.length - 1 ? startDates[targetIndex + 1] : null;
			const previousEndDate = nextStartDate
				? toDateOnly(
						new Date(new Date(`${nextStartDate}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
					)
				: null;

			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('changeStartDate', changeStartDate)
				.query(
					`DELETE FROM dbo.EmployeeTypeVersions
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId
					   AND StartDate = @changeStartDate
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);

			if (previousStartDate) {
				await new sql.Request(tx)
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('previousStartDate', previousStartDate)
					.input('previousEndDate', previousEndDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.EmployeeTypeVersions
						 SET EndDate = @previousEndDate,
							 EndedAt = CASE WHEN @previousEndDate IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
							 EndedBy = CASE WHEN @previousEndDate IS NULL THEN NULL ELSE @actorOid END,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorOid
						 WHERE ScheduleId = @scheduleId
						   AND EmployeeTypeId = @employeeTypeId
						   AND StartDate = @previousStartDate
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
					);
			}

			const latestResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.query(
					`SELECT TOP (1) Name, PatternId, StartDate
					 FROM dbo.EmployeeTypeVersions
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					 ORDER BY StartDate DESC;`
				);
			const latest = latestResult.recordset?.[0];
			if (latest) {
				const updateRequest = new sql.Request(tx)
					.input('scheduleId', scheduleId)
					.input('employeeTypeId', employeeTypeId)
					.input('name', latest.Name)
					.input('patternId', latest.PatternId ?? null)
					.input('actorOid', actorOid);
				if (hasStartDate) {
					updateRequest.input('startDate', toDateOnly(latest.StartDate as Date | string));
				}
				await updateRequest.query(
					hasStartDate
						? `UPDATE dbo.EmployeeTypes
							 SET Name = @name,
								 PatternId = @patternId,
								 StartDate = @startDate,
								 UpdatedAt = SYSUTCDATETIME(),
								 UpdatedBy = @actorOid
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
						: `UPDATE dbo.EmployeeTypes
							 SET Name = @name,
								 PatternId = @patternId,
								 UpdatedAt = SYSUTCDATETIME(),
								 UpdatedBy = @actorOid
							 WHERE ScheduleId = @scheduleId
							   AND EmployeeTypeId = @employeeTypeId
							   AND IsActive = 1
							   AND DeletedAt IS NULL;`
				);
			}

			await tx.commit();
			return json({ success: true, removalMode: 'history_removed' });
		}

		const serverDateResult = await new sql.Request(tx).query(
			`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`
		);
		const today = toDateOnly(serverDateResult.recordset?.[0]?.Today ?? '');
		if (!today) {
			throw error(500, 'Could not resolve current server date');
		}

		const assignmentStatsResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('today', today)
			.query(
				`SELECT
					COUNT(*) AS AnyAssignmentCount,
					SUM(CASE WHEN StartDate <= @today AND (EndDate IS NULL OR EndDate >= @today) THEN 1 ELSE 0 END) AS ActiveAssignmentCount
				 FROM dbo.ScheduleUserTypes
				 WHERE ScheduleId = @scheduleId
				   AND EmployeeTypeId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		const anyAssignmentCount = Number(assignmentStatsResult.recordset?.[0]?.AnyAssignmentCount ?? 0);
		const activeAssignmentCount = Number(
			assignmentStatsResult.recordset?.[0]?.ActiveAssignmentCount ?? 0
		);

		if (anyAssignmentCount > 0 && activeAssignmentCount > 0 && !confirmActiveAssignmentRemoval) {
			await tx.rollback();
			return json(
				{
					code: 'SHIFT_ACTIVE_ASSIGNMENTS',
					message:
						'This shift is currently assigned to one or more active users. Confirm removal to end active assignments effective today and remove future assignments.',
					activeAssignmentCount
				},
				{ status: 409 }
			);
		}

		if (anyAssignmentCount > 0) {
			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
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
					   AND EmployeeTypeId = @employeeTypeId
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND StartDate <= @today
					   AND (EndDate IS NULL OR EndDate >= @today);

					 UPDATE dbo.ScheduleUserTypes
					 SET IsActive = 0,
						 DeletedAt = SYSUTCDATETIME(),
						 DeletedBy = @actorOid
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND StartDate > @today;`
				);

			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('actorOid', actorOid)
				.query(
					`UPDATE dbo.EmployeeTypes
					 SET IsActive = 0,
						 DeletedAt = SYSUTCDATETIME(),
						 DeletedBy = @actorOid,
						 UpdatedAt = SYSUTCDATETIME(),
						 UpdatedBy = @actorOid
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);

			await tx.commit();
			return json({ success: true, removalMode: 'soft_deleted' });
		}

		if (hasVersions) {
			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.query(
					`DELETE FROM dbo.ScheduleEvents
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId;
					 DELETE FROM dbo.EmployeeTypeVersions
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId;
					 DELETE FROM dbo.EmployeeTypes
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId;`
				);
		} else {
			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.query(
					`DELETE FROM dbo.ScheduleEvents
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId;
					 DELETE FROM dbo.EmployeeTypes
					 WHERE ScheduleId = @scheduleId
					   AND EmployeeTypeId = @employeeTypeId;`
				);
		}

		await new sql.Request(tx).input('scheduleId', scheduleId).query(
			`WITH Ordered AS (
				SELECT
					EmployeeTypeId,
					ROW_NUMBER() OVER (
						ORDER BY DisplayOrder ASC, Name ASC, EmployeeTypeId ASC
					) AS NextDisplayOrder
				FROM dbo.EmployeeTypes
				WHERE ScheduleId = @scheduleId
				  AND IsActive = 1
				  AND DeletedAt IS NULL
			)
			UPDATE et
			   SET DisplayOrder = o.NextDisplayOrder
			FROM dbo.EmployeeTypes et
			INNER JOIN Ordered o
			  ON o.EmployeeTypeId = et.EmployeeTypeId
			WHERE et.ScheduleId = @scheduleId
			  AND et.IsActive = 1
			  AND et.DeletedAt IS NULL
			  AND et.DisplayOrder <> o.NextDisplayOrder;`
		);

		await tx.commit();
		return json({ success: true, removalMode: 'hard_deleted' });
	} catch (err) {
		try {
			await tx.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw err;
	}
};
