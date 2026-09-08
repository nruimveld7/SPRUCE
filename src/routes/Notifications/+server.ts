import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { GetPool } from '$lib/server/db';
import type { RequestHandler } from './$types';
import sql from 'mssql';
import { storedUserDisplayNameSql } from '$lib/server/user-name-sql';

const NOTIFICATIONS_MTLS_ALLOWED_SUBJECTS = 'NOTIFICATIONS_MTLS_ALLOWED_SUBJECTS';
const NOTIFICATIONS_MTLS_ALLOWED_ISSUERS = 'NOTIFICATIONS_MTLS_ALLOWED_ISSUERS';
const NOTIFICATIONS_MTLS_ALLOWED_FINGERPRINTS = 'NOTIFICATIONS_MTLS_ALLOWED_FINGERPRINTS';

const OVERDUE_CUTOFF_MS = 3 * 60 * 60 * 1000;
const FORWARD_LOOKAHEAD_MS = 60 * 60 * 1000;

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

type CandidateEventRow = {
	EventId: number;
	ScheduleId: number;
	UserOid: string | null;
	ShiftId: number | null;
	StartDate: Date | string;
	EndDate: Date | string;
	Notes: string | null;
	ScheduledRemindersJson: string | null;
	RemindersHandled: boolean | null;
	ScheduleName: string | null;
	ScheduleThemeJson: string | null;
	CoverageLabel: string | null;
	CoverageCode: string | null;
	CustomName: string | null;
	CustomCode: string | null;
};

type AffectedEventMember = {
	userOid: string;
	name: string;
	email: string | null;
};

type NotificationsRequestPayload = {
	type: 'NotificationsRequest';
};

type NotificationResultRow = {
	notificationId: string;
	success: boolean;
	error?: string;
};

type NotificationsResultPayload = {
	type?: 'NotificationsResult';
	results: NotificationResultRow[];
};

type NotificationTheme = {
	buttonColor: string | null;
	buttonTextColor: string | null;
};

function parseCsv(value: string | undefined): Set<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean)
	);
}

function requireAllowedIdentity(headerValue: string | null, allowed: Set<string>, fieldName: string): void {
	if (!headerValue) {
		throw error(403, `mTLS client ${fieldName} is missing`);
	}
	if (!allowed.has(headerValue)) {
		throw error(403, `mTLS client ${fieldName} is not allowed`);
	}
}

function normalizeFingerprint(value: string): string {
	return value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function requireAllowedFingerprint(
	headerValue: string | null,
	allowedFingerprints: Set<string>
): void {
	if (!headerValue) {
		throw error(403, 'mTLS client fingerprint is missing');
	}
	if (!allowedFingerprints.has(normalizeFingerprint(headerValue))) {
		throw error(403, 'mTLS client fingerprint is not allowed');
	}
}

function requireIdentityPolicyConfigured(): {
	allowedSubjects: Set<string>;
	allowedIssuers: Set<string>;
	allowedFingerprints: Set<string>;
} {
	const allowedSubjects = parseCsv(env[NOTIFICATIONS_MTLS_ALLOWED_SUBJECTS]);
	const allowedIssuers = parseCsv(env[NOTIFICATIONS_MTLS_ALLOWED_ISSUERS]);
	const allowedFingerprints = new Set(
		Array.from(parseCsv(env[NOTIFICATIONS_MTLS_ALLOWED_FINGERPRINTS]), normalizeFingerprint)
	);

	if (allowedSubjects.size === 0 || allowedIssuers.size === 0 || allowedFingerprints.size === 0) {
		throw error(
			503,
			`${NOTIFICATIONS_MTLS_ALLOWED_SUBJECTS}, ${NOTIFICATIONS_MTLS_ALLOWED_ISSUERS}, and ${NOTIFICATIONS_MTLS_ALLOWED_FINGERPRINTS} must all be configured`
		);
	}

	return { allowedSubjects, allowedIssuers, allowedFingerprints };
}

function requireTrustedClientChain(request: Request): void {
	const mtlsVerify = request.headers.get('x-client-verify');
	const mtlsGate = request.headers.get('x-mtls-route');
	if (mtlsVerify !== 'SUCCESS' || mtlsGate !== 'notifications-v1') {
		throw error(403, 'mTLS client certificate validation failed');
	}
}

function parseDateOnly(value: Date | string): { year: number; month: number; day: number } | null {
	if (value instanceof Date) {
		return {
			year: value.getUTCFullYear(),
			month: value.getUTCMonth() + 1,
			day: value.getUTCDate()
		};
	}
	if (typeof value !== 'string') return null;
	const trimmed = value.slice(0, 10);
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
	if (!match) return null;
	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3])
	};
}

function toDateOnly(value: Date | string): string | null {
	const parsed = parseDateOnly(value);
	if (!parsed) return null;
	const year = String(parsed.year).padStart(4, '0');
	const month = String(parsed.month).padStart(2, '0');
	const day = String(parsed.day).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function reminderHourTo24(hour: number, meridiem: ReminderMeridiem): number {
	let output = hour;
	if (output === 12) output = 0;
	if (meridiem === 'PM') output += 12;
	return output;
}

function reminderDueAt(startDate: Date | string, reminder: ReminderDraft): Date | null {
	const parsed = parseDateOnly(startDate);
	if (!parsed) return null;
	const due = new Date(
		parsed.year,
		parsed.month - 1,
		parsed.day,
		reminderHourTo24(reminder.hour, reminder.meridiem),
		0,
		0,
		0
	);
	if (Number.isNaN(due.getTime())) return null;
	if (reminder.unit === 'months') {
		due.setMonth(due.getMonth() - reminder.amount);
		return due;
	}
	const dayOffset = reminder.unit === 'weeks' ? reminder.amount * 7 : reminder.amount;
	due.setDate(due.getDate() - dayOffset);
	return due;
}

function parseScheduledRemindersJson(value: string | null): ReminderDraft[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		const output: ReminderDraft[] = [];
		const seen = new Set<string>();
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
			const key = `${amount}|${unit}|${hour}|${meridiem}`;
			if (seen.has(key)) continue;
			seen.add(key);
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

function serializeScheduledRemindersJson(reminders: ReminderDraft[]): string | null {
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

function reminderKey(reminder: ReminderDraft): string {
	return `${reminder.amount}|${reminder.unit}|${reminder.hour}|${reminder.meridiem}`;
}

function toEventName(row: CandidateEventRow): string {
	return (
		row.CoverageLabel?.trim() ||
		row.CoverageCode?.trim() ||
		row.CustomName?.trim() ||
		row.CustomCode?.trim() ||
		'Event'
	);
}

function formatEventDateForEmail(startDate: Date | string, endDate: Date | string): string {
	const startDateOnly = toDateOnly(startDate);
	const endDateOnly = toDateOnly(endDate);
	if (!startDateOnly || !endDateOnly) return '';
	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const formatDateOnlyLabel = (value: string): string => {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
		if (!match) return value;
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return value;
		if (month < 1 || month > 12 || day < 1 || day > 31) return value;
		return `${monthNames[month - 1]} ${day}, ${year}`;
	};
	const startText = formatDateOnlyLabel(startDateOnly);
	const endText = formatDateOnlyLabel(endDateOnly);
	return startDateOnly === endDateOnly ? startText : `${startText} to ${endText}`;
}

function normalizeRecipients(recipients: Array<string | null>): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const entry of recipients) {
		const value = entry?.trim();
		if (!value) continue;
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(value);
	}
	return output;
}

function parseNotificationTheme(themeJson: string | null): NotificationTheme {
	if (!themeJson) {
		return {
			buttonColor: null,
			buttonTextColor: null
		};
	}
	try {
		const parsed = JSON.parse(themeJson) as {
			dark?: { accent?: unknown; text?: unknown };
		};
		const buttonColor = typeof parsed.dark?.accent === 'string' ? parsed.dark.accent : null;
		const buttonTextColor = typeof parsed.dark?.text === 'string' ? parsed.dark.text : null;
		return { buttonColor, buttonTextColor };
	} catch {
		return {
			buttonColor: null,
			buttonTextColor: null
		};
	}
}

async function getAffectedEventMembers(params: {
	pool: Awaited<ReturnType<typeof GetPool>>;
	scheduleId: number;
	userOid: string | null;
	shiftId: number | null;
	startDate: Date | string;
	endDate: Date | string;
}): Promise<AffectedEventMember[]> {
	const { pool, scheduleId, userOid, shiftId, startDate, endDate } = params;
	const startDateOnly = toDateOnly(startDate);
	const endDateOnly = toDateOnly(endDate);
	if (!startDateOnly || !endDateOnly) return [];

	if (userOid) {
		const result = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('userOid', userOid)
			.query(
				`SELECT TOP (1)
					su.UserOid AS MemberUserOid,
					${storedUserDisplayNameSql('u')} AS MemberName,
					NULLIF(LTRIM(RTRIM(u.Email)), '') AS MemberEmail
				 FROM dbo.ScheduleUsers su
				 INNER JOIN dbo.Users u
				   ON u.UserOid = su.UserOid
				 WHERE su.ScheduleId = @scheduleId
				   AND su.UserOid = @userOid
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL;`
			);
		const memberUserOid = result.recordset?.[0]?.MemberUserOid?.trim();
		const memberName = result.recordset?.[0]?.MemberName?.trim();
		const memberEmail = result.recordset?.[0]?.MemberEmail?.trim() || null;
		return memberName && memberUserOid
			? [{ userOid: memberUserOid, name: memberName, email: memberEmail }]
			: [];
	}

	if (shiftId !== null) {
		const result = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('shiftId', shiftId)
			.input('startDate', startDateOnly)
			.input('endDate', endDateOnly)
			.query(
				`SELECT DISTINCT
					sa.UserOid AS MemberUserOid,
					${storedUserDisplayNameSql('u')} AS MemberName,
					NULLIF(LTRIM(RTRIM(u.Email)), '') AS MemberEmail
				 FROM dbo.ScheduleAssignments sa
				 INNER JOIN dbo.ScheduleUsers su
				   ON su.ScheduleId = sa.ScheduleId
				  AND su.UserOid = sa.UserOid
				 INNER JOIN dbo.Users u
				   ON u.UserOid = sa.UserOid
				 WHERE sa.ScheduleId = @scheduleId
				   AND sa.ShiftId = @shiftId
				   AND sa.IsActive = 1
				   AND sa.DeletedAt IS NULL
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL
				   AND sa.StartDate <= @endDate
				   AND (sa.EndDate IS NULL OR sa.EndDate >= @startDate)
				 ORDER BY MemberName ASC;`
			);
		return (
			result.recordset as Array<{
				MemberUserOid: string;
				MemberName: string | null;
				MemberEmail: string | null;
			}>
		)
			.map((row) => ({
				userOid: row.MemberUserOid?.trim() || '',
				name: row.MemberName?.trim() || '',
				email: row.MemberEmail?.trim() || null
			}))
			.filter((row) => Boolean(row.userOid) && Boolean(row.name));
	}

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('startDate', startDateOnly)
		.input('endDate', endDateOnly)
		.query(
			`SELECT DISTINCT
				sa.UserOid AS MemberUserOid,
				${storedUserDisplayNameSql('u')} AS MemberName,
				NULLIF(LTRIM(RTRIM(u.Email)), '') AS MemberEmail
			 FROM dbo.ScheduleAssignments sa
			 INNER JOIN dbo.ScheduleUsers su
			   ON su.ScheduleId = sa.ScheduleId
			  AND su.UserOid = sa.UserOid
			 INNER JOIN dbo.Users u
			   ON u.UserOid = sa.UserOid
			 WHERE sa.ScheduleId = @scheduleId
			   AND sa.IsActive = 1
			   AND sa.DeletedAt IS NULL
			   AND su.IsActive = 1
			   AND su.DeletedAt IS NULL
			   AND sa.StartDate <= @endDate
			   AND (sa.EndDate IS NULL OR sa.EndDate >= @startDate)
			 ORDER BY MemberName ASC;`
		);
	return (
		result.recordset as Array<{
			MemberUserOid: string;
			MemberName: string | null;
			MemberEmail: string | null;
		}>
	)
		.map((row) => ({
			userOid: row.MemberUserOid?.trim() || '',
			name: row.MemberName?.trim() || '',
			email: row.MemberEmail?.trim() || null
		}))
		.filter((row) => Boolean(row.userOid) && Boolean(row.name));
}

function makeNotificationId(eventId: number, reminder: ReminderDraft): string {
	return `event:${eventId}|reminder:${reminderKey(reminder)}`;
}

function parseNotificationId(value: string): { eventId: number; reminderKey: string } | null {
	const marker = '|reminder:';
	if (!value.startsWith('event:')) return null;
	const markerIndex = value.indexOf(marker);
	if (markerIndex < 0) return null;
	const eventPart = value.slice(6, markerIndex).trim();
	const reminderPart = value.slice(markerIndex + marker.length).trim();
	const eventId = Number(eventPart);
	if (!Number.isInteger(eventId) || eventId <= 0 || !reminderPart) return null;
	return { eventId, reminderKey: reminderPart };
}

async function hasRemindersHandledColumn(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<boolean> {
	const result = await pool.request().query(
		`SELECT TOP (1) 1 AS HasColumn
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'ScheduleEvents'
		   AND COLUMN_NAME = 'RemindersHandled';`
	);
	return result.recordset?.[0]?.HasColumn === 1;
}

async function updateEventReminderState(params: {
	pool: Awaited<ReturnType<typeof GetPool>>;
	eventId: number;
	reminders: ReminderDraft[];
	remindersHandled: boolean;
	hasRemindersHandledColumn: boolean;
}): Promise<void> {
	const { pool, eventId, reminders, remindersHandled, hasRemindersHandledColumn } = params;
	const request = pool
		.request()
		.input('eventId', eventId)
		.input('scheduledRemindersJson', serializeScheduledRemindersJson(reminders));
	const setClauses = ['ScheduledRemindersJson = @scheduledRemindersJson'];
	if (hasRemindersHandledColumn) {
		request.input('remindersHandled', remindersHandled);
		setClauses.push('RemindersHandled = @remindersHandled');
	}
	await request.query(
		`UPDATE dbo.ScheduleEvents
		 SET ${setClauses.join(', ')}
		 WHERE EventId = @eventId
		   AND IsActive = 1
		   AND DeletedAt IS NULL;`
	);
}

async function markReminderHandledFromResult(params: {
	pool: Awaited<ReturnType<typeof GetPool>>;
	eventId: number;
	reminderKeyValue: string;
	handledAtUtc: string;
	hasRemindersHandledColumn: boolean;
}): Promise<boolean> {
	const tx = new sql.Transaction(params.pool);
	await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
	try {
		const selectColumns = params.hasRemindersHandledColumn
			? 'ScheduledRemindersJson, RemindersHandled'
			: 'ScheduledRemindersJson, CAST(0 AS bit) AS RemindersHandled';
		const rowResult = await new sql.Request(tx).input('eventId', params.eventId).query(
			`SELECT TOP (1) ${selectColumns}
			 FROM dbo.ScheduleEvents WITH (UPDLOCK, HOLDLOCK)
			 WHERE EventId = @eventId
			   AND IsActive = 1
			   AND DeletedAt IS NULL;`
		);
		const row = rowResult.recordset?.[0] as
			| { ScheduledRemindersJson?: string | null; RemindersHandled?: boolean | null }
			| undefined;
		if (!row) {
			await tx.rollback();
			return false;
		}

		const reminders = parseScheduledRemindersJson(row.ScheduledRemindersJson ?? null);
		let changed = false;
		for (const reminder of reminders) {
			if (reminderKey(reminder) !== params.reminderKeyValue) continue;
			if (reminder.handled === true) {
				await tx.rollback();
				return false;
			}
			reminder.handled = true;
			reminder.handledAtUtc = params.handledAtUtc;
			changed = true;
			break;
		}
		if (!changed) {
			await tx.rollback();
			return false;
		}

		const remindersHandled = reminders.every((reminder) => reminder.handled === true);
		const update = new sql.Request(tx)
			.input('eventId', params.eventId)
			.input('scheduledRemindersJson', serializeScheduledRemindersJson(reminders));
		const setClauses = ['ScheduledRemindersJson = @scheduledRemindersJson'];
		if (params.hasRemindersHandledColumn) {
			update.input('remindersHandled', remindersHandled);
			setClauses.push('RemindersHandled = @remindersHandled');
		}
		await update.query(
			`UPDATE dbo.ScheduleEvents
			 SET ${setClauses.join(', ')}
			 WHERE EventId = @eventId;`
		);
		await tx.commit();
		return true;
	} catch (err) {
		try {
			await tx.rollback();
		} catch {
			// no-op
		}
		throw err;
	}
}

function isNotificationsRequestPayload(value: unknown): value is NotificationsRequestPayload {
	if (!value || typeof value !== 'object') return false;
	return (value as Record<string, unknown>).type === 'NotificationsRequest';
}

function isNotificationsResultPayload(value: unknown): value is NotificationsResultPayload {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	if (record.type !== undefined && record.type !== 'NotificationsResult') return false;
	if (!Array.isArray(record.results)) return false;
	return record.results.every((row) => {
		if (!row || typeof row !== 'object') return false;
		const item = row as Record<string, unknown>;
		return typeof item.notificationId === 'string' && typeof item.success === 'boolean';
	});
}

async function handleNotificationsRequest(): Promise<Response> {
	const pool = await GetPool();
	const remindersHandledColumn = await hasRemindersHandledColumn(pool);
	const selectRemindersHandled = remindersHandledColumn
		? 'se.RemindersHandled'
		: 'CAST(0 AS bit) AS RemindersHandled';
	const remindersHandledPredicate = remindersHandledColumn
		? 'AND ISNULL(se.RemindersHandled, 0) = 0'
		: '';

	const result = await pool.request().query(
		`SELECT
			se.EventId,
			se.ScheduleId,
			se.UserOid,
			se.ShiftId,
			se.StartDate,
			se.EndDate,
			se.Notes,
			se.ScheduledRemindersJson,
			${selectRemindersHandled},
			s.Name AS ScheduleName,
			s.ThemeJson AS ScheduleThemeJson,
			ec.Label AS CoverageLabel,
			ec.Code AS CoverageCode,
			se.CustomName,
			se.CustomCode
		 FROM dbo.ScheduleEvents se
		 INNER JOIN dbo.Schedules s
		   ON s.ScheduleId = se.ScheduleId
		 LEFT JOIN dbo.EventCodes ec
		   ON ec.ScheduleId = se.ScheduleId
		  AND ec.EventCodeId = se.EventCodeId
		  AND ec.IsActive = 1
		  AND ec.DeletedAt IS NULL
		 WHERE se.IsActive = 1
		   AND se.DeletedAt IS NULL
		   AND se.ScheduledRemindersJson IS NOT NULL
		   AND LTRIM(RTRIM(se.ScheduledRemindersJson)) <> ''
		   ${remindersHandledPredicate}
		   AND se.StartDate >= DATEADD(day, -7, CAST(SYSUTCDATETIME() AS date))
		   AND se.StartDate <= DATEADD(month, 31, CAST(SYSUTCDATETIME() AS date));`
	);

	const rows = result.recordset as CandidateEventRow[];
	const now = new Date();
	const nowIso = now.toISOString();
	const staleCutoff = new Date(now.getTime() - OVERDUE_CUTOFF_MS);
	const forwardCutoff = new Date(now.getTime() + FORWARD_LOOKAHEAD_MS);

	const notifications: Array<{
		notificationId: string;
		recipients: string[];
		scheduleName: string;
		eventName: string;
		dateLabel: string;
		comments: string;
		theme: NotificationTheme;
	}> = [];

	for (const row of rows) {
		const scheduleName = row.ScheduleName?.trim();
		if (!scheduleName) continue;
		const reminders = parseScheduledRemindersJson(row.ScheduledRemindersJson);
		if (reminders.length === 0) {
			if (remindersHandledColumn && row.RemindersHandled !== true) {
				await updateEventReminderState({
					pool,
					eventId: Number(row.EventId),
					reminders,
					remindersHandled: true,
					hasRemindersHandledColumn: remindersHandledColumn
				});
			}
			continue;
		}

		const dueReminders: Array<{ reminder: ReminderDraft; dueAt: Date }> = [];
		let rowChanged = false;
		for (const reminder of reminders) {
			if (reminder.handled === true) continue;
			const dueAt = reminderDueAt(row.StartDate, reminder);
			if (!dueAt) continue;
			if (dueAt.getTime() < staleCutoff.getTime()) {
				reminder.handled = true;
				reminder.handledAtUtc = nowIso;
				rowChanged = true;
				continue;
			}
			if (dueAt.getTime() > forwardCutoff.getTime()) continue;
			dueReminders.push({ reminder, dueAt });
		}

		const remindersHandled = reminders.every((reminder) => reminder.handled === true);
		if (rowChanged || (remindersHandledColumn && row.RemindersHandled !== remindersHandled)) {
			await updateEventReminderState({
				pool,
				eventId: Number(row.EventId),
				reminders,
				remindersHandled,
				hasRemindersHandledColumn: remindersHandledColumn
			});
		}

		if (dueReminders.length === 0) continue;
		const affectedUsers = await getAffectedEventMembers({
			pool,
			scheduleId: Number(row.ScheduleId),
			userOid: row.UserOid?.trim() || null,
			shiftId: row.ShiftId === null || row.ShiftId === undefined ? null : Number(row.ShiftId),
			startDate: row.StartDate,
			endDate: row.EndDate
		});
		const recipients = normalizeRecipients(affectedUsers.map((member) => member.email));
		if (recipients.length === 0) continue;

		const eventName = toEventName(row);
		const comments = row.Notes?.trim() ?? '';
		const dateLabel = formatEventDateForEmail(row.StartDate, row.EndDate);
		if (!dateLabel) continue;
		const theme = parseNotificationTheme(row.ScheduleThemeJson ?? null);

		for (const dueReminder of dueReminders) {
			notifications.push({
				notificationId: makeNotificationId(Number(row.EventId), dueReminder.reminder),
				recipients,
				scheduleName,
				eventName,
				dateLabel,
				comments,
				theme
			});
		}
	}

	return json({ notifications });
}

async function handleNotificationsResult(payload: NotificationsResultPayload): Promise<Response> {
	const pool = await GetPool();
	const remindersHandledColumn = await hasRemindersHandledColumn(pool);
	const handledAtUtc = new Date().toISOString();
	let markedHandled = 0;
	let ignored = 0;
	const rejectedIds: string[] = [];

	for (const resultRow of payload.results) {
		if (!resultRow.success) {
			ignored += 1;
			continue;
		}
		const parsed = parseNotificationId(resultRow.notificationId);
		if (!parsed) {
			rejectedIds.push(resultRow.notificationId);
			continue;
		}
		const updated = await markReminderHandledFromResult({
			pool,
			eventId: parsed.eventId,
			reminderKeyValue: parsed.reminderKey,
			handledAtUtc,
			hasRemindersHandledColumn: remindersHandledColumn
		});
		if (updated) {
			markedHandled += 1;
		} else {
			ignored += 1;
		}
	}

	return json({
		type: 'NotificationsResultAck',
		receivedResults: payload.results.length,
		markedHandled,
		ignored,
		rejectedIds
	});
}

function requireNotificationsClient(request: Request): void {
	requireTrustedClientChain(request);
	const { allowedSubjects, allowedIssuers, allowedFingerprints } = requireIdentityPolicyConfigured();
	requireAllowedIdentity(request.headers.get('x-client-subject-dn'), allowedSubjects, 'subject');
	requireAllowedIdentity(request.headers.get('x-client-issuer-dn'), allowedIssuers, 'issuer');
	requireAllowedFingerprint(request.headers.get('x-client-fingerprint'), allowedFingerprints);
}

export const GET: RequestHandler = async ({ request }) => {
	requireNotificationsClient(request);
	return json({
		message: 'Notification endpoint is online',
		acceptedPayloads: [
			{ type: 'NotificationsRequest' },
			{ type: 'NotificationsResult', results: [{ notificationId: '...', success: true }] },
			{ results: [{ notificationId: '...', success: true }] }
		]
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireNotificationsClient(request);
	const body = (await request.json().catch(() => null)) as unknown;

	if (isNotificationsRequestPayload(body)) {
		return handleNotificationsRequest();
	}
	if (isNotificationsResultPayload(body)) {
		return handleNotificationsResult(body);
	}

	throw error(
		400,
		'Body must be {"type":"NotificationsRequest"} or {"results":[{"notificationId":"...","success":true}]}.'
	);
};
