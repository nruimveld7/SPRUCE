import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestEvent, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId, getSessionAccessToken } from '$lib/server/auth';
import sql from 'mssql';
import { sendShiftChangeNotification } from '$lib/server/mail/notifications';
import { requireScheduleRole } from '$lib/server/schedule-access';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

type AssignmentRow = {
	UserOid: string;
	ShiftId: number;
	StartDate: Date | string;
	EndDate: Date | string | null;
	UserName: string | null;
	ShiftName: string | null;
	ModifiedAt?: Date | string | null;
};

type ShiftEmailContext = {
	scheduleName: string;
	scheduleThemeJson: string | null;
	targetDisplayName: string;
	targetEmail: string | null;
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

function cleanOptionalDateOnly(value: unknown, label: string): string | null {
	if (value === null || value === undefined || value === '') return null;
	return cleanDateOnly(value, label);
}

function toDateOnly(value: Date | string | null): string | null {
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

function assignmentVersionStamp(startDate: string, modifiedAtIso: string | null): string {
	return `${startDate}|${modifiedAtIso ?? '0'}`;
}

function assignmentTimelineVersionStamp(
	changes: Array<{ startDate: string; modifiedAtIso: string | null }>
): string {
	const latestModifiedAtIso = changes.reduce<string | null>((latest, change) => {
		if (!change.modifiedAtIso) return latest;
		if (!latest || change.modifiedAtIso > latest) return change.modifiedAtIso;
		return latest;
	}, null);
	return `${changes.length}|${latestModifiedAtIso ?? '0'}`;
}

function minusOneDay(dateOnly: string): string {
	const utcDate = new Date(`${dateOnly}T00:00:00Z`);
	return toDateOnly(new Date(utcDate.getTime() - 24 * 60 * 60 * 1000)) ?? dateOnly;
}

function cleanAsOfDate(value: string | null): string | null {
	if (!value) return null;
	return cleanDateOnly(value, 'asOf');
}

function cleanOptionalMonth(value: unknown, label: string): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') {
		throw error(400, `${label} must be in YYYY-MM format`);
	}
	const trimmed = value.trim();
	const match = /^(\d{4})-(\d{2})$/.exec(trimmed);
	if (!match) {
		throw error(400, `${label} must be in YYYY-MM format`);
	}
	const month = Number(match[2]);
	if (!Number.isInteger(month) || month < 1 || month > 12) {
		throw error(400, `${label} must be in YYYY-MM format`);
	}
	return trimmed;
}

function monthWindow(monthValue: string): { start: string; end: string } {
	const [yearText, monthText] = monthValue.split('-');
	const year = Number(yearText);
	const month = Number(monthText);
	const start = new Date(Date.UTC(year, month - 1, 1));
	const end = new Date(Date.UTC(year, month, 0));
	const toIso = (value: Date) => value.toISOString().slice(0, 10);
	return { start: toIso(start), end: toIso(end) };
}

function monthStartFromMonthValue(monthValue: string): string {
	return `${monthValue}-01`;
}

function dateWithinAssignmentWindow(
	date: string,
	startDate: string,
	endDate: string | null | undefined
): boolean {
	const effectiveEnd = endDate && endDate.trim() ? endDate : '9999-12-31';
	return startDate <= date && effectiveEnd >= date;
}

function parseOrderedAssignmentUserOid(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	const pipeIndex = trimmed.indexOf('|');
	if (pipeIndex <= 0) return trimmed;
	return trimmed.slice(0, pipeIndex);
}

function cleanRequiredStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw error(400, `${label} is required`);
	}
	const values = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
	if (values.some((entry) => !entry)) {
		throw error(400, `${label} must contain valid values`);
	}
	if (new Set(values).size !== values.length) {
		throw error(400, `${label} contains duplicates`);
	}
	return values;
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

async function resolveAssignmentOrderForMonth(params: {
	pool: sql.ConnectionPool;
	scheduleId: number;
	monthStart: string;
	shiftId: number;
	activeUserOids: string[];
	fallbackOrderedUserOids: string[];
}): Promise<string[]> {
	const { pool, scheduleId, monthStart, shiftId, activeUserOids, fallbackOrderedUserOids } = params;
	const activeSet = new Set(activeUserOids);
	if (activeSet.size === 0) return [];

	const monthRow = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('shiftId', shiftId)
		.input('monthStart', monthStart)
		.query(
			`SELECT TOP (1) EffectiveMonth
			 FROM dbo.ScheduleAssignmentOrders
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @shiftId
			   AND EffectiveMonth <= @monthStart
			 ORDER BY EffectiveMonth DESC;`
		);
	const resolvedMonth = toDateOnly(monthRow.recordset?.[0]?.EffectiveMonth) ?? null;
	const ordered: string[] = [];

	if (resolvedMonth) {
		const rows = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('shiftId', shiftId)
			.input('effectiveMonth', resolvedMonth)
			.query(
				`SELECT UserOid
				 FROM dbo.ScheduleAssignmentOrders
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @shiftId
				   AND EffectiveMonth = @effectiveMonth
				 ORDER BY DisplayOrder ASC, UserOid ASC;`
			);
		for (const row of rows.recordset as Array<{ UserOid: string }>) {
			const userOid = row.UserOid;
			if (activeSet.has(userOid) && !ordered.includes(userOid)) {
				ordered.push(userOid);
			}
		}
	}

	for (const userOid of fallbackOrderedUserOids) {
		if (activeSet.has(userOid) && !ordered.includes(userOid)) {
			ordered.push(userOid);
		}
	}
	for (const userOid of activeUserOids) {
		if (!ordered.includes(userOid)) {
			ordered.push(userOid);
		}
	}
	return ordered;
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
			 FROM dbo.Shifts
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @employeeTypeId
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
	endDate: string | null;
	scopeToEmployeeType: boolean;
}): Promise<{ targetEndDate: string | null }> {
	const {
		tx,
		scheduleId,
		actorOid,
		userOid,
		employeeTypeId,
		startDate,
		endDate,
		scopeToEmployeeType
	} = params;
	const employeeTypeFilter = scopeToEmployeeType ? 'AND ShiftId = @employeeTypeId' : '';

	const timelineResult = await new sql.Request(tx)
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.input('employeeTypeId', employeeTypeId)
		.input('effectiveStartDate', startDate)
		.query(
			`SELECT
				(SELECT TOP (1) StartDate
				 FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   ${employeeTypeFilter}
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate > @effectiveStartDate
				 ORDER BY StartDate ASC) AS NextStartDate,
				(SELECT TOP (1) StartDate
				 FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   ${employeeTypeFilter}
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate = @effectiveStartDate
				 ORDER BY ShiftId ASC) AS ExactStartDate,
				(SELECT TOP (1) StartDate
				 FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   ${employeeTypeFilter}
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate < @effectiveStartDate
				   AND (EndDate IS NULL OR EndDate >= @effectiveStartDate)
				 ORDER BY StartDate DESC, ShiftId ASC) AS ContainingStartDate;`
		);

	const nextStartDate = toDateOnly(timelineResult.recordset?.[0]?.NextStartDate);
	const exactStartDate = toDateOnly(timelineResult.recordset?.[0]?.ExactStartDate);
	const containingStartDate = toDateOnly(timelineResult.recordset?.[0]?.ContainingStartDate);
	const naturalEndDate = nextStartDate
		? toDateOnly(new Date(new Date(`${nextStartDate}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000))
		: null;
	const targetEndDate = endDate ?? naturalEndDate;
	if (nextStartDate && targetEndDate && targetEndDate >= nextStartDate) {
		throw error(400, 'End date must be before the next assignment change');
	}

	if (containingStartDate) {
		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('employeeTypeId', employeeTypeId)
			.input('containingStartDate', containingStartDate)
			.input('effectiveStartDate', startDate)
			.input('actorOid', actorOid)
			.query(
				`UPDATE dbo.ScheduleAssignments
				 SET EndDate = DATEADD(day, -1, @effectiveStartDate),
					 EndedAt = SYSUTCDATETIME(),
					 EndedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   ${employeeTypeFilter}
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
			.input('targetEndDate', targetEndDate)
			.input('actorOid', actorOid)
			.query(
				`UPDATE dbo.ScheduleAssignments
				 SET ShiftId = @employeeTypeId,
					 EndDate = @targetEndDate,
					 EndedAt = CASE WHEN @targetEndDate IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
					 EndedBy = CASE WHEN @targetEndDate IS NULL THEN NULL ELSE @actorOid END
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   ${employeeTypeFilter}
				   AND StartDate = @effectiveStartDate
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		return { targetEndDate };
	}

	await new sql.Request(tx)
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.input('employeeTypeId', employeeTypeId)
		.input('effectiveStartDate', startDate)
		.input('targetEndDate', targetEndDate)
		.input('actorOid', actorOid)
		.query(
			`INSERT INTO dbo.ScheduleAssignments (
				ScheduleId,
				UserOid,
				ShiftId,
				StartDate,
				EndDate,
				CreatedBy
			)
			VALUES (
				@scheduleId,
				@userOid,
				@employeeTypeId,
				@effectiveStartDate,
				@targetEndDate,
				@actorOid
			);`
		);

	return { targetEndDate };
}

function assignmentAffectsCurrentOrFuture(params: {
	startDate: string;
	endDate: string | null;
	today: string;
}): boolean {
	const { startDate, endDate, today } = params;
	if (startDate >= today) return true;
	return endDate === null || endDate >= today;
}

type AssignmentOrderCandidate = {
	userOid: string;
	firstStartDate: string;
	firstCreatedAtIso: string | null;
};

function compareMonthStart(a: string, b: string): number {
	return a.localeCompare(b);
}

function monthStartFromDateOnly(dateOnly: string): string {
	return monthStartFromMonthValue(dateOnly.slice(0, 7));
}

function minMonthStart(a: string, b: string): string {
	return compareMonthStart(a, b) <= 0 ? a : b;
}

function compareAssignmentOrderCandidate(
	a: AssignmentOrderCandidate,
	b: AssignmentOrderCandidate
): number {
	const startDiff = a.firstStartDate.localeCompare(b.firstStartDate);
	if (startDiff !== 0) return startDiff;
	const aCreated = a.firstCreatedAtIso ?? '9999-12-31T23:59:59.999Z';
	const bCreated = b.firstCreatedAtIso ?? '9999-12-31T23:59:59.999Z';
	const createdDiff = aCreated.localeCompare(bCreated);
	if (createdDiff !== 0) return createdDiff;
	return a.userOid.localeCompare(b.userOid);
}

function normalizeOrderForMonth(params: {
	baseOrder: string[];
	activeCandidates: AssignmentOrderCandidate[];
}): string[] {
	const activeSet = new Set(params.activeCandidates.map((candidate) => candidate.userOid));
	const normalized: string[] = [];
	for (const userOid of params.baseOrder) {
		if (activeSet.has(userOid) && !normalized.includes(userOid)) {
			normalized.push(userOid);
		}
	}
	const missing = params.activeCandidates
		.filter((candidate) => !normalized.includes(candidate.userOid))
		.sort(compareAssignmentOrderCandidate);
	for (const candidate of missing) {
		normalized.push(candidate.userOid);
	}
	return normalized;
}

async function loadActiveAssignmentCandidatesForMonth(params: {
	tx: sql.Transaction;
	scheduleId: number;
	shiftId: number;
	monthStart: string;
}): Promise<AssignmentOrderCandidate[]> {
	const month = params.monthStart.slice(0, 7);
	const { end: monthEnd } = monthWindow(month);
	const result = await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('shiftId', params.shiftId)
		.input('monthStart', params.monthStart)
		.input('monthEnd', monthEnd)
		.query(
			`SELECT
				sut.UserOid,
				MIN(sut.StartDate) AS FirstStartDate,
				MIN(sut.CreatedAt) AS FirstCreatedAt
			 FROM dbo.ScheduleAssignments sut
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.ShiftId = @shiftId
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL
			   AND sut.StartDate <= @monthEnd
			   AND (sut.EndDate IS NULL OR sut.EndDate >= @monthStart)
			 GROUP BY sut.UserOid;`
		);
	return (
		result.recordset as Array<{
			UserOid: string;
			FirstStartDate: Date | string | null;
			FirstCreatedAt: Date | string | null;
		}>
	)
		.map((row) => ({
			userOid: row.UserOid,
			firstStartDate: toDateOnly(row.FirstStartDate) ?? params.monthStart,
			firstCreatedAtIso: toDateTimeIso(row.FirstCreatedAt)
		}))
		.sort(compareAssignmentOrderCandidate);
}

async function loadOrderForExplicitMonth(params: {
	tx: sql.Transaction;
	scheduleId: number;
	shiftId: number;
	monthStart: string;
}): Promise<string[]> {
	const rows = await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('shiftId', params.shiftId)
		.input('monthStart', params.monthStart)
		.query(
			`SELECT UserOid
			 FROM dbo.ScheduleAssignmentOrders
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @shiftId
			   AND EffectiveMonth = @monthStart
			 ORDER BY DisplayOrder ASC, UserOid ASC;`
		);
	return (rows.recordset as Array<{ UserOid: string }>).map((row) => row.UserOid);
}

async function saveExplicitAssignmentOrderForMonth(params: {
	tx: sql.Transaction;
	scheduleId: number;
	shiftId: number;
	monthStart: string;
	orderedUserOids: string[];
}) {
	await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('shiftId', params.shiftId)
		.input('monthStart', params.monthStart)
		.query(
			`DELETE FROM dbo.ScheduleAssignmentOrders
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @shiftId
			   AND EffectiveMonth = @monthStart;`
		);

	for (let index = 0; index < params.orderedUserOids.length; index += 1) {
		await new sql.Request(params.tx)
			.input('scheduleId', params.scheduleId)
			.input('shiftId', params.shiftId)
			.input('monthStart', params.monthStart)
			.input('userOid', params.orderedUserOids[index])
			.input('displayOrder', index + 1)
			.query(
				`INSERT INTO dbo.ScheduleAssignmentOrders (
					ScheduleId,
					EffectiveMonth,
					ShiftId,
					UserOid,
					DisplayOrder
				)
				VALUES (
					@scheduleId,
					@monthStart,
					@shiftId,
					@userOid,
					@displayOrder
				);`
			);
	}
}

async function recomputeAssignmentOrdersForShiftFromMonth(params: {
	tx: sql.Transaction;
	scheduleId: number;
	shiftId: number;
	startMonth: string;
}) {
	const explicitRows = await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('shiftId', params.shiftId)
		.input('startMonth', params.startMonth)
		.query(
			`SELECT EffectiveMonth, UserOid
			 FROM dbo.ScheduleAssignmentOrders
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @shiftId
			   AND EffectiveMonth >= @startMonth
			 ORDER BY EffectiveMonth ASC, DisplayOrder ASC, UserOid ASC;`
		);

	const explicitOrderByMonth = new Map<string, string[]>();
	for (const row of explicitRows.recordset as Array<{
		EffectiveMonth: Date | string;
		UserOid: string;
	}>) {
		const monthStart = toDateOnly(row.EffectiveMonth);
		if (!monthStart) continue;
		const list = explicitOrderByMonth.get(monthStart) ?? [];
		list.push(row.UserOid);
		explicitOrderByMonth.set(monthStart, list);
	}

	const monthsToRecompute = new Set<string>([params.startMonth, ...explicitOrderByMonth.keys()]);
	const orderedMonths = [...monthsToRecompute].sort(compareMonthStart);

	const priorMonthRow = await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('shiftId', params.shiftId)
		.input('startMonth', params.startMonth)
		.query(
			`SELECT TOP (1) EffectiveMonth
			 FROM dbo.ScheduleAssignmentOrders
			 WHERE ScheduleId = @scheduleId
			   AND ShiftId = @shiftId
			   AND EffectiveMonth < @startMonth
			 ORDER BY EffectiveMonth DESC;`
		);
	const priorMonthStart = toDateOnly(priorMonthRow.recordset?.[0]?.EffectiveMonth ?? null);
	let inheritedOrder =
		priorMonthStart === null
			? []
			: await loadOrderForExplicitMonth({
					tx: params.tx,
					scheduleId: params.scheduleId,
					shiftId: params.shiftId,
					monthStart: priorMonthStart
				});

	for (const monthStart of orderedMonths) {
		const activeCandidates = await loadActiveAssignmentCandidatesForMonth({
			tx: params.tx,
			scheduleId: params.scheduleId,
			shiftId: params.shiftId,
			monthStart
		});
		const explicitOrder = explicitOrderByMonth.get(monthStart) ?? null;
		const baseOrder = explicitOrder ?? inheritedOrder;
		const normalizedOrder = normalizeOrderForMonth({
			baseOrder,
			activeCandidates
		});

		await saveExplicitAssignmentOrderForMonth({
			tx: params.tx,
			scheduleId: params.scheduleId,
			shiftId: params.shiftId,
			monthStart,
			orderedUserOids: normalizedOrder
		});
		inheritedOrder = normalizedOrder;
	}
}

async function reorderAssignmentsForShift(params: {
	locals: { user?: { id: string } | null };
	cookies: Cookies;
	body: unknown;
}) {
	const currentUser = params.locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, params.cookies);
	const shiftId = cleanRequiredInt((params.body as { shiftId?: unknown })?.shiftId, 'Shift');
	const requestedMonth = cleanOptionalMonth((params.body as { month?: unknown })?.month, 'month');
	const asOf = cleanOptionalDateOnly((params.body as { asOf?: unknown })?.asOf, 'asOf');
	const effectiveMonth = requestedMonth ?? (asOf ? asOf.slice(0, 7) : null);
	if (!effectiveMonth) {
		throw error(400, 'month is required');
	}
	const { start: monthStart, end: monthEnd } = monthWindow(effectiveMonth);
	const effectiveMonthStart = monthStartFromMonthValue(effectiveMonth);
	const orderedAssignmentIds = cleanRequiredStringArray(
		(params.body as { orderedAssignmentIds?: unknown })?.orderedAssignmentIds,
		'orderedAssignmentIds'
	);

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const activeRowsResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', shiftId)
			.input('monthStart', monthStart)
			.input('monthEnd', monthEnd)
			.query(
				`SELECT DISTINCT
					UserOid,
					ShiftId
				 FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @employeeTypeId
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				   AND StartDate <= @monthEnd
				   AND (EndDate IS NULL OR EndDate >= @monthStart)
				 ORDER BY UserOid ASC;`
			);

		const activeRows = (
			activeRowsResult.recordset as Array<{
				UserOid: string;
				ShiftId: number;
			}>
		).map((row) => {
			return {
				userOid: row.UserOid,
				shiftId: Number(row.ShiftId),
				assignmentId: row.UserOid
			};
		});

		const activeUserOids = activeRows.map((row) => row.userOid);
		const activeUserOidSet = new Set(activeUserOids);
		const normalizedOrderedUserOids = orderedAssignmentIds.map(parseOrderedAssignmentUserOid);
		if (normalizedOrderedUserOids.length !== activeUserOids.length) {
			throw error(
				400,
				'orderedAssignmentIds must include all assignments for the selected shift/month'
			);
		}
		if (new Set(normalizedOrderedUserOids).size !== normalizedOrderedUserOids.length) {
			throw error(400, 'orderedAssignmentIds contains duplicates');
		}
		if (!normalizedOrderedUserOids.every((userOid) => activeUserOidSet.has(userOid))) {
			throw error(
				400,
				'orderedAssignmentIds includes invalid assignments for the selected shift/month'
			);
		}

		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('shiftId', shiftId)
			.input('effectiveMonth', effectiveMonthStart)
			.query(
				`DELETE FROM dbo.ScheduleAssignmentOrders
				 WHERE ScheduleId = @scheduleId
				   AND ShiftId = @shiftId
				   AND EffectiveMonth = @effectiveMonth;`
			);

		for (let index = 0; index < normalizedOrderedUserOids.length; index += 1) {
			const userOid = normalizedOrderedUserOids[index];
			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('shiftId', shiftId)
				.input('effectiveMonth', effectiveMonthStart)
				.input('userOid', userOid)
				.input('displayOrder', index + 1)
				.query(
					`INSERT INTO dbo.ScheduleAssignmentOrders (
						ScheduleId,
						EffectiveMonth,
						ShiftId,
						UserOid,
						DisplayOrder
					)
					VALUES (
						@scheduleId,
						@effectiveMonth,
						@shiftId,
						@userOid,
						@displayOrder
					);`
				);
		}

		await tx.commit();
		return json({ success: true });
	} catch (err) {
		try {
			await tx.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw err;
	}
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const requestedMonth = cleanOptionalMonth(url.searchParams.get('month'), 'month');
	const asOf = cleanAsOfDate(url.searchParams.get('asOf'));
	const fallbackDate = asOf ?? new Date().toISOString().slice(0, 10);
	const { start: windowStart, end: windowEnd } = requestedMonth
		? monthWindow(requestedMonth)
		: { start: fallbackDate, end: fallbackDate };

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('windowStart', windowStart)
		.input('windowEnd', windowEnd)
		.query(
			`SELECT
				sut.UserOid,
				sut.ShiftId,
				sut.StartDate,
				sut.EndDate,
				sut.CreatedAt AS ModifiedAt,
				COALESCE(
					NULLIF(
						LTRIM(
							RTRIM(
								COALESCE(NULLIF(LTRIM(RTRIM(u.EntraFirstName)), ''), '') +
								CASE
									WHEN NULLIF(LTRIM(RTRIM(u.EntraFirstName)), '') IS NOT NULL
									 AND NULLIF(LTRIM(RTRIM(u.EntraLastName)), '') IS NOT NULL
									THEN ' '
									ELSE ''
								END +
								COALESCE(NULLIF(LTRIM(RTRIM(u.EntraLastName)), ''), '')
							)
						),
						''
					),
					NULLIF(LTRIM(RTRIM(u.FullName)), ''),
					sut.UserOid
				) AS UserName,
				et.Name AS ShiftName
			 FROM dbo.ScheduleAssignments sut
			 LEFT JOIN dbo.Users u
				ON u.UserOid = sut.UserOid
			   AND u.DeletedAt IS NULL
			 LEFT JOIN dbo.Shifts et
				ON et.ScheduleId = sut.ScheduleId
			   AND et.ShiftId = sut.ShiftId
			   AND et.IsActive = 1
			   AND et.DeletedAt IS NULL
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL
			   AND sut.StartDate <= @windowEnd
			   AND (sut.EndDate IS NULL OR sut.EndDate >= @windowStart)
			 ORDER BY sut.UserOid ASC, sut.ShiftId ASC, sut.StartDate ASC;`
		);

	const assignments = (result.recordset as AssignmentRow[]).map((row) => {
		const startDate = toDateOnly(row.StartDate) ?? '';
		const assignmentId = `${row.UserOid}|${row.ShiftId}|${startDate}`;
		const modifiedAtIso = toDateTimeIso(row.ModifiedAt);
		return {
			assignmentId,
			sortOrder: 1,
			userOid: row.UserOid,
			shiftId: Number(row.ShiftId),
			startDate,
			endDate: toDateOnly(row.EndDate),
			userName: row.UserName?.trim() || row.UserOid,
			shiftName: row.ShiftName?.trim() || 'Unknown shift',
			versionStamp: assignmentVersionStamp(startDate, modifiedAtIso),
			modifiedAtIso
		};
	});

	// Collapse split timeline segments into one top-level row per user/shift for the month list.
	// The selected "main" row is the segment active on the first day of the month window when possible.
	const groupedAssignments = new Map<string, (typeof assignments)[number][]>();
	for (const assignment of assignments) {
		const key = `${assignment.userOid}|${assignment.shiftId}`;
		const existing = groupedAssignments.get(key) ?? [];
		existing.push(assignment);
		groupedAssignments.set(key, existing);
	}
	const collapsedAssignments = Array.from(groupedAssignments.values()).map((group) => {
		const sortedGroup = [...group].sort((a, b) => a.startDate.localeCompare(b.startDate));
		const activeAtWindowStart = sortedGroup.find((candidate) =>
			dateWithinAssignmentWindow(windowStart, candidate.startDate, candidate.endDate)
		);
		return { ...(activeAtWindowStart ?? sortedGroup[0]) };
	});

	if (requestedMonth) {
		const monthStart = monthStartFromMonthValue(requestedMonth);
		const activeByShift = new Map<number, string[]>();
		for (const assignment of collapsedAssignments) {
			const list = activeByShift.get(assignment.shiftId) ?? [];
			if (!list.includes(assignment.userOid)) {
				list.push(assignment.userOid);
				activeByShift.set(assignment.shiftId, list);
			}
		}
		for (const [shiftId, userOids] of activeByShift.entries()) {
			const fallbackOrderedUserOids = collapsedAssignments
				.filter((assignment) => assignment.shiftId === shiftId)
				.sort((a, b) => a.sortOrder - b.sortOrder || a.userOid.localeCompare(b.userOid))
				.map((assignment) => assignment.userOid)
				.filter((userOid, index, list) => list.indexOf(userOid) === index);
			const resolvedOrderedUserOids = await resolveAssignmentOrderForMonth({
				pool,
				scheduleId,
				monthStart,
				shiftId,
				activeUserOids: userOids,
				fallbackOrderedUserOids
			});
			const orderMap = new Map<string, number>();
			for (let index = 0; index < resolvedOrderedUserOids.length; index += 1) {
				orderMap.set(resolvedOrderedUserOids[index], index + 1);
			}
			for (const assignment of collapsedAssignments) {
				if (assignment.shiftId !== shiftId) continue;
				assignment.sortOrder = orderMap.get(assignment.userOid) ?? assignment.sortOrder;
			}
		}
	}

	collapsedAssignments.sort(
		(a, b) =>
			a.sortOrder - b.sortOrder ||
			a.shiftId - b.shiftId ||
			a.userName.localeCompare(b.userName) ||
			a.userOid.localeCompare(b.userOid)
	);

	const historyResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('windowStart', windowStart)
		.input('windowEnd', windowEnd)
		.query(
			`SELECT
			sut.UserOid,
			sut.ShiftId,
			sut.StartDate,
			sut.EndDate,
			sut.CreatedAt AS ModifiedAt,
			COALESCE(
				NULLIF(
					LTRIM(
						RTRIM(
							COALESCE(NULLIF(LTRIM(RTRIM(u.EntraFirstName)), ''), '') +
							CASE
								WHEN NULLIF(LTRIM(RTRIM(u.EntraFirstName)), '') IS NOT NULL
								 AND NULLIF(LTRIM(RTRIM(u.EntraLastName)), '') IS NOT NULL
								THEN ' '
								ELSE ''
							END +
							COALESCE(NULLIF(LTRIM(RTRIM(u.EntraLastName)), ''), '')
						)
					),
					''
				),
				NULLIF(LTRIM(RTRIM(u.FullName)), ''),
				sut.UserOid
			) AS UserName,
			et.Name AS ShiftName
		 FROM dbo.ScheduleAssignments sut
		 LEFT JOIN dbo.Users u
			ON u.UserOid = sut.UserOid
		   AND u.DeletedAt IS NULL
		 LEFT JOIN dbo.Shifts et
			ON et.ScheduleId = sut.ScheduleId
		   AND et.ShiftId = sut.ShiftId
		   AND et.IsActive = 1
		   AND et.DeletedAt IS NULL
		 WHERE sut.ScheduleId = @scheduleId
		   AND sut.IsActive = 1
		   AND sut.DeletedAt IS NULL
		   AND sut.StartDate <= @windowEnd
		   AND (sut.EndDate IS NULL OR sut.EndDate >= @windowStart)
		 ORDER BY sut.UserOid ASC, sut.StartDate ASC;`
		);
	const historyByUser = new Map<
		string,
		Array<{
			assignmentId: string;
			sortOrder: number;
			userOid: string;
			shiftId: number;
			startDate: string;
			endDate: string | null;
			userName: string;
			shiftName: string;
			versionStamp: string;
			modifiedAtIso: string | null;
		}>
	>();
	for (const row of historyResult.recordset as AssignmentRow[]) {
		const startDate = toDateOnly(row.StartDate) ?? '';
		const assignmentId = `${row.UserOid}|${row.ShiftId}|${startDate}`;
		const modifiedAtIso = toDateTimeIso(row.ModifiedAt);
		const existing = historyByUser.get(row.UserOid) ?? [];
		existing.push({
			assignmentId,
			sortOrder: 1,
			userOid: row.UserOid,
			shiftId: Number(row.ShiftId),
			startDate,
			endDate: toDateOnly(row.EndDate),
			userName: row.UserName?.trim() || row.UserOid,
			shiftName: row.ShiftName?.trim() || 'Unknown shift',
			versionStamp: assignmentVersionStamp(startDate, modifiedAtIso),
			modifiedAtIso
		});
		historyByUser.set(row.UserOid, existing);
	}

	const timelineStampResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			`SELECT
				sut.UserOid,
				COUNT(*) AS EntryCount,
				MAX(sut.CreatedAt) AS LatestModifiedAt
			 FROM dbo.ScheduleAssignments sut
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL
			 GROUP BY sut.UserOid;`
		);
	const timelineStampByUser = new Map<string, string>();
	for (const row of timelineStampResult.recordset as Array<{
		UserOid: string;
		EntryCount: number;
		LatestModifiedAt: Date | string | null;
	}>) {
		const entryCount = Number(row.EntryCount ?? 0);
		timelineStampByUser.set(
			row.UserOid,
			`${entryCount}|${toDateTimeIso(row.LatestModifiedAt) ?? '0'}`
		);
	}

	const assignmentsWithHistory = collapsedAssignments.map((assignment) => {
		const history = historyByUser.get(assignment.userOid) ?? [
			{
				assignmentId: assignment.assignmentId,
				sortOrder: assignment.sortOrder,
				userOid: assignment.userOid,
				shiftId: assignment.shiftId,
				startDate: assignment.startDate,
				endDate: assignment.endDate ?? null,
				userName: assignment.userName ?? assignment.userOid,
				shiftName: assignment.shiftName ?? 'Unknown shift',
				versionStamp: assignment.versionStamp,
				modifiedAtIso: assignment.modifiedAtIso
			}
		];
		return {
			...assignment,
			timelineVersionStamp:
				timelineStampByUser.get(assignment.userOid) ?? assignmentTimelineVersionStamp(history),
			changes: history.map((change) => {
				const sanitized = { ...change };
				delete (sanitized as { modifiedAtIso?: string | null }).modifiedAtIso;
				return sanitized;
			})
		};
	});

	return json({ assignments: assignmentsWithHistory });
};

async function upsertAssignment({
	event,
	locals,
	cookies,
	request,
	enforceConcurrency
}: {
	event: RequestEvent;
	locals: { user?: { id: string } | null };
	cookies: Cookies;
	request: Request;
	enforceConcurrency: boolean;
}) {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	if ((body as { reorderOnly?: unknown })?.reorderOnly === true) {
		return reorderAssignmentsForShift({ locals, cookies, body });
	}
	const mode =
		typeof body?.editMode === 'string' && body.editMode.trim().toLowerCase() === 'history'
			? 'history'
			: 'create_or_effective';
	const expectedTimelineVersionStamp = enforceConcurrency
		? cleanRequiredVersionStamp(body?.expectedTimelineVersionStamp, 'Timeline version stamp')
		: null;
	const expectedChangeVersionStamp =
		enforceConcurrency && mode === 'history'
			? cleanRequiredVersionStamp(body?.expectedChangeVersionStamp, 'Change version stamp')
			: null;

	const userOid = cleanRequiredText(body?.userOid, 64, 'User');
	const employeeTypeId = cleanRequiredInt(body?.shiftId, 'Shift');
	const startDate = cleanDateOnly(body?.startDate, 'Effective start date');
	const endDate = cleanOptionalDateOnly(body?.endDate, 'End date');
	if (endDate && endDate < startDate) {
		throw error(400, 'End date must be on or after effective start date');
	}
	const historyStartDate =
		mode === 'history'
			? cleanDateOnly(
					body?.changeStartDate ?? body?.historyStartDate ?? body?.startDate,
					'Change start date'
				)
			: null;
	const shiftChangeIntentRaw = (body as { confirmShiftChange?: unknown } | null)
		?.confirmShiftChange;
	const confirmShiftChange =
		shiftChangeIntentRaw === true ? true : shiftChangeIntentRaw === false ? false : null;
	let applyAsShiftChange = false;
	let overlapShiftIds: number[] = [];

	if (mode !== 'history') {
		const overlapResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('employeeTypeId', employeeTypeId)
			.input('effectiveStartDate', startDate)
			.input('targetEndDate', endDate)
			.query(
				`SELECT TOP (1)
					sut.ShiftId,
					sut.StartDate,
					sut.EndDate,
					COALESCE(NULLIF(et.Name, ''), CONCAT('Shift #', CONVERT(varchar(20), sut.ShiftId))) AS ShiftName,
					COUNT(*) OVER() AS OverlapCount
				 FROM dbo.ScheduleAssignments sut
				 LEFT JOIN dbo.Shifts et
					ON et.ScheduleId = sut.ScheduleId
				   AND et.ShiftId = sut.ShiftId
				   AND et.IsActive = 1
				   AND et.DeletedAt IS NULL
				 WHERE sut.ScheduleId = @scheduleId
				   AND sut.UserOid = @userOid
				   AND sut.ShiftId <> @employeeTypeId
				   AND sut.IsActive = 1
				   AND sut.DeletedAt IS NULL
				   AND sut.StartDate <= COALESCE(@targetEndDate, CONVERT(date, '9999-12-31'))
				   AND (sut.EndDate IS NULL OR sut.EndDate >= @effectiveStartDate)
				 ORDER BY sut.StartDate ASC, sut.ShiftId ASC;`
			);
		const overlapRow = overlapResult.recordset?.[0] as
			| {
					ShiftId?: number;
					StartDate?: Date | string;
					EndDate?: Date | string | null;
					ShiftName?: string | null;
					OverlapCount?: number;
			  }
			| undefined;
		const overlapCount = Number(overlapRow?.OverlapCount ?? 0);
		if (overlapCount > 0 && confirmShiftChange === null) {
			const overlapShiftName = String(overlapRow?.ShiftName ?? 'another shift');
			return json(
				{
					code: 'ASSIGNMENT_OVERLAP_CONFIRMATION',
					message:
						'This user is already assigned to another shift during that time period. Is this intended to be a shift change?',
					overlap: {
						shiftId: Number(overlapRow?.ShiftId ?? 0),
						shiftName: overlapShiftName,
						startDate: toDateOnly(overlapRow?.StartDate ?? null),
						endDate: toDateOnly(overlapRow?.EndDate ?? null),
						count: overlapCount
					}
				},
				{ status: 409 }
			);
		}
		applyAsShiftChange = overlapCount > 0 && confirmShiftChange === true;
		if (applyAsShiftChange) {
			const overlapShiftRows = await pool
				.request()
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('employeeTypeId', employeeTypeId)
				.input('effectiveStartDate', startDate)
				.input('targetEndDate', endDate)
				.query(
					`SELECT DISTINCT sut.ShiftId
					 FROM dbo.ScheduleAssignments sut
					 WHERE sut.ScheduleId = @scheduleId
					   AND sut.UserOid = @userOid
					   AND sut.ShiftId <> @employeeTypeId
					   AND sut.IsActive = 1
					   AND sut.DeletedAt IS NULL
					   AND sut.StartDate <= COALESCE(@targetEndDate, CONVERT(date, '9999-12-31'))
					   AND (sut.EndDate IS NULL OR sut.EndDate >= @effectiveStartDate);`
				);
			overlapShiftIds = (overlapShiftRows.recordset as Array<{ ShiftId: number }>)
				.map((row) => Number(row.ShiftId))
				.filter((shiftId) => Number.isInteger(shiftId) && shiftId > 0);
		}
	}

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const affectedShiftAnchors = new Map<number, string>();
		const markAffectedShift = (shiftId: number, dateOnly: string) => {
			if (!Number.isInteger(shiftId) || shiftId <= 0) return;
			const monthStart = monthStartFromDateOnly(dateOnly);
			const existing = affectedShiftAnchors.get(shiftId);
			affectedShiftAnchors.set(
				shiftId,
				existing ? minMonthStart(existing, monthStart) : monthStart
			);
		};

		const serverDateResult = await new sql.Request(tx).query(
			`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`
		);
		const today = toDateOnly(serverDateResult.recordset?.[0]?.Today);
		if (!today) {
			throw error(500, 'Could not resolve current server date');
		}

		await ensureAssignmentReferencesValid(tx, scheduleId, userOid, employeeTypeId);
		if (enforceConcurrency) {
			const timelineResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.query(
					`SELECT StartDate, CreatedAt AS ModifiedAt
					 FROM dbo.ScheduleAssignments
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @userOid
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					 ORDER BY StartDate ASC;`
				);
			const timelineRows = (
				timelineResult.recordset as Array<{
					StartDate: Date | string;
					ModifiedAt: Date | string | null;
				}>
			).map((row) => ({
				startDate: toDateOnly(row.StartDate) ?? '',
				modifiedAtIso: toDateTimeIso(row.ModifiedAt)
			}));
			const currentTimelineVersionStamp = assignmentTimelineVersionStamp(timelineRows);
			if (currentTimelineVersionStamp !== expectedTimelineVersionStamp) {
				throw error(409, 'This assignment timeline has changed. Refresh and try again.');
			}
		}
		const previousShift = await getEffectiveShiftNameForDate(
			new sql.Request(tx),
			scheduleId,
			userOid,
			startDate
		);
		let shouldNotify = false;
		let newShift = previousShift;

		if (mode === 'history') {
			if (!historyStartDate) {
				throw error(400, 'Change start date is required for history edits');
			}

			const existingRowResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('historyStartDate', historyStartDate)
				.query(
					`SELECT TOP (1) ShiftId, StartDate, CreatedAt AS ModifiedAt
						 FROM dbo.ScheduleAssignments
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
			const existingStartDate = toDateOnly(existingRow.StartDate as Date | string | null) ?? '';
			const existingModifiedAtIso = toDateTimeIso(
				(existingRow as { ModifiedAt?: Date | string | null }).ModifiedAt ?? null
			);
			const existingVersionStamp = assignmentVersionStamp(existingStartDate, existingModifiedAtIso);
			if (
				enforceConcurrency &&
				expectedChangeVersionStamp &&
				existingVersionStamp !== expectedChangeVersionStamp
			) {
				throw error(409, 'This assignment change has changed. Refresh and try again.');
			}

			const currentShiftId = Number(existingRow.ShiftId ?? 0);
			if (!currentShiftId) {
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
						 FROM dbo.ScheduleAssignments
						 WHERE ScheduleId = @scheduleId
						   AND UserOid = @userOid
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate < @historyStartDate
						 ORDER BY StartDate DESC) AS PreviousStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.ScheduleAssignments
						 WHERE ScheduleId = @scheduleId
						   AND UserOid = @userOid
						   AND IsActive = 1
						   AND DeletedAt IS NULL
						   AND StartDate > @historyStartDate
						 ORDER BY StartDate ASC) AS NextStartDate,
						(SELECT TOP (1) StartDate
						 FROM dbo.ScheduleAssignments
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
			const currentEndDate = endDate ?? (nextStartDate ? minusOneDay(nextStartDate) : null);
			if (nextStartDate && currentEndDate && currentEndDate >= nextStartDate) {
				throw error(400, 'End date must be before the next assignment change');
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
						`UPDATE dbo.ScheduleAssignments
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
					.input('currentEndDate', currentEndDate)
					.input('actorOid', actorOid)
					.query(
						`UPDATE dbo.ScheduleAssignments
						 SET StartDate = @targetStartDate,
							 EndDate = @currentEndDate,
							 ShiftId = @employeeTypeId,
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

			markAffectedShift(currentShiftId, historyStartDate);
			markAffectedShift(employeeTypeId, startDate);
			newShift = await getEffectiveShiftNameForDate(
				new sql.Request(tx),
				scheduleId,
				userOid,
				startDate
			);
			shouldNotify = assignmentAffectsCurrentOrFuture({
				startDate,
				endDate: currentEndDate,
				today
			});
		} else {
			const { targetEndDate } = await applyEffectiveAssignmentChange({
				tx,
				scheduleId,
				actorOid,
				userOid,
				employeeTypeId,
				startDate,
				endDate,
				scopeToEmployeeType: !applyAsShiftChange
			});
			markAffectedShift(employeeTypeId, startDate);
			for (const shiftId of overlapShiftIds) {
				markAffectedShift(shiftId, startDate);
			}
			newShift = await getEffectiveShiftNameForDate(
				new sql.Request(tx),
				scheduleId,
				userOid,
				startDate
			);
			shouldNotify = assignmentAffectsCurrentOrFuture({
				startDate,
				endDate: targetEndDate,
				today
			});
		}

		const recomputeTargets = [...affectedShiftAnchors.entries()].sort(
			([aShiftId, aMonth], [bShiftId, bMonth]) =>
				aShiftId - bShiftId || compareMonthStart(aMonth, bMonth)
		);
		for (const [shiftId, startMonth] of recomputeTargets) {
			await recomputeAssignmentOrdersForShiftFromMonth({
				tx,
				scheduleId,
				shiftId,
				startMonth
			});
		}

		await tx.commit();

			if (shouldNotify) {
				const emailContext = await getShiftEmailContext({
					pool,
					scheduleId,
					targetUserOid: userOid,
					actorUserOid: actorOid
				});
				if (emailContext) {
					try {
						const delegatedAccessToken = await getSessionAccessToken(event);
						await sendShiftChangeNotification({
							scheduleName: emailContext.scheduleName,
							themeJson: emailContext.scheduleThemeJson,
							intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
							targetMemberName: emailContext.targetDisplayName,
							date: startDate,
							previousShift,
							newShift,
							triggeringUserName: emailContext.actorDisplayName,
							delegatedAccessToken
						});
					} catch (notificationError) {
						console.error('Shift change notification failed:', notificationError);
					}
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

export const POST: RequestHandler = async (event) =>
	upsertAssignment({
		event,
		locals: event.locals,
		cookies: event.cookies,
		request: event.request,
		enforceConcurrency: false
	});

export const PATCH: RequestHandler = async (event) =>
	upsertAssignment({
		event,
		locals: event.locals,
		cookies: event.cookies,
		request: event.request,
		enforceConcurrency: true
	});

type RemoveAssignmentPayload = {
	userOid?: unknown;
	editMode?: unknown;
	changeStartDate?: unknown;
	expectedTimelineVersionStamp?: unknown;
	expectedChangeVersionStamp?: unknown;
};

export const DELETE: RequestHandler = async (event) => {
	const { locals, cookies, request } = event;
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
	const expectedTimelineVersionStamp = cleanRequiredVersionStamp(
		body?.expectedTimelineVersionStamp,
		'Timeline version stamp'
	);
	const expectedChangeVersionStamp =
		editMode === 'history'
			? cleanRequiredVersionStamp(body?.expectedChangeVersionStamp, 'Change version stamp')
			: null;

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const serverDateResult = await new sql.Request(tx).query(
			`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`
		);
		const today = toDateOnly(serverDateResult.recordset?.[0]?.Today) ?? '';
		if (!today) {
			throw error(500, 'Could not resolve current server date');
		}

		const affectedShiftAnchors = new Map<number, string>();
		const markAffectedShift = (shiftId: number, dateOnly: string | null) => {
			if (!Number.isInteger(shiftId) || shiftId <= 0 || !dateOnly) return;
			const monthStart = monthStartFromDateOnly(dateOnly);
			const existing = affectedShiftAnchors.get(shiftId);
			affectedShiftAnchors.set(
				shiftId,
				existing ? minMonthStart(existing, monthStart) : monthStart
			);
		};

		const timelineResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.query(
				`SELECT ShiftId, StartDate, CreatedAt AS ModifiedAt
				 FROM dbo.ScheduleAssignments
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL
				 ORDER BY StartDate ASC;`
			);
		const timelineRows = (
			timelineResult.recordset as Array<{
				ShiftId: number;
				StartDate: Date | string;
				ModifiedAt: Date | string | null;
			}>
		).map((row) => {
			const startDate = toDateOnly(row.StartDate) ?? '';
			markAffectedShift(Number(row.ShiftId), startDate);
			return {
				shiftId: Number(row.ShiftId),
				startDate,
				modifiedAtIso: toDateTimeIso(row.ModifiedAt)
			};
		});
		const currentTimelineVersionStamp = assignmentTimelineVersionStamp(timelineRows);
		if (currentTimelineVersionStamp !== expectedTimelineVersionStamp) {
			throw error(409, 'This assignment timeline has changed. Refresh and try again.');
		}

		if (editMode === 'history') {
			if (!changeStartDate) {
				throw error(400, 'Change start date is required for history edits');
			}

			const rowResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('changeStartDate', changeStartDate)
				.query(
					`SELECT TOP (1)
						sut.ShiftId,
						sut.StartDate,
						sut.EndDate,
						sut.CreatedAt AS ModifiedAt,
						COALESCE(NULLIF(et.Name, ''), 'Unknown shift') AS ShiftName
					 FROM dbo.ScheduleAssignments sut
					 LEFT JOIN dbo.Shifts et
					    ON et.ScheduleId = sut.ScheduleId
					   AND et.ShiftId = sut.ShiftId
					   AND et.IsActive = 1
					   AND et.DeletedAt IS NULL
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @userOid
					   AND StartDate = @changeStartDate
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);
			const row = rowResult.recordset?.[0] as
				| {
						ShiftId?: number;
						StartDate?: Date | string;
						EndDate?: Date | string | null;
						ModifiedAt?: Date | string | null;
						ShiftName?: string | null;
				  }
				| undefined;
			const currentShiftId = Number(row?.ShiftId ?? 0);
			if (!currentShiftId) {
				throw error(404, 'Assignment change entry not found');
			}
			const rowVersionStamp = assignmentVersionStamp(
				toDateOnly(row?.StartDate ?? null) ?? '',
				toDateTimeIso(row?.ModifiedAt ?? null)
			);
			if (expectedChangeVersionStamp && rowVersionStamp !== expectedChangeVersionStamp) {
				throw error(409, 'This assignment change has changed. Refresh and try again.');
			}
			markAffectedShift(currentShiftId, changeStartDate);
			const shouldNotify = assignmentAffectsCurrentOrFuture({
				startDate: changeStartDate,
				endDate: toDateOnly(row?.EndDate ?? null),
				today
			});
			const previousShift = String(row?.ShiftName ?? 'Unknown shift');

			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('userOid', userOid)
				.input('changeStartDate', changeStartDate)
				.query(
					`DELETE FROM dbo.ScheduleAssignments
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @userOid
					   AND StartDate = @changeStartDate
					   AND IsActive = 1
					   AND DeletedAt IS NULL;`
				);

			for (const [shiftId, startMonth] of [...affectedShiftAnchors.entries()].sort(
				([aShiftId, aMonth], [bShiftId, bMonth]) =>
					aShiftId - bShiftId || compareMonthStart(aMonth, bMonth)
			)) {
				await recomputeAssignmentOrdersForShiftFromMonth({
					tx,
					scheduleId,
					shiftId,
					startMonth
				});
			}

			await tx.commit();

			if (shouldNotify) {
				const newShift = await getEffectiveShiftNameForDate(
					new sql.Request(pool),
					scheduleId,
					userOid,
					changeStartDate
				);
				const emailContext = await getShiftEmailContext({
					pool,
					scheduleId,
					targetUserOid: userOid,
					actorUserOid: actorOid
				});
				if (emailContext) {
					try {
						const delegatedAccessToken = await getSessionAccessToken(event);
						await sendShiftChangeNotification({
							scheduleName: emailContext.scheduleName,
							themeJson: emailContext.scheduleThemeJson,
							intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
							targetMemberName: emailContext.targetDisplayName,
							date: changeStartDate,
							previousShift,
							newShift,
							triggeringUserName: emailContext.actorDisplayName,
							delegatedAccessToken
						});
					} catch (notificationError) {
						console.error('Shift change notification failed:', notificationError);
					}
				}
			}

			return json({ success: true, removalMode: 'history_removed' });
		}
		const impactedAssignmentResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('today', today)
			.query(
				`SELECT TOP (1)
					sut.StartDate,
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
				   AND (sut.EndDate IS NULL OR sut.EndDate >= @today)
				 ORDER BY
					CASE
						WHEN sut.StartDate <= @today AND (sut.EndDate IS NULL OR sut.EndDate >= @today)
							THEN 0
						ELSE 1
					END ASC,
					CASE WHEN sut.StartDate <= @today THEN sut.StartDate END DESC,
					CASE WHEN sut.StartDate > @today THEN sut.StartDate END ASC;`
			);
		const impactedAssignmentRow = impactedAssignmentResult.recordset?.[0] as
			| { StartDate?: Date | string; ShiftName?: string | null }
			| undefined;
		const impactedStartDate = toDateOnly(impactedAssignmentRow?.StartDate ?? null);
		const notifyDate =
			impactedStartDate && impactedStartDate > today ? impactedStartDate : today;
		const shouldNotify = Boolean(impactedAssignmentRow && notifyDate);
		const previousShift = String(impactedAssignmentRow?.ShiftName ?? 'Unknown shift');

		await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.input('today', today)
			.input('actorOid', actorOid)
			.query(
				`UPDATE dbo.ScheduleAssignments
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

				 UPDATE dbo.ScheduleAssignments
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @userOid
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND StartDate > @today;`
			);

		for (const [shiftId, startMonth] of [...affectedShiftAnchors.entries()].sort(
			([aShiftId, aMonth], [bShiftId, bMonth]) =>
				aShiftId - bShiftId || compareMonthStart(aMonth, bMonth)
		)) {
			await recomputeAssignmentOrdersForShiftFromMonth({
				tx,
				scheduleId,
				shiftId,
				startMonth
			});
		}

		await tx.commit();

		if (shouldNotify && notifyDate) {
			const newShift = await getEffectiveShiftNameForDate(
				new sql.Request(pool),
				scheduleId,
				userOid,
				notifyDate
			);
			const emailContext = await getShiftEmailContext({
				pool,
				scheduleId,
				targetUserOid: userOid,
				actorUserOid: actorOid
			});
			if (emailContext) {
				try {
					const delegatedAccessToken = await getSessionAccessToken(event);
					await sendShiftChangeNotification({
						scheduleName: emailContext.scheduleName,
						themeJson: emailContext.scheduleThemeJson,
						intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
						targetMemberName: emailContext.targetDisplayName,
						date: notifyDate,
						previousShift,
						newShift,
						triggeringUserName: emailContext.actorDisplayName,
						delegatedAccessToken
					});
				} catch (notificationError) {
					console.error('Shift change notification failed:', notificationError);
				}
			}
		}

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
