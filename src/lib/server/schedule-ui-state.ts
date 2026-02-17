export type CollapsedGroupsBySchedule = Record<number, Record<string, boolean>>;
export type ThemePreference = 'system' | 'dark' | 'light';

type PersistedScheduleState = {
	collapsedGroups?: Record<string, boolean>;
};

type PersistedUiState = {
	themePreference?: ThemePreference;
	schedules?: Record<string, PersistedScheduleState>;
};

type ParsedUiState = {
	collapsedGroupsBySchedule: CollapsedGroupsBySchedule;
	themePreference: ThemePreference;
};

const MAX_GROUP_KEY_LENGTH = 200;
const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

function parseScheduleIdKey(value: string): number | null {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return null;
	}
	return parsed;
}

function normalizeGroupKey(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_GROUP_KEY_LENGTH);
}

function normalizeThemePreference(value: unknown): ThemePreference {
	if (value === 'dark' || value === 'light' || value === 'system') {
		return value;
	}
	return DEFAULT_THEME_PREFERENCE;
}

function parsePersistedUiState(raw: string | null | undefined): ParsedUiState {
	const emptyState: ParsedUiState = {
		collapsedGroupsBySchedule: {},
		themePreference: DEFAULT_THEME_PREFERENCE
	};
	if (!raw || !raw.trim()) return emptyState;

	try {
		const parsed = JSON.parse(raw) as PersistedUiState;
		if (!parsed || typeof parsed !== 'object') return emptyState;
		if (!parsed.schedules || typeof parsed.schedules !== 'object') {
			return {
				collapsedGroupsBySchedule: {},
				themePreference: normalizeThemePreference(parsed.themePreference)
			};
		}

		const output: CollapsedGroupsBySchedule = {};
		for (const [scheduleKey, scheduleState] of Object.entries(parsed.schedules)) {
			const scheduleId = parseScheduleIdKey(scheduleKey);
			if (!scheduleId || !scheduleState || typeof scheduleState !== 'object') continue;
			const collapsedGroups = scheduleState.collapsedGroups;
			if (!collapsedGroups || typeof collapsedGroups !== 'object') continue;

			const normalizedCollapsed: Record<string, boolean> = {};
			for (const [groupKey, collapsedValue] of Object.entries(collapsedGroups)) {
				const normalizedGroup = normalizeGroupKey(groupKey);
				if (!normalizedGroup || typeof collapsedValue !== 'boolean') continue;
				normalizedCollapsed[normalizedGroup] = collapsedValue;
			}
			output[scheduleId] = normalizedCollapsed;
		}
		return {
			collapsedGroupsBySchedule: output,
			themePreference: normalizeThemePreference(parsed.themePreference)
		};
	} catch {
		return emptyState;
	}
}

function buildPersistedUiStateJson(state: ParsedUiState): string {
	const schedules: Record<string, PersistedScheduleState> = {};
	for (const [scheduleKey, groups] of Object.entries(state.collapsedGroupsBySchedule)) {
		schedules[scheduleKey] = { collapsedGroups: groups };
	}

	return JSON.stringify({
		themePreference: state.themePreference,
		schedules
	});
}

export function parseCollapsedGroupsBySchedule(raw: string | null | undefined): CollapsedGroupsBySchedule {
	return parsePersistedUiState(raw).collapsedGroupsBySchedule;
}

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
	return parsePersistedUiState(raw).themePreference;
}

export function setThemePreference(params: {
	currentJson: string | null | undefined;
	themePreference: ThemePreference;
}): string {
	const { currentJson, themePreference } = params;
	const parsed = parsePersistedUiState(currentJson);
	return buildPersistedUiStateJson({
		...parsed,
		themePreference: normalizeThemePreference(themePreference)
	});
}

export function setCollapsedGroupPreference(params: {
	currentJson: string | null | undefined;
	scheduleId: number;
	groupKey: string;
	collapsed: boolean;
}): string {
	const { currentJson, scheduleId, groupKey, collapsed } = params;
	const normalizedGroup = normalizeGroupKey(groupKey);
	if (!normalizedGroup) {
		return buildPersistedUiStateJson(parsePersistedUiState(currentJson));
	}

	const parsed = parsePersistedUiState(currentJson);
	const collapsedBySchedule = { ...parsed.collapsedGroupsBySchedule };
	const existingForSchedule = collapsedBySchedule[scheduleId] ?? {};
	collapsedBySchedule[scheduleId] = {
		...existingForSchedule,
		[normalizedGroup]: collapsed
	};

	return buildPersistedUiStateJson({
		...parsed,
		collapsedGroupsBySchedule: collapsedBySchedule
	});
}
