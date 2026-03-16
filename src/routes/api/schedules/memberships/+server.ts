import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId } from '$lib/server/auth';
import { listEffectiveScheduleMemberships } from '$lib/server/schedule-access';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
type ScheduleMembership = {
	ScheduleId: number;
	Name: string;
	RoleName: ScheduleRole;
	IsDefault: boolean;
	IsActive: boolean;
	ThemeJson: string | null;
	VersionAt: string | Date;
};

export const GET: RequestHandler = async ({ locals, cookies }) => {
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const activeScheduleId = await getActiveScheduleId(cookies);
	const pool = await GetPool();

	const defaultResult = await pool
		.request()
		.input('userOid', user.id)
		.query(
			`SELECT TOP (1) DefaultScheduleId
			 FROM dbo.Users
			 WHERE UserOid = @userOid
			   AND DeletedAt IS NULL;`
		);

	const defaultScheduleId = (defaultResult.recordset?.[0]?.DefaultScheduleId as number | null) ?? null;

	const memberships = (await listEffectiveScheduleMemberships({
		userOid: user.id,
		defaultScheduleId,
		pool
	})) as ScheduleMembership[];
	const resolvedActiveScheduleId =
		activeScheduleId !== null &&
		memberships.some((membership) => membership.ScheduleId === activeScheduleId)
			? activeScheduleId
			: (memberships[0]?.ScheduleId ?? null);

	return json({
		activeScheduleId: resolvedActiveScheduleId,
		defaultScheduleId,
		memberships
	});
};
