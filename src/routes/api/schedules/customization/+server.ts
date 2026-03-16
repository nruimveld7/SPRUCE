import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import { DEFAULT_SCHEDULE_THEME } from '$lib/server/schedule-theme';
import sql from 'mssql';
import { requireScheduleRole } from '$lib/server/schedule-access';

type ThemeFieldKey =
	| 'background'
	| 'text'
	| 'accent'
	| 'todayColor'
	| 'weekendColor'
	| 'weekdayColor'
	| 'pageBorderColor'
	| 'scheduleBorderColor'
	| 'primaryGradient1'
	| 'primaryGradient2'
	| 'secondaryGradient1'
	| 'secondaryGradient2';
type ThemeDraft = Record<ThemeFieldKey, string>;
type ScheduleThemePayload = {
	dark: ThemeDraft;
	light: ThemeDraft;
};

const themeKeys: ThemeFieldKey[] = [
	'background',
	'text',
	'accent',
	'todayColor',
	'weekendColor',
	'weekdayColor',
	'pageBorderColor',
	'scheduleBorderColor',
	'primaryGradient1',
	'primaryGradient2',
	'secondaryGradient1',
	'secondaryGradient2'
];

const themeDefaults: Record<'dark' | 'light', ThemeDraft> = DEFAULT_SCHEDULE_THEME;

function parseScheduleId(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw error(400, 'A valid scheduleId is required');
	}
	return value;
}

function parseScheduleName(value: unknown): string {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	if (!trimmed) {
		throw error(400, 'Schedule name is required');
	}
	if (trimmed.length > 200) {
		throw error(400, 'Schedule name must be 200 characters or fewer');
	}
	return trimmed;
}

function isHexColor(value: string): boolean {
	return /^#[0-9a-f]{6}$/i.test(value);
}

function parseExpectedVersionEpochMs(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') {
		throw error(400, 'A valid expectedVersionAt value is required');
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, 'A valid expectedVersionAt value is required');
	}
	return parsed.getTime();
}

function parseThemePayload(value: unknown): ScheduleThemePayload {
	if (!value || typeof value !== 'object') {
		throw error(400, 'A valid theme payload is required');
	}

	const candidate = value as Record<string, unknown>;
	const dark = candidate.dark as Record<string, unknown> | undefined;
	const light = candidate.light as Record<string, unknown> | undefined;
	if (!dark || !light || typeof dark !== 'object' || typeof light !== 'object') {
		throw error(400, 'Both dark and light theme values are required');
	}

	const parseMode = (mode: Record<string, unknown>, modeDefaults: ThemeDraft): ThemeDraft => {
		const parsed = {} as ThemeDraft;
		for (const key of themeKeys) {
			const raw =
				mode[key] ??
				((key === 'pageBorderColor' || key === 'scheduleBorderColor'
					? mode.borderColor
					: undefined) as unknown) ??
				modeDefaults[key];
			if (typeof raw !== 'string' || !isHexColor(raw)) {
				throw error(400, `Invalid color value for ${key}`);
			}
			parsed[key] = raw.toLowerCase();
		}
		return parsed;
	};

	return {
		dark: parseMode(dark, themeDefaults.dark),
		light: parseMode(light, themeDefaults.light)
	};
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const body = await request.json().catch(() => null);
	const scheduleId = parseScheduleId(body?.scheduleId);
	const scheduleName = parseScheduleName(body?.scheduleName);
	const expectedVersionEpochMs = parseExpectedVersionEpochMs(body?.expectedVersionAt);
	const theme = parseThemePayload(body?.theme);
	const themeJson = JSON.stringify(theme);

	const pool = await GetPool();
	await requireScheduleRole({
		userOid: user.id,
		scheduleId,
		minRole: 'Manager',
		pool,
		errorMessage: 'Only schedule managers can update schedule customization'
	});

	const updateResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('scheduleName', scheduleName)
		.input('themeJson', themeJson)
		.input('updatedBy', user.id)
		.input('expectedVersionEpochMs', sql.BigInt, expectedVersionEpochMs)
		.query(
			`UPDATE dbo.Schedules
			 SET Name = @scheduleName,
				 ThemeJson = @themeJson,
				 UpdatedAt = SYSUTCDATETIME(),
				 UpdatedBy = @updatedBy
			 WHERE ScheduleId = @scheduleId
			   AND (
					@expectedVersionEpochMs IS NULL
					OR DATEDIFF_BIG(MILLISECOND, '19700101', COALESCE(UpdatedAt, CreatedAt)) = @expectedVersionEpochMs
			   )
			   AND DeletedAt IS NULL;

			 SELECT @@ROWCOUNT AS UpdatedRows;`
		);

	const updatedRows = Number(updateResult.recordset?.[0]?.UpdatedRows ?? 0);
	if (updatedRows === 0) {
		const currentRowResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.query(
				`SELECT TOP (1)
					COALESCE(UpdatedAt, CreatedAt) AS VersionAt,
					IsActive
				 FROM dbo.Schedules
				 WHERE ScheduleId = @scheduleId
				   AND DeletedAt IS NULL;`
			);
		const currentRow = currentRowResult.recordset?.[0];
		if (!currentRow) {
			throw error(404, 'Schedule not found');
		}
		return json(
			{
				code: 'SCHEDULE_CONCURRENT_MODIFICATION',
				message: 'This schedule changed while you were editing. Refresh and retry.'
			},
			{ status: 409 }
		);
	}

	const versionResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			`SELECT TOP (1)
				COALESCE(UpdatedAt, CreatedAt) AS VersionAt,
				IsActive
			 FROM dbo.Schedules
			 WHERE ScheduleId = @scheduleId
			   AND DeletedAt IS NULL;`
		);
	const updatedSchedule = versionResult.recordset?.[0];
	if (!updatedSchedule) {
		throw error(404, 'Schedule not found');
	}

	return json({
		ok: true,
		scheduleId,
		scheduleName,
		isActive: Boolean(updatedSchedule.IsActive),
		theme,
		versionAt: updatedSchedule.VersionAt
	});
};
