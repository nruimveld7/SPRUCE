import { error } from '@sveltejs/kit';
import { GetPool } from '$lib/server/db';
import type { ConnectionPool } from 'mssql';

export type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';

function roleTier(role: ScheduleRole): number {
	if (role === 'Manager') return 3;
	if (role === 'Maintainer') return 2;
	return 1;
}

export function hasRequiredRole(role: ScheduleRole, minRole: ScheduleRole): boolean {
	return roleTier(role) >= roleTier(minRole);
}

export async function isBootstrapManager(
	userOid: string,
	poolArg?: ConnectionPool
): Promise<boolean> {
	const pool = poolArg ?? (await GetPool());
	const result = await pool
		.request()
		.input('userOid', userOid)
		.query(
			`DECLARE @isBootstrap bit = 0;

			 IF OBJECT_ID('dbo.BootstrapManagers', 'U') IS NOT NULL
			 BEGIN
			 	IF EXISTS (
			 		SELECT 1
			 		FROM dbo.BootstrapManagers
			 		WHERE UserOid = @userOid
			 		  AND IsActive = 1
			 		  AND DeletedAt IS NULL
			 	)
			 	BEGIN
			 		SET @isBootstrap = 1;
			 	END
			 END

			 SELECT @isBootstrap AS IsBootstrap;`
		);

	return Boolean(result.recordset?.[0]?.IsBootstrap);
}

export async function getEffectiveScheduleRole(params: {
	userOid: string;
	scheduleId: number;
	pool?: ConnectionPool;
}): Promise<ScheduleRole | null> {
	const pool = params.pool ?? (await GetPool());
	const result = await pool
		.request()
		.input('userOid', params.userOid)
		.input('scheduleId', params.scheduleId)
		.query(
			`DECLARE @isBootstrap bit = 0;

			 IF OBJECT_ID('dbo.BootstrapManagers', 'U') IS NOT NULL
			 BEGIN
			 	IF EXISTS (
			 		SELECT 1
			 		FROM dbo.BootstrapManagers
			 		WHERE UserOid = @userOid
			 		  AND IsActive = 1
			 		  AND DeletedAt IS NULL
			 	)
			 	BEGIN
			 		SET @isBootstrap = 1;
			 	END
			 END

			 ;WITH ExplicitRole AS (
			 	SELECT TOP (1) r.RoleName
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
			 	  END DESC,
			 	  su.GrantedAt DESC
			 ),
			 EffectiveRole AS (
			 	SELECT CAST('Manager' AS nvarchar(20)) AS RoleName
			 	WHERE @isBootstrap = 1
			 	UNION ALL
			 	SELECT RoleName FROM ExplicitRole
			 )
			 SELECT TOP (1) er.RoleName
			 FROM dbo.Schedules s
			 CROSS APPLY (
			 	SELECT TOP (1) RoleName
			 	FROM EffectiveRole
			 	ORDER BY
			 	  CASE RoleName
			 		WHEN 'Manager' THEN 3
			 		WHEN 'Maintainer' THEN 2
			 		WHEN 'Member' THEN 1
			 		ELSE 0
			 	  END DESC
			 ) er
			 WHERE s.ScheduleId = @scheduleId
			   AND s.DeletedAt IS NULL
			   AND (s.IsActive = 1 OR er.RoleName = 'Manager');`
		);

	const role = result.recordset?.[0]?.RoleName as ScheduleRole | undefined;
	if (role !== 'Manager' && role !== 'Maintainer' && role !== 'Member') {
		return null;
	}
	return role;
}

export async function requireScheduleRole(params: {
	userOid: string;
	scheduleId: number;
	minRole: ScheduleRole;
	pool?: ConnectionPool;
	errorMessage?: string;
}): Promise<{ pool: ConnectionPool; role: ScheduleRole }> {
	const pool = params.pool ?? (await GetPool());
	const role = await getEffectiveScheduleRole({
		userOid: params.userOid,
		scheduleId: params.scheduleId,
		pool
	});
	if (!role || !hasRequiredRole(role, params.minRole)) {
		throw error(403, params.errorMessage ?? 'Insufficient permissions');
	}
	return { pool, role };
}

export async function userCanAccessSchedule(params: {
	userOid: string;
	scheduleId: number;
	pool?: ConnectionPool;
}): Promise<boolean> {
	const role = await getEffectiveScheduleRole(params);
	return role !== null;
}

export async function hasGlobalManagerAccess(
	userOid: string,
	poolArg?: ConnectionPool
): Promise<boolean> {
	const pool = poolArg ?? (await GetPool());
	const bootstrap = await isBootstrapManager(userOid, pool);
	if (bootstrap) return true;

	const result = await pool.request().input('userOid', userOid).query(
		`SELECT TOP (1) 1 AS HasManagerAccess
		 FROM dbo.ScheduleUsers su
		 INNER JOIN dbo.Roles r
		   ON r.RoleId = su.RoleId
		 INNER JOIN dbo.Schedules s
		   ON s.ScheduleId = su.ScheduleId
		 WHERE su.UserOid = @userOid
		   AND su.IsActive = 1
		   AND su.DeletedAt IS NULL
		   AND r.RoleName = 'Manager'
		   AND s.DeletedAt IS NULL;`
	);

	return Boolean(result.recordset?.[0]?.HasManagerAccess);
}

export type EffectiveScheduleMembership = {
	ScheduleId: number;
	Name: string;
	RoleName: ScheduleRole;
	IsDefault: boolean;
	IsActive: boolean;
	ThemeJson: string | null;
	VersionAt: string | Date;
};

export async function listEffectiveScheduleMemberships(params: {
	userOid: string;
	defaultScheduleId: number | null;
	pool?: ConnectionPool;
}): Promise<EffectiveScheduleMembership[]> {
	const pool = params.pool ?? (await GetPool());
	const bootstrap = await isBootstrapManager(params.userOid, pool);

	if (bootstrap) {
		const result = await pool
			.request()
			.input('defaultScheduleId', params.defaultScheduleId)
			.query(
				`SELECT
					s.ScheduleId,
					s.Name,
					CAST('Manager' AS nvarchar(20)) AS RoleName,
					CAST(CASE WHEN s.ScheduleId = @defaultScheduleId THEN 1 ELSE 0 END AS bit) AS IsDefault,
					s.IsActive,
					s.ThemeJson,
					COALESCE(s.UpdatedAt, s.CreatedAt) AS VersionAt
				 FROM dbo.Schedules s
				 WHERE s.DeletedAt IS NULL
				 ORDER BY IsDefault DESC, s.Name;`
			);
		return (result.recordset ?? []) as EffectiveScheduleMembership[];
	}

	const result = await pool
		.request()
		.input('userOid', params.userOid)
		.input('defaultScheduleId', params.defaultScheduleId)
		.query(
			`WITH RankedMemberships AS (
				SELECT
					su.ScheduleId,
					s.Name,
					r.RoleName,
					s.IsActive,
					s.ThemeJson,
					COALESCE(s.UpdatedAt, s.CreatedAt) AS VersionAt,
					CAST(CASE WHEN su.ScheduleId = @defaultScheduleId THEN 1 ELSE 0 END AS bit) AS IsDefault,
					ROW_NUMBER() OVER (
						PARTITION BY su.ScheduleId
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
				INNER JOIN dbo.Schedules s
					ON s.ScheduleId = su.ScheduleId
				INNER JOIN dbo.Roles r
					ON r.RoleId = su.RoleId
				WHERE su.UserOid = @userOid
				  AND su.DeletedAt IS NULL
				  AND su.IsActive = 1
				  AND s.DeletedAt IS NULL
				  AND (s.IsActive = 1 OR r.RoleName = 'Manager')
			)
			SELECT ScheduleId, Name, RoleName, IsDefault, IsActive, ThemeJson, VersionAt
			FROM RankedMemberships
			WHERE RoleRank = 1
			ORDER BY IsDefault DESC, Name;`
		);

	return (result.recordset ?? []) as EffectiveScheduleMembership[];
}
