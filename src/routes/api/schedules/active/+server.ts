import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setActiveScheduleForSession } from '$lib/server/auth';
import { GetPool } from '$lib/server/db';
import { userCanAccessSchedule } from '$lib/server/schedule-access';

function parseScheduleId(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw error(400, 'A valid scheduleId is required');
	}
	return value;
}

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const body = await request.json().catch(() => null);
	const scheduleId = parseScheduleId(body?.scheduleId);

	const pool = await GetPool();
	const hasAccess = await userCanAccessSchedule({ userOid: user.id, scheduleId, pool });
	if (!hasAccess) {
		throw error(403, 'You do not have access to this schedule');
	}

	await setActiveScheduleForSession(cookies, scheduleId);
	return json({ ok: true, activeScheduleId: scheduleId });
};
