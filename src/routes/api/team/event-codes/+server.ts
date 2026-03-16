import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';
import { requireScheduleRole } from '$lib/server/schedule-access';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
type EventCodeDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';

type EventCodeRow = {
	EventCodeId: number;
	Code: string;
	Label: string | null;
	DisplayMode: EventCodeDisplayMode | null;
	Color: string | null;
	IsActive: boolean;
	NotifyImmediately: boolean | null;
	ScheduledRemindersJson: string | null;
	ModifiedAt?: Date | string | null;
};

type EventCodesCapabilities = {
	hasReminderColumns: boolean;
};

const allowedDisplayModes = new Set<EventCodeDisplayMode>([
	'Schedule Overlay',
	'Badge Indicator',
	'Shift Override'
]);

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

async function getEventCodesCapabilities(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<EventCodesCapabilities> {
	const result = await pool.request().query(
		`SELECT COLUMN_NAME
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'EventCodes';`
	);
	const columns = new Set<string>(
		(result.recordset as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME)
	);
	return {
		hasReminderColumns:
			columns.has('NotifyImmediately') && columns.has('ScheduledRemindersJson')
	};
}

function cleanCode(value: unknown): string {
	if (typeof value !== 'string') {
		throw error(400, 'Event code is required');
	}
	const normalized = value.trim().toUpperCase().replace(/\s+/g, '-');
	if (!normalized) {
		throw error(400, 'Event code is required');
	}
	if (!/^[A-Z0-9_-]{1,16}$/.test(normalized)) {
		throw error(400, 'Event code must be 1-16 characters and use A-Z, 0-9, "_" or "-"');
	}
	return normalized;
}

function cleanName(value: unknown): string {
	if (typeof value !== 'string') {
		throw error(400, 'Display name is required');
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw error(400, 'Display name is required');
	}
	return trimmed.slice(0, 60);
}

function cleanDisplayMode(value: unknown): EventCodeDisplayMode {
	if (typeof value !== 'string' || !allowedDisplayModes.has(value as EventCodeDisplayMode)) {
		throw error(400, 'Display mode is invalid');
	}
	return value as EventCodeDisplayMode;
}

function cleanColor(value: unknown): string {
	if (typeof value !== 'string') {
		throw error(400, 'Color is required');
	}
	const trimmed = value.trim().toLowerCase();
	if (!/^#[0-9a-f]{6}$/.test(trimmed)) {
		throw error(400, 'Color must be a hex value like #22c55e');
	}
	return trimmed;
}

function cleanIsActive(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw error(400, 'Status is required');
	}
	return value;
}

function cleanNotifyImmediately(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === null || value === undefined) return false;
	throw error(400, 'Notify immediately is invalid');
}

type ReminderUnit = 'days' | 'weeks' | 'months';
type ReminderMeridiem = 'AM' | 'PM';
type ReminderDraft = {
	amount: number;
	unit: ReminderUnit;
	hour: number;
	meridiem: ReminderMeridiem;
};

function cleanScheduledRemindersJson(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
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
	if (normalized.length === 0) return null;
	return JSON.stringify(normalized);
}

function parseScheduledRemindersJson(value: string | null): ReminderDraft[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry) => {
			if (!entry || typeof entry !== 'object') return false;
			const row = entry as Record<string, unknown>;
			return (
				Number.isInteger(Number(row.amount)) &&
				(row.unit === 'days' || row.unit === 'weeks' || row.unit === 'months') &&
				Number.isInteger(Number(row.hour)) &&
				(row.meridiem === 'AM' || row.meridiem === 'PM')
			);
		}) as ReminderDraft[];
	} catch {
		return [];
	}
}

function cleanEventCodeId(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw error(400, 'Event code ID is required');
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
	return trimmed.slice(0, 200);
}

function toDateTimeIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== 'string') return null;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

export const GET: RequestHandler = async ({ locals, cookies }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const capabilities = await getEventCodesCapabilities(pool);
	const selectNotifyImmediately = capabilities.hasReminderColumns
		? 'NotifyImmediately'
		: 'CAST(0 AS bit) AS NotifyImmediately';
	const selectScheduledRemindersJson = capabilities.hasReminderColumns
		? 'ScheduledRemindersJson'
		: 'CAST(NULL AS nvarchar(max)) AS ScheduledRemindersJson';
	const result = await pool.request().input('scheduleId', scheduleId).query(
		`SELECT
			EventCodeId,
			Code,
			Label,
			DisplayMode,
			Color,
			IsActive,
			COALESCE(UpdatedAt, CreatedAt) AS ModifiedAt,
			${selectNotifyImmediately},
			${selectScheduledRemindersJson}
		 FROM dbo.EventCodes
		 WHERE ScheduleId = @scheduleId
		   AND DeletedAt IS NULL
		 ORDER BY SortOrder ASC, Code ASC, EventCodeId ASC;`
	);

	const eventCodes = (result.recordset as EventCodeRow[]).map((row) => ({
		eventCodeId: Number(row.EventCodeId),
		code: row.Code?.trim() ?? '',
		name: row.Label?.trim() || row.Code?.trim() || '',
		displayMode: (row.DisplayMode ?? 'Schedule Overlay') as EventCodeDisplayMode,
		color: row.Color?.trim() || '#22c55e',
		isActive: Boolean(row.IsActive),
		notifyImmediately: Boolean(row.NotifyImmediately),
		scheduledReminders: parseScheduledRemindersJson(row.ScheduledRemindersJson),
		versionStamp: `${Number(row.EventCodeId)}|${toDateTimeIso(row.ModifiedAt) ?? '0'}`
	}));

	return json({ eventCodes });
};

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const code = cleanCode(body?.code);
	const name = cleanName(body?.name);
	const displayMode = cleanDisplayMode(body?.displayMode);
	const color = cleanColor(body?.color);
	const isActive = cleanIsActive(body?.isActive);
	const notifyImmediately = cleanNotifyImmediately(body?.notifyImmediately);
	const scheduledRemindersJson = cleanScheduledRemindersJson(body?.scheduledReminders);
	const capabilities = await getEventCodesCapabilities(pool);

	const duplicateResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('code', code)
		.query(
			`SELECT TOP (1) EventCodeId
			 FROM dbo.EventCodes
			 WHERE ScheduleId = @scheduleId
			   AND Code = @code
			   AND DeletedAt IS NULL;`
		);
	if (duplicateResult.recordset?.[0]?.EventCodeId) {
		throw error(400, 'An event code with this code already exists in this schedule.');
	}

	const countResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			`SELECT COUNT(*) AS EventCodeCount
			 FROM dbo.EventCodes
			 WHERE ScheduleId = @scheduleId
			   AND DeletedAt IS NULL;`
		);
	const nextSortOrder = Number(countResult.recordset?.[0]?.EventCodeCount ?? 0) + 1;

	const insertColumns = [
		'ScheduleId',
		'Code',
		'Label',
		'DisplayMode',
		'Color',
		'SortOrder',
		'IsActive',
		'CreatedBy'
	];
	const insertValues = [
		'@scheduleId',
		'@code',
		'@name',
		'@displayMode',
		'@color',
		'@sortOrder',
		'@isActive',
		'@actorOid'
	];
	if (capabilities.hasReminderColumns) {
		insertColumns.splice(7, 0, 'NotifyImmediately', 'ScheduledRemindersJson');
		insertValues.splice(7, 0, '@notifyImmediately', '@scheduledRemindersJson');
	}

	await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('code', code)
		.input('name', name)
		.input('displayMode', displayMode)
		.input('color', color)
		.input('isActive', isActive)
		.input('notifyImmediately', notifyImmediately)
		.input('scheduledRemindersJson', scheduledRemindersJson)
		.input('sortOrder', nextSortOrder)
		.input('actorOid', actorOid)
		.query(
			`INSERT INTO dbo.EventCodes (${insertColumns.join(', ')})
			 VALUES (${insertValues.join(', ')});`
		);

	return json({ success: true }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId, actorOid } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const eventCodeId = cleanEventCodeId(body?.eventCodeId);
	const expectedVersionStamp = cleanRequiredVersionStamp(
		body?.expectedVersionStamp,
		'Version stamp'
	);
	const code = cleanCode(body?.code);
	const name = cleanName(body?.name);
	const displayMode = cleanDisplayMode(body?.displayMode);
	const color = cleanColor(body?.color);
	const isActive = cleanIsActive(body?.isActive);
	const notifyImmediately = cleanNotifyImmediately(body?.notifyImmediately);
	const scheduledRemindersJson = cleanScheduledRemindersJson(body?.scheduledReminders);
	const capabilities = await getEventCodesCapabilities(pool);

	const existsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('eventCodeId', eventCodeId)
		.query(
			`SELECT TOP (1) EventCodeId, COALESCE(UpdatedAt, CreatedAt) AS ModifiedAt
			 FROM dbo.EventCodes
			 WHERE ScheduleId = @scheduleId
			   AND EventCodeId = @eventCodeId
			   AND DeletedAt IS NULL;`
		);
	const existingRow = existsResult.recordset?.[0] as
		| { EventCodeId?: number; ModifiedAt?: Date | string | null }
		| undefined;
	if (!existingRow?.EventCodeId) {
		throw error(404, 'Event code not found');
	}
	const currentVersionStamp = `${Number(existingRow.EventCodeId)}|${
		toDateTimeIso(existingRow.ModifiedAt) ?? '0'
	}`;
	if (currentVersionStamp !== expectedVersionStamp) {
		throw error(409, 'This event code has changed. Refresh and try again.');
	}

	const duplicateResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('eventCodeId', eventCodeId)
		.input('code', code)
		.query(
			`SELECT TOP (1) EventCodeId
			 FROM dbo.EventCodes
			 WHERE ScheduleId = @scheduleId
			   AND EventCodeId <> @eventCodeId
			   AND Code = @code
			   AND DeletedAt IS NULL;`
		);
	if (duplicateResult.recordset?.[0]?.EventCodeId) {
		throw error(400, 'An event code with this code already exists in this schedule.');
	}

	const setClauses = [
		'Code = @code',
		'Label = @name',
		'DisplayMode = @displayMode',
		'Color = @color',
		'IsActive = @isActive',
		'UpdatedAt = SYSUTCDATETIME()',
		'UpdatedBy = @actorOid'
	];
	if (capabilities.hasReminderColumns) {
		setClauses.push('NotifyImmediately = @notifyImmediately', 'ScheduledRemindersJson = @scheduledRemindersJson');
	}

	await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('eventCodeId', eventCodeId)
		.input('code', code)
		.input('name', name)
		.input('displayMode', displayMode)
		.input('color', color)
		.input('isActive', isActive)
		.input('notifyImmediately', notifyImmediately)
		.input('scheduledRemindersJson', scheduledRemindersJson)
		.input('actorOid', actorOid)
		.query(
			`UPDATE dbo.EventCodes
			 SET ${setClauses.join(', ')}
			 WHERE ScheduleId = @scheduleId
			   AND EventCodeId = @eventCodeId
			   AND DeletedAt IS NULL;`
		);

	return json({ success: true });
};
