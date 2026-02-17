import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';

type ShiftSectionRow = {
	EmployeeTypeId: number;
	DisplayOrder: number;
	Name: string | null;
};

type AssignmentMemberRow = {
	EmployeeTypeId: number;
	UserOid: string;
	UserName: string | null;
	RoleName: string | null;
	DisplayOrder: number;
	StartDate: Date | string;
	EndDate: Date | string | null;
};

type ShiftVersionRow = {
	EmployeeTypeId: number;
	StartDate: Date | string;
	EndDate: Date | string | null;
	PatternId: number | null;
};

type PatternRow = {
	PatternId: number;
	PatternJson: string;
};

type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';

type ScheduleEventRow = {
	EventId: number;
	UserOid: string | null;
	EmployeeTypeId: number | null;
	StartDate: Date | string;
	EndDate: Date | string;
	CoverageCodeId: number | null;
	CustomDisplayMode: EventDisplayMode | null;
	CustomColor: string | null;
	CoverageDisplayMode: EventDisplayMode | null;
	CoverageColor: string | null;
};

type PatternSwatch = {
	swatchIndex: number;
	color: string;
	onDays: number[];
};

type ParsedPattern = {
	swatches: PatternSwatch[];
	noShiftDays: Set<number>;
	swatchByIndex: Map<number, PatternSwatch>;
	selectedOwnerByDay: Map<number, number>;
	predictionBySwatchIndex: Map<number, PredictionModel>;
	dayColorByCycleDay: Map<number, string>;
};

function cleanYear(value: string | null): number {
	if (!value) throw error(400, 'year is required');
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
		throw error(400, 'year must be a whole number between 2000 and 2100');
	}
	return parsed;
}

function cleanMonthIndex(value: string | null): number {
	if (!value) throw error(400, 'monthIndex is required');
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 11) {
		throw error(400, 'monthIndex must be a whole number between 0 and 11');
	}
	return parsed;
}

function dateOnly(year: number, monthIndex: number, day: number): string {
	const month = String(monthIndex + 1).padStart(2, '0');
	const dayText = String(day).padStart(2, '0');
	return `${year}-${month}-${dayText}`;
}

function toDateOnly(value: Date | string | null): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') return value.slice(0, 10);
	return null;
}

function toUtcDayNumber(dateOnlyText: string): number {
	const [year, month, day] = dateOnlyText.split('-').map((part) => Number(part));
	return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

const PATTERN_EDITOR_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

type PredictionModel = {
	onDays: number;
	offDays: number;
	anchor: number;
	predictedOn: Set<number>;
};

function buildSimplePatternPrediction(selectedOnDays: number[]): PredictionModel | null {
	if (selectedOnDays.length < 2) return null;
	const sorted = [...selectedOnDays].sort((a, b) => a - b);
	const runs: number[][] = [];
	let currentRun = [sorted[0]];
	for (let index = 1; index < sorted.length; index += 1) {
		const day = sorted[index];
		if (day === currentRun[currentRun.length - 1] + 1) {
			currentRun.push(day);
			continue;
		}
		runs.push(currentRun);
		currentRun = [day];
	}
	runs.push(currentRun);
	if (runs.length < 2) return null;

	let bestModel: PredictionModel | null = null;
	let bestScore = -1;
	for (let index = 0; index < runs.length - 1; index += 1) {
		const firstRun = runs[index];
		const secondRun = runs[index + 1];
		const offDays = secondRun[0] - firstRun[firstRun.length - 1] - 1;
		if (offDays <= 0) continue;
		const onDays = Math.max(firstRun.length, secondRun.length);
		if (onDays <= 0) continue;

		const cycleLength = onDays + offDays;
		const anchor = secondRun[0];
		const predictedOn = new Set<number>();
		for (const day of PATTERN_EDITOR_DAYS) {
			const offset = day - anchor;
			const cycleIndex = ((offset % cycleLength) + cycleLength) % cycleLength;
			if (cycleIndex < onDays) predictedOn.add(day);
		}

		let valid = true;
		for (const selectedDay of sorted) {
			if (!predictedOn.has(selectedDay)) {
				valid = false;
				break;
			}
		}
		if (!valid) continue;

		const score = firstRun.length + secondRun.length;
		if (score > bestScore) {
			bestScore = score;
			bestModel = { onDays, offDays, anchor, predictedOn };
		}
	}
	return bestModel;
}

function buildPatternCycleColors(
	swatches: PatternSwatch[],
	noShiftDays: Set<number>
): {
	dayColorByCycleDay: Map<number, string>;
	selectedOwnerByDay: Map<number, number>;
	swatchByIndex: Map<number, PatternSwatch>;
	predictionBySwatchIndex: Map<number, PredictionModel>;
} {
	const selectedOwnerByDay = new Map<number, number>();
	const swatchByIndex = new Map<number, PatternSwatch>();
	for (const swatch of swatches) {
		swatchByIndex.set(swatch.swatchIndex, swatch);
		for (const day of swatch.onDays) {
			if (!selectedOwnerByDay.has(day)) {
				selectedOwnerByDay.set(day, swatch.swatchIndex);
			}
		}
	}

	const predictionBySwatchIndex = new Map<number, PredictionModel>();
	for (const swatch of swatches) {
		const prediction = buildSimplePatternPrediction(swatch.onDays);
		if (prediction) {
			predictionBySwatchIndex.set(swatch.swatchIndex, prediction);
		}
	}

	const dayColorByCycleDay = new Map<number, string>();
	for (const day of PATTERN_EDITOR_DAYS) {
		if (noShiftDays.has(day)) continue;

		const explicitOwner = selectedOwnerByDay.get(day);
		if (explicitOwner !== undefined) {
			const explicitSwatch = swatchByIndex.get(explicitOwner);
			if (explicitSwatch) {
				dayColorByCycleDay.set(day, explicitSwatch.color);
			}
			continue;
		}

		const predictedOwners: number[] = [];
		for (const [swatchIndex, prediction] of predictionBySwatchIndex) {
			if (prediction.predictedOn.has(day)) {
				predictedOwners.push(swatchIndex);
			}
		}
		if (predictedOwners.length === 0) continue;
		predictedOwners.sort((a, b) => a - b);
		const chosen = swatchByIndex.get(predictedOwners[0]);
		if (chosen) {
			dayColorByCycleDay.set(day, chosen.color);
		}
	}

	return {
		dayColorByCycleDay,
		selectedOwnerByDay,
		swatchByIndex,
		predictionBySwatchIndex
	};
}

function parsePattern(value: string | null | undefined): ParsedPattern | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as {
			swatches?: unknown;
			noneSwatch?: { onDays?: unknown };
		};
		if (!Array.isArray(parsed.swatches)) return null;
		const swatches: PatternSwatch[] = [];
		for (const swatch of parsed.swatches) {
			const candidate = swatch as Partial<PatternSwatch>;
			if (typeof candidate.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(candidate.color)) continue;
			if (!Array.isArray(candidate.onDays)) continue;
			const onDays = Array.from(
				new Set(
					candidate.onDays
						.map((day) => Number(day))
						.filter((day) => Number.isInteger(day) && day >= 1 && day <= 28)
				)
			).sort((a, b) => a - b);
			swatches.push({
				swatchIndex: Number(candidate.swatchIndex ?? swatches.length),
				color: candidate.color.toLowerCase(),
				onDays
			});
		}
		swatches.sort((a, b) => a.swatchIndex - b.swatchIndex);
		const rawNoShiftDays = Array.isArray(parsed.noneSwatch?.onDays)
			? parsed.noneSwatch?.onDays
			: [];
		const noShiftDays = new Set(
			rawNoShiftDays
				.map((day) => Number(day))
				.filter((day) => Number.isInteger(day) && day >= 1 && day <= 28)
		);
		const {
			dayColorByCycleDay,
			selectedOwnerByDay,
			swatchByIndex,
			predictionBySwatchIndex
		} = buildPatternCycleColors(swatches, noShiftDays);
		return {
			swatches,
			noShiftDays,
			swatchByIndex,
			selectedOwnerByDay,
			predictionBySwatchIndex,
			dayColorByCycleDay
		};
	} catch {
		return null;
	}
}

function colorForPatternDay(pattern: ParsedPattern | null, dayNumber: number): string | null {
	if (!pattern) return null;
	const dayInEditorCycle = ((dayNumber - 1) % 28 + 28) % 28 + 1;

	const predictedOwners: number[] = [];
	for (const [swatchIndex, prediction] of pattern.predictionBySwatchIndex) {
		const cycleLength = prediction.onDays + prediction.offDays;
		if (cycleLength <= 0) continue;
		const offsetFromAnchor = dayNumber - prediction.anchor;
		const cycleIndex = ((offsetFromAnchor % cycleLength) + cycleLength) % cycleLength;
		if (cycleIndex < prediction.onDays) {
			predictedOwners.push(swatchIndex);
		}
	}
	if (predictedOwners.length > 0) {
		predictedOwners.sort((a, b) => a - b);
		return pattern.swatchByIndex.get(predictedOwners[0])?.color ?? null;
	}

	// Beyond the first 28 seed days, avoid repeating explicit editor assignments
	// when a prediction model exists; keep those dates OFF unless predicted.
	if (dayNumber > 28 && pattern.predictionBySwatchIndex.size > 0) {
		return null;
	}

	if (pattern.noShiftDays.has(dayInEditorCycle)) return null;

	const explicitOwner = pattern.selectedOwnerByDay.get(dayInEditorCycle);
	if (explicitOwner !== undefined) {
		return pattern.swatchByIndex.get(explicitOwner)?.color ?? null;
	}

	return pattern.dayColorByCycleDay.get(dayInEditorCycle) ?? null;
}

function monthRange(year: number, monthIndex: number): { monthStart: string; monthEnd: string } {
	const monthStart = dateOnly(year, monthIndex, 1);
	const endDate = new Date(Date.UTC(year, monthIndex + 1, 0));
	const monthEnd = dateOnly(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
	return { monthStart, monthEnd };
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

async function scheduleEventsHasEmployeeTypeId(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<boolean> {
	const result = await pool.request().query(
		`SELECT TOP (1) 1 AS HasColumn
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'ScheduleEvents'
		   AND COLUMN_NAME = 'EmployeeTypeId';`
	);
	return Number(result.recordset?.[0]?.HasColumn ?? 0) === 1;
}

async function scheduleEventsHasCustomColumns(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<boolean> {
	const result = await pool.request().query(
		`SELECT COLUMN_NAME
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'ScheduleEvents'
		   AND COLUMN_NAME IN ('CustomDisplayMode', 'CustomColor');`
	);
	const columns = new Set<string>(
		(result.recordset as Array<{ COLUMN_NAME: string }>).map((row) => row.COLUMN_NAME)
	);
	return columns.has('CustomDisplayMode') && columns.has('CustomColor');
}

async function getViewerContext(userOid: string, cookies: Cookies) {
	const scheduleId = await getActiveScheduleId(cookies);
	if (!scheduleId) {
		throw error(400, 'No active schedule selected');
	}

	const pool = await GetPool();
	const accessResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('userOid', userOid)
		.query(
			`SELECT TOP (1) 1 AS HasAccess
			 FROM dbo.ScheduleUsers su
			 WHERE su.ScheduleId = @scheduleId
			   AND su.UserOid = @userOid
			   AND su.IsActive = 1
			   AND su.DeletedAt IS NULL;`
		);

	if (!accessResult.recordset?.[0]?.HasAccess) {
		throw error(403, 'You do not have access to this schedule');
	}

	return { pool, scheduleId };
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const currentUser = locals.user;
	if (!currentUser) throw error(401, 'Unauthorized');

	const year = cleanYear(url.searchParams.get('year'));
	const monthIndex = cleanMonthIndex(url.searchParams.get('monthIndex'));
	const { monthStart, monthEnd } = monthRange(year, monthIndex);
	const { pool, scheduleId } = await getViewerContext(currentUser.id, cookies);
	const hasVersions = await employeeTypeVersionsEnabled(pool);
	const hasEventEmployeeTypeId = await scheduleEventsHasEmployeeTypeId(pool);
	const hasEventCustomColumns = await scheduleEventsHasCustomColumns(pool);

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
			hasVersions
				? `SELECT
					et.EmployeeTypeId,
					et.DisplayOrder,
					COALESCE(vMonthEnd.Name, vWindowLatest.Name, et.Name) AS Name
				FROM dbo.EmployeeTypes et
				OUTER APPLY (
					SELECT TOP (1) etv.Name
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = et.ScheduleId
					  AND etv.EmployeeTypeId = et.EmployeeTypeId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= @monthEnd
					  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthEnd)
					ORDER BY etv.StartDate DESC, etv.CreatedAt DESC
				) vMonthEnd
				OUTER APPLY (
					SELECT TOP (1) etv.Name
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = et.ScheduleId
					  AND etv.EmployeeTypeId = et.EmployeeTypeId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= @monthEnd
					  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
					ORDER BY etv.StartDate DESC, etv.CreatedAt DESC
				) vWindowLatest
				WHERE et.ScheduleId = @scheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				  AND EXISTS (
					SELECT 1
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = et.ScheduleId
					  AND etv.EmployeeTypeId = et.EmployeeTypeId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= @monthEnd
					  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
				  )
				ORDER BY et.DisplayOrder ASC, Name ASC, et.EmployeeTypeId ASC;`
				: `SELECT
					et.EmployeeTypeId,
					et.DisplayOrder,
					et.Name
				FROM dbo.EmployeeTypes et
				WHERE et.ScheduleId = @scheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				  AND et.StartDate <= @monthEnd
					ORDER BY et.DisplayOrder ASC, et.Name ASC, et.EmployeeTypeId ASC;`
		);

	const shiftRows = (result.recordset as ShiftSectionRow[]).map((row) => ({
		employeeTypeId: Number(row.EmployeeTypeId),
		category: row.Name?.trim() || `Shift ${row.EmployeeTypeId}`
	}));

	const assignmentsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
			`SELECT
				sut.EmployeeTypeId,
				sut.UserOid,
				COALESCE(NULLIF(u.DisplayName, ''), NULLIF(u.FullName, ''), sut.UserOid) AS UserName,
				rolePick.RoleName,
				sut.DisplayOrder,
				sut.StartDate,
				sut.EndDate
			 FROM dbo.ScheduleUserTypes sut
			 LEFT JOIN dbo.Users u
				ON u.UserOid = sut.UserOid
			   AND u.DeletedAt IS NULL
			 OUTER APPLY (
				SELECT TOP (1) r.RoleName
				FROM dbo.ScheduleUsers su
				INNER JOIN dbo.Roles r
					ON r.RoleId = su.RoleId
				WHERE su.ScheduleId = sut.ScheduleId
				  AND su.UserOid = sut.UserOid
				  AND su.IsActive = 1
				  AND su.DeletedAt IS NULL
				ORDER BY
				  CASE r.RoleName
					WHEN 'Manager' THEN 3
					WHEN 'Maintainer' THEN 2
					WHEN 'Member' THEN 1
					ELSE 0
				  END DESC
			 ) rolePick
			 WHERE sut.ScheduleId = @scheduleId
			   AND sut.IsActive = 1
			   AND sut.DeletedAt IS NULL
			   AND sut.StartDate <= @monthEnd
			   AND (sut.EndDate IS NULL OR sut.EndDate >= @monthStart)
			 ORDER BY sut.EmployeeTypeId ASC, sut.DisplayOrder ASC, sut.StartDate DESC, sut.UserOid ASC;`
		);

	const shiftIds = Array.from(new Set(shiftRows.map((row) => row.employeeTypeId)));
	const shiftIdSet = new Set(shiftIds);

	const versionsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
			hasVersions
				? `SELECT
					etv.EmployeeTypeId,
					etv.StartDate,
					etv.EndDate,
					etv.PatternId
				FROM dbo.EmployeeTypeVersions etv
				WHERE etv.ScheduleId = @scheduleId
				  AND etv.IsActive = 1
				  AND etv.DeletedAt IS NULL
				  AND etv.StartDate <= @monthEnd
				  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
				ORDER BY etv.EmployeeTypeId ASC, etv.StartDate DESC, etv.CreatedAt DESC;`
				: `SELECT
					et.EmployeeTypeId,
					et.StartDate,
					CAST(NULL AS date) AS EndDate,
					et.PatternId
				FROM dbo.EmployeeTypes et
				WHERE et.ScheduleId = @scheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				  AND et.StartDate <= @monthEnd
				ORDER BY et.EmployeeTypeId ASC, et.StartDate DESC;`
		);

	const versionsByShift = new Map<number, Array<{ startDate: string; endDate: string | null; patternId: number | null }>>();
	const patternIds = new Set<number>();
	for (const versionRow of versionsResult.recordset as ShiftVersionRow[]) {
		const employeeTypeId = Number(versionRow.EmployeeTypeId);
		if (!shiftIdSet.has(employeeTypeId)) continue;
		const startDate = toDateOnly(versionRow.StartDate);
		if (!startDate) continue;
		const endDate = toDateOnly(versionRow.EndDate);
		const patternId = versionRow.PatternId === null ? null : Number(versionRow.PatternId);
		const existing = versionsByShift.get(employeeTypeId) ?? [];
		existing.push({ startDate, endDate, patternId });
		versionsByShift.set(employeeTypeId, existing);
		if (patternId !== null) patternIds.add(patternId);
	}

	const patternsById = new Map<number, ParsedPattern>();
	if (patternIds.size > 0) {
		const patternRequest = pool.request().input('scheduleId', scheduleId);
		const inList = Array.from(patternIds);
		for (let index = 0; index < inList.length; index += 1) {
			patternRequest.input(`patternId${index}`, inList[index]);
		}
		const patternQuery = inList.map((_, index) => `@patternId${index}`).join(', ');
		const patternResult = await patternRequest.query(
			`SELECT PatternId, PatternJson
			 FROM dbo.Patterns
			 WHERE ScheduleId = @scheduleId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND PatternId IN (${patternQuery});`
		);
		for (const patternRow of patternResult.recordset as PatternRow[]) {
			const parsed = parsePattern(patternRow.PatternJson);
			if (!parsed) continue;
			patternsById.set(Number(patternRow.PatternId), parsed);
		}
	}

	const monthDays = [];
	for (let day = 1; day <= Number(monthEnd.slice(8, 10)); day += 1) {
		monthDays.push({
			day,
			date: dateOnly(year, monthIndex, day)
		});
	}

	const membersByShift = new Map<
		number,
		Array<{
			userOid: string;
			name: string;
			role: string;
			pattern: Array<'WORK' | 'OFF' | 'VAC' | 'HLDY' | 'OOT'>;
			dayColors: Record<number, string>;
		}>
	>();
	const memberByShiftUser = new Map<string, {
		userOid: string;
		name: string;
		role: string;
		pattern: Array<'WORK' | 'OFF' | 'VAC' | 'HLDY' | 'OOT'>;
		dayColors: Record<number, string>;
	}>();

	for (const row of assignmentsResult.recordset as AssignmentMemberRow[]) {
		const employeeTypeId = Number(row.EmployeeTypeId);
		if (!shiftIdSet.has(employeeTypeId)) continue;
		const assignmentStart = toDateOnly(row.StartDate);
		if (!assignmentStart) continue;
		const assignmentEnd = toDateOnly(row.EndDate) ?? monthEnd;
		const rowKey = `${employeeTypeId}|${row.UserOid}`;
		let member = memberByShiftUser.get(rowKey);
		if (!member) {
			member = {
				userOid: row.UserOid,
				name: row.UserName?.trim() || row.UserOid,
				role: row.RoleName?.trim() || 'Member',
				pattern: [],
				dayColors: {}
			};
			memberByShiftUser.set(rowKey, member);
			const existing = membersByShift.get(employeeTypeId) ?? [];
			existing.push(member);
			membersByShift.set(employeeTypeId, existing);
		}

		const versions = versionsByShift.get(employeeTypeId) ?? [];
		for (const monthDay of monthDays) {
			const dayDate = monthDay.date;
			if (dayDate < assignmentStart || dayDate > assignmentEnd) continue;
			const version = versions.find(
				(candidate) =>
					candidate.startDate <= dayDate &&
					(candidate.endDate === null || candidate.endDate >= dayDate)
			);
			if (!version || version.patternId === null) continue;
			const parsedPattern = patternsById.get(version.patternId);
			if (!parsedPattern) continue;
			const dayNumber = toUtcDayNumber(dayDate) - toUtcDayNumber(version.startDate) + 1;
			const color = colorForPatternDay(parsedPattern, dayNumber);
			if (!color) continue;
			member.dayColors[monthDay.day] = color;
		}
	}

	const groups = shiftRows.map((row) => ({
		employeeTypeId: row.employeeTypeId,
		category: row.category,
		employees: membersByShift.get(row.employeeTypeId) ?? []
	}));

	const selectEventEmployeeTypeId = hasEventEmployeeTypeId
		? 'se.EmployeeTypeId'
		: 'CAST(NULL AS int) AS EmployeeTypeId';
	const selectEventCustomDisplayMode = hasEventCustomColumns
		? 'se.CustomDisplayMode'
		: "CAST(NULL AS nvarchar(30)) AS CustomDisplayMode";
	const selectEventCustomColor = hasEventCustomColumns
		? 'se.CustomColor'
		: 'CAST(NULL AS nvarchar(20)) AS CustomColor';

	const eventsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
			`SELECT
				se.EventId,
				se.UserOid,
				${selectEventEmployeeTypeId},
				se.StartDate,
				se.EndDate,
				se.CoverageCodeId,
				${selectEventCustomDisplayMode},
				${selectEventCustomColor},
				cc.DisplayMode AS CoverageDisplayMode,
				cc.Color AS CoverageColor
			 FROM dbo.ScheduleEvents se
			 LEFT JOIN dbo.CoverageCodes cc
			   ON cc.ScheduleId = se.ScheduleId
			  AND cc.CoverageCodeId = se.CoverageCodeId
			 WHERE se.ScheduleId = @scheduleId
			   AND se.IsActive = 1
			   AND se.DeletedAt IS NULL
			   AND se.StartDate <= @monthEnd
			   AND se.EndDate >= @monthStart
			 ORDER BY se.StartDate ASC, se.EndDate ASC, se.EventId ASC;`
		);

	const events = (eventsResult.recordset as ScheduleEventRow[]).map((row) => {
		const userOid = row.UserOid?.trim() || null;
		const employeeTypeId =
			row.EmployeeTypeId === null || row.EmployeeTypeId === undefined
				? null
				: Number(row.EmployeeTypeId);
		const scopeType = userOid ? 'user' : employeeTypeId !== null ? 'shift' : 'global';
		const displayMode =
			(row.CoverageCodeId ? row.CoverageDisplayMode : row.CustomDisplayMode) ?? 'Schedule Overlay';
		const color = (row.CoverageCodeId ? row.CoverageColor : row.CustomColor)?.trim() || '#22c55e';
		return {
			eventId: Number(row.EventId),
			scopeType,
			employeeTypeId,
			userOid,
			startDate: toDateOnly(row.StartDate) ?? monthStart,
			endDate: toDateOnly(row.EndDate) ?? monthEnd,
			eventDisplayMode: displayMode,
			eventCodeColor: color
		};
	});

	return json({ groups, events, monthStart, monthEnd });
};
