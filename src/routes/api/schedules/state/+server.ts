import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import { getSessionAccessToken } from '$lib/server/auth';
import { sendAccessRemovedNotification } from '$lib/server/mail/notifications';
import sql from 'mssql';
import { isBootstrapManager, requireScheduleRole } from '$lib/server/schedule-access';

type ScheduleDeactivationEmailTarget = {
	targetDisplayName: string;
	targetEmail: string | null;
};

type ScheduleDeactivationEmailContext = {
	scheduleName: string;
	scheduleThemeJson: string | null;
	actorDisplayName: string;
	targets: ScheduleDeactivationEmailTarget[];
};

function parseScheduleId(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw error(400, 'A valid scheduleId is required');
	}
	return value;
}

function parseIsActive(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw error(400, 'A valid isActive flag is required');
	}
	return value;
}

function parseConfirmDeactivation(value: unknown): boolean {
	return value === true;
}

function parseExpectedVersionAt(value: unknown): Date | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') {
		throw error(400, 'A valid expectedVersionAt value is required');
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw error(400, 'A valid expectedVersionAt value is required');
	}
	return parsed;
}

async function getScheduleDeactivationEmailContext(params: {
	tx: sql.Transaction;
	scheduleId: number;
	actorUserOid: string;
}): Promise<ScheduleDeactivationEmailContext | null> {
	const scheduleResult = await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.input('actorUserOid', params.actorUserOid)
		.query(
			`SELECT TOP (1)
				s.Name AS ScheduleName,
				s.ThemeJson AS ScheduleThemeJson,
				COALESCE(NULLIF(au.DisplayName, ''), NULLIF(au.FullName, ''), @actorUserOid) AS ActorDisplayName
			 FROM dbo.Schedules s
			 LEFT JOIN dbo.Users au
			   ON au.UserOid = @actorUserOid
			  AND au.DeletedAt IS NULL
			 WHERE s.ScheduleId = @scheduleId
			   AND s.DeletedAt IS NULL;`
		);

	const scheduleRow = scheduleResult.recordset?.[0];
	if (!scheduleRow) return null;

	const targetsResult = await new sql.Request(params.tx)
		.input('scheduleId', params.scheduleId)
		.query(
			`SELECT
				su.UserOid,
				COALESCE(NULLIF(u.DisplayName, ''), NULLIF(u.FullName, ''), su.UserOid) AS TargetDisplayName,
				NULLIF(LTRIM(RTRIM(u.Email)), '') AS TargetEmail
			 FROM dbo.ScheduleUsers su
			 LEFT JOIN dbo.Users u
			   ON u.UserOid = su.UserOid
			  AND u.DeletedAt IS NULL
			 WHERE su.ScheduleId = @scheduleId
			   AND su.IsActive = 1
			   AND su.DeletedAt IS NULL;`
		);

	const targetRows = (targetsResult.recordset ?? []) as Array<{
		UserOid: string;
		TargetDisplayName: string | null;
		TargetEmail: string | null;
	}>;
	const targets = targetRows.map((row) => ({
		targetDisplayName: String(row.TargetDisplayName ?? row.UserOid ?? ''),
		targetEmail: row.TargetEmail ? String(row.TargetEmail) : null
	}));

	return {
		scheduleName: String(scheduleRow.ScheduleName ?? ''),
		scheduleThemeJson: (scheduleRow.ScheduleThemeJson as string | null) ?? null,
		actorDisplayName: String(scheduleRow.ActorDisplayName ?? params.actorUserOid),
		targets
	};
}

export const POST: RequestHandler = async (event) => {
	const { locals, request } = event;
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const body = await request.json().catch(() => null);
	const scheduleId = parseScheduleId(body?.scheduleId);
	const isActive = parseIsActive(body?.isActive);
	const confirmDeactivation = parseConfirmDeactivation(body?.confirmDeactivation);
	const expectedVersionAt = parseExpectedVersionAt(body?.expectedVersionAt);
	const pool = await GetPool();

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		let scheduleDeactivationEmailContext: ScheduleDeactivationEmailContext | null = null;
		await requireScheduleRole({
			userOid: user.id,
			scheduleId,
			minRole: 'Manager',
			pool,
			errorMessage: 'Only managers can change schedule state'
		});
		const actorIsBootstrap = await isBootstrapManager(user.id, pool);

		const scheduleVersionResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.query(
				`SELECT TOP (1) COALESCE(UpdatedAt, CreatedAt) AS VersionAt
				 FROM dbo.Schedules
				 WHERE ScheduleId = @scheduleId
				   AND DeletedAt IS NULL;`
			);
		const currentVersionAt = scheduleVersionResult.recordset?.[0]?.VersionAt as Date | undefined;
		if (!currentVersionAt) {
			throw error(404, 'Schedule not found');
		}
		if (expectedVersionAt && currentVersionAt.getTime() !== expectedVersionAt.getTime()) {
			await tx.rollback();
			return json(
				{
					code: 'SCHEDULE_CONCURRENT_MODIFICATION',
					message: 'This schedule changed while you were editing. Refresh and retry.'
				},
				{ status: 409 }
			);
		}

		if (isActive) {
			const updateResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('isActive', 1)
				.input('userOid', user.id)
				.query(
					`UPDATE dbo.Schedules
					 SET IsActive = @isActive,
					     UpdatedAt = SYSUTCDATETIME(),
					     UpdatedBy = @userOid
					 WHERE ScheduleId = @scheduleId
					   AND DeletedAt IS NULL;

					 SELECT @@ROWCOUNT AS UpdatedRows;`
				);

			const updatedRows = Number(updateResult.recordset?.[0]?.UpdatedRows ?? 0);
			if (updatedRows < 1) {
				throw error(404, 'Schedule not found');
			}

			const refreshedVersionResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.query(
					`SELECT TOP (1) COALESCE(UpdatedAt, CreatedAt) AS VersionAt
					 FROM dbo.Schedules
					 WHERE ScheduleId = @scheduleId
					   AND DeletedAt IS NULL;`
				);
			const refreshedVersionAt = refreshedVersionResult.recordset?.[0]?.VersionAt as Date | undefined;
			await tx.commit();
			return json({
				ok: true,
				scheduleId,
				isActive: true,
				mode: 'schedule_state_updated' as const,
				versionAt: refreshedVersionAt ?? currentVersionAt
			});
		}

		const managerCountResult = await new sql.Request(tx).input('scheduleId', scheduleId).query(
			`SELECT COUNT(DISTINCT su.UserOid) AS ManagerCount
			 FROM dbo.ScheduleUsers su
			 INNER JOIN dbo.Roles r
			   ON r.RoleId = su.RoleId
			 WHERE su.ScheduleId = @scheduleId
			   AND su.IsActive = 1
			   AND su.DeletedAt IS NULL
			   AND r.RoleName = 'Manager';`
		);
		const managerCount = Number(managerCountResult.recordset?.[0]?.ManagerCount ?? 0);
		const actorExplicitManagerResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', user.id)
			.query(
				`SELECT TOP (1) 1 AS IsExplicitManager
				 FROM dbo.ScheduleUsers su
				 INNER JOIN dbo.Roles r
				   ON r.RoleId = su.RoleId
				 WHERE su.ScheduleId = @scheduleId
				   AND su.UserOid = @userOid
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL
				   AND r.RoleName = 'Manager';`
			);
		const isExplicitManager = Boolean(actorExplicitManagerResult.recordset?.[0]?.IsExplicitManager);

		if (managerCount <= 0 && !actorIsBootstrap) {
			throw error(400, 'No active manager exists for this schedule');
		}

		if (!confirmDeactivation) {
			if (managerCount > 1 && isExplicitManager) {
					await tx.rollback();
					return json(
						{
							code: 'SCHEDULE_DEACTIVATION_CONFIRMATION_REQUIRED',
							action: 'REMOVE_SELF',
							managerCount,
							message:
								'This user is currently assigned to active shifts. If you continue, active assignments will end effective today and future assignments will be removed. Continue?'
						},
						{ status: 409 }
					);
				}
				await tx.rollback();
				return json(
					{
						code: 'SCHEDULE_DEACTIVATION_CONFIRMATION_REQUIRED',
						action: 'DELETE_SCHEDULE',
						managerCount,
						message:
							'You are the last Manager for this schedule. If you continue, the schedule and all related data will be permanently deleted. Continue?'
					},
					{ status: 409 }
				);
			}

		if (managerCount > 1 && isExplicitManager) {
			const serverDateResult = await new sql.Request(tx).query(
				`SELECT CONVERT(date, SYSUTCDATETIME()) AS Today;`
			);
			const today = String(serverDateResult.recordset?.[0]?.Today ?? '').slice(0, 10);
			if (!today) {
				throw error(500, 'Could not resolve current server date');
			}

			const activeAssignmentResult = await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('targetUserOid', user.id)
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
				activeAssignmentResult.recordset?.[0]?.ActiveAssignmentCount ?? 0
			);

			await new sql.Request(tx)
				.input('scheduleId', scheduleId)
				.input('targetUserOid', user.id)
				.input('actorUserOid', user.id)
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

			const remainingManagerCountResult = await new sql.Request(tx).input('scheduleId', scheduleId).query(
				`SELECT COUNT(DISTINCT su.UserOid) AS ManagerCount
				 FROM dbo.ScheduleUsers su
				 INNER JOIN dbo.Roles r
				   ON r.RoleId = su.RoleId
				 WHERE su.ScheduleId = @scheduleId
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL
				   AND r.RoleName = 'Manager';`
			);
			const remainingManagerCount = Number(
				remainingManagerCountResult.recordset?.[0]?.ManagerCount ?? 0
			);
			if (remainingManagerCount <= 0) {
				await tx.rollback();
				return json(
					{
						code: 'SCHEDULE_CONCURRENT_MODIFICATION',
						message:
							'This schedule changed while you were editing. Another manager update prevented this operation.'
					},
					{ status: 409 }
				);
			}

			if (activeAssignmentCount > 0) {
				await new sql.Request(tx)
					.input('scheduleId', scheduleId)
					.input('targetUserOid', user.id)
					.input('today', today)
					.input('actorUserOid', user.id)
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
					.input('scheduleId', scheduleId)
					.input('targetUserOid', user.id)
					.input('today', today)
					.input('actorUserOid', user.id)
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

			await tx.commit();
			return json({
				ok: true,
				scheduleId,
				isActive: true,
				mode: 'manager_removed' as const
			});
		}

		scheduleDeactivationEmailContext = await getScheduleDeactivationEmailContext({
			tx,
			scheduleId,
			actorUserOid: user.id
		});

		const deleteResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
			.input('userOid', user.id)
			.query(
				`UPDATE u
				 SET DefaultScheduleId = nextSchedule.ScheduleId,
					 UpdatedAt = SYSUTCDATETIME()
				 FROM dbo.Users u
				 OUTER APPLY (
					 SELECT TOP (1) su.ScheduleId
					 FROM dbo.ScheduleUsers su
					 INNER JOIN dbo.Schedules s
					   ON s.ScheduleId = su.ScheduleId
					 LEFT JOIN dbo.Roles r
					   ON r.RoleId = su.RoleId
					 WHERE su.UserOid = u.UserOid
					   AND su.ScheduleId <> @scheduleId
					   AND su.IsActive = 1
					   AND su.DeletedAt IS NULL
					   AND s.DeletedAt IS NULL
					   AND (s.IsActive = 1 OR r.RoleName = 'Manager')
					 GROUP BY su.ScheduleId, s.Name
					 ORDER BY s.Name ASC, su.ScheduleId ASC
				 ) AS nextSchedule
					 WHERE u.DefaultScheduleId = @scheduleId
					   AND u.DeletedAt IS NULL;

				 UPDATE dbo.ScheduleUsers
				 SET IsActive = 0,
				     DeletedAt = COALESCE(DeletedAt, SYSUTCDATETIME()),
				     DeletedBy = COALESCE(DeletedBy, @userOid)
				 WHERE ScheduleId = @scheduleId
				   AND IsActive = 1
				   AND DeletedAt IS NULL;

				 UPDATE dbo.Schedules
				 SET IsActive = 0,
				     UpdatedAt = SYSUTCDATETIME(),
				     UpdatedBy = @userOid,
				     DeletedAt = SYSUTCDATETIME(),
				     DeletedBy = @userOid
				 WHERE ScheduleId = @scheduleId
				   AND DeletedAt IS NULL;

				 SELECT @@ROWCOUNT AS DeletedSchedules;`
			);
		const deletedSchedules = Number(deleteResult.recordset?.[0]?.DeletedSchedules ?? 0);
		if (deletedSchedules < 1) {
			throw error(404, 'Schedule not found');
		}

		await tx.commit();

		if (scheduleDeactivationEmailContext) {
			const seenEmails = new Set<string>();
			const intendedRecipients: string[] = [];
			for (const target of scheduleDeactivationEmailContext.targets) {
				const email = target.targetEmail?.trim();
				if (!email) continue;
				const key = email.toLowerCase();
				if (seenEmails.has(key)) continue;
				seenEmails.add(key);
				intendedRecipients.push(email);
			}
			const affectedUserNames = scheduleDeactivationEmailContext.targets
				.map((target) => target.targetDisplayName.trim())
				.filter(Boolean);
			const targetMemberName =
				affectedUserNames.length === 0
					? 'Schedule Members'
					: affectedUserNames.length <= 5
						? affectedUserNames.join(', ')
						: `${affectedUserNames.length} schedule members`;

			if (intendedRecipients.length > 0) {
				try {
					const delegatedAccessToken = await getSessionAccessToken(event);
					await sendAccessRemovedNotification({
						scheduleName: scheduleDeactivationEmailContext.scheduleName,
						themeJson: scheduleDeactivationEmailContext.scheduleThemeJson,
						intendedRecipients,
						targetMemberName,
						triggeringUserName: scheduleDeactivationEmailContext.actorDisplayName,
						status: 'Schedule Deactivated',
						delegatedAccessToken
					});
				} catch (notificationError) {
					console.error('Schedule deactivation access removed notification failed:', notificationError);
				}
			}
		}

		return json({
			ok: true,
			scheduleId,
			isActive: false,
			mode: 'schedule_deleted' as const
		});
	} catch (e) {
		await tx.rollback();
		throw e;
	}
};
