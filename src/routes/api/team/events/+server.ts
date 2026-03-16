import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId, getSessionAccessToken } from '$lib/server/auth';
import { sendUpcomingEventNotification } from '$lib/server/mail/notifications';
import sql from 'mssql';
import { requireScheduleRole } from '$lib/server/schedule-access';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
type EventScopeType = 'global' | 'shift' | 'user';
type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';

type ScheduleEventRow = {
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
	NotifyImmediately: boolean | null;
	ScheduledRemindersJson: string | null;
};

type ExistingEventScopeRow = {
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
	NotifyImmediately: boolean | null;
	ScheduledRemindersJson: string | null;
};

type ScheduleEventsCapabilities = {
	hasShiftId: boolean;
	hasCustomColumns: boolean;
	hasReminderColumns: boolean;
};

type ReminderUnit = 'days' | 'weeks' | 'months';
type ReminderMeridiem = 'AM' | 'PM';
type ReminderDraft = {
	amount: number;
	unit: ReminderUnit;
	hour: number;
	meridiem: ReminderMeridiem;
	handled?: boolean;
	handledAtUtc?: string;
};
type AffectedEventMember = {
	name: string;
	email: string | null;
};

const allowedDisplayModes = new Set<EventDisplayMode>([
	'Schedule Overlay',
	'Badge Indicator',
	'Shift Override'
]);

async function getActorContext(localsUserOid: string, cookies: Cookies, minRole: ScheduleRole) {
	const scheduleId = await getActiveScheduleId(cookies);
	if (!scheduleId) {
		throw error(400, 'No active schedule selected');
	}

	const pool = await GetPool();
	await requireScheduleRole({
		userOid: localsUserOid,
		scheduleId,
		minRole,
		pool,
		errorMessage: 'Insufficient permissions'
	});

	return { pool, scheduleId, actorOid: localsUserOid };
}

function cleanScope(value: unknown): EventScopeType {
	if (value !== 'global' && value !== 'shift' && value !== 'user') {
		throw error(400, 'Scope is invalid');
	}
	return value;
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

function dateOnlyFromServerNow(now: Date = new Date()): string {
	const year = String(now.getFullYear()).padStart(4, '0');
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function eventRangeIsNotEntirelyPast(
	endDate: string,
	now: Date = new Date()
): boolean {
	const currentDate = dateOnlyFromServerNow(now);
	return endDate >= currentDate;
}

function cleanOptionalComments(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value !== 'string') {
		throw error(400, 'Comments are invalid');
	}
	return value.trim().slice(0, 2000);
}

function cleanOptionalInt(value: unknown, label: string): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, `${label} is invalid`);
	}
	return parsed;
}

function cleanRequiredVersionStamp(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw error(400, `${label} is required`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw error(400, `${label} is required`);
	}
	return trimmed.slice(0, 500);
}

function cleanOptionalUserOid(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') {
		throw error(400, 'User is invalid');
	}
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, 64);
}

function cleanOptionalCustomCode(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') {
		throw error(400, 'Custom event code is invalid');
	}
	const normalized = value.trim().toUpperCase().replace(/\s+/g, '-');
	if (!normalized) {
		throw error(400, 'Custom event code is required');
	}
	if (!/^[A-Z0-9_-]{1,16}$/.test(normalized)) {
		throw error(400, 'Custom event code must be 1-16 characters and use A-Z, 0-9, "_" or "-"');
	}
	return normalized;
}

function cleanOptionalCustomName(value: unknown, fallback: string | null): string | null {
	if (value === null || value === undefined || value === '') {
		return fallback;
	}
	if (typeof value !== 'string') {
		throw error(400, 'Custom event name is invalid');
	}
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	return trimmed.slice(0, 100);
}

function cleanOptionalDisplayMode(value: unknown): EventDisplayMode | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string' || !allowedDisplayModes.has(value as EventDisplayMode)) {
		throw error(400, 'Display mode is invalid');
	}
	return value as EventDisplayMode;
}

function cleanOptionalColor(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') {
		throw error(400, 'Color is invalid');
	}
	const trimmed = value.trim().toLowerCase();
	if (!/^#[0-9a-f]{6}$/.test(trimmed)) {
		throw error(400, 'Color must be a hex value like #22c55e');
	}
	return trimmed;
}

function cleanNotifyImmediately(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === null || value === undefined) return false;
	throw error(400, 'Notify immediately is invalid');
}

function cleanScheduledReminders(value: unknown): ReminderDraft[] {
	if (value === null || value === undefined || value === '') return [];
	if (!Array.isArray(value)) {
		throw error(400, 'Scheduled reminders are invalid');
	}
	const normalized: ReminderDraft[] = [];
	const seenKeys = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const amount = Number(row.amount);
		const hour = Number(row.hour);
		const unit = row.unit;
		const meridiem = row.meridiem;
		if (!Number.isInteger(amount) || amount < 0 || amount > 30) {
			throw error(400, 'Scheduled reminder amount must be an integer between 0 and 30');
		}
		if (unit !== 'days' && unit !== 'weeks' && unit !== 'months') {
			throw error(400, 'Scheduled reminder unit is invalid');
		}
		if (!Number.isInteger(hour) || hour < 0 || hour > 12) {
			throw error(400, 'Scheduled reminder hour must be an integer between 0 and 12');
		}
		if (meridiem !== 'AM' && meridiem !== 'PM') {
			throw error(400, 'Scheduled reminder AM/PM is invalid');
		}
		const key = `${amount}|${unit}|${hour}|${meridiem}`;
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);
		normalized.push({ amount, unit, hour, meridiem });
	}
	return normalized;
}

function remindersToJson(reminders: ReminderDraft[]): string | null {
	if (reminders.length === 0) return null;
	return JSON.stringify(
		reminders.map((reminder) => ({
			amount: reminder.amount,
			unit: reminder.unit,
			hour: reminder.hour,
			meridiem: reminder.meridiem,
			handled: reminder.handled === true,
			handledAtUtc: reminder.handled === true ? (reminder.handledAtUtc ?? null) : null
		}))
	);
}

function parseScheduledRemindersJson(value: string | null): ReminderDraft[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		const output: ReminderDraft[] = [];
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue;
			const row = entry as Record<string, unknown>;
			const amount = Number(row.amount);
			const hour = Number(row.hour);
			const unit = row.unit;
			const meridiem = row.meridiem;
			if (!Number.isInteger(amount) || amount < 0 || amount > 30) continue;
			if (unit !== 'days' && unit !== 'weeks' && unit !== 'months') continue;
			if (!Number.isInteger(hour) || hour < 0 || hour > 12) continue;
			if (meridiem !== 'AM' && meridiem !== 'PM') continue;
			output.push({
				amount,
				unit,
				hour,
				meridiem,
				handled: row.handled === true,
				handledAtUtc: typeof row.handledAtUtc === 'string' ? row.handledAtUtc : undefined
			});
		}
		return output;
	} catch {
		return [];
	}
}

function scheduledReminderKey(reminder: ReminderDraft): string {
	return `${reminder.amount}|${reminder.unit}|${reminder.hour}|${reminder.meridiem}`;
}

function mergeReminderHandlingFromExisting(
	reminders: ReminderDraft[],
	existingRemindersJson: string | null
): ReminderDraft[] {
	const existingByKey = new Map<string, ReminderDraft>();
	for (const reminder of parseScheduledRemindersJson(existingRemindersJson)) {
		existingByKey.set(scheduledReminderKey(reminder), reminder);
	}
	return reminders.map((reminder) => {
		const existing = existingByKey.get(scheduledReminderKey(reminder));
		if (!existing?.handled) return reminder;
		return {
			...reminder,
			handled: true,
			handledAtUtc: existing.handledAtUtc
		};
	});
}

function toDateOnly(value: Date | string | null): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') return value.slice(0, 10);
	return null;
}

function eventVersionStamp(row: ExistingEventScopeRow): string {
	const eventId = Number(row.EventId);
	const userOid = row.UserOid?.trim() ?? '';
	const employeeTypeId =
		row.ShiftId === null || row.ShiftId === undefined ? '' : String(Number(row.ShiftId));
	const startDate = toDateOnly(row.StartDate) ?? '';
	const endDate = toDateOnly(row.EndDate) ?? '';
	const coverageCodeId =
		row.EventCodeId === null || row.EventCodeId === undefined
			? ''
			: String(Number(row.EventCodeId));
	const customCode = row.CustomCode?.trim() ?? '';
	const customName = row.CustomName?.trim() ?? '';
	const customDisplayMode = row.CustomDisplayMode?.trim() ?? '';
	const customColor = row.CustomColor?.trim().toLowerCase() ?? '';
	const notes = row.Notes?.trim() ?? '';
	const scheduledRemindersJson = row.ScheduledRemindersJson?.trim() ?? '';
	return [
		eventId,
		userOid,
		employeeTypeId,
		startDate,
		endDate,
		coverageCodeId,
		customCode,
		customName,
		customDisplayMode,
		customColor,
		notes,
		scheduledRemindersJson
	].join('|');
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
		hasCustomColumns:
			columns.has('CustomCode') &&
			columns.has('CustomName') &&
			columns.has('CustomDisplayMode') &&
			columns.has('CustomColor'),
		hasReminderColumns: columns.has('ScheduledRemindersJson')
	};
}

async function ensureShiftScopeIsValid(
	pool: Awaited<ReturnType<typeof GetPool>>,
	scheduleId: number,
	employeeTypeId: number
) {
	const shiftResult = await pool
		.request()
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

async function ensureUserScopeIsValid(
	pool: Awaited<ReturnType<typeof GetPool>>,
	scheduleId: number,
	userOid: string
) {
	const userResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.query(
			`SELECT TOP (1) 1 AS HasUser
			 FROM dbo.ScheduleUsers
			 WHERE ScheduleId = @scheduleId
			   AND UserOid = @userOid;`
		);
	if (!userResult.recordset?.[0]?.HasUser) {
		throw error(400, 'Selected user does not belong to this schedule');
	}
}

async function ensureCoverageCodeIsValid(
	pool: Awaited<ReturnType<typeof GetPool>>,
	scheduleId: number,
	coverageCodeId: number
) {
	const codeResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('coverageCodeId', coverageCodeId)
		.query(
			`SELECT TOP (1) 1 AS HasCode
			 FROM dbo.EventCodes
			 WHERE ScheduleId = @scheduleId
			   AND EventCodeId = @coverageCodeId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
	if (!codeResult.recordset?.[0]?.HasCode) {
		throw error(400, 'Selected event code is no longer available');
	}
}

function formatEventDateForEmail(startDate: string, endDate: string): string {
	const formatter = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const start = new Date(`${startDate}T00:00:00Z`);
	const end = new Date(`${endDate}T00:00:00Z`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
		return startDate === endDate ? startDate : `${startDate} to ${endDate}`;
	}
	const startText = formatter.format(start);
	const endText = formatter.format(end);
	return startDate === endDate ? startText : `${startText} to ${endText}`;
}

async function getEventEmailContext(pool: Awaited<ReturnType<typeof GetPool>>, scheduleId: number) {
	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			`SELECT TOP (1)
			s.Name AS ScheduleName,
			s.ThemeJson AS ScheduleThemeJson
		 FROM dbo.Schedules s
		 WHERE s.ScheduleId = @scheduleId;`
		);
	const row = result.recordset?.[0] as
		| {
				ScheduleName: string | null;
				ScheduleThemeJson: string | null;
		  }
		| undefined;
	if (!row?.ScheduleName?.trim()) return null;
	return {
		scheduleName: row.ScheduleName.trim(),
		scheduleThemeJson: row.ScheduleThemeJson ?? null
	};
}

async function getAffectedEventMemberNames(params: {
	pool: Awaited<ReturnType<typeof GetPool>>;
	scheduleId: number;
	scope: EventScopeType;
	employeeTypeId: number | null;
	userOid: string | null;
	startDate: string;
	endDate: string;
}): Promise<AffectedEventMember[]> {
	const { pool, scheduleId, scope, employeeTypeId, userOid, startDate, endDate } = params;
	if (scope === 'user') {
		if (!userOid) return [];
		const result = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.query(
				`SELECT TOP (1)
					COALESCE(NULLIF(LTRIM(RTRIM(u.DisplayName)), ''), NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserOid) AS MemberName,
					NULLIF(LTRIM(RTRIM(u.Email)), '') AS MemberEmail
				 FROM dbo.ScheduleUsers su
				 INNER JOIN dbo.Users u
				   ON u.UserOid = su.UserOid
				 WHERE su.ScheduleId = @scheduleId
				   AND su.UserOid = @userOid
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL;`
			);
		const name = result.recordset?.[0]?.MemberName?.trim();
		const email = result.recordset?.[0]?.MemberEmail?.trim() || null;
		return name ? [{ name, email }] : [];
	}

	if (scope === 'shift') {
		if (!employeeTypeId) return [];
		const result = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('employeeTypeId', employeeTypeId)
			.input('startDate', startDate)
			.input('endDate', endDate)
			.query(
				`SELECT DISTINCT
					COALESCE(NULLIF(LTRIM(RTRIM(u.DisplayName)), ''), NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserOid) AS MemberName,
					NULLIF(LTRIM(RTRIM(u.Email)), '') AS MemberEmail
				 FROM dbo.ScheduleAssignments sut
				 INNER JOIN dbo.ScheduleUsers su
				   ON su.ScheduleId = sut.ScheduleId
				  AND su.UserOid = sut.UserOid
				 INNER JOIN dbo.Users u
				   ON u.UserOid = sut.UserOid
				 WHERE sut.ScheduleId = @scheduleId
				   AND sut.ShiftId = @employeeTypeId
				   AND sut.IsActive = 1
				   AND sut.DeletedAt IS NULL
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL
				   AND sut.StartDate <= @endDate
				   AND (sut.EndDate IS NULL OR sut.EndDate >= @startDate)
				 ORDER BY MemberName ASC;`
			);
		return (result.recordset as Array<{ MemberName: string | null; MemberEmail: string | null }>)
			.map((row) => ({
				name: row.MemberName?.trim() || '',
				email: row.MemberEmail?.trim() || null
			}))
			.filter((row) => Boolean(row.name));
	}

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('startDate', startDate)
		.input('endDate', endDate)
		.query(
			`SELECT DISTINCT
			COALESCE(NULLIF(LTRIM(RTRIM(u.DisplayName)), ''), NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserOid) AS MemberName,
			NULLIF(LTRIM(RTRIM(u.Email)), '') AS MemberEmail
		 FROM dbo.ScheduleAssignments sut
		 INNER JOIN dbo.ScheduleUsers su
		   ON su.ScheduleId = sut.ScheduleId
		  AND su.UserOid = sut.UserOid
		 INNER JOIN dbo.Users u
		   ON u.UserOid = sut.UserOid
		 WHERE sut.ScheduleId = @scheduleId
		   AND sut.IsActive = 1
		   AND sut.DeletedAt IS NULL
		   AND su.IsActive = 1
		   AND su.DeletedAt IS NULL
		   AND sut.StartDate <= @endDate
		   AND (sut.EndDate IS NULL OR sut.EndDate >= @startDate)
		 ORDER BY MemberName ASC;`
		);
	return (result.recordset as Array<{ MemberName: string | null; MemberEmail: string | null }>)
		.map((row) => ({ name: row.MemberName?.trim() || '', email: row.MemberEmail?.trim() || null }))
		.filter((row) => Boolean(row.name));
}

async function cleanScopeInputs(
	pool: Awaited<ReturnType<typeof GetPool>>,
	scheduleId: number,
	body: Record<string, unknown> | URLSearchParams,
	options?: { allowUserShiftContext?: boolean }
) {
	const scope = cleanScope(body instanceof URLSearchParams ? body.get('scope') : body.scope);
	const employeeTypeId = cleanOptionalInt(
		body instanceof URLSearchParams ? body.get('employeeTypeId') : body.employeeTypeId,
		'Shift'
	);
	const userOid = cleanOptionalUserOid(
		body instanceof URLSearchParams ? body.get('userOid') : body.userOid
	);

	if (scope === 'global') {
		return { scope, employeeTypeId: null, userOid: null };
	}
	if (scope === 'shift') {
		if (!employeeTypeId) {
			throw error(400, 'Shift scope requires employeeTypeId');
		}
		await ensureShiftScopeIsValid(pool, scheduleId, employeeTypeId);
		return { scope, employeeTypeId, userOid: null };
	}
	if (!userOid) {
		throw error(400, 'User scope requires userOid');
	}
	await ensureUserScopeIsValid(pool, scheduleId, userOid);
	if (options?.allowUserShiftContext && employeeTypeId !== null) {
		await ensureShiftScopeIsValid(pool, scheduleId, employeeTypeId);
		return { scope, employeeTypeId, userOid };
	}
	return { scope, employeeTypeId: null, userOid };
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies, 'Member');
	const dayParam = url.searchParams.get('day');
	const startDateParam = url.searchParams.get('startDate');
	const endDateParam = url.searchParams.get('endDate');
	const hasRangeParams = startDateParam !== null || endDateParam !== null;
	if (hasRangeParams && dayParam !== null) {
		throw error(400, 'Provide either day or startDate/endDate, not both');
	}
	if (hasRangeParams && (startDateParam === null || endDateParam === null)) {
		throw error(400, 'Both startDate and endDate are required when using range mode');
	}
	const day = !hasRangeParams ? cleanDateOnly(dayParam, 'day') : null;
	const startDate = hasRangeParams ? cleanDateOnly(startDateParam, 'startDate') : null;
	const endDate = hasRangeParams ? cleanDateOnly(endDateParam, 'endDate') : null;
	if (startDate !== null && endDate !== null && endDate < startDate) {
		throw error(400, 'endDate cannot be before startDate');
	}
	const { scope, employeeTypeId, userOid } = await cleanScopeInputs(
		pool,
		scheduleId,
		url.searchParams,
		{
			allowUserShiftContext: true
		}
	);
	const capabilities = await getScheduleEventsCapabilities(pool);
	if (scope === 'user' && capabilities.hasShiftId && employeeTypeId === null) {
		throw error(400, 'User scope requires employeeTypeId');
	}

	const request = pool
		.request()
		.input('scheduleId', scheduleId)
		.input('scope', scope)
		.input('employeeTypeId', employeeTypeId)
		.input('userOid', userOid);
	if (day !== null) {
		request.input('day', day);
	}
	if (startDate !== null && endDate !== null) {
		request.input('startDate', startDate).input('endDate', endDate);
	}

	const selectShiftId = capabilities.hasShiftId ? 'se.ShiftId' : 'CAST(NULL AS int) AS ShiftId';
	const selectCustomCode = capabilities.hasCustomColumns
		? 'se.CustomCode'
		: 'CAST(NULL AS nvarchar(16)) AS CustomCode';
	const selectCustomName = capabilities.hasCustomColumns
		? 'se.CustomName'
		: 'CAST(NULL AS nvarchar(100)) AS CustomName';
	const selectCustomDisplayMode = capabilities.hasCustomColumns
		? 'se.CustomDisplayMode'
		: 'CAST(NULL AS nvarchar(30)) AS CustomDisplayMode';
	const selectCustomColor = capabilities.hasCustomColumns
		? 'se.CustomColor'
		: 'CAST(NULL AS nvarchar(20)) AS CustomColor';
	const selectNotifyImmediately = 'CAST(0 AS bit) AS NotifyImmediately';
	const selectScheduledRemindersJson = capabilities.hasReminderColumns
		? 'se.ScheduledRemindersJson'
		: 'CAST(NULL AS nvarchar(max)) AS ScheduledRemindersJson';
	const globalPredicate = capabilities.hasShiftId
		? '(se.ShiftId IS NULL AND se.UserOid IS NULL)'
		: '(se.UserOid IS NULL)';
	const shiftPredicate = capabilities.hasShiftId
		? '(se.ShiftId = @employeeTypeId AND se.UserOid IS NULL)'
		: '(1 = 0)';
	const userPredicate = capabilities.hasShiftId
		? employeeTypeId !== null
			? '(se.UserOid = @userOid AND se.ShiftId = @employeeTypeId)'
			: '(se.UserOid = @userOid AND se.ShiftId IS NULL)'
		: '(se.UserOid = @userOid)';

	const scopePredicate =
		scope === 'global'
			? globalPredicate
			: scope === 'shift'
				? `(${shiftPredicate} OR ${globalPredicate})`
				: capabilities.hasShiftId && employeeTypeId !== null
					? `(${userPredicate} OR ${shiftPredicate} OR ${globalPredicate})`
					: `(${userPredicate} OR ${globalPredicate})`;

	const windowPredicate =
		day !== null
			? 'se.StartDate <= @day AND se.EndDate >= @day'
			: 'se.StartDate <= @endDate AND se.EndDate >= @startDate';

	const result = await request.query(
		`SELECT
			se.EventId,
			se.UserOid,
			se.StartDate,
			se.EndDate,
			se.Notes,
			se.EventCodeId,
			${selectShiftId},
			${selectCustomCode},
			${selectCustomName},
			${selectCustomDisplayMode},
			${selectCustomColor},
			${selectNotifyImmediately},
			${selectScheduledRemindersJson},
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
		   AND ${windowPredicate}
		   AND ${scopePredicate}
		 ORDER BY se.StartDate ASC, se.EndDate ASC, se.EventId ASC;`
	);

	const events = (result.recordset as ScheduleEventRow[]).map((row) => {
		const coverageCodeId = row.EventCodeId === null ? null : Number(row.EventCodeId);
		const employeeTypeId =
			row.ShiftId === null || row.ShiftId === undefined ? null : Number(row.ShiftId);
		const userOid = row.UserOid?.trim() || null;
		const scopeType: EventScopeType = userOid
			? 'user'
			: employeeTypeId !== null
				? 'shift'
				: 'global';
		const isCustom = coverageCodeId === null;
		const eventCodeCode = (coverageCodeId ? row.CoverageCode : row.CustomCode)?.trim() || '';
		const fallbackName = eventCodeCode || 'Event';
		const eventCodeName =
			(coverageCodeId ? row.CoverageLabel : row.CustomName)?.trim() ||
			(coverageCodeId ? row.CoverageCode : row.CustomCode)?.trim() ||
			fallbackName;
		return {
			eventId: Number(row.EventId),
			eventCodeId: coverageCodeId,
			eventCodeCode,
			eventCodeName,
			scopeType,
			employeeTypeId,
			userOid,
			eventDisplayMode:
				(coverageCodeId ? row.CoverageDisplayMode : row.CustomDisplayMode) ?? 'Schedule Overlay',
			eventCodeColor: (coverageCodeId ? row.CoverageColor : row.CustomColor)?.trim() || '#22c55e',
			startDate: toDateOnly(row.StartDate) ?? '',
			endDate: toDateOnly(row.EndDate) ?? '',
			comments: row.Notes?.trim() ?? '',
			versionStamp: eventVersionStamp({
				EventId: Number(row.EventId),
				UserOid: row.UserOid,
				ShiftId: row.ShiftId === null || row.ShiftId === undefined ? null : Number(row.ShiftId),
				StartDate: row.StartDate,
				EndDate: row.EndDate,
				Notes: row.Notes,
				EventCodeId: row.EventCodeId,
				CustomCode: row.CustomCode,
				CustomName: row.CustomName,
				CustomDisplayMode: row.CustomDisplayMode,
				CustomColor: row.CustomColor,
				NotifyImmediately: row.NotifyImmediately,
				ScheduledRemindersJson: row.ScheduledRemindersJson
			}),
			isCustom,
			notifyImmediately: Boolean(row.NotifyImmediately),
			scheduledReminders: parseScheduledRemindersJson(row.ScheduledRemindersJson)
		};
	});

	return json({ events });
};

export const POST: RequestHandler = async (event) => {
	const { locals, cookies, request } = event;
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(
		currentUser.id,
		cookies,
		'Maintainer'
	);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') {
		throw error(400, 'Body is invalid');
	}

	const capabilities = await getScheduleEventsCapabilities(pool);
	const { scope, employeeTypeId, userOid } = await cleanScopeInputs(pool, scheduleId, body, {
		allowUserShiftContext: true
	});
	if (employeeTypeId !== null && !capabilities.hasShiftId) {
		throw error(400, 'Shift-scoped events require a ScheduleEvents schema update.');
	}
	if (scope === 'user' && capabilities.hasShiftId && employeeTypeId === null) {
		throw error(400, 'User scope requires employeeTypeId');
	}
	const startDate = cleanDateOnly(body.startDate, 'Start date');
	const endDate = cleanDateOnly(body.endDate, 'End date');
	if (endDate < startDate) {
		throw error(400, 'End date cannot be before start date');
	}

	const comments = cleanOptionalComments(body.comments);
	const coverageCodeId = cleanOptionalInt(body.coverageCodeId, 'Event code');
	const hasNotifyImmediatelyInput = Object.prototype.hasOwnProperty.call(body, 'notifyImmediately');
	const hasScheduledRemindersInput = Object.prototype.hasOwnProperty.call(
		body,
		'scheduledReminders'
	);
	let notifyImmediately = cleanNotifyImmediately(
		hasNotifyImmediatelyInput ? body.notifyImmediately : undefined
	);
	let scheduledReminders = cleanScheduledReminders(
		hasScheduledRemindersInput ? body.scheduledReminders : []
	);

	let customCode: string | null = null;
	let customName: string | null = null;
	let customDisplayMode: EventDisplayMode | null = null;
	let customColor: string | null = null;
	let notificationEventName = 'Event';

	if (coverageCodeId !== null) {
		await ensureCoverageCodeIsValid(pool, scheduleId, coverageCodeId);
		const codeResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('coverageCodeId', coverageCodeId)
			.query(
				`SELECT TOP (1) Label, Code
				 FROM dbo.EventCodes
				 WHERE ScheduleId = @scheduleId
				   AND EventCodeId = @coverageCodeId
				   AND DeletedAt IS NULL;`
			);
		notificationEventName =
			codeResult.recordset?.[0]?.Label?.trim() ||
			codeResult.recordset?.[0]?.Code?.trim() ||
			'Event';
		if (
			capabilities.hasReminderColumns &&
			(!hasNotifyImmediatelyInput || !hasScheduledRemindersInput)
		) {
			const defaultsResult = await pool
				.request()
				.input('scheduleId', scheduleId)
				.input('coverageCodeId', coverageCodeId)
				.query(
					`SELECT TOP (1) NotifyImmediately, ScheduledRemindersJson
					 FROM dbo.EventCodes
					 WHERE ScheduleId = @scheduleId
					   AND EventCodeId = @coverageCodeId
					   AND DeletedAt IS NULL;`
				);
			const defaultRow = defaultsResult.recordset?.[0] as
				| { NotifyImmediately: boolean | null; ScheduledRemindersJson: string | null }
				| undefined;
			if (!hasNotifyImmediatelyInput) {
				notifyImmediately = Boolean(defaultRow?.NotifyImmediately);
			}
			if (!hasScheduledRemindersInput) {
				scheduledReminders = parseScheduledRemindersJson(
					defaultRow?.ScheduledRemindersJson ?? null
				);
			}
		}
	} else {
		if (!capabilities.hasCustomColumns) {
			throw error(400, 'Custom events require a ScheduleEvents schema update.');
		}
		customCode = cleanOptionalCustomCode(body.customCode);
		customDisplayMode = cleanOptionalDisplayMode(body.customDisplayMode);
		customColor = cleanOptionalColor(body.customColor);
		if (!customCode || !customDisplayMode || !customColor) {
			throw error(
				400,
				'Custom events require code, display mode, and color when no event code is selected'
			);
		}
		customName = cleanOptionalCustomName(body.customName, customCode);
		notificationEventName = customName || customCode || 'Custom Event';
	}
	scheduledReminders = mergeReminderHandlingFromExisting(
		scheduledReminders,
		null
	);
	const scheduledRemindersJson = remindersToJson(scheduledReminders);

	const insertColumns = [
		'ScheduleId',
		'UserOid',
		'StartDate',
		'EndDate',
		'EventCodeId',
		'Notes',
		'CreatedBy'
	];
	const insertValues = [
		'@scheduleId',
		'@userOid',
		'@startDate',
		'@endDate',
		'@coverageCodeId',
		'@comments',
		'@actorOid'
	];
	if (capabilities.hasShiftId) {
		insertColumns.splice(2, 0, 'ShiftId');
		insertValues.splice(2, 0, '@employeeTypeId');
	}
	if (capabilities.hasCustomColumns) {
		insertColumns.splice(5, 0, 'CustomCode', 'CustomName', 'CustomDisplayMode', 'CustomColor');
		insertValues.splice(5, 0, '@customCode', '@customName', '@customDisplayMode', '@customColor');
	}
	if (capabilities.hasReminderColumns) {
		insertColumns.splice(6, 0, 'ScheduledRemindersJson');
		insertValues.splice(6, 0, '@scheduledRemindersJson');
	}

	const insertResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.input('employeeTypeId', employeeTypeId)
		.input('startDate', startDate)
		.input('endDate', endDate)
		.input('coverageCodeId', coverageCodeId)
		.input('customCode', customCode)
		.input('customName', customName)
		.input('customDisplayMode', customDisplayMode)
		.input('customColor', customColor)
		.input('scheduledRemindersJson', scheduledRemindersJson)
		.input('comments', comments || null)
		.input('actorOid', actorOid)
		.query(
			`INSERT INTO dbo.ScheduleEvents (${insertColumns.join(', ')})
			OUTPUT INSERTED.EventId
			VALUES (${insertValues.join(', ')});`
		);

	const eventId = Number(insertResult.recordset?.[0]?.EventId ?? 0);

	if (notifyImmediately && eventRangeIsNotEntirelyPast(endDate)) {
		try {
			const context = await getEventEmailContext(pool, scheduleId);
			if (context) {
				const delegatedAccessToken = await getSessionAccessToken(event);
				const affectedUsers = await getAffectedEventMemberNames({
					pool,
					scheduleId,
					scope,
					employeeTypeId,
					userOid,
					startDate,
					endDate
				});
				const intendedRecipients = affectedUsers
					.map((member) => member.email)
					.filter((email): email is string => Boolean(email));
				const affectedUserNames = affectedUsers.map((member) => member.name);
				const targetMemberName =
					affectedUserNames.length === 0
						? 'Schedule Members'
						: affectedUserNames.length <= 5
							? affectedUserNames.join(', ')
							: `${affectedUserNames.length} schedule members`;
				await sendUpcomingEventNotification({
					scheduleName: context.scheduleName,
					themeJson: context.scheduleThemeJson,
					intendedRecipients,
					targetMemberName,
					eventName: notificationEventName,
					date: formatEventDateForEmail(startDate, endDate),
					comments,
					delegatedAccessToken
				});
			}
		} catch (notificationError) {
			console.error('Upcoming event immediate notification failed:', notificationError);
		}
	}

	return json({ eventId }, { status: 201 });
};

export const PATCH: RequestHandler = async (event) => {
	const { locals, cookies, request } = event;
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies, 'Maintainer');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') {
		throw error(400, 'Body is invalid');
	}

	const capabilities = await getScheduleEventsCapabilities(pool);
	const eventId = cleanOptionalInt(body.eventId, 'Event');
	const expectedVersionStamp = cleanRequiredVersionStamp(
		body.expectedVersionStamp,
		'Version stamp'
	);
	if (!eventId) {
		throw error(400, 'Event is invalid');
	}

	const existingQueryShiftId = capabilities.hasShiftId ? 'ShiftId' : 'CAST(NULL AS int) AS ShiftId';
	const existingQueryCustomCode = capabilities.hasCustomColumns
		? 'CustomCode'
		: 'CAST(NULL AS nvarchar(16)) AS CustomCode';
	const existingQueryCustomName = capabilities.hasCustomColumns
		? 'CustomName'
		: 'CAST(NULL AS nvarchar(100)) AS CustomName';
	const existingQueryCustomDisplayMode = capabilities.hasCustomColumns
		? 'CustomDisplayMode'
		: 'CAST(NULL AS nvarchar(30)) AS CustomDisplayMode';
	const existingQueryCustomColor = capabilities.hasCustomColumns
		? 'CustomColor'
		: 'CAST(NULL AS nvarchar(20)) AS CustomColor';
	const existingQueryNotifyImmediately = 'CAST(0 AS bit) AS NotifyImmediately';
	const existingQueryScheduledRemindersJson = capabilities.hasReminderColumns
		? 'ScheduledRemindersJson'
		: 'CAST(NULL AS nvarchar(max)) AS ScheduledRemindersJson';

	const existsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('eventId', eventId)
		.query(
			`SELECT TOP (1)
				EventId,
				UserOid,
				${existingQueryShiftId},
				StartDate,
				EndDate,
				Notes,
				EventCodeId,
				${existingQueryCustomCode},
				${existingQueryCustomName},
				${existingQueryCustomDisplayMode},
				${existingQueryCustomColor},
				${existingQueryNotifyImmediately},
				${existingQueryScheduledRemindersJson}
			 FROM dbo.ScheduleEvents
			 WHERE ScheduleId = @scheduleId
			   AND EventId = @eventId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
	const existingEvent = (existsResult.recordset?.[0] as ExistingEventScopeRow | undefined) ?? null;
	if (!existingEvent?.EventId) {
		throw error(404, 'Event not found');
	}
	const currentVersionStamp = eventVersionStamp(existingEvent);
	if (currentVersionStamp !== expectedVersionStamp) {
		throw error(409, 'This event has changed. Refresh and try again.');
	}

	const userOid = existingEvent.UserOid?.trim() || null;
	const employeeTypeId =
		existingEvent.ShiftId === null || existingEvent.ShiftId === undefined
			? null
			: Number(existingEvent.ShiftId);

	const startDate = cleanDateOnly(body.startDate, 'Start date');
	const endDate = cleanDateOnly(body.endDate, 'End date');
	if (endDate < startDate) {
		throw error(400, 'End date cannot be before start date');
	}

	const comments = cleanOptionalComments(body.comments);
	const coverageCodeId = cleanOptionalInt(body.coverageCodeId, 'Event code');
	const hasNotifyImmediatelyInput = Object.prototype.hasOwnProperty.call(body, 'notifyImmediately');
	const hasScheduledRemindersInput = Object.prototype.hasOwnProperty.call(
		body,
		'scheduledReminders'
	);
	let notifyImmediately = cleanNotifyImmediately(
		hasNotifyImmediatelyInput ? body.notifyImmediately : undefined
	);
	let scheduledReminders = cleanScheduledReminders(
		hasScheduledRemindersInput ? body.scheduledReminders : []
	);

	let customCode: string | null = null;
	let customName: string | null = null;
	let customDisplayMode: EventDisplayMode | null = null;
	let customColor: string | null = null;
	let notificationEventName = 'Event';

	if (coverageCodeId !== null) {
		await ensureCoverageCodeIsValid(pool, scheduleId, coverageCodeId);
		const codeResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('coverageCodeId', coverageCodeId)
			.query(
				`SELECT TOP (1) Label, Code
				 FROM dbo.EventCodes
				 WHERE ScheduleId = @scheduleId
				   AND EventCodeId = @coverageCodeId
				   AND DeletedAt IS NULL;`
			);
		notificationEventName =
			codeResult.recordset?.[0]?.Label?.trim() ||
			codeResult.recordset?.[0]?.Code?.trim() ||
			'Event';
		if (
			capabilities.hasReminderColumns &&
			(!hasNotifyImmediatelyInput || !hasScheduledRemindersInput)
		) {
			const defaultsResult = await pool
				.request()
				.input('scheduleId', scheduleId)
				.input('coverageCodeId', coverageCodeId)
				.query(
					`SELECT TOP (1) NotifyImmediately, ScheduledRemindersJson
					 FROM dbo.EventCodes
					 WHERE ScheduleId = @scheduleId
					   AND EventCodeId = @coverageCodeId
					   AND DeletedAt IS NULL;`
				);
			const defaultRow = defaultsResult.recordset?.[0] as
				| { NotifyImmediately: boolean | null; ScheduledRemindersJson: string | null }
				| undefined;
			if (!hasNotifyImmediatelyInput) {
				notifyImmediately = Boolean(defaultRow?.NotifyImmediately);
			}
			if (!hasScheduledRemindersInput) {
				scheduledReminders = parseScheduledRemindersJson(
					defaultRow?.ScheduledRemindersJson ?? null
				);
			}
		}
	} else {
		if (!capabilities.hasCustomColumns) {
			throw error(400, 'Custom events require a ScheduleEvents schema update.');
		}
		customCode = cleanOptionalCustomCode(body.customCode);
		customDisplayMode = cleanOptionalDisplayMode(body.customDisplayMode);
		customColor = cleanOptionalColor(body.customColor);
		if (!customCode || !customDisplayMode || !customColor) {
			throw error(
				400,
				'Custom events require code, display mode, and color when no event code is selected'
			);
		}
		customName = cleanOptionalCustomName(body.customName, customCode);
		notificationEventName = customName || customCode || 'Custom Event';
	}
	const scheduledRemindersJson = remindersToJson(scheduledReminders);

	const setClauses = [
		'UserOid = @userOid',
		'StartDate = @startDate',
		'EndDate = @endDate',
		'EventCodeId = @coverageCodeId',
		'Notes = @comments'
	];
	if (capabilities.hasShiftId) {
		setClauses.splice(1, 0, 'ShiftId = @employeeTypeId');
	}
	if (capabilities.hasCustomColumns) {
		setClauses.splice(
			4,
			0,
			'CustomCode = @customCode',
			'CustomName = @customName',
			'CustomDisplayMode = @customDisplayMode',
			'CustomColor = @customColor'
		);
	}
	if (capabilities.hasReminderColumns) {
		setClauses.push('ScheduledRemindersJson = @scheduledRemindersJson');
	}

	const whereClauses = [
		'ScheduleId = @scheduleId',
		'EventId = @eventId',
		'IsActive = 1',
		'DeletedAt IS NULL',
		'((UserOid IS NULL AND @originalUserOid IS NULL) OR UserOid = @originalUserOid)',
		'((EventCodeId IS NULL AND @originalEventCodeId IS NULL) OR EventCodeId = @originalEventCodeId)',
		'StartDate = @originalStartDate',
		'EndDate = @originalEndDate',
		"ISNULL(LTRIM(RTRIM(Notes)), N'') = ISNULL(@originalNotes, N'')"
	];
	if (capabilities.hasShiftId) {
		whereClauses.push(
			'((ShiftId IS NULL AND @originalShiftId IS NULL) OR ShiftId = @originalShiftId)'
		);
	}
	if (capabilities.hasCustomColumns) {
		whereClauses.push(
			"ISNULL(LTRIM(RTRIM(CustomCode)), N'') = ISNULL(@originalCustomCode, N'')",
			"ISNULL(LTRIM(RTRIM(CustomName)), N'') = ISNULL(@originalCustomName, N'')",
			"ISNULL(LTRIM(RTRIM(CustomDisplayMode)), N'') = ISNULL(@originalCustomDisplayMode, N'')",
			"ISNULL(LOWER(LTRIM(RTRIM(CustomColor))), N'') = ISNULL(@originalCustomColor, N'')"
		);
	}
	if (capabilities.hasReminderColumns) {
		whereClauses.push(
			"ISNULL(ScheduledRemindersJson, N'') = ISNULL(@originalScheduledRemindersJson, N'')"
		);
	}

	const updateResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('eventId', eventId)
		.input('userOid', userOid)
		.input('employeeTypeId', employeeTypeId)
		.input('startDate', startDate)
		.input('endDate', endDate)
		.input('coverageCodeId', coverageCodeId)
		.input('customCode', customCode)
		.input('customName', customName)
		.input('customDisplayMode', customDisplayMode)
		.input('customColor', customColor)
		.input('scheduledRemindersJson', scheduledRemindersJson)
		.input('comments', comments || null)
		.input('originalUserOid', existingEvent.UserOid?.trim() || null)
		.input(
			'originalShiftId',
			existingEvent.ShiftId === null || existingEvent.ShiftId === undefined
				? null
				: Number(existingEvent.ShiftId)
		)
		.input('originalStartDate', toDateOnly(existingEvent.StartDate))
		.input('originalEndDate', toDateOnly(existingEvent.EndDate))
		.input(
			'originalEventCodeId',
			existingEvent.EventCodeId === null ? null : Number(existingEvent.EventCodeId)
		)
		.input('originalNotes', existingEvent.Notes?.trim() || null)
		.input('originalCustomCode', existingEvent.CustomCode?.trim() || null)
		.input('originalCustomName', existingEvent.CustomName?.trim() || null)
		.input('originalCustomDisplayMode', existingEvent.CustomDisplayMode?.trim() || null)
		.input('originalCustomColor', existingEvent.CustomColor?.trim().toLowerCase() || null)
		.input('originalScheduledRemindersJson', existingEvent.ScheduledRemindersJson?.trim() || null)
		.query(
			`UPDATE dbo.ScheduleEvents
			 SET ${setClauses.join(', ')}
			 WHERE ${whereClauses.join('\n			   AND ')};

			 SELECT @@ROWCOUNT AS UpdatedRows;`
		);
	const updatedRows = Number(updateResult.recordset?.[0]?.UpdatedRows ?? 0);
	if (updatedRows < 1) {
		throw error(409, 'This event has changed. Refresh and try again.');
	}

	if (notifyImmediately && eventRangeIsNotEntirelyPast(endDate)) {
		const scopeType: EventScopeType = userOid
			? 'user'
			: employeeTypeId !== null
				? 'shift'
				: 'global';
		try {
			const context = await getEventEmailContext(pool, scheduleId);
			if (context) {
				const delegatedAccessToken = await getSessionAccessToken(event);
				const affectedUsers = await getAffectedEventMemberNames({
					pool,
					scheduleId,
					scope: scopeType,
					employeeTypeId,
					userOid,
					startDate,
					endDate
				});
				const intendedRecipients = affectedUsers
					.map((member) => member.email)
					.filter((email): email is string => Boolean(email));
				const affectedUserNames = affectedUsers.map((member) => member.name);
				const targetMemberName =
					affectedUserNames.length === 0
						? 'Schedule Members'
						: affectedUserNames.length <= 5
							? affectedUserNames.join(', ')
							: `${affectedUserNames.length} schedule members`;
				await sendUpcomingEventNotification({
					scheduleName: context.scheduleName,
					themeJson: context.scheduleThemeJson,
					intendedRecipients,
					targetMemberName,
					eventName: notificationEventName,
					date: formatEventDateForEmail(startDate, endDate),
					comments,
					delegatedAccessToken
				});
			}
		} catch (notificationError) {
			console.error('Upcoming event immediate notification failed:', notificationError);
		}
	}

	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies, 'Maintainer');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') {
		throw error(400, 'Body is invalid');
	}

	const eventId = cleanOptionalInt(body.eventId, 'Event');
	const expectedVersionStamp = cleanRequiredVersionStamp(
		body.expectedVersionStamp,
		'Version stamp'
	);
	if (!eventId) {
		throw error(400, 'Event is invalid');
	}
	const capabilities = await getScheduleEventsCapabilities(pool);
	const existingQueryShiftId = capabilities.hasShiftId ? 'ShiftId' : 'CAST(NULL AS int) AS ShiftId';
	const existingQueryCustomCode = capabilities.hasCustomColumns
		? 'CustomCode'
		: 'CAST(NULL AS nvarchar(16)) AS CustomCode';
	const existingQueryCustomName = capabilities.hasCustomColumns
		? 'CustomName'
		: 'CAST(NULL AS nvarchar(100)) AS CustomName';
	const existingQueryCustomDisplayMode = capabilities.hasCustomColumns
		? 'CustomDisplayMode'
		: 'CAST(NULL AS nvarchar(30)) AS CustomDisplayMode';
	const existingQueryCustomColor = capabilities.hasCustomColumns
		? 'CustomColor'
		: 'CAST(NULL AS nvarchar(20)) AS CustomColor';
	const existingQueryNotifyImmediately = 'CAST(0 AS bit) AS NotifyImmediately';
	const existingQueryScheduledRemindersJson = capabilities.hasReminderColumns
		? 'ScheduledRemindersJson'
		: 'CAST(NULL AS nvarchar(max)) AS ScheduledRemindersJson';

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const existsResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('eventId', eventId)
			.query(
				`SELECT TOP (1)
					EventId,
					UserOid,
					${existingQueryShiftId},
					StartDate,
					EndDate,
					Notes,
					EventCodeId,
					${existingQueryCustomCode},
					${existingQueryCustomName},
					${existingQueryCustomDisplayMode},
					${existingQueryCustomColor},
					${existingQueryNotifyImmediately},
					${existingQueryScheduledRemindersJson}
				 FROM dbo.ScheduleEvents WITH (UPDLOCK, HOLDLOCK)
				 WHERE ScheduleId = @scheduleId
				   AND EventId = @eventId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);
		const existingEvent =
			(existsResult.recordset?.[0] as ExistingEventScopeRow | undefined) ?? null;
		if (!existingEvent?.EventId) {
			throw error(404, 'Event not found');
		}
		const currentVersionStamp = eventVersionStamp(existingEvent);
		if (currentVersionStamp !== expectedVersionStamp) {
			throw error(409, 'This event has changed. Refresh and try again.');
		}

		const result = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('eventId', eventId)
			.query(
				`DELETE FROM dbo.ScheduleEvents
				 OUTPUT DELETED.EventId
				 WHERE ScheduleId = @scheduleId
				   AND EventId = @eventId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);

		if (!result.recordset?.[0]?.EventId) {
			throw error(409, 'This event has changed. Refresh and try again.');
		}
		await tx.commit();
	} catch (e) {
		await tx.rollback();
		throw e;
	}

	return json({ success: true });
};
