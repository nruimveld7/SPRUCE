import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId, getSessionAccessToken } from '$lib/server/auth';
import { searchTenantUsers } from '$lib/server/graph';
import sql from 'mssql';
import type { Cookies } from '@sveltejs/kit';
import {
	sendAccessChangedNotification,
	sendAccessGrantedNotification,
	sendAccessRemovedNotification
} from '$lib/server/mail/notifications';

type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

type TeamUserRow = {
	UserOid: string;
	Name: string | null;
	DisplayName: string | null;
	Email: string | null;
	RoleName: ScheduleRole;
	RoleGrantedAt: Date | string | null;
};

type ActorContext = {
	userOid: string;
	scheduleId: number;
	role: ScheduleRole;
};

type EffectiveRoleRow = {
	RoleName: ScheduleRole;
	RoleGrantedAt?: Date | string | null;
};

type ActiveAssignmentCountRow = {
	ActiveAssignmentCount: number;
};

type AnyAssignmentCountRow = {
	AnyAssignmentCount: number;
};

type ActiveMembershipCountRow = {
	ActiveMembershipCount: number;
};

type ConfirmRemovalPayload = {
	confirmActiveAssignmentRemoval?: boolean;
	expectedVersionStamp?: unknown;
};

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

function userVersionStamp(role: ScheduleRole, roleGrantedAt: Date | string | null | undefined): string {
	return `${role}|${toDateTimeIso(roleGrantedAt) ?? '0'}`;
}

type AccessEmailContext = {
	scheduleName: string;
	scheduleThemeJson: string | null;
	targetDisplayName: string;
	targetEmail: string | null;
	actorDisplayName: string;
};

function assertRole(role: unknown): ScheduleRole {
	if (role === 'Member' || role === 'Maintainer' || role === 'Manager') {
		return role;
	}
	throw error(400, 'Invalid role');
}

function cleanOptionalText(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLength);
}

function toLastFirstName(params: {
	name: string | null;
	givenName: string | null;
	surname: string | null;
}): string | null {
	const given = params.givenName?.trim() ?? '';
	const surname = params.surname?.trim() ?? '';
	if (surname && given) return `${surname}, ${given}`;

	const sourceName = params.name?.trim() ?? '';
	if (!sourceName) return null;
	if (sourceName.includes(',')) return sourceName;

	const parts = sourceName.split(/\s+/).filter(Boolean);
	if (parts.length >= 2) {
		const last = parts[parts.length - 1] ?? '';
		const first = parts.slice(0, -1).join(' ');
		if (last && first) return `${last}, ${first}`;
	}

	return sourceName;
}

function toDateOnly(value: Date | string | null | undefined): string {
	if (!value) return '';
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') return value.slice(0, 10);
	return '';
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

	return {
		pool,
		ctx: { userOid: localsUserOid, scheduleId, role } satisfies ActorContext
	};
}

async function getEffectiveRole(
	request: sql.Request,
	scheduleId: number,
	userOid: string
): Promise<{ role: ScheduleRole; versionStamp: string } | null> {
	const result = await request
		.input('scheduleId', scheduleId)
		.input('targetUserOid', userOid)
		.query(
			`SELECT TOP (1) r.RoleName, su.GrantedAt AS RoleGrantedAt
			 FROM dbo.ScheduleUsers su
			 INNER JOIN dbo.Roles r
			   ON r.RoleId = su.RoleId
			 WHERE su.ScheduleId = @scheduleId
			   AND su.UserOid = @targetUserOid
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

	const row = result.recordset?.[0] as EffectiveRoleRow | undefined;
	if (!row?.RoleName) return null;
	return {
		role: row.RoleName,
		versionStamp: userVersionStamp(row.RoleName, row.RoleGrantedAt ?? null)
	};
}

async function countManagers(request: sql.Request, scheduleId: number): Promise<number> {
	const result = await request.input('scheduleId', scheduleId).query(
		`SELECT COUNT(DISTINCT su.UserOid) AS ManagerCount
		 FROM dbo.ScheduleUsers su
		 INNER JOIN dbo.Roles r
		   ON r.RoleId = su.RoleId
		 WHERE su.ScheduleId = @scheduleId
		   AND su.IsActive = 1
		   AND su.DeletedAt IS NULL
		   AND r.RoleName = 'Manager';`
	);
	return Number(result.recordset?.[0]?.ManagerCount ?? 0);
}

function cleanBoolean(value: unknown): boolean {
	return value === true;
}

async function getAccessEmailContext(params: {
	pool: sql.ConnectionPool;
	scheduleId: number;
	targetUserOid: string;
	actorUserOid: string;
}): Promise<AccessEmailContext | null> {
	const result = await params.pool
		.request()
		.input('scheduleId', params.scheduleId)
		.input('targetUserOid', params.targetUserOid)
		.input('actorUserOid', params.actorUserOid)
		.query(
				`SELECT TOP (1)
					s.Name AS ScheduleName,
					s.ThemeJson AS ScheduleThemeJson,
					COALESCE(NULLIF(tu.DisplayName, ''), NULLIF(tu.FullName, ''), @targetUserOid) AS TargetDisplayName,
					NULLIF(LTRIM(RTRIM(tu.Email)), '') AS TargetEmail,
					COALESCE(NULLIF(au.DisplayName, ''), NULLIF(au.FullName, ''), @actorUserOid) AS ActorDisplayName
				 FROM dbo.Schedules s
				 LEFT JOIN dbo.Users tu
					ON tu.UserOid = @targetUserOid
				   AND tu.DeletedAt IS NULL
				 LEFT JOIN dbo.Users au
					ON au.UserOid = @actorUserOid
				   AND au.DeletedAt IS NULL
				 WHERE s.ScheduleId = @scheduleId
				   AND s.DeletedAt IS NULL;`
			);
	const row = result.recordset?.[0];
	if (!row) return null;
	return {
		scheduleName: String(row.ScheduleName ?? ''),
		scheduleThemeJson: (row.ScheduleThemeJson as string | null) ?? null,
		targetDisplayName: String(row.TargetDisplayName ?? params.targetUserOid),
		targetEmail: row.TargetEmail ? String(row.TargetEmail) : null,
		actorDisplayName: String(row.ActorDisplayName ?? params.actorUserOid)
	};
}

function assertCanManageRoleChanges(actor: ActorContext, currentRole: ScheduleRole | null, nextRole: ScheduleRole) {
	if (nextRole === 'Manager' && actor.role !== 'Manager') {
		throw error(403, 'Only Managers can assign Manager role');
	}
	if (currentRole === 'Manager' && actor.role !== 'Manager') {
		throw error(403, 'Only Managers can modify a Manager user');
	}
}

export const GET: RequestHandler = async (event) => {
	const { locals, cookies, url } = event;
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, ctx } = await getActorContext(currentUser.id, cookies);
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (q.length > 0) {
		const token = await getSessionAccessToken(event);
		const users = await searchTenantUsers(token, q);
		return json({ users });
	}

	const result = await pool
		.request()
		.input('scheduleId', ctx.scheduleId)
		.query(
			`WITH RankedUsers AS (
				SELECT
					su.UserOid,
					COALESCE(
						NULLIF(LTRIM(RTRIM(u.FullName)), ''),
						NULLIF(
							LTRIM(
								RTRIM(
									COALESCE(NULLIF(LTRIM(RTRIM(u.EntraFirstName)), ''), '') +
									CASE
										WHEN NULLIF(LTRIM(RTRIM(u.EntraFirstName)), '') IS NOT NULL
										 AND NULLIF(LTRIM(RTRIM(u.EntraLastName)), '') IS NOT NULL
										THEN ' '
										ELSE ''
									END +
									COALESCE(NULLIF(LTRIM(RTRIM(u.EntraLastName)), ''), '')
								)
							),
							''
						),
						su.UserOid
					) AS Name,
					NULLIF(LTRIM(RTRIM(u.DisplayName)), '') AS DisplayName,
					u.Email,
					r.RoleName,
					su.GrantedAt AS RoleGrantedAt,
					ROW_NUMBER() OVER (
						PARTITION BY su.UserOid
						ORDER BY
							CASE r.RoleName
								WHEN 'Manager' THEN 3
								WHEN 'Maintainer' THEN 2
								WHEN 'Member' THEN 1
								ELSE 0
							END DESC,
							su.GrantedAt DESC
					) AS RoleRank
				FROM dbo.ScheduleUsers su
				INNER JOIN dbo.Roles r
					ON r.RoleId = su.RoleId
				LEFT JOIN dbo.Users u
					ON u.UserOid = su.UserOid
				   AND u.DeletedAt IS NULL
				WHERE su.ScheduleId = @scheduleId
				  AND su.IsActive = 1
				  AND su.DeletedAt IS NULL
			)
			SELECT UserOid, Name, DisplayName, Email, RoleName, RoleGrantedAt
			FROM RankedUsers
			WHERE RoleRank = 1
			ORDER BY Name ASC, UserOid ASC;`
		);

	const users = (result.recordset as TeamUserRow[]).map((row) => ({
		userOid: row.UserOid,
		name: row.Name?.trim() || row.UserOid,
		displayName: row.DisplayName?.trim() || '',
		email: row.Email?.trim() || '',
		role: row.RoleName,
		versionStamp: userVersionStamp(row.RoleName, row.RoleGrantedAt)
	}));

	return json({ users });
};

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, ctx } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const targetUserOid = cleanOptionalText(body?.userOid, 64);
	const name = cleanOptionalText(body?.name, 200);
	const givenName = cleanOptionalText(body?.givenName, 100);
	const surname = cleanOptionalText(body?.surname, 100);
	const resolvedName = toLastFirstName({ name, givenName, surname });
	const email = cleanOptionalText(body?.email, 320);
	const role = assertRole(body?.role);

	if (!targetUserOid) {
		throw error(400, 'A user must be selected');
	}

	assertCanManageRoleChanges(ctx, null, role);

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const upsertUserRequest = new sql.Request(tx);
		await upsertUserRequest
			.input('userOid', targetUserOid)
			.input('fullName', resolvedName)
			.input('displayName', resolvedName)
			.input('entraFirstName', givenName)
			.input('entraLastName', surname)
			.input('email', email)
			.query(
				`MERGE dbo.Users AS target
				 USING (SELECT @userOid AS UserOid) AS source
				 ON target.UserOid = source.UserOid
				 WHEN MATCHED THEN
				   UPDATE SET FullName = COALESCE(@fullName, target.FullName),
							  EntraFirstName = COALESCE(@entraFirstName, target.EntraFirstName),
							  EntraLastName = COALESCE(@entraLastName, target.EntraLastName),
							  DisplayName = CASE
								 WHEN NULLIF(LTRIM(RTRIM(target.DisplayName)), '') IS NULL
								 THEN COALESCE(@displayName, target.DisplayName)
								 ELSE target.DisplayName
							  END,
							  Email = COALESCE(@email, target.Email),
							  IsActive = 1,
							  DeletedAt = NULL,
							  DeletedBy = NULL,
							  UpdatedAt = SYSUTCDATETIME()
				 WHEN NOT MATCHED THEN
				   INSERT (UserOid, FullName, DisplayName, EntraFirstName, EntraLastName, Email)
				   VALUES (@userOid, @fullName, @displayName, @entraFirstName, @entraLastName, @email);`
			);

		const roleIdResult = await new sql.Request(tx).input('roleName', role).query(
			`SELECT TOP (1) RoleId
			 FROM dbo.Roles
			 WHERE RoleName = @roleName;`
		);
		const roleId = roleIdResult.recordset?.[0]?.RoleId;
		if (!roleId) {
			throw error(500, 'Role configuration is missing');
		}

		await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.input('actorUserOid', ctx.userOid)
			.query(
				`UPDATE dbo.ScheduleUsers
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorUserOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @targetUserOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);

		await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.input('roleId', roleId)
			.input('actorUserOid', ctx.userOid)
			.query(
				`MERGE dbo.ScheduleUsers AS target
				 USING (SELECT @scheduleId AS ScheduleId, @targetUserOid AS UserOid, @roleId AS RoleId) AS source
				 ON target.ScheduleId = source.ScheduleId
				 AND target.UserOid = source.UserOid
				 AND target.RoleId = source.RoleId
				 WHEN MATCHED THEN
				   UPDATE SET IsActive = 1,
							  DeletedAt = NULL,
							  DeletedBy = NULL,
							  GrantedAt = SYSUTCDATETIME(),
							  GrantedBy = @actorUserOid
				 WHEN NOT MATCHED THEN
				   INSERT (ScheduleId, UserOid, RoleId, GrantedBy)
				   VALUES (@scheduleId, @targetUserOid, @roleId, @actorUserOid);`
			);

		await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.query(
				`UPDATE dbo.Users
				 SET DefaultScheduleId = @scheduleId,
					 UpdatedAt = SYSUTCDATETIME()
				 WHERE UserOid = @targetUserOid
				   AND DeletedAt IS NULL
				   AND DefaultScheduleId IS NULL;`
			);

		await tx.commit();

		const emailContext = await getAccessEmailContext({
			pool,
			scheduleId: ctx.scheduleId,
			targetUserOid,
			actorUserOid: ctx.userOid
		});
		if (emailContext) {
			try {
				await sendAccessGrantedNotification({
					scheduleName: emailContext.scheduleName,
					themeJson: emailContext.scheduleThemeJson,
					intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
					targetMemberName: emailContext.targetDisplayName,
					authorizedByName: emailContext.actorDisplayName,
					status: role
				});
			} catch (notificationError) {
				console.error('Access granted notification failed:', notificationError);
			}
		}

		return json({ ok: true });
	} catch (e) {
		await tx.rollback();
		throw e;
	}
};

export const PATCH: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, ctx } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const targetUserOid = cleanOptionalText(body?.userOid, 64);
	const nextRole = assertRole(body?.role);
	const expectedVersionStamp = cleanRequiredVersionStamp(body?.expectedVersionStamp, 'Version stamp');

	if (!targetUserOid) {
		throw error(400, 'Target user is required');
	}

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const currentSnapshot = await getEffectiveRole(new sql.Request(tx), ctx.scheduleId, targetUserOid);
		if (!currentSnapshot) {
			throw error(404, 'User is not assigned to this schedule');
		}
		if (currentSnapshot.versionStamp !== expectedVersionStamp) {
			throw error(409, 'This user access entry has changed. Refresh and try again.');
		}
		const currentRole = currentSnapshot.role;

		assertCanManageRoleChanges(ctx, currentRole, nextRole);

		if (currentRole === 'Manager' && nextRole !== 'Manager') {
			const managerCount = await countManagers(new sql.Request(tx), ctx.scheduleId);
			if (managerCount <= 1) {
				throw error(400, 'At least one Manager is required for the schedule');
			}
		}

		const roleIdResult = await new sql.Request(tx).input('roleName', nextRole).query(
			`SELECT TOP (1) RoleId
			 FROM dbo.Roles
			 WHERE RoleName = @roleName;`
		);
		const roleId = roleIdResult.recordset?.[0]?.RoleId;
		if (!roleId) {
			throw error(500, 'Role configuration is missing');
		}

		await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.input('actorUserOid', ctx.userOid)
			.query(
				`UPDATE dbo.ScheduleUsers
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorUserOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @targetUserOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);

		await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.input('roleId', roleId)
			.input('actorUserOid', ctx.userOid)
			.query(
				`MERGE dbo.ScheduleUsers AS target
				 USING (SELECT @scheduleId AS ScheduleId, @targetUserOid AS UserOid, @roleId AS RoleId) AS source
				 ON target.ScheduleId = source.ScheduleId
				 AND target.UserOid = source.UserOid
				 AND target.RoleId = source.RoleId
				 WHEN MATCHED THEN
				   UPDATE SET IsActive = 1,
							  DeletedAt = NULL,
							  DeletedBy = NULL,
							  GrantedAt = SYSUTCDATETIME(),
							  GrantedBy = @actorUserOid
				 WHEN NOT MATCHED THEN
				   INSERT (ScheduleId, UserOid, RoleId, GrantedBy)
				   VALUES (@scheduleId, @targetUserOid, @roleId, @actorUserOid);`
			);

			await tx.commit();

			if (currentRole !== nextRole) {
				const emailContext = await getAccessEmailContext({
					pool,
					scheduleId: ctx.scheduleId,
					targetUserOid,
					actorUserOid: ctx.userOid
				});
				if (emailContext) {
					try {
						await sendAccessChangedNotification({
							scheduleName: emailContext.scheduleName,
							themeJson: emailContext.scheduleThemeJson,
							intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
							targetMemberName: emailContext.targetDisplayName,
							authorizedByName: emailContext.actorDisplayName,
							status: nextRole
						});
					} catch (notificationError) {
						console.error('Access changed notification failed:', notificationError);
					}
				}
			}

			return json({ ok: true });
	} catch (e) {
		await tx.rollback();
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ locals, cookies, request }) => {
	const currentUser = locals.user;
	if (!currentUser) {
		throw error(401, 'Unauthorized');
	}

	const { pool, ctx } = await getActorContext(currentUser.id, cookies);
	const body = await request.json().catch(() => null);
	const targetUserOid = cleanOptionalText(body?.userOid, 64);
	const expectedVersionStamp = cleanRequiredVersionStamp(
		(body as ConfirmRemovalPayload | null)?.expectedVersionStamp,
		'Version stamp'
	);
	const confirmActiveAssignmentRemoval = cleanBoolean(
		(body as ConfirmRemovalPayload | null)?.confirmActiveAssignmentRemoval
	);
	if (!targetUserOid) {
		throw error(400, 'Target user is required');
	}

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const emailContext = await getAccessEmailContext({
			pool,
			scheduleId: ctx.scheduleId,
			targetUserOid,
			actorUserOid: ctx.userOid
		});

		const currentSnapshot = await getEffectiveRole(new sql.Request(tx), ctx.scheduleId, targetUserOid);
		if (!currentSnapshot) {
			throw error(404, 'User is not assigned to this schedule');
		}
		if (currentSnapshot.versionStamp !== expectedVersionStamp) {
			throw error(409, 'This user access entry has changed. Refresh and try again.');
		}
		const currentRole = currentSnapshot.role;

		if (currentRole === 'Manager' && ctx.role !== 'Manager') {
			throw error(403, 'Only Managers can remove a Manager user');
		}

		if (currentRole === 'Manager') {
			const managerCount = await countManagers(new sql.Request(tx), ctx.scheduleId);
			if (managerCount <= 1) {
				throw error(400, 'At least one Manager is required for the schedule');
			}
		}

		const serverDateResult = await new sql.Request(tx).query(
			`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`
		);
		const today = toDateOnly(serverDateResult.recordset?.[0]?.Today);
		if (!today) {
			throw error(500, 'Could not resolve current server date');
		}

		const activeAssignmentResult = await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.input('today', today)
			.query(
				`SELECT COUNT(*) AS ActiveAssignmentCount
				 FROM dbo.ScheduleAssignments sut
				 WHERE sut.ScheduleId = @scheduleId
				   AND sut.UserOid = @targetUserOid
				   AND sut.IsActive = 1
				   AND sut.DeletedAt IS NULL
				   AND sut.StartDate <= @today
				   AND (sut.EndDate IS NULL OR sut.EndDate >= @today);`
			);
		const activeAssignmentCount = Number(
			(activeAssignmentResult.recordset?.[0] as ActiveAssignmentCountRow | undefined)
				?.ActiveAssignmentCount ?? 0
		);

		if (activeAssignmentCount > 0 && !confirmActiveAssignmentRemoval) {
			throw error(409, {
				code: 'USER_ACTIVE_ASSIGNMENTS',
				message:
					'This user is currently assigned to one or more shifts. Confirm removal to end active assignment(s) effective today.',
				activeAssignmentCount
			});
		}

		const anyAssignmentResult = await new sql.Request(tx)
			.input('targetUserOid', targetUserOid)
			.query(
				`SELECT COUNT(*) AS AnyAssignmentCount
				 FROM dbo.ScheduleAssignments sut
				 WHERE sut.UserOid = @targetUserOid;`
			);
		const anyAssignmentCount = Number(
			(anyAssignmentResult.recordset?.[0] as AnyAssignmentCountRow | undefined)?.AnyAssignmentCount ?? 0
		);
		const hasEverAssignment = anyAssignmentCount > 0;

		await new sql.Request(tx)
			.input('scheduleId', ctx.scheduleId)
			.input('targetUserOid', targetUserOid)
			.input('actorUserOid', ctx.userOid)
			.query(
				`UPDATE dbo.ScheduleUsers
				 SET IsActive = 0,
					 DeletedAt = SYSUTCDATETIME(),
					 DeletedBy = @actorUserOid
				 WHERE ScheduleId = @scheduleId
				   AND UserOid = @targetUserOid
				   AND IsActive = 1
				   AND DeletedAt IS NULL;`
			);

		if (activeAssignmentCount > 0) {
			await new sql.Request(tx)
				.input('scheduleId', ctx.scheduleId)
				.input('targetUserOid', targetUserOid)
				.input('today', today)
				.input('actorUserOid', ctx.userOid)
				.query(
					`UPDATE dbo.ScheduleAssignments
					 SET EndDate = CASE
						 WHEN EndDate IS NULL OR EndDate > @today THEN @today
						 ELSE EndDate
					 END,
					 EndedAt = SYSUTCDATETIME(),
					 EndedBy = @actorUserOid
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @targetUserOid
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND StartDate <= @today
					   AND (EndDate IS NULL OR EndDate >= @today);`
				);

			await new sql.Request(tx)
				.input('scheduleId', ctx.scheduleId)
				.input('targetUserOid', targetUserOid)
				.input('today', today)
				.input('actorUserOid', ctx.userOid)
				.query(
					`UPDATE dbo.ScheduleAssignments
					 SET IsActive = 0,
					 	 DeletedAt = SYSUTCDATETIME(),
					 	 DeletedBy = @actorUserOid
					 WHERE ScheduleId = @scheduleId
					   AND UserOid = @targetUserOid
					   AND IsActive = 1
					   AND DeletedAt IS NULL
					   AND StartDate > @today;`
				);
		}

		const activeMembershipResult = await new sql.Request(tx)
			.input('targetUserOid', targetUserOid)
			.query(
				`SELECT COUNT(*) AS ActiveMembershipCount
				 FROM dbo.ScheduleUsers su
				 WHERE su.UserOid = @targetUserOid
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL;`
			);
		const activeMembershipCount = Number(
			(activeMembershipResult.recordset?.[0] as ActiveMembershipCountRow | undefined)
				?.ActiveMembershipCount ?? 0
		);

		let removalMode: 'hard_deleted' | 'soft_deactivated' | 'schedule_removed_only' =
			'schedule_removed_only';

		if (!hasEverAssignment && activeMembershipCount === 0) {
			await new sql.Request(tx)
				.input('targetUserOid', targetUserOid)
				.query(
					`DELETE FROM dbo.ScheduleEvents WHERE UserOid = @targetUserOid;
					 DELETE FROM dbo.BootstrapManagers WHERE UserOid = @targetUserOid;
					 DELETE FROM dbo.ScheduleUsers WHERE UserOid = @targetUserOid;
					 DELETE FROM dbo.Users WHERE UserOid = @targetUserOid;`
				);
			removalMode = 'hard_deleted';
		} else if (activeMembershipCount === 0) {
			await new sql.Request(tx)
				.input('targetUserOid', targetUserOid)
				.input('actorUserOid', ctx.userOid)
				.query(
					`UPDATE dbo.Users
					 SET IsActive = 0,
					 	 DeletedAt = SYSUTCDATETIME(),
					 	 DeletedBy = @actorUserOid,
					 	 UpdatedAt = SYSUTCDATETIME()
					 WHERE UserOid = @targetUserOid;`
				);
			removalMode = 'soft_deactivated';
		}

		await tx.commit();

		if (emailContext) {
			try {
				await sendAccessRemovedNotification({
					scheduleName: emailContext.scheduleName,
					themeJson: emailContext.scheduleThemeJson,
					intendedRecipients: emailContext.targetEmail ? [emailContext.targetEmail] : [],
					targetMemberName: emailContext.targetDisplayName,
					triggeringUserName: emailContext.actorDisplayName
				});
			} catch (notificationError) {
				console.error('Access removed notification failed:', notificationError);
			}
		}

		return json({
			ok: true,
			removalMode,
			endedActiveAssignments: activeAssignmentCount > 0
		});
	} catch (e) {
		try {
			await tx.rollback();
		} catch {
			// Preserve the original SQL error when SQL Server already aborted the transaction.
		}
		throw e;
	}
};
