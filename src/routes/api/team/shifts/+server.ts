import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import sql from 'mssql';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId, getSessionAccessToken } from '$lib/server/auth';
import { sendShiftChangeNotification } from '$lib/server/mail/notifications';
import {
	cleanMonthValue,
	getActiveShiftIdsForMonth,
	monthEndForMonthStart,
	monthStartForDate,
	resolveShiftOrderForMonth,
	upsertShiftOrderSnapshot
} from '$lib/server/shift-order';
import { requireScheduleRole } from '$lib/server/schedule-access';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

type VersionRow = {
	StartDate: Date | string;
	EndDate: Date | string | null;
	Name: string;
	PatternId: number | null;
	DisplayOrder: number | null;
	ModifiedAt?: Date | string | null;
};

type ShiftRow = {
	ShiftId: number;
	Name: string;
	PatternId: number | null;
	PatternName: string | null;
	StartDate: Date | string;
	EndDate: Date | string | null;
};

type ShiftEmailContext = {
	scheduleName: string;
	scheduleThemeJson: string | null;
	targetDisplayName: string;
	targetEmail: string | null;
	actorDisplayName: string;
};

type ImpactedShiftAssignmentNotification = {
	userOid: string;
	notifyDate: string;
};

type RemoveShiftPayload = {
	employeeTypeId?: unknown;
	editMode?: unknown;
	changeStartDate?: unknown;
	confirmUsedShiftRemoval?: unknown;
	expectedShiftVersionStamp?: unknown;
	expectedChangeVersionStamp?: unknown;
};

const CASE_SENSITIVE_COLLATION = 'Latin1_General_100_CS_AS';
const SHIFT_REORDER_SERVER_DEBUG = true;

function logShiftReorderServer(message: string, details?: Record<string, unknown>) {
	if (!SHIFT_REORDER_SERVER_DEBUG) return;
	if (details) {
		console.info(`[ShiftReorderServer] ${message}`, details);
		return;
	}
	console.info(`[ShiftReorderServer] ${message}`);
}

function req(runner: sql.ConnectionPool | sql.Transaction): sql.Request {
	// mssql types do not accept a union argument, but both pool and transaction are valid at runtime.
	return new sql.Request(runner as sql.Transaction);
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
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, 'Pattern is invalid');
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
	const [yearText, monthText, dayText] = trimmed.split('-');
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	if (
		Number.isNaN(parsed.getTime()) ||
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() + 1 !== month ||
		parsed.getUTCDate() !== day
	) {
		throw error(400, `${label} is invalid`);
	}
	return trimmed;
}

function cleanOptionalDateOnly(value: unknown, label: string): string | null {
	if (value === null || value === undefined || value === '') return null;
	return cleanDateOnly(value, label);
}

function cleanBoolean(value: unknown): boolean {
	return value === true;
}

function cleanRequiredVersionStamp(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw error(400, `${label} is required`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw error(400, `${label} is required`);
	}
	return trimmed.slice(0, 200);
}

function cleanShiftId(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, 'Shift ID is required');
	}
	return parsed;
}

function cleanShiftIdList(value: unknown): number[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw error(400, 'orderedShiftIds is required');
	}
	const parsed = value.map((entry) => Number(entry));
	if (parsed.some((entry) => !Number.isInteger(entry) || entry <= 0)) {
		throw error(400, 'orderedShiftIds must contain valid shift IDs');
	}
	if (new Set(parsed).size !== parsed.length) {
		throw error(400, 'orderedShiftIds contains duplicates');
	}
	return parsed;
}

function toDateOnly(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') return value.slice(0, 10);
	return null;
}

function toDateTimeIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== 'string') return null;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

function versionStampForVersion(startDate: string, modifiedAtIso: string | null): string {
	return `${startDate}|${modifiedAtIso ?? '0'}`;
}

function shiftVersionStampForVersions(
	versions: Array<{ startDate: string; modifiedAtIso: string | null }>
): string {
	const latestModifiedAtIso = versions.reduce<string | null>((latest, version) => {
		if (!version.modifiedAtIso) return latest;
		if (!latest || version.modifiedAtIso > latest) return version.modifiedAtIso;
		return latest;
	}, null);
	return `${versions.length}|${latestModifiedAtIso ?? '0'}`;
}

function toSqlDateValue(dateOnly: string): Date {
	const [yearText, monthText, dayText] = dateOnly.split('-');
	return new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
}

function toNullableSqlDateValue(dateOnly: string | null): Date | null {
	return dateOnly ? toSqlDateValue(dateOnly) : null;
}

function plusOneDay(dateOnly: string): string {
	const parsed = new Date(`${dateOnly}T00:00:00Z`);
	return new Date(parsed.getTime() + 86_400_000).toISOString().slice(0, 10);
}

function minusOneDay(dateOnly: string): string {
	const parsed = new Date(`${dateOnly}T00:00:00Z`);
	return new Date(parsed.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function dateLessThan(left: string, right: string): boolean {
	return left < right;
}

function dateGreaterThan(left: string, right: string): boolean {
	return left > right;
}

function normalizeEndDate(endDate: string | null): string {
	return endDate ?? '9999-12-31';
}

function rangesOverlap(
	leftStart: string,
	leftEnd: string | null,
	rightStart: string,
	rightEnd: string | null
): boolean {
	return leftStart <= normalizeEndDate(rightEnd) && rightStart <= normalizeEndDate(leftEnd);
}

async function getActorContext(localsUserOid: string, cookies: Cookies) {
	const scheduleId = await getActiveScheduleId(cookies);
	if (!scheduleId) {
		throw error(400, 'No active schedule selected');
	}

	const pool = await GetPool();
	await requireScheduleRole({
		userOid: localsUserOid,
		scheduleId,
		minRole: 'Maintainer',
		pool,
		errorMessage: 'Insufficient permissions'
	});

	return { pool, scheduleId, actorOid: localsUserOid };
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
				NULLIF(LTRIM(RTRIM(tu.Email)), '') AS TargetEmail,
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
		targetEmail: row.TargetEmail ? String(row.TargetEmail) : null,
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
			 FROM dbo.ScheduleAssignments sut
			 LEFT JOIN dbo.Shifts et
				ON et.ScheduleId = sut.ScheduleId
			   AND et.ShiftId = sut.ShiftId
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

async function ensurePatternExists(
	runner: sql.ConnectionPool | sql.Transaction,
	scheduleId: number,
	patternId: number | null
) {
	if (patternId === null) return;
	const patternResult = await req(runner)
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

async function ensureShiftExists(
	runner: sql.ConnectionPool | sql.Transaction,
	scheduleId: number,
	employeeTypeId: number
) {
	const result = await req(runner)
		.input('scheduleId', scheduleId)
		.input('employeeTypeId', employeeTypeId)
		.query(
			`SELECT TOP (1) ShiftId
			 FROM dbo.Shifts
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
	if (!result.recordset?.[0]?.ShiftId) {
		throw error(404, 'Shift not found');
	}
}

async function assertNoNameOverlap(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	name: string;
	startDate: string;
	endDate: string | null;
	excludeShiftId?: number | null;
}) {
	const overlap = await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('name', params.name)
		.input('startDate', sql.Date, toSqlDateValue(params.startDate))
		.input('endDate', sql.Date, toNullableSqlDateValue(params.endDate))
		.input('excludeShiftId', params.excludeShiftId ?? null)
		.query(
			`SELECT TOP (1) etv.ShiftId
			 FROM dbo.ShiftEdits etv
			 INNER JOIN dbo.Shifts et
			   ON et.ShiftId = etv.ShiftId
			  AND et.ScheduleId = etv.ScheduleId
			  AND et.IsActive = 1
			  AND et.DeletedAt IS NULL
			 WHERE etv.ScheduleId = @scheduleId
			   AND etv.IsActive = 1
			   AND etv.DeletedAt IS NULL
			   AND etv.Name COLLATE ${CASE_SENSITIVE_COLLATION} = @name COLLATE ${CASE_SENSITIVE_COLLATION}
			   AND etv.StartDate <= ISNULL(@endDate, '9999-12-31')
			   AND ISNULL(etv.EndDate, '9999-12-31') >= @startDate
			   AND (@excludeShiftId IS NULL OR etv.ShiftId <> @excludeShiftId);`
		);

	if (overlap.recordset?.[0]?.ShiftId) {
		throw error(409, 'A shift with this name is already active during the selected timespan');
	}
}

async function loadVersions(
	runner: sql.ConnectionPool | sql.Transaction,
	scheduleId: number,
	employeeTypeId: number
): Promise<
	Array<{
		startDate: string;
		endDate: string | null;
		name: string;
		patternId: number | null;
		modifiedAtIso: string | null;
		versionStamp: string;
	}>
> {
	const result = await req(runner)
		.input('scheduleId', scheduleId)
		.input('employeeTypeId', employeeTypeId)
		.query(
			`SELECT StartDate, EndDate, Name, PatternId, COALESCE(UpdatedAt, CreatedAt) AS ModifiedAt
			 FROM dbo.ShiftEdits
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			 ORDER BY StartDate ASC;`
		);
	return (result.recordset as VersionRow[]).map((row) => {
		const startDate = toDateOnly(row.StartDate) ?? '';
		const modifiedAtIso = toDateTimeIso(row.ModifiedAt);
		return {
			startDate,
			endDate: toDateOnly(row.EndDate),
			name: row.Name,
			patternId: row.PatternId === null ? null : Number(row.PatternId),
			modifiedAtIso,
			versionStamp: versionStampForVersion(startDate, modifiedAtIso)
		};
	});
}

async function replaceVersions(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	employeeTypeId: number;
	versions: Array<{ startDate: string; endDate: string | null; name: string; patternId: number | null }>;
	actorOid: string;
}) {
	await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('employeeTypeId', params.employeeTypeId)
		.query(
			`DELETE FROM dbo.ShiftEdits
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId;`
		);

	for (const version of params.versions) {
		await req(params.runner)
			.input('scheduleId', params.scheduleId)
			.input('employeeTypeId', params.employeeTypeId)
			.input('startDate', sql.Date, toSqlDateValue(version.startDate))
			.input('endDate', sql.Date, toNullableSqlDateValue(version.endDate))
			.input('name', version.name)
			.input('patternId', version.patternId)
			.input('actorOid', params.actorOid)
			.query(
				`INSERT INTO dbo.ShiftEdits (
					ScheduleId,
					ShiftId,
					StartDate,
					EndDate,
					Name,
					PatternId,
					CreatedBy,
					IsActive
				)
				VALUES (
					@scheduleId,
					@employeeTypeId,
					@startDate,
					@endDate,
					@name,
					@patternId,
					@actorOid,
					1
				);`
			);
	}
}

async function syncShiftMainFromVersions(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	employeeTypeId: number;
	actorOid: string;
}) {
	const rows = await loadVersions(params.runner, params.scheduleId, params.employeeTypeId);
	if (rows.length === 0) {
		await req(params.runner)
			.input('scheduleId', params.scheduleId)
			.input('employeeTypeId', params.employeeTypeId)
			.input('actorOid', params.actorOid)
			.query(
				`UPDATE dbo.Shifts
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorOid,
					 UpdatedAt = SYSUTCDATETIME(),
					 UpdatedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;`
			);
		return;
	}

	const earliest = rows[0];
	const latest = rows[rows.length - 1];
	const hasOpenEnded = rows.some((row) => row.endDate === null);
	const latestClosedEnd = rows.reduce<string | null>((current, row) => {
		if (row.endDate === null) return current;
		if (!current || row.endDate > current) return row.endDate;
		return current;
	}, null);

	await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('employeeTypeId', params.employeeTypeId)
		.input('name', latest.name)
		.input('patternId', latest.patternId)
		.input('startDate', sql.Date, toSqlDateValue(earliest.startDate))
		.input('endDate', sql.Date, toNullableSqlDateValue(hasOpenEnded ? null : latestClosedEnd))
		.input('actorOid', params.actorOid)
		.query(
			`UPDATE dbo.Shifts
			 SET Name = @name,
				 PatternId = @patternId,
				 StartDate = @startDate,
				 EndDate = @endDate,
				 IsActive = 1,
				 DeletedAt = NULL,
				 DeletedBy = NULL,
				 UpdatedAt = SYSUTCDATETIME(),
				 UpdatedBy = @actorOid
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId;`
		);
}

function applyIntervalSurgery(params: {
	existing: Array<{ startDate: string; endDate: string | null; name: string; patternId: number | null }>;
	inserted: { startDate: string; endDate: string | null; name: string; patternId: number | null };
}): Array<{ startDate: string; endDate: string | null; name: string; patternId: number | null }> {
	const next: Array<{ startDate: string; endDate: string | null; name: string; patternId: number | null }> = [];

	for (const row of params.existing) {
		if (!rangesOverlap(row.startDate, row.endDate, params.inserted.startDate, params.inserted.endDate)) {
			next.push(row);
			continue;
		}

		if (dateLessThan(row.startDate, params.inserted.startDate)) {
			const leftEnd = minusOneDay(params.inserted.startDate);
			if (!row.endDate || !dateLessThan(row.endDate, row.startDate)) {
				if (leftEnd >= row.startDate) {
					next.push({ ...row, endDate: row.endDate && row.endDate < leftEnd ? row.endDate : leftEnd });
				}
			}
		}

		if (params.inserted.endDate && (!row.endDate || dateGreaterThan(row.endDate, params.inserted.endDate))) {
			const rightStart = plusOneDay(params.inserted.endDate);
			if (!row.endDate || rightStart <= row.endDate) {
				next.push({ ...row, startDate: rightStart });
			}
		}
	}

	next.push(params.inserted);
	next.sort((a, b) => a.startDate.localeCompare(b.startDate));
	return next;
}

async function cleanupShiftScopedDataAfterEndDate(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	employeeTypeId: number;
	endDate: string;
	actorOid: string;
}) {
	await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('employeeTypeId', params.employeeTypeId)
		.input('endDate', sql.Date, toSqlDateValue(params.endDate))
		.input('actorOid', params.actorOid)
		.query(
			`DELETE FROM dbo.ScheduleAssignments
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND StartDate > @endDate;

			 UPDATE dbo.ScheduleAssignments
			 SET EndDate = @endDate,
				 EndedAt = SYSUTCDATETIME(),
				 EndedBy = @actorOid
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND StartDate <= @endDate
			   AND (EndDate IS NULL OR EndDate > @endDate);

			 DELETE FROM dbo.ScheduleEvents
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND StartDate > @endDate;

			 UPDATE dbo.ScheduleEvents
			 SET EndDate = @endDate
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND StartDate <= @endDate
			   AND EndDate > @endDate;

			 DELETE FROM dbo.ShiftEdits
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND StartDate > @endDate;

			 UPDATE dbo.ShiftEdits
			 SET EndDate = @endDate,
				 UpdatedAt = SYSUTCDATETIME(),
				 UpdatedBy = @actorOid
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND StartDate <= @endDate
			   AND (EndDate IS NULL OR EndDate > @endDate);`
		);
}

async function getFallbackOrderedShiftIdsForMonth(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	monthStart: string;
}): Promise<number[]> {
	const monthEnd = monthEndForMonthStart(params.monthStart);
	const result = await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('monthStart', params.monthStart)
		.input('monthEnd', monthEnd)
		.query(
			`SELECT DISTINCT et.ShiftId, et.DisplayOrder, et.Name
			 FROM dbo.Shifts et
			 INNER JOIN dbo.ShiftEdits etv
			   ON etv.ShiftId = et.ShiftId
			  AND etv.ScheduleId = et.ScheduleId
			  AND etv.IsActive = 1
			  AND etv.DeletedAt IS NULL
			  AND etv.StartDate <= @monthEnd
			  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
			 WHERE et.ScheduleId = @scheduleId
			   AND et.IsActive = 1
			   AND et.DeletedAt IS NULL
			 ORDER BY et.DisplayOrder ASC, et.Name ASC, et.ShiftId ASC;`
		);
	return (result.recordset as Array<{ ShiftId: number }>).map((row) => Number(row.ShiftId));
}

async function registerAppendShiftOrderForMonth(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	monthStart: string;
	employeeTypeId: number;
	actorOid: string;
}) {
	const activeShiftIds = await getActiveShiftIdsForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart
	});
	if (!activeShiftIds.includes(params.employeeTypeId)) {
		return;
	}

	const fallbackOrderedIds = await getFallbackOrderedShiftIdsForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart
	});
	const resolved = await resolveShiftOrderForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart,
		activeShiftIds,
		fallbackOrderedIds
	});
	const next = resolved.filter((id) => id !== params.employeeTypeId);
	next.push(params.employeeTypeId);
	await upsertShiftOrderSnapshot({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart,
		orderedShiftIds: next,
		actorOid: params.actorOid
	});
}

async function registerReplaceShiftOrderForMonth(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	monthStart: string;
	fromShiftId: number;
	toShiftId: number;
	preferredIndex?: number;
	actorOid: string;
}) {
	const activeShiftIds = await getActiveShiftIdsForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart
	});
	if (!activeShiftIds.includes(params.toShiftId)) {
		return;
	}

	const fallbackOrderedIds = await getFallbackOrderedShiftIdsForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart
	});
	const resolved = await resolveShiftOrderForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart,
		activeShiftIds,
		fallbackOrderedIds
	});

	const monthRow = await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('monthStart', sql.Date, toSqlDateValue(params.monthStart))
		.query(
			`SELECT TOP (1) EffectiveMonth
			 FROM dbo.ScheduleShiftOrders
			 WHERE ScheduleId = @scheduleId
			   AND EffectiveMonth <= @monthStart
			 ORDER BY EffectiveMonth DESC;`
		);
	const anchorMonth = monthRow.recordset?.[0]?.EffectiveMonth as Date | string | undefined;
	let anchorOrder: number[] = [];
	if (anchorMonth) {
		const rows = await req(params.runner)
			.input('scheduleId', params.scheduleId)
			.input('effectiveMonth', sql.Date, new Date(anchorMonth))
			.query(
				`SELECT ShiftId
				 FROM dbo.ScheduleShiftOrders
				 WHERE ScheduleId = @scheduleId
				   AND EffectiveMonth = @effectiveMonth
				 ORDER BY DisplayOrder ASC, ShiftId ASC;`
			);
		anchorOrder = (rows.recordset as Array<{ ShiftId: number }>).map((row) => Number(row.ShiftId));
	}

	const next = resolved.filter((id) => id !== params.toShiftId);
	const anchorIndex = anchorOrder.indexOf(params.fromShiftId);
	if (anchorIndex >= 0 && anchorIndex <= next.length) {
		next.splice(anchorIndex, 0, params.toShiftId);
	} else if (
		typeof params.preferredIndex === 'number' &&
		Number.isInteger(params.preferredIndex) &&
		params.preferredIndex >= 0 &&
		params.preferredIndex <= next.length
	) {
		next.splice(params.preferredIndex, 0, params.toShiftId);
	} else {
		next.push(params.toShiftId);
	}

	await upsertShiftOrderSnapshot({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart,
		orderedShiftIds: next,
		actorOid: params.actorOid
	});
}

async function copyShiftDisplayOrder(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	fromShiftId: number;
	toShiftId: number;
	actorOid: string;
}) {
	await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('fromShiftId', params.fromShiftId)
		.input('toShiftId', params.toShiftId)
		.input('actorOid', params.actorOid)
		.query(
			`UPDATE dst
			 SET dst.DisplayOrder = src.DisplayOrder,
				 dst.UpdatedAt = SYSUTCDATETIME(),
				 dst.UpdatedBy = @actorOid
			 FROM dbo.Shifts dst
			 INNER JOIN dbo.Shifts src
			   ON src.ScheduleId = dst.ScheduleId
			  AND src.ShiftId = @fromShiftId
			 WHERE dst.ScheduleId = @scheduleId
			   AND dst.ShiftId = @toShiftId;`
		);
}

async function replaceShiftInFutureOrderSnapshots(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	monthStart: string;
	fromShiftId: number;
	toShiftId: number;
	actorOid: string;
}) {
	await req(params.runner)
		.input('scheduleId', params.scheduleId)
		.input('monthStart', sql.Date, toSqlDateValue(params.monthStart))
		.input('fromShiftId', params.fromShiftId)
		.input('toShiftId', params.toShiftId)
		.input('actorOid', params.actorOid)
		.query(
			`DELETE target
			 FROM dbo.ScheduleShiftOrders target
			 WHERE target.ScheduleId = @scheduleId
			   AND target.EffectiveMonth >= @monthStart
			   AND target.ShiftId = @toShiftId
			   AND EXISTS (
					SELECT 1
					FROM dbo.ScheduleShiftOrders prior
					WHERE prior.ScheduleId = target.ScheduleId
					  AND prior.EffectiveMonth = target.EffectiveMonth
					  AND prior.ShiftId = @fromShiftId
			   );

			 UPDATE dbo.ScheduleShiftOrders
			 SET ShiftId = @toShiftId,
				 UpdatedAt = SYSUTCDATETIME(),
				 UpdatedBy = @actorOid
			 WHERE ScheduleId = @scheduleId
			   AND EffectiveMonth >= @monthStart
			   AND ShiftId = @fromShiftId;

			 WITH Ordered AS (
				SELECT
					ScheduleId,
					EffectiveMonth,
					ShiftId,
					ROW_NUMBER() OVER (
						PARTITION BY ScheduleId, EffectiveMonth
						ORDER BY DisplayOrder ASC, ShiftId ASC
					) AS NextDisplayOrder
				FROM dbo.ScheduleShiftOrders
				WHERE ScheduleId = @scheduleId
				  AND EffectiveMonth >= @monthStart
			 )
			 UPDATE sso
			 SET DisplayOrder = o.NextDisplayOrder,
				 UpdatedAt = SYSUTCDATETIME(),
				 UpdatedBy = @actorOid
			 FROM dbo.ScheduleShiftOrders sso
			 INNER JOIN Ordered o
			   ON o.ScheduleId = sso.ScheduleId
			  AND o.EffectiveMonth = sso.EffectiveMonth
			  AND o.ShiftId = sso.ShiftId
			 WHERE sso.DisplayOrder <> o.NextDisplayOrder;`
		);
}

async function registerRemoveShiftOrderForMonth(params: {
	runner: sql.ConnectionPool | sql.Transaction;
	scheduleId: number;
	monthStart: string;
	employeeTypeId: number;
	actorOid: string;
}) {
	const activeShiftIds = await getActiveShiftIdsForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart
	});
	const fallbackOrderedIds = await getFallbackOrderedShiftIdsForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart
	});
	const resolved = await resolveShiftOrderForMonth({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart,
		activeShiftIds,
		fallbackOrderedIds
	});
	const next = resolved.filter((id) => id !== params.employeeTypeId);
	await upsertShiftOrderSnapshot({
		runner: params.runner,
		scheduleId: params.scheduleId,
		monthStart: params.monthStart,
		orderedShiftIds: next,
		actorOid: params.actorOid
	});
}

async function createOrReinstateShift(params: {
	tx: sql.Transaction;
	scheduleId: number;
	name: string;
	patternId: number | null;
	startDate: string;
	endDate: string | null;
	actorOid: string;
}): Promise<number> {
	await assertNoNameOverlap({
		runner: params.tx,
		scheduleId: params.scheduleId,
		name: params.name,
		startDate: params.startDate,
		endDate: params.endDate
	});

	const softDeleted = await req(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('name', params.name)
		.query(
			`SELECT TOP (1) ShiftId
			 FROM dbo.Shifts
			 WHERE ScheduleId = @scheduleId
			   AND Name COLLATE ${CASE_SENSITIVE_COLLATION} = @name COLLATE ${CASE_SENSITIVE_COLLATION}
			   AND (IsActive = 0 OR DeletedAt IS NOT NULL)
			 ORDER BY DeletedAt DESC, ShiftId DESC;`
		);

	let employeeTypeId = Number(softDeleted.recordset?.[0]?.ShiftId ?? 0);
	if (employeeTypeId > 0) {
		await req(params.tx)
			.input('scheduleId', params.scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('name', params.name)
			.input('patternId', params.patternId)
			.input('startDate', sql.Date, toSqlDateValue(params.startDate))
			.input('endDate', sql.Date, toNullableSqlDateValue(params.endDate))
			.input('actorOid', params.actorOid)
			.query(
				`UPDATE dbo.Shifts
				 SET Name = @name,
					 PatternId = @patternId,
					 StartDate = @startDate,
					 EndDate = @endDate,
					 IsActive = 1,
					 DeletedAt = NULL,
					 DeletedBy = NULL,
					 UpdatedAt = SYSUTCDATETIME(),
					 UpdatedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;`
			);

		await req(params.tx)
			.input('scheduleId', params.scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`DELETE FROM dbo.ShiftEdits
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;`
			);
	} else {
		const inserted = await req(params.tx)
			.input('scheduleId', params.scheduleId)
			.input('name', params.name)
			.input('patternId', params.patternId)
			.input('startDate', sql.Date, toSqlDateValue(params.startDate))
			.input('endDate', sql.Date, toNullableSqlDateValue(params.endDate))
			.input('actorOid', params.actorOid)
			.query(
				`INSERT INTO dbo.Shifts (
					ScheduleId,
					Name,
					PatternId,
					StartDate,
					EndDate,
					DisplayOrder,
					CreatedBy
				)
				OUTPUT inserted.ShiftId AS ShiftId
				VALUES (
					@scheduleId,
					@name,
					@patternId,
					@startDate,
					@endDate,
					1,
					@actorOid
				);`
			);
		employeeTypeId = Number(inserted.recordset?.[0]?.ShiftId ?? 0);
	}

	if (!employeeTypeId) {
		throw error(500, 'Failed to create shift');
	}

	await replaceVersions({
		runner: params.tx,
		scheduleId: params.scheduleId,
		employeeTypeId,
		actorOid: params.actorOid,
		versions: [
			{
				startDate: params.startDate,
				endDate: params.endDate,
				name: params.name,
				patternId: params.patternId
			}
		]
	});

	await syncShiftMainFromVersions({
		runner: params.tx,
		scheduleId: params.scheduleId,
		employeeTypeId,
		actorOid: params.actorOid
	});

	return employeeTypeId;
}

async function moveShiftScopedDataFromDate(params: {
	tx: sql.Transaction;
	scheduleId: number;
	fromShiftId: number;
	toShiftId: number;
	effectiveStartDate: string;
	actorOid: string;
}) {
	const splitDateEnd = minusOneDay(params.effectiveStartDate);

	await req(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('fromShiftId', params.fromShiftId)
		.input('toShiftId', params.toShiftId)
		.input('effectiveStartDate', sql.Date, toSqlDateValue(params.effectiveStartDate))
		.input('splitDateEnd', sql.Date, toSqlDateValue(splitDateEnd))
		.input('actorOid', params.actorOid)
		.query(
			`UPDATE dbo.ScheduleAssignments
			 SET ShiftId = @toShiftId
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @fromShiftId
			   AND StartDate >= @effectiveStartDate
			   AND IsActive = 1
			   AND DeletedAt IS NULL;

			 DECLARE @AssignmentSplits TABLE (
				UserOid nvarchar(64) NOT NULL,
				EndDate date NULL
			 );

			 INSERT INTO @AssignmentSplits (UserOid, EndDate)
			 SELECT sut.UserOid, sut.EndDate
			 FROM dbo.ScheduleAssignments sut
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.ShiftId = @fromShiftId
			   AND sut.StartDate < @effectiveStartDate
			   AND (sut.EndDate IS NULL OR sut.EndDate >= @effectiveStartDate)
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL;

			 UPDATE dbo.ScheduleAssignments
			 SET EndDate = @splitDateEnd,
				 EndedAt = SYSUTCDATETIME(),
				 EndedBy = @actorOid
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @fromShiftId
			   AND StartDate < @effectiveStartDate
			   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
			   AND IsActive = 1
			   AND DeletedAt IS NULL;

			 INSERT INTO dbo.ScheduleAssignments (
				ScheduleId,
				UserOid,
				ShiftId,
				StartDate,
				EndDate,
				CreatedBy,
				IsActive
			 )
			 SELECT
				@scheduleId,
				split.UserOid,
				@toShiftId,
				@effectiveStartDate,
				split.EndDate,
				@actorOid,
				1
			 FROM @AssignmentSplits split;

			 UPDATE dbo.ScheduleAssignmentOrders
			 SET ShiftId = @toShiftId
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @fromShiftId
			   AND EffectiveMonth >= DATEFROMPARTS(
					YEAR(@effectiveStartDate),
					MONTH(@effectiveStartDate),
					1
			   );

			 UPDATE dbo.ScheduleEvents
			 SET ShiftId = @toShiftId
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @fromShiftId
			   AND StartDate >= @effectiveStartDate
			   AND IsActive = 1
			   AND DeletedAt IS NULL;

			 DECLARE @EventSplits TABLE (
				UserOid nvarchar(64) NULL,
				EndDate date NOT NULL,
				EventCodeId int NULL,
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
				EventCodeId,
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
				se.EventCodeId,
				se.CustomCode,
				se.CustomName,
				se.CustomDisplayMode,
				se.CustomColor,
				se.Title,
				se.Notes,
				se.CreatedBy
			 FROM dbo.ScheduleEvents se
			 WHERE se.ScheduleId = @scheduleId
			   AND se.ShiftId = @fromShiftId
			   AND se.StartDate < @effectiveStartDate
			   AND se.EndDate >= @effectiveStartDate
			   AND se.IsActive = 1
			   AND se.DeletedAt IS NULL;

			 UPDATE dbo.ScheduleEvents
			 SET EndDate = @splitDateEnd
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @fromShiftId
			   AND StartDate < @effectiveStartDate
			   AND EndDate >= @effectiveStartDate
			   AND IsActive = 1
			   AND DeletedAt IS NULL;

			 INSERT INTO dbo.ScheduleEvents (
				ScheduleId,
				UserOid,
				ShiftId,
				StartDate,
				EndDate,
				EventCodeId,
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
				eventSplit.UserOid,
				@toShiftId,
				@effectiveStartDate,
				eventSplit.EndDate,
				eventSplit.EventCodeId,
				eventSplit.CustomCode,
				eventSplit.CustomName,
				eventSplit.CustomDisplayMode,
				eventSplit.CustomColor,
				eventSplit.Title,
				eventSplit.Notes,
				COALESCE(eventSplit.CreatedBy, @actorOid),
				1
			 FROM @EventSplits eventSplit;`
		);
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const month = url.searchParams.get('month')?.trim();
	const monthStart = month ? cleanMonthValue(month, 'month') : `${new Date().toISOString().slice(0, 7)}-01`;
	const monthEnd = monthEndForMonthStart(monthStart);

	const shiftResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', sql.Date, toSqlDateValue(monthStart))
		.input('monthEnd', sql.Date, toSqlDateValue(monthEnd))
		.query(
			`SELECT
				et.ShiftId,
				COALESCE(vAtMonthStart.Name, vInMonth.Name) AS Name,
				COALESCE(vAtMonthStart.PatternId, vInMonth.PatternId) AS PatternId,
				p.Name AS PatternName,
				COALESCE(vAtMonthStart.StartDate, vInMonth.StartDate) AS StartDate,
				COALESCE(vAtMonthStart.EndDate, vInMonth.EndDate) AS EndDate
			 FROM dbo.Shifts et
			 OUTER APPLY (
				SELECT TOP (1) etv.Name, etv.PatternId, etv.StartDate, etv.EndDate
				FROM dbo.ShiftEdits etv
				WHERE etv.ScheduleId = et.ScheduleId
				  AND etv.ShiftId = et.ShiftId
				  AND etv.IsActive = 1
				  AND etv.DeletedAt IS NULL
				  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
				  AND etv.StartDate <= @monthStart
				ORDER BY etv.StartDate DESC
			 ) vAtMonthStart
			 OUTER APPLY (
				SELECT TOP (1) etv.Name, etv.PatternId, etv.StartDate, etv.EndDate
				FROM dbo.ShiftEdits etv
				WHERE etv.ScheduleId = et.ScheduleId
				  AND etv.ShiftId = et.ShiftId
				  AND etv.IsActive = 1
				  AND etv.DeletedAt IS NULL
				  AND etv.StartDate > @monthStart
				  AND etv.StartDate <= @monthEnd
				  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
				ORDER BY etv.StartDate ASC
			 ) vInMonth
			 LEFT JOIN dbo.Patterns p
				ON p.PatternId = COALESCE(vAtMonthStart.PatternId, vInMonth.PatternId)
			   AND p.ScheduleId = et.ScheduleId
			   AND p.IsActive = 1
			   AND p.DeletedAt IS NULL
			 WHERE et.ScheduleId = @scheduleId
			   AND et.IsActive = 1
			   AND et.DeletedAt IS NULL
			   AND COALESCE(vAtMonthStart.StartDate, vInMonth.StartDate) IS NOT NULL;`
		);

	const historyResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			`SELECT
				etv.ShiftId,
				etv.StartDate,
				etv.EndDate,
				etv.Name,
				etv.PatternId,
				COALESCE(etv.UpdatedAt, etv.CreatedAt) AS ModifiedAt,
				p.Name AS PatternName
			 FROM dbo.ShiftEdits etv
			 LEFT JOIN dbo.Patterns p
				ON p.PatternId = etv.PatternId
			   AND p.ScheduleId = etv.ScheduleId
			   AND p.IsActive = 1
			   AND p.DeletedAt IS NULL
			 WHERE etv.ScheduleId = @scheduleId
			   AND etv.IsActive = 1
			   AND etv.DeletedAt IS NULL
			 ORDER BY etv.ShiftId ASC, etv.StartDate ASC;`
		);

	const activeShiftIds = (shiftResult.recordset as ShiftRow[]).map((row) => Number(row.ShiftId));
	const fallbackOrderedIds = await getFallbackOrderedShiftIdsForMonth({
		runner: pool,
		scheduleId,
		monthStart
	});
	const orderedShiftIds = await resolveShiftOrderForMonth({
		runner: pool,
		scheduleId,
		monthStart,
		activeShiftIds,
		fallbackOrderedIds
	});
	const orderMap = new Map(orderedShiftIds.map((id, index) => [id, index + 1]));

	const historyByShift = new Map<
		number,
		Array<{
			sortOrder: number;
			startDate: string;
			endDate: string | null;
			name: string;
			patternId: number | null;
			pattern: string;
			versionStamp: string;
			modifiedAtIso: string | null;
		}>
	>();

	for (const row of historyResult.recordset as Array<VersionRow & { ShiftId: number; PatternName: string | null }>) {
		const employeeTypeId = Number(row.ShiftId);
		const list = historyByShift.get(employeeTypeId) ?? [];
		const startDate = toDateOnly(row.StartDate) ?? '';
		const modifiedAtIso = toDateTimeIso((row as VersionRow).ModifiedAt);
		list.push({
			sortOrder: orderMap.get(employeeTypeId) ?? Number.MAX_SAFE_INTEGER,
			startDate,
			endDate: toDateOnly(row.EndDate),
			name: row.Name,
			patternId: row.PatternId,
			pattern: row.PatternName?.trim() || '',
			versionStamp: versionStampForVersion(startDate, modifiedAtIso),
			modifiedAtIso
		});
		historyByShift.set(employeeTypeId, list);
	}

	const shifts = (shiftResult.recordset as ShiftRow[])
		.map((row) => {
			const employeeTypeId = Number(row.ShiftId);
			const historyRows = historyByShift.get(employeeTypeId) ?? [];
			return {
				employeeTypeId,
				sortOrder: orderMap.get(employeeTypeId) ?? Number.MAX_SAFE_INTEGER,
				name: row.Name,
				patternId: row.PatternId,
				pattern: row.PatternName?.trim() || '',
				startDate: toDateOnly(row.StartDate) ?? '',
				endDate: toDateOnly(row.EndDate),
				versionStamp: shiftVersionStampForVersions(historyRows),
				changes: historyRows.map(({ modifiedAtIso: _modifiedAtIso, ...change }) => change)
			};
		})
		.sort((a, b) => {
			if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
			const nameDiff = a.name.localeCompare(b.name);
			if (nameDiff !== 0) return nameDiff;
			return a.employeeTypeId - b.employeeTypeId;
		});

	return json({ shifts });
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
	const startDate = cleanDateOnly(body?.startDate, 'Start date');
	const endDate = cleanOptionalDateOnly(body?.endDate, 'End date');
	if (endDate && endDate < startDate) {
		throw error(400, 'End date must be on or after start date');
	}

	await ensurePatternExists(pool, scheduleId, patternId);

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const employeeTypeId = await createOrReinstateShift({
			tx,
			scheduleId,
			name,
			patternId,
			startDate,
			endDate,
			actorOid
		});

		await registerAppendShiftOrderForMonth({
			runner: tx,
			scheduleId,
			monthStart: monthStartForDate(startDate),
			employeeTypeId,
			actorOid
		});

		await tx.commit();
	} catch (err) {
		try {
			await tx.rollback();
		} catch {
			// keep original error
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
	const employeeTypeId = cleanShiftId(body?.employeeTypeId);
	const reorderOnly = body?.reorderOnly === true;

	if (reorderOnly) {
		const startDate = cleanDateOnly(body?.startDate, 'Start date');
		const monthStart = monthStartForDate(startDate);
		const orderedShiftIds = cleanShiftIdList(body?.orderedShiftIds);
		const logContext = {
			scheduleId,
			actorOid,
			sourceShiftId: employeeTypeId,
			startDate,
			monthStart,
			orderedShiftIds
		};

		const tx = new sql.Transaction(pool);
		await tx.begin();
		try {
			logShiftReorderServer('PATCH reorder request received', logContext);
			const activeShiftIds = await getActiveShiftIdsForMonth({
				runner: tx,
				scheduleId,
				monthStart
			});
			logShiftReorderServer('Active shifts for month resolved', {
				...logContext,
				activeShiftIds
			});
			const activeSet = new Set(activeShiftIds);
			if (orderedShiftIds.length !== activeShiftIds.length) {
				logShiftReorderServer('Rejecting reorder: count mismatch', {
					...logContext,
					activeShiftIds
				});
				throw error(400, 'orderedShiftIds must include all shifts active in the selected month');
			}
			if (!orderedShiftIds.every((id) => activeSet.has(id))) {
				logShiftReorderServer('Rejecting reorder: contains invalid shift IDs', {
					...logContext,
					activeShiftIds
				});
				throw error(400, 'orderedShiftIds includes invalid shifts for the selected month');
			}

			await upsertShiftOrderSnapshot({
				runner: tx,
				scheduleId,
				monthStart,
				orderedShiftIds: orderedShiftIds,
				actorOid
			});
			const persistedRows = await req(tx)
				.input('scheduleId', scheduleId)
				.input('monthStart', sql.Date, toSqlDateValue(monthStart))
				.query(
					`SELECT ShiftId
					 FROM dbo.ScheduleShiftOrders
					 WHERE ScheduleId = @scheduleId
					   AND EffectiveMonth = @monthStart
					 ORDER BY DisplayOrder ASC, ShiftId ASC;`
				);
			const persistedShiftIds = (persistedRows.recordset as Array<{ ShiftId: number }>).map((row) =>
				Number(row.ShiftId)
			);

			const fallbackOrderedIds = await getFallbackOrderedShiftIdsForMonth({
				runner: tx,
				scheduleId,
				monthStart
			});
			const resolvedOrder = await resolveShiftOrderForMonth({
				runner: tx,
				scheduleId,
				monthStart,
				activeShiftIds,
				fallbackOrderedIds
			});
			logShiftReorderServer('Persisted month snapshot after upsert', {
				...logContext,
				persistedShiftIds,
				resolvedOrder
			});
			await tx.commit();
			logShiftReorderServer('PATCH reorder committed', logContext);
		} catch (err) {
			try {
				await tx.rollback();
			} catch {
				// keep original error
			}
			logShiftReorderServer('PATCH reorder failed', {
				...logContext,
				error: err instanceof Error ? err.message : String(err)
			});
			throw err;
		}
		return json({ success: true });
	}

	const name = cleanRequiredText(body?.name, 50, 'Shift name');
	const patternId = cleanOptionalPatternId(body?.patternId);
	const startDate = cleanDateOnly(body?.startDate, 'Change effective date');
	const endDate = cleanOptionalDateOnly(body?.endDate, 'End date');
	if (endDate && endDate < startDate) {
		throw error(400, 'End date must be on or after change effective date');
	}

	const editMode =
		typeof body?.editMode === 'string' && body.editMode.trim().toLowerCase() === 'history'
			? 'history'
			: 'timeline';
	const changeStartDate =
		editMode === 'history' ? cleanDateOnly(body?.changeStartDate, 'Change start date') : null;
	const expectedShiftVersionStamp = cleanRequiredVersionStamp(
		body?.expectedShiftVersionStamp,
		'Shift version stamp'
	);
	const expectedChangeVersionStamp =
		editMode === 'history'
			? cleanRequiredVersionStamp(body?.expectedChangeVersionStamp, 'Change version stamp')
			: null;

	await ensurePatternExists(pool, scheduleId, patternId);
	await ensureShiftExists(pool, scheduleId, employeeTypeId);

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const versionsBefore = await loadVersions(tx, scheduleId, employeeTypeId);
		if (versionsBefore.length === 0) {
			throw error(400, 'Shift has no editable entries');
		}
		const currentShiftVersionStamp = shiftVersionStampForVersions(versionsBefore);
		if (currentShiftVersionStamp !== expectedShiftVersionStamp) {
			throw error(409, 'This shift has changed. Refresh and try again.');
		}
		const oldPrimaryStart = versionsBefore[0]?.startDate ?? startDate;

		let sourceForName: (typeof versionsBefore)[number] | null = null;
		if (editMode === 'history' && changeStartDate) {
			sourceForName = versionsBefore.find((row) => row.startDate === changeStartDate) ?? null;
			if (!sourceForName) {
				throw error(404, 'Shift not found');
			}
			if (expectedChangeVersionStamp && sourceForName.versionStamp !== expectedChangeVersionStamp) {
				throw error(409, 'This shift change has changed. Refresh and try again.');
			}
		} else {
			sourceForName =
				versionsBefore.find((row) => rangesOverlap(row.startDate, row.endDate, startDate, startDate)) ??
				versionsBefore[versionsBefore.length - 1];
		}
		const oldName = sourceForName?.name ?? name;
		const rename = oldName !== name;

		if (rename) {
			const reorderMonthStart = monthStartForDate(startDate);
			const preRenameActiveShiftIds = await getActiveShiftIdsForMonth({
				runner: tx,
				scheduleId,
				monthStart: reorderMonthStart
			});
			const preRenameFallbackOrderedIds = await getFallbackOrderedShiftIdsForMonth({
				runner: tx,
				scheduleId,
				monthStart: reorderMonthStart
			});
			const preRenameResolvedOrder = await resolveShiftOrderForMonth({
				runner: tx,
				scheduleId,
				monthStart: reorderMonthStart,
				activeShiftIds: preRenameActiveShiftIds,
				fallbackOrderedIds: preRenameFallbackOrderedIds
			});
			const preRenameIndex = preRenameResolvedOrder.indexOf(employeeTypeId);

			await assertNoNameOverlap({
				runner: tx,
				scheduleId,
				name,
				startDate,
				endDate,
				excludeShiftId: employeeTypeId
			});

			const newShiftId = await createOrReinstateShift({
				tx,
				scheduleId,
				name,
				patternId,
				startDate,
				endDate,
				actorOid
			});

			// If the rename effective date is before the old primary start, the rename acts as
			// a full replacement. Do not carry old future versions into the new shift.
			const moveFutureVersions =
				startDate < oldPrimaryStart
					? []
					: versionsBefore
							.filter((row) => row.startDate > startDate)
							.map(({ startDate: rowStartDate, endDate: rowEndDate, name: rowName, patternId: rowPatternId }) => ({
								startDate: rowStartDate,
								endDate: rowEndDate,
								name: rowName,
								patternId: rowPatternId
							}));
			const oldRemaining = versionsBefore
				.filter((row) => row.startDate < startDate)
				.map(({ startDate: rowStartDate, endDate: rowEndDate, name: rowName, patternId: rowPatternId }) => {
					if (!rowEndDate || rowEndDate >= startDate) {
						return {
							startDate: rowStartDate,
							endDate: minusOneDay(startDate),
							name: rowName,
							patternId: rowPatternId
						};
					}
					return {
						startDate: rowStartDate,
						endDate: rowEndDate,
						name: rowName,
						patternId: rowPatternId
					};
				})
				.filter((row) => row.endDate === null || row.endDate >= row.startDate);
			oldRemaining.sort((a, b) => a.startDate.localeCompare(b.startDate));

			if (moveFutureVersions.length > 0) {
				const targetVersions = (await loadVersions(tx, scheduleId, newShiftId)).map(
					({ startDate: rowStartDate, endDate: rowEndDate, name: rowName, patternId: rowPatternId }) => ({
						startDate: rowStartDate,
						endDate: rowEndDate,
						name: rowName,
						patternId: rowPatternId
					})
				);
				let merged = [...targetVersions];
				for (const moved of moveFutureVersions) {
					merged = applyIntervalSurgery({ existing: merged, inserted: moved });
				}
				await replaceVersions({
					runner: tx,
					scheduleId,
					employeeTypeId: newShiftId,
					actorOid,
					versions: merged
				});
			}

			await replaceVersions({
				runner: tx,
				scheduleId,
				employeeTypeId,
				actorOid,
				versions: oldRemaining
			});

			await moveShiftScopedDataFromDate({
				tx,
				scheduleId,
				fromShiftId: employeeTypeId,
				toShiftId: newShiftId,
				effectiveStartDate: startDate,
				actorOid
			});

			await copyShiftDisplayOrder({
				runner: tx,
				scheduleId,
				fromShiftId: employeeTypeId,
				toShiftId: newShiftId,
				actorOid
			});
			await replaceShiftInFutureOrderSnapshots({
				runner: tx,
				scheduleId,
				monthStart: reorderMonthStart,
				fromShiftId: employeeTypeId,
				toShiftId: newShiftId,
				actorOid
			});

			if (endDate) {
				await cleanupShiftScopedDataAfterEndDate({
					runner: tx,
					scheduleId,
					employeeTypeId: newShiftId,
					endDate,
					actorOid
				});
			}

			await syncShiftMainFromVersions({
				runner: tx,
				scheduleId,
				employeeTypeId,
				actorOid
			});
			await syncShiftMainFromVersions({
				runner: tx,
				scheduleId,
				employeeTypeId: newShiftId,
				actorOid
			});

			await registerReplaceShiftOrderForMonth({
				runner: tx,
				scheduleId,
				monthStart: reorderMonthStart,
				fromShiftId: employeeTypeId,
				toShiftId: newShiftId,
				preferredIndex: preRenameIndex >= 0 ? preRenameIndex : undefined,
				actorOid
			});

			await tx.commit();
			return json({ success: true, mode: 'rename' });
		}

		await assertNoNameOverlap({
			runner: tx,
			scheduleId,
			name,
			startDate,
			endDate,
			excludeShiftId: employeeTypeId
		});

		let working = [...versionsBefore];
		if (editMode === 'history' && changeStartDate) {
			const exists = working.some((entry) => entry.startDate === changeStartDate);
			if (!exists) {
				throw error(404, 'Shift not found');
			}
			working = working.filter((entry) => entry.startDate !== changeStartDate);
		}

		const rebuilt = applyIntervalSurgery({
			existing: working,
			inserted: {
				startDate,
				endDate,
				name,
				patternId
			}
		});

		await replaceVersions({
			runner: tx,
			scheduleId,
			employeeTypeId,
			actorOid,
			versions: rebuilt
		});

		const versionsAfter = await loadVersions(tx, scheduleId, employeeTypeId);
		const hasOpenEndedVersion = versionsAfter.some((row) => row.endDate === null);
		const terminalShiftEndDate = hasOpenEndedVersion
			? null
			: versionsAfter.reduce<string | null>((latest, row) => {
					if (!row.endDate) return latest;
					if (!latest || row.endDate > latest) return row.endDate;
					return latest;
				}, null);
		if (terminalShiftEndDate) {
			await cleanupShiftScopedDataAfterEndDate({
				runner: tx,
				scheduleId,
				employeeTypeId,
				endDate: terminalShiftEndDate,
				actorOid
			});
		}

		await syncShiftMainFromVersions({
			runner: tx,
			scheduleId,
			employeeTypeId,
			actorOid
		});

		await tx.commit();
	} catch (err) {
		try {
			await tx.rollback();
		} catch {
			// keep original error
		}
		throw err;
	}

	return json({ success: true });
};

export const DELETE: RequestHandler = async (event) => {
	const { locals, cookies, request } = event;
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = (await request.json().catch(() => null)) as RemoveShiftPayload | null;
	const employeeTypeId = cleanShiftId(body?.employeeTypeId);
	const editMode =
		typeof body?.editMode === 'string' && body.editMode.trim().toLowerCase() === 'history'
			? 'history'
			: 'timeline';
	const changeStartDate =
		editMode === 'history' ? cleanDateOnly(body?.changeStartDate, 'Change start date') : null;
	const expectedShiftVersionStamp = cleanRequiredVersionStamp(
		body?.expectedShiftVersionStamp,
		'Shift version stamp'
	);
	const expectedChangeVersionStamp =
		editMode === 'history'
			? cleanRequiredVersionStamp(body?.expectedChangeVersionStamp, 'Change version stamp')
			: null;
	const confirmUsedShiftRemoval = cleanBoolean(body?.confirmUsedShiftRemoval);

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		await ensureShiftExists(tx, scheduleId, employeeTypeId);
		const versionsBefore = await loadVersions(tx, scheduleId, employeeTypeId);
		if (versionsBefore.length === 0) {
			throw error(404, 'Shift not found');
		}
		const currentShiftVersionStamp = shiftVersionStampForVersions(versionsBefore);
		if (currentShiftVersionStamp !== expectedShiftVersionStamp) {
			throw error(409, 'This shift has changed. Refresh and try again.');
		}

		if (editMode === 'history' && changeStartDate) {
			const targetVersion = versionsBefore.find((entry) => entry.startDate === changeStartDate) ?? null;
			if (!targetVersion) {
				throw error(404, 'Shift not found');
			}
			if (expectedChangeVersionStamp && targetVersion.versionStamp !== expectedChangeVersionStamp) {
				throw error(409, 'This shift change has changed. Refresh and try again.');
			}

			await req(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.input('changeStartDate', changeStartDate)
				.query(
					`DELETE FROM dbo.ShiftEdits
					 WHERE ScheduleId = @scheduleId
					   AND ShiftId = @employeeTypeId
					   AND StartDate = @changeStartDate
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);

			await syncShiftMainFromVersions({
				runner: tx,
				scheduleId,
				employeeTypeId,
				actorOid
			});

			await tx.commit();
			return json({ success: true, removalMode: 'history_removed' });
		}

		const assignmentStats = await req(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`SELECT COUNT(*) AS AssignmentCount
				 FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		const hasEverBeenInUse = Number(assignmentStats.recordset?.[0]?.AssignmentCount ?? 0) > 0;

		if (hasEverBeenInUse && !confirmUsedShiftRemoval) {
			const impactCounts = await req(tx)
				.input('scheduleId', scheduleId)
				.input('employeeTypeId', employeeTypeId)
				.query(
					`SELECT
						(SELECT COUNT(*) FROM dbo.ScheduleAssignments
						 WHERE ScheduleId = @scheduleId AND ShiftId = @employeeTypeId
						   AND IsActive = 1 AND DeletedAt IS NULL) AS AssignmentCount,
						(SELECT COUNT(*) FROM dbo.ScheduleEvents
						 WHERE ScheduleId = @scheduleId AND ShiftId = @employeeTypeId
						   AND IsActive = 1 AND DeletedAt IS NULL) AS ShiftEventCount,
						(SELECT COUNT(*) FROM dbo.ShiftEdits
						 WHERE ScheduleId = @scheduleId AND ShiftId = @employeeTypeId
						   AND IsActive = 1 AND DeletedAt IS NULL) AS ShiftChangeCount;`
				);

			await tx.rollback();
			return json(
				{
					code: 'SHIFT_IN_USE_CONFIRMATION',
					message:
						'This shift has been used in assignments. Deleting it will permanently remove assignment and related event history.',
					assignmentCount: Number(impactCounts.recordset?.[0]?.AssignmentCount ?? 0),
					shiftEventCount: Number(impactCounts.recordset?.[0]?.ShiftEventCount ?? 0),
					shiftChangeCount: Number(impactCounts.recordset?.[0]?.ShiftChangeCount ?? 0)
				},
				{ status: 409 }
			);
		}

		const firstStart = await req(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`SELECT TOP (1) StartDate
				 FROM dbo.ShiftEdits
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				 ORDER BY StartDate ASC;`
			);
		const removalStartDate =
			toDateOnly(firstStart.recordset?.[0]?.StartDate) ?? new Date().toISOString().slice(0, 10);
		const serverDateResult = await req(tx).query(`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`);
		const today = toDateOnly(serverDateResult.recordset?.[0]?.Today) ?? '';
		if (!today) {
			throw error(500, 'Could not resolve current server date');
		}
		const currentShiftName = versionsBefore[versionsBefore.length - 1]?.name?.trim() || 'Unknown shift';
		const impactedAssignmentsResult = await req(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('today', today)
			.query(
				`WITH RankedImpacted AS (
					SELECT
						sut.UserOid,
						CASE WHEN sut.StartDate <= @today THEN @today ELSE sut.StartDate END AS NotifyDate,
						ROW_NUMBER() OVER (
							PARTITION BY sut.UserOid
							ORDER BY
								CASE WHEN sut.StartDate <= @today THEN 0 ELSE 1 END ASC,
								CASE WHEN sut.StartDate <= @today THEN sut.StartDate END DESC,
								CASE WHEN sut.StartDate > @today THEN sut.StartDate END ASC
						) AS RowNum
					FROM dbo.ScheduleAssignments sut
					WHERE sut.ScheduleId = @scheduleId
					  AND sut.ShiftId = @employeeTypeId
					  AND sut.IsActive = 1
					  AND sut.DeletedAt IS NULL
					  AND (sut.EndDate IS NULL OR sut.EndDate >= @today)
				)
				SELECT UserOid, NotifyDate
				FROM RankedImpacted
				WHERE RowNum = 1;`
			);
		const impactedNotifications = (impactedAssignmentsResult.recordset as Array<{
			UserOid: string;
			NotifyDate: Date | string;
		}>).map((row) => ({
			userOid: row.UserOid,
			notifyDate: toDateOnly(row.NotifyDate) ?? today
		})) satisfies ImpactedShiftAssignmentNotification[];

		await req(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.query(
				`DELETE se
				 FROM dbo.ScheduleEvents se
				 WHERE se.ScheduleId = @scheduleId
				   AND se.UserOid IS NOT NULL
				   AND se.IsActive = 1
				   AND se.DeletedAt IS NULL
				   AND EXISTS (
						SELECT 1
						FROM dbo.ScheduleAssignments sut
						WHERE sut.ScheduleId = @scheduleId
						  AND sut.ShiftId = @employeeTypeId
						  AND sut.UserOid = se.UserOid
						  AND sut.IsActive = 1
						  AND sut.DeletedAt IS NULL
						  AND se.StartDate <= ISNULL(sut.EndDate, '9999-12-31')
						  AND se.EndDate >= sut.StartDate
				   );

				 DELETE FROM dbo.ScheduleEvents
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;

				 DELETE FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;

				 DELETE FROM dbo.ShiftEdits
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;

				 DELETE FROM dbo.ScheduleShiftOrders
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;

				 DELETE FROM dbo.ScheduleAssignmentOrders
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;

				 DELETE FROM dbo.Shifts
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId;`
			);

		await req(tx)
			.input('scheduleId', scheduleId)
			.query(
				`WITH Ordered AS (
					SELECT
						ScheduleId,
						EffectiveMonth,
						ShiftId,
						ROW_NUMBER() OVER (
							PARTITION BY ScheduleId, EffectiveMonth
							ORDER BY DisplayOrder ASC, ShiftId ASC
						) AS NextDisplayOrder
					FROM dbo.ScheduleShiftOrders
					WHERE ScheduleId = @scheduleId
				)
				UPDATE soi
				SET DisplayOrder = o.NextDisplayOrder,
					UpdatedAt = SYSUTCDATETIME(),
					UpdatedBy = NULL
				FROM dbo.ScheduleShiftOrders soi
				INNER JOIN Ordered o
				  ON o.ScheduleId = soi.ScheduleId
				 AND o.EffectiveMonth = soi.EffectiveMonth
				 AND o.ShiftId = soi.ShiftId
				WHERE soi.DisplayOrder <> o.NextDisplayOrder;

				DELETE som
				FROM dbo.ScheduleShiftOrders som
				WHERE som.ScheduleId = @scheduleId
				  AND NOT EXISTS (
					SELECT 1
					FROM dbo.ScheduleShiftOrders soi
					WHERE soi.ScheduleId = som.ScheduleId
					  AND soi.EffectiveMonth = som.EffectiveMonth
				  );`
			);

		await registerRemoveShiftOrderForMonth({
			runner: tx,
			scheduleId,
			monthStart: monthStartForDate(removalStartDate),
			employeeTypeId,
			actorOid
		});

		await tx.commit();

		for (const impacted of impactedNotifications) {
			const emailContext = await getShiftEmailContext({
				pool,
				scheduleId,
				targetUserOid: impacted.userOid,
				actorUserOid: actorOid
			});
			if (!emailContext) continue;
			try {
				const newShift = await getEffectiveShiftNameForDate(
					new sql.Request(pool),
					scheduleId,
					impacted.userOid,
					impacted.notifyDate
				);
				const delegatedAccessToken = await getSessionAccessToken(event);
				await sendShiftChangeNotification({
					scheduleName: emailContext.scheduleName,
					themeJson: emailContext.scheduleThemeJson,
					intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
					targetMemberName: emailContext.targetDisplayName,
					date: impacted.notifyDate,
					previousShift: currentShiftName,
					newShift,
					triggeringUserName: emailContext.actorDisplayName,
					delegatedAccessToken
				});
			} catch (notificationError) {
				console.error('Shift change notification failed:', notificationError);
			}
		}

		return json({ success: true, removalMode: 'hard_deleted' });
	} catch (err) {
		try {
			await tx.rollback();
		} catch {
			// keep original error
		}
		throw err;
	}
};
