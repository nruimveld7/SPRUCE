import type { PageServerLoad } from './$types';
import { GetPool } from '$lib/server/db';
import { getActiveScheduleId, setActiveScheduleForSession } from '$lib/server/auth';
import {
	getRoleTier,
	loadOnboardingSlidesByTierRange,
	toRoleTier,
	type OnboardingSlide,
	type ScheduleRole
} from '$lib/server/onboarding';
import {
	parseCollapsedGroupsBySchedule,
	parseThemePreference,
	type ThemePreference
} from '$lib/server/schedule-ui-state';
import { listEffectiveScheduleMemberships } from '$lib/server/schedule-access';

type ScheduleMembership = {
	ScheduleId: number;
	Name: string;
	RoleName: ScheduleRole;
	IsDefault: boolean;
	IsActive: boolean;
	ThemeJson: string | null;
	VersionAt: string | Date;
};

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const user = locals.user;
	if (!user) {
		return {
			schedule: null,
			userRole: null,
			scheduleMemberships: [] as ScheduleMembership[],
			currentUserOid: null,
			collapsedGroupsBySchedule: {},
			themePreference: 'system' as ThemePreference,
			onboarding: {
				currentTier: 0,
				targetTier: 0,
				slides: [] as OnboardingSlide[]
			}
		};
	}

	let scheduleId = await getActiveScheduleId(cookies);
	const pool = await GetPool();
	const userSettingsResult = await pool
		.request()
		.input('userOid', user.id)
		.query(
			`SELECT TOP (1) DefaultScheduleId, ScheduleUiStateJson, OnboardingRole
			 FROM dbo.Users
			 WHERE UserOid = @userOid
			   AND DeletedAt IS NULL;`
		);
	const defaultScheduleId =
		(userSettingsResult.recordset?.[0]?.DefaultScheduleId as number | null) ?? null;
	const onboardingRole = toRoleTier(userSettingsResult.recordset?.[0]?.OnboardingRole);
	const collapsedGroupsBySchedule = parseCollapsedGroupsBySchedule(
		(userSettingsResult.recordset?.[0]?.ScheduleUiStateJson as string | null) ?? null
	);
	const themePreference = parseThemePreference(
		(userSettingsResult.recordset?.[0]?.ScheduleUiStateJson as string | null) ?? null
	);

	const scheduleMemberships = (await listEffectiveScheduleMemberships({
		userOid: user.id,
		defaultScheduleId,
		pool
	})) as ScheduleMembership[];

	if (
		scheduleId &&
		!scheduleMemberships.some((membership) => membership.ScheduleId === scheduleId)
	) {
		scheduleId = null;
	}

	if (!scheduleId) {
		scheduleId = scheduleMemberships[0]?.ScheduleId ?? null;
		if (scheduleId) {
			await setActiveScheduleForSession(cookies, scheduleId);
		}
	}

	if (!scheduleId) {
		const highestRoleTier = Math.max(
			0,
			...scheduleMemberships.map((membership) => getRoleTier(membership.RoleName))
		);
		const onboardingSlides = await loadOnboardingSlidesByTierRange({
			minExclusiveTier: onboardingRole,
			maxInclusiveTier: highestRoleTier
		});
		return {
			schedule: null,
			userRole: null,
			scheduleMemberships,
			currentUserOid: user.id,
			collapsedGroupsBySchedule,
			themePreference,
			onboarding: {
				currentTier: onboardingRole,
				targetTier: highestRoleTier,
				slides: onboardingSlides
			}
		};
	}
	const activeMembership = scheduleMemberships.find(
		(membership) => membership.ScheduleId === scheduleId
	);
	const highestRoleTier = Math.max(
		0,
		...scheduleMemberships.map((membership) => getRoleTier(membership.RoleName))
	);
	const onboardingSlides = await loadOnboardingSlidesByTierRange({
		minExclusiveTier: onboardingRole,
		maxInclusiveTier: highestRoleTier
	});

	return {
		schedule: activeMembership
			? { ScheduleId: activeMembership.ScheduleId, Name: activeMembership.Name }
			: null,
		userRole: activeMembership?.RoleName ?? null,
		scheduleMemberships,
		currentUserOid: user.id,
		collapsedGroupsBySchedule,
		themePreference,
		onboarding: {
			currentTier: onboardingRole,
			targetTier: highestRoleTier,
			slides: onboardingSlides as OnboardingSlide[]
		}
	};
};
