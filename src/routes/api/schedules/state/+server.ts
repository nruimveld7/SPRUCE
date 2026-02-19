import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GetPool } from '$lib/server/db';
import sql from 'mssql';

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

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) {
		throw error(401, 'Unauthorized');
	}

	const body = await request.json().catch(() => null);
	const scheduleId = parseScheduleId(body?.scheduleId);
	const isActive = parseIsActive(body?.isActive);
	const confirmDeactivation = parseConfirmDeactivation(body?.confirmDeactivation);
	const pool = await GetPool();

	const tx = new sql.Transaction(pool);
	await tx.begin();
	try {
		const managerAccessResult = await new sql.Request(tx)
			.input('userOid', user.id)
			.input('scheduleId', scheduleId)
			.query(
				`SELECT TOP (1) 1 AS HasManagerAccess
				 FROM dbo.ScheduleUsers su
				 INNER JOIN dbo.Roles r
				   ON r.RoleId = su.RoleId
				 WHERE su.UserOid = @userOid
				   AND su.ScheduleId = @scheduleId
				   AND su.IsActive = 1
				   AND su.DeletedAt IS NULL
				   AND r.RoleName = 'Manager';`
			);

		if (!managerAccessResult.recordset?.[0]?.HasManagerAccess) {
			throw error(403, 'Only managers can change schedule state');
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

			await tx.commit();
			return json({ ok: true, scheduleId, isActive: true, mode: 'schedule_state_updated' as const });
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

		if (managerCount <= 0) {
			throw error(400, 'No active manager exists for this schedule');
		}

		if (!confirmDeactivation) {
			if (managerCount > 1) {
				throw error(409, {
					code: 'SCHEDULE_DEACTIVATION_CONFIRMATION_REQUIRED',
					action: 'REMOVE_SELF',
					managerCount,
					message:
						'This user is currently assigned to active shifts. If you continue, active assignments will end effective today and future assignments will be removed. Continue?'
				});
			}
			throw error(409, {
				code: 'SCHEDULE_DEACTIVATION_CONFIRMATION_REQUIRED',
				action: 'DELETE_SCHEDULE',
				managerCount,
				message:
					'You are the last Manager for this schedule. If you continue, the schedule and all related data will be permanently deleted. Continue?'
			});
		}

		if (managerCount > 1) {
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
					 FROM dbo.ScheduleUserTypes sut
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

			if (activeAssignmentCount > 0) {
				await new sql.Request(tx)
					.input('scheduleId', scheduleId)
					.input('targetUserOid', user.id)
					.input('today', today)
					.input('actorUserOid', user.id)
					.query(
						`UPDATE dbo.ScheduleUserTypes
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
						`UPDATE dbo.ScheduleUserTypes
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

		const deleteResult = await new sql.Request(tx)
			.input('scheduleId', scheduleId)
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

				 DELETE FROM dbo.ScheduleEvents
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.ScheduleUserTypes
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.ScheduleUsers
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.EmployeeTypeVersions
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.CoverageCodes
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.EmployeeTypes
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.Patterns
				 WHERE ScheduleId = @scheduleId;

				 DELETE FROM dbo.Schedules
				 WHERE ScheduleId = @scheduleId
				   AND DeletedAt IS NULL;

				 SELECT @@ROWCOUNT AS DeletedSchedules;`
			);
		const deletedSchedules = Number(deleteResult.recordset?.[0]?.DeletedSchedules ?? 0);
		if (deletedSchedules < 1) {
			throw error(404, 'Schedule not found');
		}

		await tx.commit();
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
