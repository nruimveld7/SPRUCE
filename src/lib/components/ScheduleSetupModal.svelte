<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onDestroy, onMount, tick } from 'svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import ColorPicker from '$lib/components/ColorPicker.svelte';
	import { fetchWithAuthRedirect as fetchWithAuthRedirectUtil } from '$lib/utils/fetchWithAuthRedirect';

	type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
	type ScheduleMembership = {
		ScheduleId: number;
		Name: string;
		RoleName: ScheduleRole;
		IsDefault: boolean;
		IsActive: boolean;
		ThemeJson?: string | null;
	};
	type ThemeMode = 'dark' | 'light';
	type ThemeSection = 'page' | 'schedule';
	type ThemeFieldKey =
		| 'background'
		| 'text'
		| 'accent'
		| 'todayColor'
		| 'weekendColor'
		| 'weekdayColor'
		| 'pageBorderColor'
		| 'scheduleBorderColor'
		| 'primaryGradient1'
		| 'primaryGradient2'
		| 'secondaryGradient1'
		| 'secondaryGradient2';
	type ThemeDraft = Record<ThemeFieldKey, string>;
	type ThemeFieldOption = { key: ThemeFieldKey; label: string; section: ThemeSection };
	type StatusTone = 'success' | 'error' | 'info';
	type ManagerCustomizationState = {
		scheduleName: string;
		isActive: boolean;
		themes: Record<ThemeMode, ThemeDraft>;
	};
	type ScheduleStateMutationResponse = {
		ok?: boolean;
		scheduleId?: number;
		isActive?: boolean;
		mode?: 'schedule_state_updated' | 'manager_removed' | 'schedule_deleted';
	};
	type ScheduleStateConflictResponse = {
		code?: string;
		action?: 'REMOVE_SELF' | 'DELETE_SCHEDULE';
		managerCount?: number;
		message?: string;
	};

	export let open = false;
	export let activeScheduleId: number | null = null;
	export let scheduleMemberships: ScheduleMembership[] = [];
	export let currentThemeMode: ThemeMode = 'dark';
	export let onThemeModeChange: (nextMode: ThemeMode) => void | Promise<void> = () => {};
	export let onClose: () => void = () => {};
	let liveMemberships: ScheduleMembership[] = [];
	let membershipsLoading = false;
	let membershipsError = '';
	let hasLiveMemberships = false;
	let wasOpen = false;
	let syncSelectionToCurrentOnRefresh = false;
	let selectedScheduleId: number | null = null;
	let currentScheduleId: number | null = null;
	let selectedMembership: ScheduleMembership | null = null;
	let isSavingDefault = false;
	let isSwitchingSchedule = false;
	let isSavingManagerDraft = false;
	let isCreatingSchedule = false;
	let isTogglingScheduleState = false;
	let showCreateScheduleForm = false;
	let newScheduleName = '';
	let actionError = '';
	let effectiveMemberships: ScheduleMembership[] = [];
	let resolvedCurrentScheduleId: number | null = null;
	let isSelectedMembershipActive = false;
	let canCreateSchedules = false;
	let managerSavedByScheduleId: Record<number, ManagerCustomizationState> = {};
	let managerDraftByScheduleId: Record<number, ManagerCustomizationState> = {};
	let selectedManagerSaved: ManagerCustomizationState | null = null;
	let selectedManagerDraft: ManagerCustomizationState | null = null;
	let hasManagerThemeChanges = false;
	let areAllThemeFieldsAtDefaults = true;
	let hasManagerDraftChanges = false;
	let managerDraftStatusMessage = '';
	let managerDraftStatusTone: StatusTone = 'info';
	let managerThemesExpanded = false;
	let lastManagerSelectionId: number | null = null;
	let selectedThemeMode: ThemeMode = 'dark';
	let selectedThemeSection: ThemeSection = 'page';
	let modalScrollEl: HTMLDivElement | null = null;
	let railEl: HTMLDivElement | null = null;
	let showCustomScrollbar = false;
	let thumbHeightPx = 0;
	let thumbTopPx = 0;
	let isDraggingScrollbar = false;
	let dragStartY = 0;
	let dragStartThumbTopPx = 0;
	let modalScrollSyncKey = '';

	const themeFieldOptions: ThemeFieldOption[] = [
		{ key: 'background', label: 'Background', section: 'page' },
		{ key: 'text', label: 'Text', section: 'page' },
		{ key: 'accent', label: 'Accent', section: 'page' },
		{ key: 'pageBorderColor', label: 'Border Color', section: 'page' },
		{ key: 'primaryGradient1', label: 'Primary Gradient 1', section: 'page' },
		{ key: 'primaryGradient2', label: 'Primary Gradient 2', section: 'page' },
		{ key: 'secondaryGradient1', label: 'Secondary Gradient 1', section: 'page' },
		{ key: 'secondaryGradient2', label: 'Secondary Gradient 2', section: 'page' },
		{ key: 'todayColor', label: 'Today Color', section: 'schedule' },
		{ key: 'weekendColor', label: 'Weekend Color', section: 'schedule' },
		{ key: 'weekdayColor', label: 'Weekday Color', section: 'schedule' },
		{ key: 'scheduleBorderColor', label: 'Border Color', section: 'schedule' }
	];
	$: activeThemeFieldOptions = themeFieldOptions.filter(
		(themeField) => themeField.section === selectedThemeSection
	);

	const themeDefaults: Record<ThemeMode, ThemeDraft> = {
		dark: {
			background: '#07080b',
			text: '#ffffff',
			accent: '#c8102e',
			todayColor: '#c8102e',
			weekendColor: '#000000',
			weekdayColor: '#161a22',
			pageBorderColor: '#292a30',
			scheduleBorderColor: '#292a30',
			primaryGradient1: '#7a1b2c',
			primaryGradient2: '#2d1118',
			secondaryGradient1: '#361219',
			secondaryGradient2: '#0c0e12'
		},
		light: {
			background: '#f2f3f5',
			text: '#000000',
			accent: '#c8102e',
			todayColor: '#c8102e',
			weekendColor: '#d4d7de',
			weekdayColor: '#f5f6f8',
			pageBorderColor: '#bbbec6',
			scheduleBorderColor: '#bbbec6',
			primaryGradient1: '#f4d7dd',
			primaryGradient2: '#f8f9fb',
			secondaryGradient1: '#faeef0',
			secondaryGradient2: '#f5f6f8'
		}
	};

	const themeOverrideSuffixes = [
		'bg-0',
		'bg-1',
		'bg-2',
		'surface-0',
		'surface-1',
		'surface-2',
		'text',
		'muted',
		'faint',
		'grid-1',
		'grid-2',
		'accent',
		'accent-1',
		'accent-2',
		'accent-3',
		'today',
		'today-header-bg',
		'focus-ring',
		'interactive-bg',
		'interactive-bg-hover',
		'interactive-border',
		'interactive-border-hover',
		'team-cell-hover',
		'team-cell-active',
		'modal-backdrop',
		'modal-border',
		'panel-bg',
		'table-header-bg',
		'input-bg',
		'scrollbar-track-bg',
		'scrollbar-thumb-bg',
		'scrollbar-thumb-bg-hover',
		'border-color',
		'border-accent-soft',
		'border-accent-medium',
		'border-accent-strong',
		'border-accent-focus',
		'table-weekday-bg',
		'table-weekend-bg',
		'table-border-color',
		'table-header-gradient-start',
		'table-header-gradient-end',
		'table-team-cell-bg',
		'gradient-header-start',
		'gradient-header-end',
		'gradient-modal-start',
		'gradient-modal-end',
		'gradient-popover-start',
		'gradient-popover-end',
		'gradient-primary-start',
		'gradient-primary-end'
	] as const;

	const themeOverrideVarKeys = (['dark', 'light'] as const).flatMap((mode) =>
		themeOverrideSuffixes.map((suffix) => `--theme-${mode}-${suffix}`)
	);

	const themeFallback: ThemeDraft = {
		background: '#07080b',
		text: '#ffffff',
		accent: '#c8102e',
		todayColor: '#c8102e',
		weekendColor: '#000000',
		weekdayColor: '#161a22',
		pageBorderColor: '#292a30',
		scheduleBorderColor: '#292a30',
		primaryGradient1: '#7a1b2c',
		primaryGradient2: '#2d1118',
		secondaryGradient1: '#361219',
		secondaryGradient2: '#0c0e12'
	};

	function normalizeScheduleId(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Number(value);
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	function normalizeHexColor(value: string, fallback: string): string {
		const trimmed = value.trim().toLowerCase();
		const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
		if (hexMatch) {
			const hexValue = hexMatch[1];
			if (hexValue.length === 3) {
				return `#${hexValue
					.split('')
					.map((part) => `${part}${part}`)
					.join('')}`;
			}
			return `#${hexValue}`;
		}

		const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
		if (rgbMatch) {
			const channels = rgbMatch[1]
				.split(',')
				.slice(0, 3)
				.map((segment) => Number(segment.trim()))
				.filter((segment) => Number.isFinite(segment));
			if (channels.length === 3) {
				return `#${channels
					.map((channel) => {
						const clamped = Math.max(0, Math.min(255, Math.round(channel)));
						return clamped.toString(16).padStart(2, '0');
					})
					.join('')}`;
			}
		}

		return fallback;
	}

	function hexToRgb(color: string): { r: number; g: number; b: number } {
		const normalized = normalizeHexColor(color, '#000000').slice(1);
		return {
			r: Number.parseInt(normalized.slice(0, 2), 16),
			g: Number.parseInt(normalized.slice(2, 4), 16),
			b: Number.parseInt(normalized.slice(4, 6), 16)
		};
	}

	function rgbToHex(r: number, g: number, b: number): string {
		return `#${[r, g, b]
			.map((value) =>
				Math.max(0, Math.min(255, Math.round(value)))
					.toString(16)
					.padStart(2, '0')
			)
			.join('')}`;
	}

	function mixColors(base: string, mixWith: string, weight: number): string {
		const left = hexToRgb(base);
		const right = hexToRgb(mixWith);
		const safeWeight = Math.max(0, Math.min(1, weight));
		return rgbToHex(
			left.r * (1 - safeWeight) + right.r * safeWeight,
			left.g * (1 - safeWeight) + right.g * safeWeight,
			left.b * (1 - safeWeight) + right.b * safeWeight
		);
	}

	function rgba(color: string, alpha: number): string {
		const { r, g, b } = hexToRgb(color);
		const safeAlpha = Math.max(0, Math.min(1, alpha));
		return `rgba(${r}, ${g}, ${b}, ${safeAlpha.toFixed(2)})`;
	}

	function cloneManagerState(state: ManagerCustomizationState): ManagerCustomizationState {
		return {
			scheduleName: state.scheduleName,
			isActive: state.isActive,
			themes: {
				dark: { ...state.themes.dark },
				light: { ...state.themes.light }
			}
		};
	}

	function areThemeDraftsEqual(a: ThemeDraft, b: ThemeDraft): boolean {
		return themeFieldOptions.every((field) => a[field.key] === b[field.key]);
	}

	function buildModeOverrides(mode: ThemeMode, theme: ThemeDraft): Record<string, string> {
		const defaults = themeDefaults[mode];
		const background = normalizeHexColor(theme.background, defaults.background);
		const text = normalizeHexColor(theme.text, defaults.text);
		const accent = normalizeHexColor(theme.accent, defaults.accent);
		const todayColor = normalizeHexColor(theme.todayColor, defaults.todayColor);
		const weekendColor = normalizeHexColor(theme.weekendColor, defaults.weekendColor);
		const weekdayColor = normalizeHexColor(theme.weekdayColor, defaults.weekdayColor);
		const pageBorderColor = normalizeHexColor(theme.pageBorderColor, defaults.pageBorderColor);
		const scheduleBorderColor = normalizeHexColor(
			theme.scheduleBorderColor,
			defaults.scheduleBorderColor
		);
		const headerGradientFrom = normalizeHexColor(theme.primaryGradient1, defaults.primaryGradient1);
		const headerGradientTo = normalizeHexColor(theme.primaryGradient2, defaults.primaryGradient2);
		const modalGradientFrom = normalizeHexColor(
			theme.secondaryGradient1,
			defaults.secondaryGradient1
		);
		const modalGradientTo = normalizeHexColor(
			theme.secondaryGradient2,
			defaults.secondaryGradient2
		);
		const popoverGradientFrom = modalGradientFrom;
		const popoverGradientTo = modalGradientTo;
		const primaryGradientFrom = headerGradientFrom;
		const primaryGradientTo = headerGradientTo;
		const surface = mixColors(background, '#ffffff', mode === 'dark' ? 0.14 : 0.08);
		const border = pageBorderColor;
		const isDark = mode === 'dark';
		const headerGradientBottom = mixColors(weekdayColor, '#000000', isDark ? 0.24 : 0.12);
		const teamCellColor = mixColors(weekdayColor, '#000000', isDark ? 0.32 : 0.16);

		const bgWeight1 = isDark ? 0.08 : 0.06;
		const bgWeight2 = isDark ? 0.15 : 0.12;
		const surfaceAlpha0 = isDark ? 0.78 : 0.78;
		const surfaceAlpha1 = isDark ? 0.82 : 0.84;
		const surfaceAlpha2 = isDark ? 0.88 : 0.9;
		const textAlpha = isDark ? 0.92 : 0.86;
		const mutedAlpha = isDark ? 0.72 : 0.6;
		const faintAlpha = isDark ? 0.56 : 0.45;
		const todayAlpha = isDark ? 0.24 : 0.2;
		const interactiveHoverAlpha = isDark ? 0.5 : 0.45;
		const cellActiveAlpha = isDark ? 0.18 : 0.16;
		const panelAlpha = isDark ? 0.04 : 0.68;
		const tableHeaderAlpha = isDark ? 0.06 : 0.04;
		const inputAlpha = isDark ? 0.04 : 0.95;
		const backdropAlpha = isDark ? 0.52 : 0.22;
		const scrollTrackAlpha = isDark ? 0.04 : 0.08;
		const scrollThumbAlpha = isDark ? 0.3 : 0.34;
		const scrollThumbHoverAlpha = isDark ? 0.42 : 0.44;

		return {
			[`--theme-${mode}-bg-0`]: background,
			[`--theme-${mode}-bg-1`]: mixColors(background, '#ffffff', bgWeight1),
			[`--theme-${mode}-bg-2`]: mixColors(background, '#ffffff', bgWeight2),
			[`--theme-${mode}-surface-0`]: rgba(surface, surfaceAlpha0),
			[`--theme-${mode}-surface-1`]: rgba(surface, surfaceAlpha1),
			[`--theme-${mode}-surface-2`]: rgba(surface, surfaceAlpha2),
			[`--theme-${mode}-text`]: rgba(text, textAlpha),
			[`--theme-${mode}-muted`]: rgba(text, mutedAlpha),
			[`--theme-${mode}-faint`]: rgba(text, faintAlpha),
			[`--theme-${mode}-grid-1`]: rgba(text, isDark ? 0.11 : 0.12),
			[`--theme-${mode}-grid-2`]: rgba(text, isDark ? 0.06 : 0.08),
			[`--theme-${mode}-accent`]: accent,
			[`--theme-${mode}-accent-1`]: rgba(accent, 0.62),
			[`--theme-${mode}-accent-2`]: rgba(accent, 0.3),
			[`--theme-${mode}-accent-3`]: rgba(accent, 0.15),
			[`--theme-${mode}-today`]: rgba(todayColor, todayAlpha),
			[`--theme-${mode}-today-header-bg`]: rgba(todayColor, 0.33),
			[`--theme-${mode}-focus-ring`]: `0 0 0 3px ${rgba(accent, 0.22)}`,
			[`--theme-${mode}-interactive-bg`]: isDark ? rgba('#ffffff', 0.06) : rgba('#ffffff', 0.72),
			[`--theme-${mode}-interactive-bg-hover`]: isDark
				? rgba('#ffffff', 0.09)
				: rgba('#ffffff', 0.9),
			[`--theme-${mode}-interactive-border`]: isDark
				? rgba('#ffffff', 0.14)
				: rgba('#000000', 0.14),
			[`--theme-${mode}-interactive-border-hover`]: rgba(accent, interactiveHoverAlpha),
			[`--theme-${mode}-team-cell-hover`]: rgba(accent, 0.12),
			[`--theme-${mode}-team-cell-active`]: rgba(accent, cellActiveAlpha),
			[`--theme-${mode}-modal-backdrop`]: rgba('#000000', backdropAlpha),
			[`--theme-${mode}-modal-border`]: isDark ? rgba(border, 0.38) : rgba(border, 0.3),
			[`--theme-${mode}-panel-bg`]: rgba('#ffffff', panelAlpha),
			[`--theme-${mode}-table-header-bg`]: isDark
				? rgba('#ffffff', tableHeaderAlpha)
				: rgba('#000000', tableHeaderAlpha),
			[`--theme-${mode}-input-bg`]: rgba('#ffffff', inputAlpha),
			[`--theme-${mode}-scrollbar-track-bg`]: isDark
				? rgba('#ffffff', scrollTrackAlpha)
				: rgba('#000000', scrollTrackAlpha),
			[`--theme-${mode}-scrollbar-thumb-bg`]: rgba(accent, scrollThumbAlpha),
			[`--theme-${mode}-scrollbar-thumb-bg-hover`]: rgba(accent, scrollThumbHoverAlpha),
			[`--theme-${mode}-border-color`]: border,
			[`--theme-${mode}-border-accent-soft`]: rgba(border, 0.26),
			[`--theme-${mode}-border-accent-medium`]: rgba(border, 0.42),
			[`--theme-${mode}-border-accent-strong`]: rgba(border, 0.55),
			[`--theme-${mode}-border-accent-focus`]: rgba(border, 0.72),
			[`--theme-${mode}-table-weekday-bg`]: rgba(weekdayColor, 1),
			[`--theme-${mode}-table-weekend-bg`]: rgba(weekendColor, 1),
			[`--theme-${mode}-table-border-color`]: rgba(scheduleBorderColor, 1),
			[`--theme-${mode}-table-header-gradient-start`]: rgba(weekdayColor, 1),
			[`--theme-${mode}-table-header-gradient-end`]: rgba(headerGradientBottom, 1),
			[`--theme-${mode}-table-team-cell-bg`]: rgba(teamCellColor, 1),
			[`--theme-${mode}-gradient-header-start`]: headerGradientFrom,
			[`--theme-${mode}-gradient-header-end`]: headerGradientTo,
			[`--theme-${mode}-gradient-modal-start`]: modalGradientFrom,
			[`--theme-${mode}-gradient-modal-end`]: modalGradientTo,
			[`--theme-${mode}-gradient-popover-start`]: popoverGradientFrom,
			[`--theme-${mode}-gradient-popover-end`]: popoverGradientTo,
			[`--theme-${mode}-gradient-primary-start`]: primaryGradientFrom,
			[`--theme-${mode}-gradient-primary-end`]: primaryGradientTo
		};
	}

	function applyThemeState(state: ManagerCustomizationState) {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		const darkVars = buildModeOverrides('dark', state.themes.dark);
		const lightVars = buildModeOverrides('light', state.themes.light);
		for (const [key, value] of Object.entries({ ...darkVars, ...lightVars })) {
			root.style.setProperty(key, value);
		}
	}

	function clearThemeOverrides() {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		for (const varKey of themeOverrideVarKeys) {
			root.style.removeProperty(varKey);
		}
	}

	function applyActiveScheduleThemeOrDefault() {
		const activeId = resolvedCurrentScheduleId;
		if (activeId !== null) {
			const saved = managerSavedByScheduleId[activeId];
			if (saved) {
				applyThemeState(saved);
				return;
			}
			const activeMembership =
				effectiveMemberships.find((membership) => membership.ScheduleId === activeId) ?? null;
			if (activeMembership) {
				const parsedThemes = parseThemeJsonText(activeMembership.ThemeJson);
				if (parsedThemes) {
					applyThemeState({
						scheduleName: activeMembership.Name,
						isActive: activeMembership.IsActive,
						themes: {
							dark: { ...parsedThemes.dark },
							light: { ...parsedThemes.light }
						}
					});
					return;
				}
			}
		}
		clearThemeOverrides();
	}

	function parseThemeJsonValue(value: unknown): Record<ThemeMode, ThemeDraft> | null {
		if (!value || typeof value !== 'object') return null;
		const candidate = value as Record<string, unknown>;
		const dark = candidate.dark as Record<string, unknown> | undefined;
		const light = candidate.light as Record<string, unknown> | undefined;
		if (!dark || !light) return null;

		const parseMode = (
			modeValue: Record<string, unknown>,
			modeDefaults: ThemeDraft
		): ThemeDraft => {
			const parsed = {} as ThemeDraft;
			for (const option of themeFieldOptions) {
				const raw =
					modeValue[option.key] ??
					((option.key === 'pageBorderColor' || option.key === 'scheduleBorderColor'
						? modeValue.borderColor
						: undefined) as unknown);
				parsed[option.key] =
					typeof raw === 'string'
						? normalizeHexColor(raw, modeDefaults[option.key])
						: modeDefaults[option.key];
			}
			return parsed;
		};

		const parsedDark = parseMode(dark, themeDefaults.dark);
		const parsedLight = parseMode(light, themeDefaults.light);

		return { dark: parsedDark, light: parsedLight };
	}

	function parseThemeJsonText(
		themeJson: string | null | undefined
	): Record<ThemeMode, ThemeDraft> | null {
		if (typeof themeJson !== 'string' || !themeJson.trim()) return null;
		try {
			return parseThemeJsonValue(JSON.parse(themeJson));
		} catch {
			return null;
		}
	}

	function ensureManagerState(membership: ScheduleMembership) {
		if (membership.RoleName !== 'Manager') return;
		const scheduleId = membership.ScheduleId;
		if (managerSavedByScheduleId[scheduleId] && managerDraftByScheduleId[scheduleId]) return;
		const parsedThemes = parseThemeJsonText(membership.ThemeJson);

		const seed: ManagerCustomizationState = {
			scheduleName: membership.Name,
			isActive: membership.IsActive,
			themes: {
				dark: parsedThemes ? { ...parsedThemes.dark } : { ...themeDefaults.dark },
				light: parsedThemes ? { ...parsedThemes.light } : { ...themeDefaults.light }
			}
		};
		managerSavedByScheduleId = {
			...managerSavedByScheduleId,
			[scheduleId]: cloneManagerState(seed)
		};
		managerDraftByScheduleId = {
			...managerDraftByScheduleId,
			[scheduleId]: cloneManagerState(seed)
		};
	}

	function updateManagerDraft(scheduleId: number, nextState: ManagerCustomizationState) {
		managerDraftByScheduleId = {
			...managerDraftByScheduleId,
			[scheduleId]: cloneManagerState(nextState)
		};
	}

	function displayScheduleName(membership: ScheduleMembership): string {
		return managerSavedByScheduleId[membership.ScheduleId]?.scheduleName ?? membership.Name;
	}

	function handleManagerNameInput(event: Event) {
		if (!selectedMembership || selectedMembership.RoleName !== 'Manager' || !selectedManagerDraft)
			return;
		const input = event.currentTarget as HTMLInputElement;
		updateManagerDraft(selectedMembership.ScheduleId, {
			...selectedManagerDraft,
			scheduleName: input.value
		});
		managerDraftStatusMessage = '';
	}

	function handleManagerThemeInput(themeKey: ThemeFieldKey, rawColor: string) {
		if (!selectedMembership || selectedMembership.RoleName !== 'Manager' || !selectedManagerDraft)
			return;
		const normalized = normalizeHexColor(rawColor, themeFallback[themeKey] ?? '#000000');
		const next: ManagerCustomizationState = {
			...selectedManagerDraft,
			themes: {
				...selectedManagerDraft.themes,
				[selectedThemeMode]: {
					...selectedManagerDraft.themes[selectedThemeMode],
					[themeKey]: normalized
				}
			}
		};
		updateManagerDraft(selectedMembership.ScheduleId, next);
		applyThemeState(next);
		managerDraftStatusMessage = '';
	}

	function resolveScheduleNameForSave(draftName: string, savedName: string): string {
		const trimmed = draftName.trim();
		return trimmed || savedName;
	}

	async function postManagerCustomizationUpdate(
		scheduleId: number,
		nextState: ManagerCustomizationState
	): Promise<void> {
		const response = await fetchWithAuthRedirect(`${base}/api/schedules/customization`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				scheduleId,
				scheduleName: nextState.scheduleName,
				isActive: nextState.isActive,
				theme: nextState.themes
			})
		});
		if (!response) {
			throw new Error('Session expired or access changed. Sign in again and retry.');
		}
		if (!response.ok) {
			const message = await parseErrorMessage(
				response,
				`Failed to save customization (${response.status})`
			);
			throw new Error(message);
		}
	}

	async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
		let text = '';
		try {
			text = (await response.text()).trim();
		} catch {
			return fallback;
		}
		if (!text) return fallback;
		try {
			const data = JSON.parse(text) as { message?: string };
			if (typeof data.message === 'string' && data.message.trim()) {
				return data.message;
			}
		} catch {
			// treat as plain text
		}
		return text;
	}

	async function fetchWithAuthRedirect(
		input: RequestInfo | URL,
		init: RequestInit
	): Promise<Response | null> {
		return fetchWithAuthRedirectUtil(input, init, base);
	}

	async function toggleManagerScheduleActive() {
		if (!selectedMembership || selectedMembership.RoleName !== 'Manager' || !selectedManagerDraft)
			return;
		if (isTogglingScheduleState) return;
		isTogglingScheduleState = true;
		actionError = '';
		managerDraftStatusMessage = '';

		const scheduleId = selectedMembership.ScheduleId;
		const nextIsActive = !selectedManagerDraft.isActive;

		try {
			const sendStateChange = async (confirmDeactivation: boolean): Promise<Response | null> =>
				fetchWithAuthRedirect(`${base}/api/schedules/state`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({
						scheduleId,
						isActive: nextIsActive,
						confirmDeactivation
					})
				});

			let response = await sendStateChange(false);
			if (!response) return;

			if (!response.ok && !nextIsActive && response.status === 409) {
				let conflict: ScheduleStateConflictResponse | null = null;
				try {
					conflict = (await response.json()) as ScheduleStateConflictResponse;
				} catch {
					conflict = null;
				}

				if (conflict?.code === 'SCHEDULE_DEACTIVATION_CONFIRMATION_REQUIRED') {
					const promptMessage =
						typeof conflict.message === 'string' && conflict.message.trim()
							? conflict.message
							: conflict.action === 'DELETE_SCHEDULE'
								? 'You are the last Manager for this schedule. If you continue, the schedule and all related data will be permanently deleted. Continue?'
								: 'This user is currently assigned to active shifts. If you continue, active assignments will end effective today and future assignments will be removed. Continue?';
					if (!window.confirm(promptMessage)) {
						return;
					}
					response = await sendStateChange(true);
					if (!response) return;
				}
			}

			if (!response.ok) {
				const message = await parseErrorMessage(
					response,
					`Failed to update schedule state (${response.status})`
				);
				throw new Error(message);
			}

			const payload = (await response.json()) as ScheduleStateMutationResponse;
			if (payload.mode === 'manager_removed' || payload.mode === 'schedule_deleted') {
				syncSelectionToCurrentOnRefresh = true;
				await refreshMemberships();
				await goto(`${base}/`, { invalidateAll: true });
				return;
			}

			updateManagerDraft(scheduleId, {
				...selectedManagerDraft,
				isActive: nextIsActive
			});
			const savedState = managerSavedByScheduleId[scheduleId];
			if (savedState) {
				managerSavedByScheduleId = {
					...managerSavedByScheduleId,
					[scheduleId]: {
						...savedState,
						isActive: nextIsActive
					}
				};
			}
			await refreshMemberships();
		} catch (errorValue) {
			actionError =
				errorValue instanceof Error ? errorValue.message : 'Failed to update schedule state';
		} finally {
			isTogglingScheduleState = false;
		}
	}

	function handleManagerResetDefaults() {
		if (!selectedMembership || selectedMembership.RoleName !== 'Manager' || !selectedManagerDraft)
			return;
		const next: ManagerCustomizationState = {
			...selectedManagerDraft,
			themes: {
				dark: { ...themeDefaults.dark },
				light: { ...themeDefaults.light }
			}
		};
		updateManagerDraft(selectedMembership.ScheduleId, next);
		applyThemeState(next);
	}

	function handleManagerThemeRestoreSaved() {
		if (!selectedMembership || selectedMembership.RoleName !== 'Manager' || !selectedManagerSaved)
			return;
		const scheduleId = selectedMembership.ScheduleId;
		const draft = managerDraftByScheduleId[scheduleId];
		if (!draft) return;
		const nextDraft: ManagerCustomizationState = {
			...draft,
			themes: {
				dark: { ...selectedManagerSaved.themes.dark },
				light: { ...selectedManagerSaved.themes.light }
			}
		};
		updateManagerDraft(scheduleId, nextDraft);
		if (isSelectedMembershipActive) {
			applyThemeState(nextDraft);
		}
	}

	function toggleSelectedThemeMode() {
		const nextMode: ThemeMode = selectedThemeMode === 'dark' ? 'light' : 'dark';
		selectedThemeMode = nextMode;
		void onThemeModeChange(nextMode);
	}

	function toggleManagerThemesExpanded() {
		managerThemesExpanded = !managerThemesExpanded;
	}

	async function handleManagerSaveDraft() {
		if (
			!selectedMembership ||
			selectedMembership.RoleName !== 'Manager' ||
			!selectedManagerDraft ||
			!selectedManagerSaved
		)
			return;
		if (isSavingManagerDraft) return;
		if (!hasManagerDraftChanges) {
			managerDraftStatusTone = 'info';
			managerDraftStatusMessage = 'No changes to save.';
			return;
		}

		const scheduleId = selectedMembership.ScheduleId;
		const nextName = resolveScheduleNameForSave(
			selectedManagerDraft.scheduleName,
			selectedManagerSaved.scheduleName
		);
		const nextSaved: ManagerCustomizationState = {
			...selectedManagerSaved,
			scheduleName: nextName,
			themes: {
				dark: { ...selectedManagerDraft.themes.dark },
				light: { ...selectedManagerDraft.themes.light }
			}
		};
		isSavingManagerDraft = true;
		managerDraftStatusMessage = '';

		try {
			await postManagerCustomizationUpdate(scheduleId, nextSaved);
			managerSavedByScheduleId = {
				...managerSavedByScheduleId,
				[scheduleId]: cloneManagerState(nextSaved)
			};
			managerDraftByScheduleId = {
				...managerDraftByScheduleId,
				[scheduleId]: cloneManagerState(nextSaved)
			};
			await refreshMemberships();
			if (isSelectedMembershipActive) {
				applyThemeState(nextSaved);
			}
			managerDraftStatusTone = 'success';
			managerDraftStatusMessage = 'Changes saved.';
		} catch (errorValue) {
			managerDraftStatusTone = 'error';
			managerDraftStatusMessage =
				errorValue instanceof Error ? errorValue.message : 'Failed to save customization';
		} finally {
			isSavingManagerDraft = false;
		}
	}

	function closeModal() {
		onClose();
	}

	function handleBackdropMouseDown(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			closeModal();
		}
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') closeModal();
	}

	function scheduleRoleSuffix(role: ScheduleRole): string {
		return role === 'Manager' ? ' (Manager)' : role === 'Maintainer' ? ' (Maintainer)' : '';
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function updateCustomScrollbar() {
		if (!modalScrollEl) return;

		const scrollHeight = modalScrollEl.scrollHeight;
		const clientHeight = modalScrollEl.clientHeight;
		const scrollTop = modalScrollEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;

		showCustomScrollbar = hasOverflow;
		if (!hasOverflow) {
			thumbHeightPx = 0;
			thumbTopPx = 0;
			return;
		}

		const railHeight = railEl?.clientHeight ?? Math.max(clientHeight - 24, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		thumbHeightPx = nextThumbHeight;
		thumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onModalScroll() {
		if (!isDraggingScrollbar) {
			updateCustomScrollbar();
		}
	}

	function onDragMove(event: MouseEvent) {
		if (!isDraggingScrollbar || !modalScrollEl || !railEl) return;

		const railHeight = railEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - thumbHeightPx, 0);
		const nextThumbTop = clamp(dragStartThumbTopPx + (event.clientY - dragStartY), 0, maxThumbTop);
		const maxScrollTop = Math.max(modalScrollEl.scrollHeight - modalScrollEl.clientHeight, 0);

		thumbTopPx = nextThumbTop;
		modalScrollEl.scrollTop = maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function setGlobalScrollbarDragging(active: boolean) {
		if (typeof document === 'undefined') return;
		const body = document.body;
		const current = Number(body.dataset.scrollbarDragCount ?? '0');
		const next = Math.max(0, current + (active ? 1 : -1));
		if (next === 0) {
			delete body.dataset.scrollbarDragCount;
		} else {
			body.dataset.scrollbarDragCount = String(next);
		}
		body.classList.toggle('scrollbar-dragging', next > 0);
	}

	function stopDragging() {
		if (isDraggingScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onDragMove);
			window.removeEventListener('mouseup', stopDragging);
		}
	}

	function startThumbDrag(event: MouseEvent) {
		if (!showCustomScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingScrollbar = true;
		setGlobalScrollbarDragging(true);
		dragStartY = event.clientY;
		dragStartThumbTopPx = thumbTopPx;
		window.addEventListener('mousemove', onDragMove);
		window.addEventListener('mouseup', stopDragging);
	}

	function handleRailClick(event: MouseEvent) {
		if (!modalScrollEl || !railEl || !showCustomScrollbar) return;
		if (event.target !== railEl) return;

		const rect = railEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - thumbHeightPx / 2,
			0,
			Math.max(rect.height - thumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - thumbHeightPx, 1);
		const maxScrollTop = Math.max(modalScrollEl.scrollHeight - modalScrollEl.clientHeight, 0);
		modalScrollEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateCustomScrollbar();
	}

	function handleSelectSchedule(scheduleId: number) {
		selectedScheduleId = scheduleId;
		showCreateScheduleForm = false;
		actionError = '';
	}

	function openCreateScheduleForm() {
		if (isCreatingSchedule) return;
		selectedScheduleId = null;
		showCreateScheduleForm = true;
		newScheduleName = '';
		actionError = '';
		managerDraftStatusMessage = '';
		if (typeof document !== 'undefined') {
			const activeEl = document.activeElement;
			if (activeEl instanceof HTMLElement) {
				activeEl.blur();
			}
		}
	}

	async function handleCreateSchedule() {
		if (isCreatingSchedule) return;
		const scheduleName = newScheduleName.trim();
		if (!scheduleName) return;

		isCreatingSchedule = true;
		actionError = '';

		try {
			const response = await fetchWithAuthRedirect(`${base}/api/schedules`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ scheduleName })
			});
			if (!response) return;
			if (!response.ok) {
				const message = await parseErrorMessage(
					response,
					`Failed to create schedule (${response.status})`
				);
				throw new Error(message);
			}

			const data = (await response.json()) as { scheduleId?: number | null };
			await refreshMemberships();
			const newScheduleId = normalizeScheduleId(data.scheduleId);
			if (newScheduleId !== null) {
				currentScheduleId = newScheduleId;
				selectedScheduleId = newScheduleId;
				showCreateScheduleForm = false;
				newScheduleName = '';
			}
			await goto(`${base}/`, { invalidateAll: true });
		} catch (errorValue) {
			actionError = errorValue instanceof Error ? errorValue.message : 'Failed to create schedule';
		} finally {
			isCreatingSchedule = false;
		}
	}

	async function refreshMemberships() {
		membershipsLoading = true;
		membershipsError = '';

		try {
			const response = await fetchWithAuthRedirect(`${base}/api/schedules/memberships`, {
				headers: { accept: 'application/json' }
			});
			if (!response) {
				throw new Error('Session expired or access changed. Sign in again and retry.');
			}

			if (!response.ok) {
				const message = await parseErrorMessage(
					response,
					`Failed to refresh schedule list (${response.status})`
				);
				throw new Error(message);
			}

			const data = (await response.json()) as {
				activeScheduleId?: number | null;
				memberships?: ScheduleMembership[];
			};
			liveMemberships = Array.isArray(data.memberships)
				? data.memberships.map((membership) => ({
						...membership,
						ScheduleId: Number(membership.ScheduleId),
						IsActive: Boolean(membership.IsActive),
						ThemeJson: typeof membership.ThemeJson === 'string' ? membership.ThemeJson : null
					}))
				: [];
			currentScheduleId = normalizeScheduleId(data.activeScheduleId) ?? currentScheduleId;
			if (syncSelectionToCurrentOnRefresh) {
				selectedScheduleId =
					currentScheduleId ??
					(liveMemberships.length > 0 ? liveMemberships[0].ScheduleId : selectedScheduleId);
				syncSelectionToCurrentOnRefresh = false;
			}
			hasLiveMemberships = true;
		} catch (errorValue) {
			membershipsError =
				errorValue instanceof Error ? errorValue.message : 'Failed to refresh schedule list';
		} finally {
			membershipsLoading = false;
		}
	}

	async function handleMakeDefault() {
		if (!selectedMembership || selectedMembership.IsDefault || isSavingDefault) return;
		isSavingDefault = true;
		actionError = '';

		try {
			const response = await fetchWithAuthRedirect(`${base}/api/schedules/default`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ scheduleId: selectedMembership.ScheduleId })
			});
			if (!response) return;
			if (!response.ok) {
				const message = await parseErrorMessage(
					response,
					`Failed to save default schedule (${response.status})`
				);
				throw new Error(message);
			}
			await refreshMemberships();
		} catch (errorValue) {
			actionError =
				errorValue instanceof Error ? errorValue.message : 'Failed to save default schedule';
		} finally {
			isSavingDefault = false;
		}
	}

	async function handleViewSchedule() {
		if (
			!selectedMembership ||
			selectedMembership.ScheduleId === resolvedCurrentScheduleId ||
			isSwitchingSchedule
		)
			return;
		isSwitchingSchedule = true;
		actionError = '';

		try {
			const response = await fetchWithAuthRedirect(`${base}/api/schedules/active`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ scheduleId: selectedMembership.ScheduleId })
			});
			if (!response) return;
			if (!response.ok) {
				const message = await parseErrorMessage(
					response,
					`Failed to switch schedule (${response.status})`
				);
				throw new Error(message);
			}
			currentScheduleId = selectedMembership.ScheduleId;
			await goto(`${base}/`, { invalidateAll: true });
		} catch (errorValue) {
			actionError = errorValue instanceof Error ? errorValue.message : 'Failed to switch schedule';
		} finally {
			isSwitchingSchedule = false;
		}
	}

	$: if (typeof document !== 'undefined') {
		document.body.classList.toggle('team-modal-open', open);
	}

	$: effectiveMemberships = hasLiveMemberships
		? liveMemberships
		: open && membershipsLoading
			? []
			: scheduleMemberships;

	$: resolvedCurrentScheduleId =
		currentScheduleId ??
		normalizeScheduleId(activeScheduleId) ??
		(effectiveMemberships.length === 1 ? effectiveMemberships[0].ScheduleId : null);

	$: selectedMembership =
		(selectedScheduleId === null
			? null
			: effectiveMemberships.find((membership) => membership.ScheduleId === selectedScheduleId)) ??
		null;

	$: isSelectedMembershipActive =
		selectedMembership !== null && selectedMembership.ScheduleId === resolvedCurrentScheduleId;

	$: canCreateSchedules = effectiveMemberships.some(
		(membership) => membership.RoleName === 'Manager'
	);

	$: if (selectedMembership && selectedMembership.RoleName === 'Manager') {
		ensureManagerState(selectedMembership);
	}

	$: selectedManagerSaved =
		selectedMembership && selectedMembership.RoleName === 'Manager'
			? (managerSavedByScheduleId[selectedMembership.ScheduleId] ?? null)
			: null;

	$: selectedManagerDraft =
		selectedMembership && selectedMembership.RoleName === 'Manager'
			? (managerDraftByScheduleId[selectedMembership.ScheduleId] ?? null)
			: null;

	$: if (
		selectedMembership &&
		selectedMembership.RoleName === 'Manager' &&
		!isTogglingScheduleState
	) {
		const scheduleId = selectedMembership.ScheduleId;
		const nextIsActive = selectedMembership.IsActive;
		const savedState = managerSavedByScheduleId[scheduleId];
		if (savedState && savedState.isActive !== nextIsActive) {
			managerSavedByScheduleId = {
				...managerSavedByScheduleId,
				[scheduleId]: {
					...savedState,
					isActive: nextIsActive
				}
			};
		}
		const draftState = managerDraftByScheduleId[scheduleId];
		if (draftState && draftState.isActive !== nextIsActive) {
			managerDraftByScheduleId = {
				...managerDraftByScheduleId,
				[scheduleId]: {
					...draftState,
					isActive: nextIsActive
				}
			};
		}
	}

	$: hasManagerThemeChanges =
		selectedManagerSaved && selectedManagerDraft
			? !areThemeDraftsEqual(selectedManagerSaved.themes.dark, selectedManagerDraft.themes.dark) ||
				!areThemeDraftsEqual(selectedManagerSaved.themes.light, selectedManagerDraft.themes.light)
			: false;

	$: areAllThemeFieldsAtDefaults =
		selectedManagerDraft !== null
			? areThemeDraftsEqual(selectedManagerDraft.themes.dark, themeDefaults.dark) &&
				areThemeDraftsEqual(selectedManagerDraft.themes.light, themeDefaults.light)
			: true;

	$: hasManagerDraftChanges =
		selectedManagerSaved && selectedManagerDraft
			? resolveScheduleNameForSave(
					selectedManagerDraft.scheduleName,
					selectedManagerSaved.scheduleName
				) !== selectedManagerSaved.scheduleName || hasManagerThemeChanges
			: false;

	$: {
		const currentManagerSelectionId =
			selectedMembership && selectedMembership.RoleName === 'Manager'
				? selectedMembership.ScheduleId
				: null;
		if (
			currentManagerSelectionId !== null &&
			currentManagerSelectionId !== lastManagerSelectionId
		) {
			managerDraftStatusMessage = '';
			selectedThemeMode = currentThemeMode;
			selectedThemeSection = 'page';
			managerThemesExpanded = false;
			lastManagerSelectionId = currentManagerSelectionId;
		}
	}

	$: if (open && !wasOpen) {
		hasLiveMemberships = false;
		liveMemberships = [];
		currentScheduleId = normalizeScheduleId(activeScheduleId);
		selectedScheduleId = null;
		selectedThemeMode = currentThemeMode;
		selectedThemeSection = 'page';
		managerThemesExpanded = false;
		lastManagerSelectionId = null;
		showCreateScheduleForm = false;
		newScheduleName = '';
		syncSelectionToCurrentOnRefresh = true;
		actionError = '';
		membershipsError = '';
		managerDraftStatusMessage = '';
		void refreshMemberships();
	}

	$: if (open && selectedThemeMode !== currentThemeMode) {
		selectedThemeMode = currentThemeMode;
	}

	$: if (open && selectedMembership) {
		if (
			selectedMembership.RoleName === 'Manager' &&
			selectedManagerDraft &&
			isSelectedMembershipActive
		) {
			applyThemeState(selectedManagerDraft);
		} else {
			applyActiveScheduleThemeOrDefault();
		}
	}

	$: if (open && !selectedScheduleId && effectiveMemberships.length > 0) {
		selectedScheduleId = resolvedCurrentScheduleId ?? effectiveMemberships[0].ScheduleId;
	}

	$: if (
		open &&
		selectedScheduleId !== null &&
		effectiveMemberships.length > 0 &&
		!effectiveMemberships.some((membership) => membership.ScheduleId === selectedScheduleId)
	) {
		selectedScheduleId = resolvedCurrentScheduleId ?? effectiveMemberships[0].ScheduleId;
	}

	$: wasOpen = open;

	$: if (!open) {
		syncSelectionToCurrentOnRefresh = false;
		stopDragging();
		applyActiveScheduleThemeOrDefault();
		managerDraftStatusMessage = '';
	}

	$: modalScrollSyncKey = open
		? [
				effectiveMemberships.length,
				selectedScheduleId ?? '',
				showCreateScheduleForm ? '1' : '0',
				selectedThemeMode,
				selectedThemeSection,
				actionError,
				managerDraftStatusMessage,
				membershipsLoading ? '1' : '0',
				membershipsError
			].join('|')
		: '';

	$: if (open && modalScrollSyncKey) {
		tick().then(() => {
			updateCustomScrollbar();
			requestAnimationFrame(updateCustomScrollbar);
		});
	}

	onDestroy(() => {
		stopDragging();
		if (typeof document !== 'undefined') {
			document.body.classList.remove('team-modal-open');
			if (!document.body.dataset.scrollbarDragCount) {
				document.body.classList.remove('scrollbar-dragging');
			}
		}
	});

	onMount(() => {
		const onResize = () => {
			updateCustomScrollbar();
		};
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
		};
	});
</script>

<svelte:window on:keydown={handleWindowKeydown} />

{#if open}
	<div class="teamSetupBackdrop" role="presentation" on:mousedown={handleBackdropMouseDown}>
		<div
			class="teamSetupModal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="schedule-setup-title"
		>
			<div class="teamSetupModalScroll" bind:this={modalScrollEl} on:scroll={onModalScroll}>
				<header class="teamSetupHeader">
					<div>
						<h2 id="schedule-setup-title">Schedules</h2>
					</div>
					<button class="btn" type="button" on:click={closeModal}>Close</button>
				</header>

				<div class="teamSetupBody">
					<nav class="teamSetupNav" aria-label="Schedules">
						{#if membershipsLoading && effectiveMemberships.length === 0}
							<div class="teamSetupNavBtn">Loading schedules...</div>
						{:else if effectiveMemberships.length === 0}
							<div class="teamSetupNavBtn">No schedules found.</div>
						{:else}
							{#each effectiveMemberships as membership (membership.ScheduleId)}
								<button
									type="button"
									class={`teamSetupNavBtn${membership.ScheduleId === selectedScheduleId ? ' active' : ''}`}
									aria-current={membership.ScheduleId === selectedScheduleId ? 'page' : undefined}
									on:click={() => handleSelectSchedule(membership.ScheduleId)}
								>
									{displayScheduleName(membership)}{scheduleRoleSuffix(membership.RoleName)}
								</button>
							{/each}
						{/if}
						{#if canCreateSchedules}
							<button
								type="button"
								class={`teamSetupNavCreateBtn${showCreateScheduleForm ? ' active' : ''}`}
								on:click={openCreateScheduleForm}
								disabled={isCreatingSchedule}
								aria-label="Create a new schedule"
								title="Create a new schedule"
							>
								<svg viewBox="0 0 24 24" aria-hidden="true">
									<path d="M12 5v14M5 12h14" />
								</svg>
							</button>
						{/if}
					</nav>

					<div class="teamSetupPanel">
						<section class="setupSection">
							{#if membershipsError}
								<p class="setupActionAlert" role="alert">{membershipsError}</p>
							{/if}
							{#if showCreateScheduleForm}
								<div class="setupCard managerCustomizationCard">
									<form
										class="setupGrid managerCustomizationGrid"
										on:submit|preventDefault={handleCreateSchedule}
									>
										<label class="setupField">
											<span class="setupFieldLabel">Schedule Name</span>
											<input
												class="input"
												type="text"
												maxlength="120"
												bind:value={newScheduleName}
												placeholder="Schedule name"
											/>
										</label>
										<button
											class="btn primary managerCreateScheduleBtn"
											type="submit"
											disabled={isCreatingSchedule || !newScheduleName.trim()}
										>
											{isCreatingSchedule ? 'Creating...' : 'Create'}
										</button>
									</form>
								</div>
							{:else if !selectedMembership}
								<p class="setupCardHint">Select a schedule to view options.</p>
							{:else}
								<div class="setupGrid">
									{#if selectedMembership.IsDefault}
										<div class="readOnlyField">
											<span>Default Schedule</span>
										</div>
									{:else}
										<button
											type="button"
											class="btn primary readOnlyFieldActionBtn"
											on:click={handleMakeDefault}
											disabled={isSavingDefault}
										>
											{isSavingDefault ? 'Saving...' : 'Make Default'}
										</button>
									{/if}

									{#if isSelectedMembershipActive}
										<div class="readOnlyField">
											<span>Active Schedule</span>
										</div>
									{:else}
										<button
											type="button"
											class="btn primary readOnlyFieldActionBtn"
											on:click={handleViewSchedule}
											disabled={isSwitchingSchedule}
										>
											{isSwitchingSchedule ? 'Switching...' : 'View'}
										</button>
									{/if}
								</div>

								{#if selectedMembership.RoleName === 'Manager' && selectedManagerDraft}
									<div class="setupCard managerCustomizationCard">
										<div class="setupGrid managerCustomizationGrid">
											<label class="setupField">
												<span class="setupFieldLabel">Schedule Name</span>
												<input
													class="input"
													type="text"
													maxlength="120"
													value={selectedManagerDraft.scheduleName}
													on:input={handleManagerNameInput}
													placeholder="Schedule name"
												/>
											</label>
											<button
												class={`btn managerScheduleToggleBtn ${selectedManagerDraft.isActive ? 'managerScheduleToggleBtnDanger' : 'managerScheduleToggleBtnSuccess'}`}
												type="button"
												on:click={toggleManagerScheduleActive}
												disabled={isTogglingScheduleState}
											>
												{isTogglingScheduleState
													? 'Saving...'
													: selectedManagerDraft.isActive
														? 'Deactivate'
														: 'Activate'}
											</button>
										</div>
										{#if isSelectedMembershipActive}
											<div class="managerThemesSection">
												<div class="managerThemesContainer" class:expanded={managerThemesExpanded}>
													<button
														type="button"
														class="btn managerThemesCollapseBtn"
														on:click={toggleManagerThemesExpanded}
														aria-expanded={managerThemesExpanded}
													>
														<span>Themes</span>
														<span class="managerThemesChevron" aria-hidden="true">
															{managerThemesExpanded ? '▾' : '▸'}
														</span>
													</button>
													{#if managerThemesExpanded}
														<div class="managerThemesContent">
															<div
																class="managerThemeSectionSwitch"
																role="tablist"
																aria-label="Theme section"
															>
																<ThemeToggle
																	theme={selectedThemeMode}
																	onToggle={toggleSelectedThemeMode}
																/>
																<button
																	type="button"
																	role="tab"
																	class={`actionBtn btn${selectedThemeSection === 'page' ? ' primary' : ''}`}
																	aria-selected={selectedThemeSection === 'page'}
																	on:click={() => (selectedThemeSection = 'page')}
																>
																	Page
																</button>
																<button
																	type="button"
																	role="tab"
																	class={`actionBtn btn${selectedThemeSection === 'schedule' ? ' primary' : ''}`}
																	aria-selected={selectedThemeSection === 'schedule'}
																	on:click={() => (selectedThemeSection = 'schedule')}
																>
																	Schedule
																</button>
																<div class="managerThemeQuickActions">
																	<button
																		type="button"
																		class="btn actionBtn managerThemeDefaultBtn"
																		on:click={handleManagerResetDefaults}
																		disabled={areAllThemeFieldsAtDefaults || isSavingManagerDraft}
																		title={areAllThemeFieldsAtDefaults
																			? 'Already using default theme'
																			: 'Reset theme colors to default values'}
																	>
																		Default
																	</button>
																	<button
																		type="button"
																		class="btn actionBtn managerThemeRevertBtn"
																		class:dirty={hasManagerThemeChanges}
																		on:click={handleManagerThemeRestoreSaved}
																		disabled={!hasManagerThemeChanges || isSavingManagerDraft}
																		title={hasManagerThemeChanges
																			? 'Revert theme colors to last saved values'
																			: 'No theme color changes have been made'}
																	>
																		Revert
																	</button>
																</div>
															</div>

															<div class="managerThemeTableWrap">
																<table class="managerThemeTable">
																	<thead>
																		<tr>
																			<th scope="col">Setting</th>
																			<th scope="col">Color</th>
																		</tr>
																	</thead>
																	<tbody>
																		{#each activeThemeFieldOptions as themeField (themeField.key)}
																			<tr>
																				<th scope="row">{themeField.label}</th>
																				<td>
																					<div class="managerThemeField">
																						<ColorPicker
																							id={`manager-theme-${themeField.key}`}
																							label={themeField.label}
																							value={selectedManagerDraft.themes[selectedThemeMode][
																								themeField.key
																							]}
																							on:change={(event) =>
																								handleManagerThemeInput(
																									themeField.key,
																									event.detail
																								)}
																						/>
																					</div>
																				</td>
																			</tr>
																		{/each}
																	</tbody>
																</table>
															</div>
														</div>
													{/if}
												</div>
											</div>
										{:else}
											<p class="setupCardHint">
												Switch to this schedule to edit its theme settings.
											</p>
										{/if}

										<div class="setupActions managerCustomizationActions">
											<button
												class="btn primary managerSaveBtn"
												type="button"
												on:click={handleManagerSaveDraft}
												disabled={!hasManagerDraftChanges || isSavingManagerDraft}
												title={hasManagerDraftChanges
													? 'Save schedule changes'
													: 'No changes have been made.'}
											>
												{isSavingManagerDraft ? 'Saving...' : 'Save'}
											</button>
										</div>

										{#if managerDraftStatusMessage}
											<p
												class={`managerStatusMessage managerStatusMessage${
													managerDraftStatusTone === 'success'
														? 'Success'
														: managerDraftStatusTone === 'error'
															? 'Error'
															: 'Info'
												}`}
												role={managerDraftStatusTone === 'error' ? 'alert' : 'status'}
											>
												{managerDraftStatusMessage}
											</p>
										{/if}
									</div>
								{/if}
							{/if}
							{#if actionError}
								<p class="setupActionAlert" role="alert">{actionError}</p>
							{/if}
						</section>
					</div>
				</div>
			</div>
			{#if showCustomScrollbar}
				<div
					class="teamSetupScrollRail"
					role="presentation"
					aria-hidden="true"
					bind:this={railEl}
					on:mousedown={handleRailClick}
				>
					<div
						class="teamSetupScrollThumb"
						class:dragging={isDraggingScrollbar}
						role="presentation"
						style={`height:${thumbHeightPx}px;transform:translateY(${thumbTopPx}px);`}
						on:mousedown={startThumbDrag}
					></div>
				</div>
			{/if}
		</div>
	</div>
{/if}
