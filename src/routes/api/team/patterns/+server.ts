import { error, json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';
import sql from 'mssql';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

type PatternRow = {
	PatternId: number;
	Name: string;
	PatternSummary: string | null;
	PatternJson: string;
	ShiftUsageCount: number;
	ActiveShiftUsageCount: number;
};

type SwatchPayload = {
	swatchIndex: number;
	color: string;
	onDays: number[];
};

type PatternJsonPayload = {
	swatches: SwatchPayload[];
	noneSwatch: {
		code: 'NONE';
		onDays?: number[];
	};
};

type PredictionModel = {
	onDays: number;
	offDays: number;
	predictedOn: Set<number>;
};

type PredictionSummary = {
	shiftCount: number;
	onDays: number | null;
	offDays: number | null;
};

const PATTERN_EDITOR_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

function cleanOptionalText(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLength);
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

	return { pool, scheduleId };
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

function assertSwatches(value: unknown): SwatchPayload[] {
	if (!Array.isArray(value)) {
		throw error(400, 'Swatches are required');
	}
	if (value.length > 4) {
		throw error(400, 'A maximum of 4 swatches is supported');
	}
	const usedIndexes = new Set<number>();
	const normalized = value.map((item, index) => {
		const swatch = item as Partial<SwatchPayload>;
		if (!Number.isInteger(swatch.swatchIndex) || (swatch.swatchIndex as number) < 0 || (swatch.swatchIndex as number) > 3) {
			throw error(400, `Swatch ${index + 1} index is invalid`);
		}
		if (usedIndexes.has(swatch.swatchIndex as number)) {
			throw error(400, `Swatch ${index + 1} index is duplicated`);
		}
		usedIndexes.add(swatch.swatchIndex as number);
		if (typeof swatch.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(swatch.color)) {
			throw error(400, `Swatch ${index + 1} color must be a hex value`);
		}
		if (!Array.isArray(swatch.onDays)) {
			throw error(400, `Swatch ${index + 1} onDays is required`);
		}
		const uniqueDays = Array.from(
			new Set(
				swatch.onDays
					.map((day) => Number(day))
					.filter((day) => Number.isInteger(day) && day >= 1 && day <= 28)
			)
		).sort((a, b) => a - b);
		return {
			swatchIndex: swatch.swatchIndex as number,
			color: swatch.color.toLowerCase(),
			onDays: uniqueDays
		};
	});
	normalized.sort((a, b) => a.swatchIndex - b.swatchIndex);
	for (let index = 0; index < normalized.length; index += 1) {
		if (normalized[index].swatchIndex !== index) {
			throw error(400, 'Swatch indexes must be contiguous starting at 0');
		}
	}
	return normalized;
}

function assertNoShiftDays(value: unknown): number[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw error(400, 'No shift days must be an array');
	}
	return Array.from(
		new Set(
			value
				.map((day) => Number(day))
				.filter((day) => Number.isInteger(day) && day >= 1 && day <= 28)
		)
	).sort((a, b) => a - b);
}

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
			bestModel = { onDays, offDays, predictedOn };
		}
	}
	return bestModel;
}

function buildPredictionSummary(
	activePrediction: PredictionModel | null,
	predictionsBySwatch: Array<PredictionModel | null>
): PredictionSummary | null {
	if (!activePrediction) return null;
	const validPredictions = predictionsBySwatch.filter(
		(prediction): prediction is PredictionModel => prediction !== null
	);
	const shiftCount = validPredictions.length;
	if (shiftCount <= 1) {
		return { shiftCount: 1, onDays: activePrediction.onDays, offDays: activePrediction.offDays };
	}

	const combinedPredictedOn = new Set<number>();
	for (const prediction of validPredictions) {
		for (const day of prediction.predictedOn) combinedPredictedOn.add(day);
	}

	const coverage = PATTERN_EDITOR_DAYS.map((day) => combinedPredictedOn.has(day));
	if (coverage.every(Boolean)) {
		return { shiftCount, onDays: null, offDays: null };
	}
	const transitionStart = coverage.findIndex(
		(value, index) => value !== coverage[(index + coverage.length - 1) % coverage.length]
	);
	if (transitionStart === -1) {
		return { shiftCount, onDays: null, offDays: null };
	}

	const runs: Array<{ on: boolean; length: number }> = [];
	let current = coverage[transitionStart];
	let length = 0;
	for (let step = 0; step < coverage.length; step += 1) {
		const value = coverage[(transitionStart + step) % coverage.length];
		if (value === current) {
			length += 1;
			continue;
		}
		runs.push({ on: current, length });
		current = value;
		length = 1;
	}
	runs.push({ on: current, length });

	const onRunLengths = runs.filter((run) => run.on).map((run) => run.length);
	const offRunLengths = runs.filter((run) => !run.on).map((run) => run.length);
	if (onRunLengths.length === 0 || offRunLengths.length === 0) {
		return { shiftCount, onDays: null, offDays: null };
	}
	const mostFrequent = (values: number[]): number => {
		const counts = new Map<number, number>();
		for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
		let bestValue = values[0];
		let bestCount = counts.get(bestValue) ?? 0;
		for (const [value, count] of counts.entries()) {
			if (count > bestCount) {
				bestValue = value;
				bestCount = count;
			}
		}
		return bestValue;
	};
	return {
		shiftCount,
		onDays: mostFrequent(onRunLengths),
		offDays: mostFrequent(offRunLengths)
	};
}

function hasPredictionConflict(
	swatches: SwatchPayload[],
	predictionsBySwatch: Array<PredictionModel | null>,
	noShiftDays: Set<number>
): boolean {
	const selectedOwnerByDay = new Map<number, number>();
	for (const swatch of swatches) {
		for (const day of swatch.onDays) {
			selectedOwnerByDay.set(day, swatch.swatchIndex);
		}
	}

	for (const day of PATTERN_EDITOR_DAYS) {
		if (noShiftDays.has(day)) continue;
		if (selectedOwnerByDay.has(day)) continue;
		let owners = 0;
		for (let swatchIndex = 0; swatchIndex < predictionsBySwatch.length; swatchIndex += 1) {
			if (predictionsBySwatch[swatchIndex]?.predictedOn.has(day)) {
				owners += 1;
				if (owners > 1) return true;
			}
		}
	}
	return false;
}

function buildPatternSummary(swatches: SwatchPayload[], noShiftDays: number[] = []): string {
	const shiftCountFromOnDays = swatches.filter((swatch) => swatch.onDays.length > 0).length;
	const fallback = `${shiftCountFromOnDays} ${shiftCountFromOnDays === 1 ? 'shift' : 'shifts'}`;
	if (swatches.length === 0) return '0 shifts';

	const predictionsBySwatch = swatches.map((swatch) => buildSimplePatternPrediction(swatch.onDays));
	if (hasPredictionConflict(swatches, predictionsBySwatch, new Set(noShiftDays))) {
		return 'Conflicting schedules';
	}

	const activePrediction = predictionsBySwatch.find((prediction) => prediction !== null) ?? null;
	const summary = buildPredictionSummary(activePrediction, predictionsBySwatch);
	if (!summary) return fallback;
	if (summary.onDays === null || summary.offDays === null) {
		return `${summary.shiftCount} ${summary.shiftCount === 1 ? 'shift' : 'shifts'}`;
	}
	return `${summary.shiftCount} ${summary.shiftCount === 1 ? 'shift' : 'shifts'} - ${summary.onDays} on / ${summary.offDays} off`;
}

export const GET: RequestHandler = async ({ locals, cookies }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const hasVersions = await employeeTypeVersionsEnabled(pool);
	const result = await pool
		.request()
		.input('scheduleId', scheduleId)
		.query(
			hasVersions
				? `SELECT
				p.PatternId,
				p.Name,
				p.PatternSummary,
				p.PatternJson,
				(
					SELECT COUNT(DISTINCT etv.EmployeeTypeId)
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = p.ScheduleId
					  AND etv.PatternId = p.PatternId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
				) AS ShiftUsageCount,
				(
					SELECT COUNT(DISTINCT etv.EmployeeTypeId)
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = p.ScheduleId
					  AND etv.PatternId = p.PatternId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= CAST(SYSUTCDATETIME() AS date)
					  AND (etv.EndDate IS NULL OR etv.EndDate >= CAST(SYSUTCDATETIME() AS date))
				) AS ActiveShiftUsageCount
			 FROM dbo.Patterns p
			 WHERE p.ScheduleId = @scheduleId
			   AND p.IsActive = 1
			   AND p.DeletedAt IS NULL
			 ORDER BY p.Name ASC, p.PatternId ASC;`
				: `SELECT
				p.PatternId,
				p.Name,
				p.PatternSummary,
				p.PatternJson,
				(
					SELECT COUNT(DISTINCT et.EmployeeTypeId)
					FROM dbo.EmployeeTypes et
					WHERE et.ScheduleId = p.ScheduleId
					  AND et.PatternId = p.PatternId
					  AND et.IsActive = 1
					  AND et.DeletedAt IS NULL
				) AS ShiftUsageCount,
				(
					SELECT COUNT(DISTINCT et.EmployeeTypeId)
					FROM dbo.EmployeeTypes et
					WHERE et.ScheduleId = p.ScheduleId
					  AND et.PatternId = p.PatternId
					  AND et.IsActive = 1
					  AND et.DeletedAt IS NULL
				) AS ActiveShiftUsageCount
			 FROM dbo.Patterns p
			 WHERE p.ScheduleId = @scheduleId
			   AND p.IsActive = 1
			   AND p.DeletedAt IS NULL
			 ORDER BY p.Name ASC, p.PatternId ASC;`
		);

	const patterns = (result.recordset as PatternRow[]).map((row) => {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(row.PatternJson);
		} catch {
			parsed = null;
		}
		const parsedPayload = parsed as {
			swatches?: SwatchPayload[];
			noneSwatch?: { onDays?: number[] };
		} | null;
		const parsedSwatches = parsedPayload?.swatches;
		let swatches: SwatchPayload[] = [];
		let noShiftDays: number[] = [];
		if (Array.isArray(parsedSwatches)) {
			try {
				swatches = assertSwatches(parsedSwatches);
			} catch {
				swatches = [];
			}
		}
		try {
			noShiftDays = assertNoShiftDays(parsedPayload?.noneSwatch?.onDays);
		} catch {
			noShiftDays = [];
		}
		return {
			patternId: row.PatternId,
			name: row.Name,
			summary: buildPatternSummary(swatches, noShiftDays),
			swatches,
			noShiftDays,
			isInUse: Number(row.ActiveShiftUsageCount ?? 0) > 0,
			isActivelyInUse: Number(row.ActiveShiftUsageCount ?? 0) > 0,
			hasAnyUsage: Number(row.ShiftUsageCount ?? 0) > 0
		};
	});

	return json({ patterns });
};

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const hasVersions = await employeeTypeVersionsEnabled(pool);
	const body = await request.json().catch(() => null);
	const name = cleanOptionalText(body?.name, 100);
	if (!name) {
		throw error(400, 'Pattern name is required');
	}

	const swatches = assertSwatches(body?.swatches);
	const noShiftDays = assertNoShiftDays(body?.noShiftDays);
	const selectedOnDays = new Set(swatches.flatMap((swatch) => swatch.onDays));
	for (const day of noShiftDays) {
		if (selectedOnDays.has(day)) {
			throw error(400, 'No shift days cannot overlap selected on-shift days');
		}
	}
	const totalSelectedOnDays = swatches.reduce((sum, swatch) => sum + swatch.onDays.length, 0);
	if (totalSelectedOnDays <= 0) {
		throw error(400, 'Select at least one on-shift day');
	}

	const payloadJson = JSON.stringify({
		swatches,
		noneSwatch: { code: 'NONE', onDays: noShiftDays }
	} satisfies PatternJsonPayload);
	const summary = buildPatternSummary(swatches, noShiftDays);

	const existingResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('name', name)
		.query(
			`SELECT TOP (1) PatternId
			 FROM dbo.Patterns
			 WHERE ScheduleId = @scheduleId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND UPPER(LTRIM(RTRIM(Name))) = UPPER(LTRIM(RTRIM(@name)));`
		);
	if (existingResult.recordset?.[0]?.PatternId) {
		throw error(409, 'A pattern with this name already exists in this schedule');
	}

	try {
		const insertResult = await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('name', name)
			.input('summary', summary)
			.input('patternJson', payloadJson)
			.input('actorUserOid', currentUser.id)
			.query(
				`INSERT INTO dbo.Patterns (ScheduleId, Name, PatternSummary, PatternJson, CreatedBy)
				 OUTPUT inserted.PatternId AS PatternId
				 VALUES (@scheduleId, @name, @summary, @patternJson, @actorUserOid);`
			);

		return json({
			ok: true,
			patternId: insertResult.recordset?.[0]?.PatternId ?? null
		});
	} catch (e) {
		const sqlError = e as { number?: number };
		if (sqlError?.number === 2601 || sqlError?.number === 2627) {
			throw error(409, 'A pattern with this name already exists in this schedule');
		}
		throw e;
	}
};

export const PATCH: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const patternId = Number(body?.patternId);
	if (!Number.isInteger(patternId) || patternId <= 0) {
		throw error(400, 'Pattern ID is required');
	}

	const name = cleanOptionalText(body?.name, 100);
	if (!name) {
		throw error(400, 'Pattern name is required');
	}

	const existsResult = await pool
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
	if (!existsResult.recordset?.[0]?.PatternId) {
		throw error(404, 'Pattern not found');
	}

	const swatches = assertSwatches(body?.swatches);
	const noShiftDays = assertNoShiftDays(body?.noShiftDays);
	const selectedOnDays = new Set(swatches.flatMap((swatch) => swatch.onDays));
	for (const day of noShiftDays) {
		if (selectedOnDays.has(day)) {
			throw error(400, 'No shift days cannot overlap selected on-shift days');
		}
	}
	const totalSelectedOnDays = swatches.reduce((sum, swatch) => sum + swatch.onDays.length, 0);
	if (totalSelectedOnDays <= 0) {
		throw error(400, 'Select at least one on-shift day');
	}

	const summary = buildPatternSummary(swatches, noShiftDays);
	const payloadJson = JSON.stringify({
		swatches,
		noneSwatch: { code: 'NONE', onDays: noShiftDays }
	} satisfies PatternJsonPayload);

	const existingResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('patternId', patternId)
		.input('name', name)
		.query(
			`SELECT TOP (1) PatternId
			 FROM dbo.Patterns
			 WHERE ScheduleId = @scheduleId
			   AND IsActive = 1
			   AND DeletedAt IS NULL
			   AND PatternId <> @patternId
			   AND UPPER(LTRIM(RTRIM(Name))) = UPPER(LTRIM(RTRIM(@name)));`
		);
	if (existingResult.recordset?.[0]?.PatternId) {
		throw error(409, 'A pattern with this name already exists in this schedule');
	}

	try {
		await pool
			.request()
			.input('scheduleId', scheduleId)
			.input('patternId', patternId)
			.input('name', name)
			.input('summary', summary)
			.input('patternJson', payloadJson)
			.input('actorUserOid', currentUser.id)
			.query(
				`UPDATE dbo.Patterns
				 SET Name = @name,
					 PatternSummary = @summary,
					 PatternJson = @patternJson,
					 UpdatedAt = SYSUTCDATETIME(),
					 UpdatedBy = @actorUserOid
				 WHERE ScheduleId = @scheduleId
				   AND PatternId = @patternId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);

		return json({ ok: true });
	} catch (e) {
		const sqlError = e as { number?: number };
		if (sqlError?.number === 2601 || sqlError?.number === 2627) {
			throw error(409, 'A pattern with this name already exists in this schedule');
		}
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, scheduleId } = await getActorContext(currentUser.id, cookies);
	const hasVersions = await employeeTypeVersionsEnabled(pool);
	const body = await request.json().catch(() => null);
	const patternId = Number(body?.patternId);
	const confirmActiveRemoval = body?.confirmActiveRemoval === true;
	if (!Number.isInteger(patternId) || patternId <= 0) {
		throw error(400, 'Pattern ID is required');
	}

	const existsResult = await pool
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
	if (!existsResult.recordset?.[0]?.PatternId) {
		throw error(404, 'Pattern not found');
	}

	const usageResult = await pool
		.request()
		.input('scheduleId', scheduleId)
		.input('patternId', patternId)
		.query(
			hasVersions
				? `SELECT
				(
					SELECT COUNT(DISTINCT etv.EmployeeTypeId)
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = @scheduleId
					  AND etv.PatternId = @patternId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
				) AS ShiftUsageCount,
				(
					SELECT COUNT(DISTINCT etv.EmployeeTypeId)
					FROM dbo.EmployeeTypeVersions etv
					WHERE etv.ScheduleId = @scheduleId
					  AND etv.PatternId = @patternId
					  AND etv.IsActive = 1
					  AND etv.DeletedAt IS NULL
					  AND etv.StartDate <= CAST(SYSUTCDATETIME() AS date)
					  AND (etv.EndDate IS NULL OR etv.EndDate >= CAST(SYSUTCDATETIME() AS date))
				) AS ActiveShiftUsageCount;`
				: `SELECT
				COUNT(DISTINCT et.EmployeeTypeId) AS ShiftUsageCount,
				COUNT(DISTINCT et.EmployeeTypeId) AS ActiveShiftUsageCount
			 FROM dbo.EmployeeTypes et
			 WHERE et.ScheduleId = @scheduleId
			   AND et.PatternId = @patternId
			   AND et.IsActive = 1
			   AND et.DeletedAt IS NULL;`
		);
	const shiftUsageCount = Number(usageResult.recordset?.[0]?.ShiftUsageCount ?? 0);
	const activeShiftUsageCount = Number(usageResult.recordset?.[0]?.ActiveShiftUsageCount ?? 0);

	if (activeShiftUsageCount > 0 && !confirmActiveRemoval) {
		return json(
			{
				message:
					'Pattern is currently assigned to one or more active shifts. Confirm removal to switch those shifts to Unassigned effective today.',
				code: 'PATTERN_ACTIVE_IN_USE',
				activeShiftUsageCount
			},
			{ status: 409 }
		);
	}

	const transaction = new sql.Transaction(pool);
	await transaction.begin();
	try {
		if (activeShiftUsageCount > 0) {
			if (hasVersions) {
				const serverDateResult = await new sql.Request(transaction).query(
					`SELECT CAST(SYSUTCDATETIME() AS date) AS ServerDate;`
				);
				const serverDateRaw = serverDateResult.recordset?.[0]?.ServerDate;
				const serverDate =
					serverDateRaw instanceof Date
						? serverDateRaw.toISOString().slice(0, 10)
						: String(serverDateRaw).slice(0, 10);

				await new sql.Request(transaction)
					.input('scheduleId', scheduleId)
					.input('patternId', patternId)
					.input('effectiveDate', serverDate)
					.input('actorUserOid', currentUser.id)
					.query(
						`UPDATE etv
						 SET EndDate = DATEADD(day, -1, @effectiveDate),
							 EndedAt = SYSUTCDATETIME(),
							 EndedBy = @actorUserOid,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorUserOid
						 FROM dbo.EmployeeTypeVersions etv
						 INNER JOIN (
							SELECT cur.ScheduleId, cur.EmployeeTypeId, cur.StartDate
							FROM dbo.EmployeeTypeVersions cur
							WHERE cur.ScheduleId = @scheduleId
							  AND cur.PatternId = @patternId
							  AND cur.IsActive = 1
							  AND cur.DeletedAt IS NULL
							  AND cur.StartDate < @effectiveDate
							  AND (cur.EndDate IS NULL OR cur.EndDate >= @effectiveDate)
						 ) active_rows
							ON active_rows.ScheduleId = etv.ScheduleId
						   AND active_rows.EmployeeTypeId = etv.EmployeeTypeId
						   AND active_rows.StartDate = etv.StartDate
						 WHERE etv.ScheduleId = @scheduleId
						   AND etv.IsActive = 1
						   AND etv.DeletedAt IS NULL;`
					);

				await new sql.Request(transaction)
					.input('scheduleId', scheduleId)
					.input('patternId', patternId)
					.input('effectiveDate', serverDate)
					.input('actorUserOid', currentUser.id)
					.query(
						`UPDATE etv
						 SET PatternId = NULL,
							 EndDate = CASE
								WHEN next_row.NextStartDate IS NULL THEN NULL
								ELSE DATEADD(day, -1, next_row.NextStartDate)
							 END,
							 EndedAt = CASE
								WHEN next_row.NextStartDate IS NULL THEN NULL
								ELSE SYSUTCDATETIME()
							 END,
							 EndedBy = CASE
								WHEN next_row.NextStartDate IS NULL THEN NULL
								ELSE @actorUserOid
							 END,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorUserOid
						 FROM dbo.EmployeeTypeVersions etv
						 OUTER APPLY (
							SELECT TOP (1) future.StartDate AS NextStartDate
							FROM dbo.EmployeeTypeVersions future
							WHERE future.ScheduleId = etv.ScheduleId
							  AND future.EmployeeTypeId = etv.EmployeeTypeId
							  AND future.IsActive = 1
							  AND future.DeletedAt IS NULL
							  AND future.StartDate > @effectiveDate
							ORDER BY future.StartDate ASC
						 ) next_row
						 WHERE etv.ScheduleId = @scheduleId
						   AND etv.PatternId = @patternId
						   AND etv.StartDate = @effectiveDate
						   AND etv.IsActive = 1
						   AND etv.DeletedAt IS NULL
						   AND (etv.EndDate IS NULL OR etv.EndDate >= @effectiveDate);`
					);

				await new sql.Request(transaction)
					.input('scheduleId', scheduleId)
					.input('patternId', patternId)
					.input('effectiveDate', serverDate)
					.input('actorUserOid', currentUser.id)
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
						SELECT
							@scheduleId,
							active_rows.EmployeeTypeId,
							@effectiveDate,
							CASE
								WHEN active_rows.NextStartDate IS NULL THEN NULL
								ELSE DATEADD(day, -1, active_rows.NextStartDate)
							END,
							active_rows.Name,
							NULL,
							@actorUserOid
						FROM (
							SELECT
								cur.EmployeeTypeId,
								cur.Name,
								(
									SELECT TOP (1) future.StartDate
									FROM dbo.EmployeeTypeVersions future
									WHERE future.ScheduleId = cur.ScheduleId
									  AND future.EmployeeTypeId = cur.EmployeeTypeId
									  AND future.IsActive = 1
									  AND future.DeletedAt IS NULL
									  AND future.StartDate > @effectiveDate
									ORDER BY future.StartDate ASC
								) AS NextStartDate
							FROM dbo.EmployeeTypeVersions cur
							WHERE cur.ScheduleId = @scheduleId
							  AND cur.PatternId = @patternId
							  AND cur.IsActive = 1
							  AND cur.DeletedAt IS NULL
							  AND cur.StartDate < @effectiveDate
							  AND (cur.EndDate IS NULL OR cur.EndDate >= @effectiveDate)
							  AND NOT EXISTS (
									SELECT 1
									FROM dbo.EmployeeTypeVersions exact_row
									WHERE exact_row.ScheduleId = cur.ScheduleId
									  AND exact_row.EmployeeTypeId = cur.EmployeeTypeId
									  AND exact_row.StartDate = @effectiveDate
									  AND exact_row.IsActive = 1
									  AND exact_row.DeletedAt IS NULL
							  )
						) active_rows;`
					);

				await new sql.Request(transaction)
					.input('scheduleId', scheduleId)
					.input('actorUserOid', currentUser.id)
					.query(
						`UPDATE et
						 SET et.Name = latest.Name,
							 et.PatternId = latest.PatternId,
							 et.StartDate = latest.StartDate,
							 et.UpdatedAt = SYSUTCDATETIME(),
							 et.UpdatedBy = @actorUserOid
						FROM dbo.EmployeeTypes et
						CROSS APPLY (
							SELECT TOP (1)
								etv.Name,
								etv.PatternId,
								etv.StartDate
							FROM dbo.EmployeeTypeVersions etv
							WHERE etv.ScheduleId = et.ScheduleId
							  AND etv.EmployeeTypeId = et.EmployeeTypeId
							  AND etv.IsActive = 1
							  AND etv.DeletedAt IS NULL
							ORDER BY etv.StartDate DESC
						) latest
						WHERE et.ScheduleId = @scheduleId
						  AND et.IsActive = 1
						  AND et.DeletedAt IS NULL;`
					);
			} else {
				await new sql.Request(transaction)
					.input('scheduleId', scheduleId)
					.input('patternId', patternId)
					.input('actorUserOid', currentUser.id)
					.query(
						`UPDATE dbo.EmployeeTypes
						 SET PatternId = NULL,
							 UpdatedAt = SYSUTCDATETIME(),
							 UpdatedBy = @actorUserOid
						 WHERE ScheduleId = @scheduleId
						   AND PatternId = @patternId
						   AND IsActive = 1
						   AND DeletedAt IS NULL;`
					);
			}
		}

		// Used at least once: mark as removed and hide from active lists.
		await new sql.Request(transaction)
			.input('scheduleId', scheduleId)
			.input('patternId', patternId)
			.input('actorUserOid', currentUser.id)
			.query(
				`UPDATE dbo.Patterns
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorUserOid,
					 UpdatedAt = SYSUTCDATETIME(),
					 UpdatedBy = @actorUserOid
				 WHERE ScheduleId = @scheduleId
				   AND PatternId = @patternId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);

		await transaction.commit();
	} catch (e) {
		await transaction.rollback();
		throw e;
	}

	return json({
		ok: true,
		mode: activeShiftUsageCount > 0 ? 'removed-with-unassigned-transition' : 'soft-remove'
	});
};
