import { GetPool } from '$lib/server/db';
import { sendUpcomingEventNotification } from '$lib/server/mail/notifications';
import sql from 'mssql';

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
	ScheduleName: string | null;
	ScheduleThemeJson: string | null;
	CoverageLabel: string | null;
	CoverageCode: string | null;
	CustomName: string | null;
	CustomCode: string | null;
};

type AffectedEventMember = {
	name: string;
	email: string | null;
};

export type ScheduledReminderDispatchSummary = {
	nowIso: string;
	candidateEvents: number;
	dueReminders: number;
	claimedReminders: number;
	sentReminders: number;
	skippedReminders: number;
	failedReminders: number;
};

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

function formatEventDateForEmail(startDate: Date | string, endDate: Date | string): string {
	const startDateOnly = toDateOnly(startDate);
	const endDateOnly = toDateOnly(endDate);
	if (!startDateOnly || !endDateOnly) return '';
	const formatter = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const start = new Date(`${startDateOnly}T00:00:00Z`);
	const end = new Date(`${endDateOnly}T00:00:00Z`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
		return startDateOnly === endDateOnly ? startDateOnly : `${startDateOnly} to ${endDateOnly}`;
	}
	const startText = formatter.format(start);
	const endText = formatter.format(end);
	return startDateOnly === endDateOnly ? startText : `${startText} to ${endText}`;
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

async function getAffectedEventMemberNames(params: {
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
		const memberName = result.recordset?.[0]?.MemberName?.trim();
		const memberEmail = result.recordset?.[0]?.MemberEmail?.trim() || null;
		return memberName ? [{ name: memberName, email: memberEmail }] : [];
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
					COALESCE(NULLIF(LTRIM(RTRIM(u.DisplayName)), ''), NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserOid) AS MemberName,
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
		.input('startDate', startDateOnly)
		.input('endDate', endDateOnly)
		.query(
			`SELECT DISTINCT
				COALESCE(NULLIF(LTRIM(RTRIM(u.DisplayName)), ''), NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserOid) AS MemberName,
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
	return (result.recordset as Array<{ MemberName: string | null; MemberEmail: string | null }>)
		.map((row) => ({ name: row.MemberName?.trim() || '', email: row.MemberEmail?.trim() || null }))
		.filter((row) => Boolean(row.name));
}

async function claimReminder(params: {
	pool: Awaited<ReturnType<typeof GetPool>>;
	eventId: number;
	reminderKey: string;
	dueByUtc: Date;
}): Promise<boolean> {
	const tx = new sql.Transaction(params.pool);
	await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
	try {
		const lockResult = await new sql.Request(tx).input('eventId', params.eventId).query(
			`SELECT TOP (1) StartDate, ScheduledRemindersJson
				 FROM dbo.ScheduleEvents WITH (UPDLOCK, HOLDLOCK)
				 WHERE EventId = @eventId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
		);
		const row = lockResult.recordset?.[0] as
			| { StartDate?: Date | string; ScheduledRemindersJson?: string | null }
			| undefined;
		if (!row?.StartDate) {
			await tx.rollback();
			return false;
		}

		const now = new Date();
		const reminders = parseScheduledRemindersJson(row.ScheduledRemindersJson ?? null);
		let changed = false;
		for (const reminder of reminders) {
			if (reminderKey(reminder) !== params.reminderKey) continue;
			if (reminder.handled) {
				await tx.rollback();
				return false;
			}
			const dueAt = reminderDueAt(row.StartDate, reminder);
			if (!dueAt || dueAt.getTime() > params.dueByUtc.getTime()) {
				await tx.rollback();
				return false;
			}
			reminder.handled = true;
			reminder.handledAtUtc = now.toISOString();
			changed = true;
			break;
		}

		if (!changed) {
			await tx.rollback();
			return false;
		}

		await new sql.Request(tx)
			.input('eventId', params.eventId)
			.input('scheduledRemindersJson', serializeScheduledRemindersJson(reminders))
			.query(
				`UPDATE dbo.ScheduleEvents
				    SET ScheduledRemindersJson = @scheduledRemindersJson
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

export async function dispatchDueScheduledEventReminders(): Promise<ScheduledReminderDispatchSummary> {
	const pool = await GetPool();
	const now = new Date();
	const staleCutoffUtc = new Date(now.getTime() - 2 * 60 * 60 * 1000);
	const summary: ScheduledReminderDispatchSummary = {
		nowIso: now.toISOString(),
		candidateEvents: 0,
		dueReminders: 0,
		claimedReminders: 0,
		sentReminders: 0,
		skippedReminders: 0,
		failedReminders: 0
	};

	const candidateEventsResult = await pool.request().query(
		`SELECT
			se.EventId,
			se.ScheduleId,
			se.UserOid,
			se.ShiftId,
			se.StartDate,
			se.EndDate,
			se.Notes,
			se.ScheduledRemindersJson,
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
		   AND se.StartDate >= DATEADD(day, -7, CAST(SYSUTCDATETIME() AS date))
		   AND se.StartDate <= DATEADD(month, 31, CAST(SYSUTCDATETIME() AS date));`
	);

	const candidateEvents = candidateEventsResult.recordset as CandidateEventRow[];
	summary.candidateEvents = candidateEvents.length;

	for (const eventRow of candidateEvents) {
		const scheduleName = eventRow.ScheduleName?.trim();
		if (!scheduleName) continue;
		const reminders = parseScheduledRemindersJson(eventRow.ScheduledRemindersJson);
		if (reminders.length === 0) continue;
		const eventName = toEventName(eventRow);
		const comments = eventRow.Notes?.trim() ?? '';
		const dateLabel = formatEventDateForEmail(eventRow.StartDate, eventRow.EndDate);
		if (!dateLabel) continue;

		for (const reminder of reminders) {
			if (reminder.handled) continue;
			const dueAt = reminderDueAt(eventRow.StartDate, reminder);
			if (!dueAt || dueAt.getTime() > now.getTime()) continue;
			summary.dueReminders += 1;

			const claimKey = reminderKey(reminder);
			if (dueAt.getTime() < staleCutoffUtc.getTime()) {
				const staleHandled = await claimReminder({
					pool,
					eventId: Number(eventRow.EventId),
					reminderKey: claimKey,
					dueByUtc: staleCutoffUtc
				});
				if (staleHandled) {
					summary.skippedReminders += 1;
				}
				continue;
			}
			const claimed = await claimReminder({
				pool,
				eventId: Number(eventRow.EventId),
				reminderKey: claimKey,
				dueByUtc: now
			});
			if (!claimed) continue;
			summary.claimedReminders += 1;

			try {
				const affectedUsers = await getAffectedEventMemberNames({
					pool,
					scheduleId: Number(eventRow.ScheduleId),
					userOid: eventRow.UserOid?.trim() || null,
					shiftId:
						eventRow.ShiftId === null || eventRow.ShiftId === undefined
							? null
							: Number(eventRow.ShiftId),
					startDate: eventRow.StartDate,
					endDate: eventRow.EndDate
				});
				const intendedRecipients = Array.from(
					new Set(
						affectedUsers
							.map((member) => member.email?.trim())
							.filter((email): email is string => Boolean(email))
							.map((email) => email.toLowerCase())
					)
				);
				const affectedUserNames = affectedUsers.map((member) => member.name);
				const targetMemberName =
					affectedUserNames.length === 0
						? 'Schedule Members'
						: affectedUserNames.length <= 5
							? affectedUserNames.join(', ')
							: `${affectedUserNames.length} schedule members`;

				if (intendedRecipients.length === 0) {
					summary.skippedReminders += 1;
					continue;
				}

				await sendUpcomingEventNotification({
					scheduleName,
					themeJson: eventRow.ScheduleThemeJson ?? null,
					intendedRecipients,
					targetMemberName,
					eventName,
					date: dateLabel,
					comments
				});

				summary.sentReminders += 1;
			} catch (error) {
				console.error('Scheduled reminder send failed:', error);
				summary.failedReminders += 1;
			}
		}
	}

	return summary;
}
