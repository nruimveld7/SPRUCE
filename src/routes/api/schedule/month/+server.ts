import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';
import { userCanAccessSchedule } from '$lib/server/schedule-access';
import { resolveShiftOrderForMonth } from '$lib/server/shift-order';

type ShiftSectionRow = {
	ShiftId: number;
	DisplayOrder: number;
	Name: string | null;
};

type AssignmentMemberRow = {
	ShiftId: number;
	UserOid: string;
	UserName: string | null;
	RoleName: string | null;
	StartDate: Date | string;
	EndDate: Date | string | null;
};

type ShiftVersionRow = {
	ShiftId: number;
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
	ShiftId: number | null;
	StartDate: Date | string;
	EndDate: Date | string;
	EventCodeId: number | null;
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
	ownerByCycleDay: Map<number, number>;
	dayColorByCycleDay: Map<number, string>;
	cycleLength: number;
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
	ownerByCycleDay: Map<number, number>;
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
	const ownerByCycleDay = new Map<number, number>();
	for (const day of PATTERN_EDITOR_DAYS) {
		if (noShiftDays.has(day)) continue;

		const explicitOwner = selectedOwnerByDay.get(day);
		if (explicitOwner !== undefined) {
			const explicitSwatch = swatchByIndex.get(explicitOwner);
			if (explicitSwatch) {
				ownerByCycleDay.set(day, explicitOwner);
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
			ownerByCycleDay.set(day, chosen.swatchIndex);
			dayColorByCycleDay.set(day, chosen.color);
		}
	}

	return {
		dayColorByCycleDay,
		ownerByCycleDay,
		selectedOwnerByDay,
		swatchByIndex,
		predictionBySwatchIndex
	};
}

function detectPatternCycleLength(ownerByCycleDay: Map<number, number>): number {
	const resolvedOwnerSeries = PATTERN_EDITOR_DAYS.map((day) => ownerByCycleDay.get(day) ?? null);
	for (let cycleLength = 1; cycleLength <= PATTERN_EDITOR_DAYS.length; cycleLength += 1) {
		let matches = true;
		for (let dayIndex = 0; dayIndex + cycleLength < resolvedOwnerSeries.length; dayIndex += 1) {
			if (resolvedOwnerSeries[dayIndex] !== resolvedOwnerSeries[dayIndex + cycleLength]) {
				matches = false;
				break;
			}
		}
		if (matches) return cycleLength;
	}
	return PATTERN_EDITOR_DAYS.length;
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
			ownerByCycleDay,
			selectedOwnerByDay,
			swatchByIndex,
			predictionBySwatchIndex
		} = buildPatternCycleColors(swatches, noShiftDays);
		const cycleLength = detectPatternCycleLength(ownerByCycleDay);
		return {
			swatches,
			noShiftDays,
			swatchByIndex,
			selectedOwnerByDay,
			predictionBySwatchIndex,
			ownerByCycleDay,
			dayColorByCycleDay,
			cycleLength
		};
	} catch {
		return null;
	}
}

function colorForPatternDay(pattern: ParsedPattern | null, dayNumber: number): string | null {
	if (!pattern) return null;
	const cycleLength = Math.max(1, Math.min(pattern.cycleLength, PATTERN_EDITOR_DAYS.length));
	const dayInEditorCycle = ((dayNumber - 1) % cycleLength + cycleLength) % cycleLength + 1;
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
		   AND TABLE_NAME = 'ShiftEdits';`
	);
	return Number(result.recordset?.[0]?.HasTable ?? 0) === 1;
}

async function scheduleEventsHasShiftId(
	pool: Awaited<ReturnType<typeof GetPool>>
): Promise<boolean> {
	const result = await pool.request().query(
		`SELECT TOP (1) 1 AS HasColumn
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA = 'dbo'
		   AND TABLE_NAME = 'ScheduleEvents'
		   AND COLUMN_NAME = 'ShiftId';`
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
	const hasAccess = await userCanAccessSchedule({ userOid, scheduleId, pool });
	if (!hasAccess) {
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
	const hasEventShiftId = await scheduleEventsHasShiftId(pool);
	const hasEventCustomColumns = await scheduleEventsHasCustomColumns(pool);

	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
				hasVersions
					? `SELECT
						et.ShiftId,
						COALESCE(vMonthEnd.DisplayOrder, vWindowLatest.DisplayOrder, et.DisplayOrder) AS DisplayOrder,
						COALESCE(vMonthEnd.Name, vWindowLatest.Name, et.Name) AS Name
					FROM dbo.Shifts et
					OUTER APPLY (
						SELECT TOP (1) etv.Name, etv.DisplayOrder
						FROM dbo.ShiftEdits etv
						WHERE etv.ScheduleId = et.ScheduleId
						  AND etv.ShiftId = et.ShiftId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= @monthEnd
					  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthEnd)
						ORDER BY etv.StartDate DESC, etv.CreatedAt DESC
					) vMonthEnd
					OUTER APPLY (
						SELECT TOP (1) etv.Name, etv.DisplayOrder
						FROM dbo.ShiftEdits etv
						WHERE etv.ScheduleId = et.ScheduleId
						  AND etv.ShiftId = et.ShiftId
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
					FROM dbo.ShiftEdits etv
					WHERE etv.ScheduleId = et.ScheduleId
					  AND etv.ShiftId = et.ShiftId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
						  AND etv.StartDate <= @monthEnd
						  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
					  )
					ORDER BY DisplayOrder ASC, Name ASC, et.ShiftId ASC;`
				: `SELECT
					et.ShiftId,
					et.DisplayOrder,
					et.Name
				FROM dbo.Shifts et
				WHERE et.ScheduleId = @scheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				  AND et.StartDate <= @monthEnd
					ORDER BY et.DisplayOrder ASC, et.Name ASC, et.ShiftId ASC;`
		);

const shiftRows = (result.recordset as ShiftSectionRow[]).map((row) => ({
		employeeTypeId: Number(row.ShiftId),
		category: row.Name?.trim() || `Shift ${row.ShiftId}`
	}));
	const fallbackShiftOrder = (result.recordset as ShiftSectionRow[]).map((row) =>
		Number(row.ShiftId)
	);
	const orderedShiftIds = await resolveShiftOrderForMonth({
		runner: pool,
		scheduleId,
		monthStart,
		activeShiftIds: shiftRows.map((row) => row.employeeTypeId),
		fallbackOrderedIds: fallbackShiftOrder
	});
	const orderMap = new Map(orderedShiftIds.map((id, index) => [id, index]));
	shiftRows.sort((a, b) => {
		const aOrder = orderMap.get(a.employeeTypeId) ?? Number.MAX_SAFE_INTEGER;
		const bOrder = orderMap.get(b.employeeTypeId) ?? Number.MAX_SAFE_INTEGER;
		if (aOrder !== bOrder) return aOrder - bOrder;
		return a.category.localeCompare(b.category);
	});

	const assignmentsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
			`SELECT
				sut.ShiftId,
				sut.UserOid,
				COALESCE(NULLIF(u.DisplayName, ''), NULLIF(u.FullName, ''), sut.UserOid) AS UserName,
				rolePick.RoleName,
				sut.StartDate,
				sut.EndDate
			 FROM dbo.ScheduleAssignments sut
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
			 ORDER BY sut.ShiftId ASC, sut.StartDate DESC, sut.UserOid ASC;`
		);

	const shiftIds = Array.from(new Set(shiftRows.map((row) => row.employeeTypeId)));
	const shiftIdSet = new Set(shiftIds);
	const assignmentOrderByShiftUser = new Map<string, number>();

	const assignmentRows = assignmentsResult.recordset as AssignmentMemberRow[];
	for (const shiftId of shiftIds) {
		const activeUsersForShift = assignmentRows
			.filter((row) => Number(row.ShiftId) === shiftId)
			.map((row) => row.UserOid)
			.filter((userOid, index, list) => list.indexOf(userOid) === index);
		if (activeUsersForShift.length === 0) continue;
		const fallbackOrder = assignmentRows
			.filter((row) => Number(row.ShiftId) === shiftId)
			.sort(
				(a, b) => a.UserOid.localeCompare(b.UserOid)
			)
			.map((row) => row.UserOid)
			.filter((userOid, index, list) => list.indexOf(userOid) === index);

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
		const resolvedMonth = toDateOnly(monthRow.recordset?.[0]?.EffectiveMonth ?? null);
		const orderedUsers: string[] = [];
		if (resolvedMonth) {
			const orderRows = await pool
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
			for (const row of orderRows.recordset as Array<{ UserOid: string }>) {
				if (activeUsersForShift.includes(row.UserOid) && !orderedUsers.includes(row.UserOid)) {
					orderedUsers.push(row.UserOid);
				}
			}
		}
		for (const userOid of fallbackOrder) {
			if (activeUsersForShift.includes(userOid) && !orderedUsers.includes(userOid)) {
				orderedUsers.push(userOid);
			}
		}
		for (const userOid of activeUsersForShift) {
			if (!orderedUsers.includes(userOid)) {
				orderedUsers.push(userOid);
			}
		}
		for (let index = 0; index < orderedUsers.length; index += 1) {
			assignmentOrderByShiftUser.set(`${shiftId}|${orderedUsers[index]}`, index + 1);
		}
	}

	const versionsResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('monthStart', monthStart)
		.input('monthEnd', monthEnd)
		.query(
			hasVersions
				? `SELECT
					etv.ShiftId,
					etv.StartDate,
					etv.EndDate,
					etv.PatternId
				FROM dbo.ShiftEdits etv
				WHERE etv.ScheduleId = @scheduleId
				  AND etv.IsActive = 1
				  AND etv.DeletedAt IS NULL
				  AND etv.StartDate <= @monthEnd
				  AND (etv.EndDate IS NULL OR etv.EndDate >= @monthStart)
				ORDER BY etv.ShiftId ASC, etv.StartDate DESC, etv.CreatedAt DESC;`
				: `SELECT
					et.ShiftId,
					et.StartDate,
					CAST(NULL AS date) AS EndDate,
					et.PatternId
				FROM dbo.Shifts et
				WHERE et.ScheduleId = @scheduleId
				  AND et.IsActive = 1
				  AND et.DeletedAt IS NULL
				  AND et.StartDate <= @monthEnd
				ORDER BY et.ShiftId ASC, et.StartDate DESC;`
		);

	const versionsByShift = new Map<number, Array<{ startDate: string; endDate: string | null; patternId: number | null }>>();
	const patternIds = new Set<number>();
	for (const versionRow of versionsResult.recordset as ShiftVersionRow[]) {
		const employeeTypeId = Number(versionRow.ShiftId);
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

	for (const row of assignmentRows) {
		const employeeTypeId = Number(row.ShiftId);
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

	for (const [shiftId, members] of membersByShift.entries()) {
		members.sort((a, b) => {
			const aOrder = assignmentOrderByShiftUser.get(`${shiftId}|${a.userOid}`) ?? Number.MAX_SAFE_INTEGER;
			const bOrder = assignmentOrderByShiftUser.get(`${shiftId}|${b.userOid}`) ?? Number.MAX_SAFE_INTEGER;
			if (aOrder !== bOrder) return aOrder - bOrder;
			return a.name.localeCompare(b.name);
		});
	}

	const groups = shiftRows.map((row) => ({
		employeeTypeId: row.employeeTypeId,
		category: row.category,
		employees: membersByShift.get(row.employeeTypeId) ?? []
	}));

	const selectEventShiftId = hasEventShiftId
		? 'se.ShiftId'
		: 'CAST(NULL AS int) AS ShiftId';
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
				${selectEventShiftId},
				se.StartDate,
				se.EndDate,
				se.EventCodeId,
				${selectEventCustomDisplayMode},
				${selectEventCustomColor},
				cc.DisplayMode AS CoverageDisplayMode,
				cc.Color AS CoverageColor
			 FROM dbo.ScheduleEvents se
			 LEFT JOIN dbo.EventCodes cc
			   ON cc.ScheduleId = se.ScheduleId
			  AND cc.EventCodeId = se.EventCodeId
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
			row.ShiftId === null || row.ShiftId === undefined
				? null
				: Number(row.ShiftId);
		const scopeType = userOid ? 'user' : employeeTypeId !== null ? 'shift' : 'global';
		const displayMode =
			(row.EventCodeId ? row.CoverageDisplayMode : row.CustomDisplayMode) ?? 'Schedule Overlay';
		const color = (row.EventCodeId ? row.CoverageColor : row.CustomColor)?.trim() || '#22c55e';
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
