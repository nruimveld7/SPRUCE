<script lang="ts">
	import { afterUpdate, onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import MonthYearBar from '$lib/components/MonthYearBar.svelte';
	import ScheduleGrid from '$lib/components/ScheduleGrid.svelte';
	import DatePicker from '$lib/components/DatePicker.svelte';
	import Picker from '$lib/components/Picker.svelte';
	import ColorPicker from '$lib/components/ColorPicker.svelte';
	import ThemedCheckbox from '$lib/components/ThemedCheckbox.svelte';
	import ThemedSpinPicker from '$lib/components/ThemedSpinPicker.svelte';
	import TeamSetupModal from '$lib/components/TeamSetupModal.svelte';
	import ScheduleSetupModal from '$lib/components/ScheduleSetupModal.svelte';
	import OnboardingTourModal from '$lib/components/OnboardingTourModal.svelte';
	import type { Employee, Group, ScheduleEvent, Status } from '$lib/types/schedule';
	import { fetchWithAuthRedirect } from '$lib/utils/fetchWithAuthRedirect';
	import { buildMonthDays, dowShort, monthNames } from '$lib/utils/date';

	type Theme = 'light' | 'dark';
	type ThemePreference = 'system' | 'dark' | 'light';
	type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
	type ScheduleMembership = {
		ScheduleId: number;
		Name: string;
		RoleName: ScheduleRole;
		IsDefault: boolean;
		IsActive: boolean;
		ThemeJson?: string | null;
		VersionAt?: string | Date | null;
	};
	type OnboardingSlide = {
		id: string;
		role: ScheduleRole;
		roleTier: number;
		title: string;
		description: string;
		imageUrl: string | null;
	};
	type ThemeMode = 'dark' | 'light';
	type EventScopeType = 'global' | 'shift' | 'user';
	type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';
	type PopupMode = 'list' | 'add' | 'edit';
	type PickerOption = { value: number | string; label: string; color?: string };
	type ScheduledReminderDraft = {
		id: number;
		amount: number;
		unit: string;
		hour: number;
		meridiem: string;
	};
	type EventCodeOption = {
		eventCodeId: number;
		code: string;
		name: string;
		displayMode: EventDisplayMode;
		color: string;
		isActive: boolean;
		notifyImmediately?: boolean;
		scheduledReminders?: Array<{
			amount: number;
			unit: 'days' | 'weeks' | 'months';
			hour: number;
			meridiem: 'AM' | 'PM';
		}>;
	};
	type CalendarDayIndicator = {
		eventId: number;
		scopeType: EventScopeType;
		eventDisplayMode: ScheduleEvent['eventDisplayMode'];
		eventCodeColor: string;
		startDate: string;
	};
	type CalendarScopedEventEntry = {
		eventId: number;
		eventCodeCode: string;
		eventCodeName: string;
		scopeType: EventScopeType;
		employeeTypeId: number | null;
		userOid: string | null;
		eventDisplayMode: EventDisplayMode;
		eventCodeColor: string;
		startDate: string;
		endDate: string;
		comments: string;
	};
	type CalendarShiftOption = { employeeTypeId: number; name: string };
	type CalendarUserOption = { userOid: string; name: string; employeeTypeIds: number[] };
	type CalendarDayDetails = {
		events: CalendarScopedEventEntry[];
		shifts: CalendarShiftOption[];
		users: CalendarUserOption[];
	};
	type CalendarEditorEventEntry = {
		eventId: number;
		eventCodeId: number | null;
		eventCodeCode: string;
		eventCodeName: string;
		scopeType: EventScopeType;
		employeeTypeId: number | null;
		userOid: string | null;
		eventDisplayMode: EventDisplayMode;
		eventCodeColor: string;
		startDate: string;
		endDate: string;
		comments: string;
		versionStamp?: string;
		notifyImmediately?: boolean;
		scheduledReminders?: Array<{
			amount: number;
			unit: 'days' | 'weeks' | 'months';
			hour: number;
			meridiem: 'AM' | 'PM';
		}>;
	};
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
	type ThemePayload = Record<ThemeMode, ThemeDraft>;
	const dowLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

	const now = () => new Date();
	const initialDate = now();
	const themeFieldKeys: ThemeFieldKey[] = [
		'background',
		'text',
		'accent',
		'todayColor',
		'weekendColor',
		'weekdayColor',
		'pageBorderColor',
		'scheduleBorderColor',
		'primaryGradient1',
		'primaryGradient2',
		'secondaryGradient1',
		'secondaryGradient2'
	];
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
		'calendar-weekday-bg',
		'calendar-weekend-bg',
		'calendar-today-color',
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
	let selectedYear = initialDate.getFullYear();
	let selectedMonthIndex = initialDate.getMonth();
	let showScheduleGridView = true;
	let theme: Theme = 'dark';
	let themePreferenceState: ThemePreference = 'system';
	let systemTheme: Theme = 'dark';
	let collapsed: Record<string, boolean> = {};
	let sessionCollapsedBySchedule: Record<number, Record<string, boolean>> = {};
	let persistedCollapsedBySchedule: Record<number, Record<string, boolean>> = {};
	let collapsedDefaultsSyncStateBySchedule: Record<number, 'idle' | 'syncing' | 'synced'> = {};
	let initialThemeReady = false;

	export let scheduleName = 'Shift Schedule';
	export let activeScheduleId: number | null = null;
	export let scheduleMemberships: ScheduleMembership[] = [];
	export let groups: Group[] = [];
	export let overrides: Record<string, { day: number; status: Status }[]> = {};
	export let showLegend = true;
	export let canMaintainTeam = false;
	export let canAssignManagerRole = false;
	export let canOpenScheduleSetup = false;
	export let currentUserOid = '';
	export let collapsedGroupsBySchedule: Record<number, Record<string, boolean>> = {};
	export let themePreference: ThemePreference = 'system';
	export let onboarding: { currentTier: number; targetTier: number; slides: OnboardingSlide[] } = {
		currentTier: 0,
		targetTier: 0,
		slides: []
	};

	let teamSetupOpen = false;
	let scheduleSetupOpen = false;
	let cardScrollEl: HTMLDivElement | null = null;
	let appRailEl: HTMLDivElement | null = null;
	let showAppScrollbar = false;
	let appThumbHeightPx = 0;
	let appThumbTopPx = 0;
	let isDraggingAppScrollbar = false;
	let appDragStartY = 0;
	let appDragStartThumbTopPx = 0;
	let lastSyncedActiveScheduleId: number | null = null;
	let scheduleGroups: Group[] = [];
	let scheduleEvents: ScheduleEvent[] = [];
	let scheduleGroupsLoaded = false;
	let scheduleGroupsRequestId = 0;
	let loadedScheduleEventsMonthKey = '';
	let scheduleLoadKey = '';
	let isScheduleTransitioning = false;
	let lastRequestedMonthViewKey = `${selectedYear}-${selectedMonthIndex}`;
	let activeScheduleThemeSignature = '';
	let lastAppliedThemeSignature = '';
	let scheduleContextPollTimer: ReturnType<typeof setInterval> | null = null;
	let scheduleContextRefreshInFlight = false;
	let displayNameEditorOpen = false;
	let displayNameEditorUserOid = '';
	let displayNameEditorCurrentName = '';
	let displayNameEditorDraft = '';
	let displayNameEditorError = '';
	let displayNameEditorSaving = false;
	let onboardingOpen = false;
	let onboardingSlideIndex = 0;
	let onboardingDontShowAgain = false;
	let onboardingSaving = false;
	let onboardingDismissedForSession = false;
	let onboardingSaveError = '';
	let onboardingSlidesSource: 'auto' | 'manual' = 'auto';
	let onboardingSlidesForModal: OnboardingSlide[] = onboarding.slides;
	let onboardingTargetTierForModal = onboarding.targetTier;
	let onboardingCurrentTierState = onboarding.currentTier;
	let popupResetToken = 0;
	let monthEventIndicatorsByDay: Record<number, CalendarDayIndicator[]> = {};
	let monthIndicatorRenderVersion = 0;
	let calendarHoverTooltipOpen = false;
	let calendarHoverTooltipLoading = false;
	let calendarHoverTooltipTitle = '';
	let calendarHoverTooltipEntries: CalendarScopedEventEntry[] = [];
	let calendarHoverTooltipData: CalendarDayDetails | null = null;
	let calendarHoverTooltipLeftPx = 0;
	let calendarHoverTooltipTopPx = 0;
	let calendarHoverTooltipEl: HTMLDivElement | null = null;
	let calendarHoverFetchToken = 0;
	let calendarHoverHideTimer: ReturnType<typeof setTimeout> | null = null;
	let canUseHoverTooltips = true;
	let calendarPopupOpen = false;
	let calendarPopupLoading = false;
	let calendarPopupError = '';
	let calendarPopupTitle = '';
	let calendarPopupDayIso = '';
	let calendarPopupData: CalendarDayDetails | null = null;
	let calendarDayDetailsCache: Record<string, CalendarDayDetails> = {};
	let calendarPopupMode: PopupMode = 'list';
	let calendarPopupScope: EventScopeType = 'global';
	let calendarPopupShiftId: number | null = null;
	let calendarPopupUserOid: string | null = null;
	let calendarPopupUserShiftId: number | null = null;
	let calendarPopupScopeQuery = '';
	let calendarPopupScopeOptionsOpen = false;
	let calendarPopupScopeInputResetToken = 0;
	let calendarPopupScopeComboEl: HTMLDivElement | null = null;
	let calendarPopupScopeOptionsScrollEl: HTMLDivElement | null = null;
	let calendarPopupScopeOptionsRailEl: HTMLDivElement | null = null;
	let calendarPopupScopeOptionsShowScrollbar = false;
	let calendarPopupScopeOptionsThumbHeightPx = 0;
	let calendarPopupScopeOptionsThumbTopPx = 0;
	let isDraggingCalendarPopupScopeOptionsScrollbar = false;
	let calendarPopupScopeOptionsDragStartY = 0;
	let calendarPopupScopeOptionsDragStartThumbTopPx = 0;
	let calendarPopupModalScrollEl: HTMLDivElement | null = null;
	let calendarPopupModalRailEl: HTMLDivElement | null = null;
	let showCalendarPopupModalScrollbar = false;
	let calendarPopupModalThumbHeightPx = 0;
	let calendarPopupModalThumbTopPx = 0;
	let isDraggingCalendarPopupModalScrollbar = false;
	let calendarPopupModalDragStartY = 0;
	let calendarPopupModalDragStartThumbTopPx = 0;
	let calendarPopupEditingEventId: number | null = null;
	let calendarPopupEditingEventVersionStamp = '';
	let calendarEventCodeOptions: EventCodeOption[] = [];
	let calendarEventCodesLoading = false;
	let calendarEventCodesError = '';
	let calendarEventCodePickerOpen = false;
	let calendarPopupUserShiftPickerOpen = false;
	let calendarCustomDisplayModePickerOpen = false;
	let calendarAddStartDatePickerOpen = false;
	let calendarAddEndDatePickerOpen = false;
	let calendarAddEventCodeId = '';
	let calendarAddEventComments = '';
	let calendarAddEventStartDate = '';
	let calendarAddEventEndDate = '';
	let calendarAddCustomEventCode = '';
	let calendarAddCustomEventName = '';
	let calendarAddCustomEventDisplayMode: EventDisplayMode = 'Schedule Overlay';
	let calendarAddCustomEventColor = '#22c55e';
	let calendarAddReminderImmediate = false;
	let calendarAddReminderScheduled = false;
	let calendarScheduledReminderDrafts: ScheduledReminderDraft[] = [];
	let nextCalendarScheduledReminderDraftId = 1;
	let calendarAddEventError = '';
	let calendarEventSaveInProgress = false;
	let calendarScrollEl: HTMLDivElement | null = null;
	let calendarHorizontalRailEl: HTMLDivElement | null = null;
	let calendarVerticalRailEl: HTMLDivElement | null = null;
	let showCalendarHorizontalScrollbar = false;
	let showCalendarVerticalScrollbar = false;
	let calendarHorizontalThumbWidthPx = 0;
	let calendarHorizontalThumbLeftPx = 0;
	let calendarVerticalThumbHeightPx = 0;
	let calendarVerticalThumbTopPx = 0;
	let isDraggingCalendarHorizontalScrollbar = false;
	let isDraggingCalendarVerticalScrollbar = false;
	let calendarDragStartX = 0;
	let calendarDragStartHorizontalThumbLeftPx = 0;
	let calendarDragStartY = 0;
	let calendarDragStartVerticalThumbTopPx = 0;
	const eventDisplayModeItems: PickerOption[] = [
		{ value: 'Schedule Overlay', label: 'Schedule Overlay' },
		{ value: 'Badge Indicator', label: 'Badge Indicator' },
		{ value: 'Shift Override', label: 'Shift Override' }
	];
	const reminderAmountOptions = Array.from({ length: 31 }, (_, index) => index);
	const reminderHourOptions = Array.from({ length: 13 }, (_, index) => index);
	const reminderUnitOptions = ['days', 'weeks', 'months'];
	const reminderMeridiemOptions = ['AM', 'PM'];
	const MAX_SCHEDULED_REMINDERS = 4;

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

	function buildModeOverrides(mode: ThemeMode, modeTheme: ThemeDraft): Record<string, string> {
		const defaults = themeDefaults[mode];
		const background = normalizeHexColor(modeTheme.background, defaults.background);
		const text = normalizeHexColor(modeTheme.text, defaults.text);
		const accent = normalizeHexColor(modeTheme.accent, defaults.accent);
		const todayColor = normalizeHexColor(modeTheme.todayColor, defaults.todayColor);
		const weekendColor = normalizeHexColor(modeTheme.weekendColor, defaults.weekendColor);
		const weekdayColor = normalizeHexColor(modeTheme.weekdayColor, defaults.weekdayColor);
		const pageBorderColor = normalizeHexColor(modeTheme.pageBorderColor, defaults.pageBorderColor);
		const scheduleBorderColor = normalizeHexColor(
			modeTheme.scheduleBorderColor,
			defaults.scheduleBorderColor
		);
		const primaryGradientFrom = normalizeHexColor(
			modeTheme.primaryGradient1,
			defaults.primaryGradient1
		);
		const primaryGradientTo = normalizeHexColor(
			modeTheme.primaryGradient2,
			defaults.primaryGradient2
		);
		const secondaryGradientFrom = normalizeHexColor(
			modeTheme.secondaryGradient1,
			defaults.secondaryGradient1
		);
		const secondaryGradientTo = normalizeHexColor(
			modeTheme.secondaryGradient2,
			defaults.secondaryGradient2
		);
		const isDark = mode === 'dark';
		const bgWeight1 = isDark ? 0.14 : 0.08;
		const bgWeight2 = isDark ? 0.24 : 0.16;
		const surface = isDark
			? mixColors(background, '#ffffff', 0.08)
			: mixColors(background, '#000000', 0.04);
		const surfaceAlpha0 = isDark ? 0.22 : 0.62;
		const surfaceAlpha1 = isDark ? 0.34 : 0.74;
		const surfaceAlpha2 = isDark ? 0.5 : 0.84;
		const textAlpha = isDark ? 0.98 : 0.92;
		const mutedAlpha = isDark ? 0.72 : 0.66;
		const faintAlpha = isDark ? 0.5 : 0.46;
		const todayAlpha = isDark ? 0.24 : 0.2;
		const interactiveAlpha = isDark ? 0.06 : 0.72;
		const interactiveHoverAlpha = isDark ? 0.09 : 0.86;
		const cellActiveAlpha = isDark ? 0.2 : 0.15;
		const backdropAlpha = isDark ? 0.68 : 0.42;
		const panelAlpha = isDark ? 0.38 : 0.88;
		const inputAlpha = isDark ? 0.08 : 0.95;
		const scrollThumbAlpha = isDark ? 0.38 : 0.24;
		const scrollThumbHoverAlpha = isDark ? 0.56 : 0.34;
		const border = pageBorderColor;
		const headerGradientBottom = mixColors(weekdayColor, '#000000', isDark ? 0.24 : 0.12);
		const teamCellColor = mixColors(weekdayColor, '#000000', isDark ? 0.32 : 0.16);
		const headerGradientFrom = primaryGradientFrom;
		const headerGradientTo = primaryGradientTo;
		const modalGradientFrom = secondaryGradientFrom;
		const modalGradientTo = secondaryGradientTo;
		const popoverGradientFrom = secondaryGradientFrom;
		const popoverGradientTo = secondaryGradientTo;

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
			[`--theme-${mode}-interactive-bg`]: isDark
				? rgba('#ffffff', interactiveAlpha)
				: rgba('#ffffff', interactiveAlpha),
			[`--theme-${mode}-interactive-bg-hover`]: isDark
				? rgba('#ffffff', interactiveHoverAlpha)
				: rgba('#ffffff', interactiveHoverAlpha),
			[`--theme-${mode}-interactive-border`]: isDark ? rgba(border, 0.32) : rgba(border, 0.28),
			[`--theme-${mode}-interactive-border-hover`]: rgba(accent, interactiveHoverAlpha),
			[`--theme-${mode}-team-cell-hover`]: rgba(accent, 0.12),
			[`--theme-${mode}-team-cell-active`]: rgba(accent, cellActiveAlpha),
			[`--theme-${mode}-modal-backdrop`]: rgba('#000000', backdropAlpha),
			[`--theme-${mode}-modal-border`]: isDark ? rgba(border, 0.38) : rgba(border, 0.3),
			[`--theme-${mode}-panel-bg`]: rgba('#ffffff', panelAlpha),
			[`--theme-${mode}-table-header-bg`]: isDark
				? `linear-gradient(180deg, ${rgba(headerGradientFrom, 0.64)}, ${rgba(headerGradientTo, 0.38)})`
				: `linear-gradient(180deg, ${rgba(headerGradientFrom, 0.72)}, ${rgba(headerGradientTo, 0.48)})`,
			[`--theme-${mode}-input-bg`]: rgba('#ffffff', inputAlpha),
			[`--theme-${mode}-scrollbar-track-bg`]: isDark
				? rgba('#ffffff', 0.08)
				: rgba('#000000', 0.08),
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
			[`--theme-${mode}-calendar-weekday-bg`]: rgba(weekdayColor, 1),
			[`--theme-${mode}-calendar-weekend-bg`]: rgba(weekendColor, 1),
			[`--theme-${mode}-calendar-today-color`]: rgba(todayColor, 1),
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

	function parseThemePayload(themeJson: string | null | undefined): ThemePayload | null {
		if (typeof themeJson !== 'string' || !themeJson.trim()) return null;
		try {
			const parsed = JSON.parse(themeJson) as Record<string, unknown>;
			if (!parsed || typeof parsed !== 'object') return null;
			const dark = parsed.dark as Record<string, unknown> | undefined;
			const light = parsed.light as Record<string, unknown> | undefined;
			if (!dark || !light) return null;

			const parseMode = (
				modeValue: Record<string, unknown>,
				modeDefaults: ThemeDraft
			): ThemeDraft => {
				const mode = {} as ThemeDraft;
				for (const key of themeFieldKeys) {
					const value =
						modeValue[key] ??
						((key === 'pageBorderColor' || key === 'scheduleBorderColor'
							? modeValue.borderColor
							: undefined) as unknown);
					mode[key] =
						typeof value === 'string'
							? normalizeHexColor(value, modeDefaults[key])
							: modeDefaults[key];
				}
				return mode;
			};

			const parsedDark = parseMode(dark, themeDefaults.dark);
			const parsedLight = parseMode(light, themeDefaults.light);

			return { dark: parsedDark, light: parsedLight };
		} catch {
			return null;
		}
	}

	function clearThemeOverrides() {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		for (const key of themeOverrideVarKeys) {
			root.style.removeProperty(key);
		}
	}

	function applyThemeOverrides(themePayload: ThemePayload) {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		const darkVars = buildModeOverrides('dark', themePayload.dark);
		const lightVars = buildModeOverrides('light', themePayload.light);
		for (const [key, value] of Object.entries({ ...darkVars, ...lightVars })) {
			root.style.setProperty(key, value);
		}
	}

	function applyActiveScheduleTheme() {
		const activeMembership =
			scheduleMemberships.find((membership) => membership.ScheduleId === activeScheduleId) ??
			scheduleMemberships.find((membership) => membership.IsDefault) ??
			scheduleMemberships[0] ??
			null;
		if (!activeMembership) {
			clearThemeOverrides();
			return;
		}
		const parsed = parseThemePayload(activeMembership.ThemeJson);
		if (!parsed) {
			clearThemeOverrides();
			return;
		}
		applyThemeOverrides(parsed);
	}

	function normalizeVersionAt(value: unknown): string {
		if (value instanceof Date) {
			return Number.isFinite(value.getTime()) ? value.toISOString() : '';
		}
		if (typeof value !== 'string') return '';
		const trimmed = value.trim();
		if (!trimmed) return '';
		const parsed = new Date(trimmed);
		return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : trimmed;
	}

	function membershipSignature(memberships: ScheduleMembership[]): string {
		return [...memberships]
			.sort((left, right) => left.ScheduleId - right.ScheduleId)
			.map((membership) =>
				[
					membership.ScheduleId,
					membership.Name,
					membership.RoleName,
					membership.IsDefault ? '1' : '0',
					membership.IsActive ? '1' : '0',
					membership.ThemeJson ?? '',
					normalizeVersionAt(membership.VersionAt)
				].join(':')
			)
			.join('|');
	}

	function buildLoadedScheduleContextSignature(
		nextActiveScheduleId: number | null,
		nextMemberships: ScheduleMembership[]
	): string {
		return `${nextActiveScheduleId ?? 'none'}|${membershipSignature(nextMemberships)}`;
	}

	function accessLevelSignature(memberships: ScheduleMembership[]): string {
		return [...memberships]
			.sort((left, right) => left.ScheduleId - right.ScheduleId)
			.map((membership) => [membership.ScheduleId, membership.RoleName, membership.IsActive ? '1' : '0'].join(':'))
			.join('|');
	}

	function resolveScheduleNameFromMemberships(
		memberships: ScheduleMembership[],
		resolvedScheduleId: number | null,
		fallbackName: string
	): string {
		const activeMembership =
			memberships.find((membership) => membership.ScheduleId === resolvedScheduleId) ??
			memberships.find((membership) => membership.IsDefault) ??
			memberships[0] ??
			null;
		return activeMembership?.Name?.trim() || fallbackName;
	}

	function handleScheduleMembershipsRefresh(
		nextMemberships: ScheduleMembership[],
		nextActiveScheduleId: number | null
	) {
		scheduleMemberships = nextMemberships;
		if (nextActiveScheduleId !== null) {
			activeScheduleId = nextActiveScheduleId;
		}
		scheduleName = resolveScheduleNameFromMemberships(
			nextMemberships,
			nextActiveScheduleId ?? activeScheduleId,
			scheduleName
		);
	}

	function closeAllPopups() {
		teamSetupOpen = false;
		scheduleSetupOpen = false;
		closeDisplayNameEditor(true);
		onboardingOpen = false;
		popupResetToken += 1;
	}

	async function refreshScheduleContextInBackground(): Promise<boolean> {
		if (!browser || scheduleContextRefreshInFlight) return false;
		scheduleContextRefreshInFlight = true;
		try {
			const response = await fetchWithAuthRedirect(
				`${base}/api/schedules/memberships`,
				{ headers: { accept: 'application/json' } },
				base
			);
			if (!response) return false;
			if (!response.ok) {
				if (response.status === 400 || response.status === 403) {
					await goto(`${base}/`, { invalidateAll: true, replaceState: true, noScroll: true });
					return true;
				}
				return false;
			}
			const payload = (await response.json()) as {
				activeScheduleId?: number | null;
				memberships?: ScheduleMembership[];
			};
			const serverMemberships = Array.isArray(payload.memberships) ? payload.memberships : [];
			const serverActiveScheduleId =
				typeof payload.activeScheduleId === 'number' ? payload.activeScheduleId : null;
			const currentSignature = buildLoadedScheduleContextSignature(
				activeScheduleId,
				scheduleMemberships
			);
			const serverSignature = buildLoadedScheduleContextSignature(
				serverActiveScheduleId,
				serverMemberships
			);
			const currentAccessLevelSignature = accessLevelSignature(scheduleMemberships);
			const serverAccessLevelSignature = accessLevelSignature(serverMemberships);
			if (serverAccessLevelSignature !== currentAccessLevelSignature) {
				closeAllPopups();
			}
			if (serverSignature !== currentSignature) {
				await goto(`${base}/`, { invalidateAll: true, replaceState: true, noScroll: true });
				return true;
			}
			return false;
		} catch {
			// Background refresh errors should not interrupt the current view.
			return false;
		} finally {
			scheduleContextRefreshInFlight = false;
		}
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
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

	function updateAppScrollbar() {
		if (!cardScrollEl) return;
		const scrollHeight = cardScrollEl.scrollHeight;
		const clientHeight = cardScrollEl.clientHeight;
		const scrollTop = cardScrollEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;
		showAppScrollbar = hasOverflow;
		if (!hasOverflow) {
			appThumbHeightPx = 0;
			appThumbTopPx = 0;
			return;
		}

		const railHeight = appRailEl?.clientHeight ?? Math.max(clientHeight - 24, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		appThumbHeightPx = nextThumbHeight;
		appThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onCardScroll() {
		if (!isDraggingAppScrollbar) {
			updateAppScrollbar();
		}
	}

	function onAppDragMove(event: MouseEvent) {
		if (!isDraggingAppScrollbar || !cardScrollEl || !appRailEl) return;
		const railHeight = appRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - appThumbHeightPx, 0);
		const nextThumbTop = clamp(
			appDragStartThumbTopPx + (event.clientY - appDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(cardScrollEl.scrollHeight - cardScrollEl.clientHeight, 0);
		appThumbTopPx = nextThumbTop;
		cardScrollEl.scrollTop = maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopAppDragging() {
		if (isDraggingAppScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingAppScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onAppDragMove);
			window.removeEventListener('mouseup', stopAppDragging);
		}
	}

	function startAppThumbDrag(event: MouseEvent) {
		if (!showAppScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingAppScrollbar = true;
		setGlobalScrollbarDragging(true);
		appDragStartY = event.clientY;
		appDragStartThumbTopPx = appThumbTopPx;
		window.addEventListener('mousemove', onAppDragMove);
		window.addEventListener('mouseup', stopAppDragging);
	}

	function handleAppRailClick(event: MouseEvent) {
		if (!cardScrollEl || !appRailEl || !showAppScrollbar) return;
		if (event.target !== appRailEl) return;

		const rect = appRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - appThumbHeightPx / 2,
			0,
			Math.max(rect.height - appThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - appThumbHeightPx, 1);
		const maxScrollTop = Math.max(cardScrollEl.scrollHeight - cardScrollEl.clientHeight, 0);
		cardScrollEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateAppScrollbar();
	}

	function updateCalendarScrollbars() {
		if (!calendarScrollEl) {
			showCalendarHorizontalScrollbar = false;
			showCalendarVerticalScrollbar = false;
			return;
		}
		const hasHorizontalOverflow = calendarScrollEl.scrollWidth > calendarScrollEl.clientWidth + 1;
		const hasVerticalOverflow = calendarScrollEl.scrollHeight > calendarScrollEl.clientHeight + 1;
		showCalendarHorizontalScrollbar = hasHorizontalOverflow;
		showCalendarVerticalScrollbar = hasVerticalOverflow;

		if (hasHorizontalOverflow) {
			const railWidth = calendarHorizontalRailEl?.clientWidth ?? calendarScrollEl.clientWidth;
			if (railWidth > 0) {
				const minThumbWidth = 40;
				const nextThumbWidth = Math.max(
					minThumbWidth,
					(railWidth * calendarScrollEl.clientWidth) / calendarScrollEl.scrollWidth
				);
				const maxThumbLeft = Math.max(railWidth - nextThumbWidth, 0);
				const maxScrollLeft = Math.max(calendarScrollEl.scrollWidth - calendarScrollEl.clientWidth, 1);
				const nextThumbLeft = (calendarScrollEl.scrollLeft / maxScrollLeft) * maxThumbLeft;
				calendarHorizontalThumbWidthPx = nextThumbWidth;
				calendarHorizontalThumbLeftPx = clamp(nextThumbLeft, 0, maxThumbLeft);
			}
		} else {
			calendarHorizontalThumbWidthPx = 0;
			calendarHorizontalThumbLeftPx = 0;
		}

		if (hasVerticalOverflow) {
			const railHeight = calendarVerticalRailEl?.clientHeight ?? calendarScrollEl.clientHeight;
			if (railHeight > 0) {
				const minThumbHeight = 36;
				const nextThumbHeight = Math.max(
					minThumbHeight,
					(railHeight * calendarScrollEl.clientHeight) / calendarScrollEl.scrollHeight
				);
				const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
				const maxScrollTop = Math.max(calendarScrollEl.scrollHeight - calendarScrollEl.clientHeight, 1);
				const nextThumbTop = (calendarScrollEl.scrollTop / maxScrollTop) * maxThumbTop;
				calendarVerticalThumbHeightPx = nextThumbHeight;
				calendarVerticalThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
			}
		} else {
			calendarVerticalThumbHeightPx = 0;
			calendarVerticalThumbTopPx = 0;
		}
	}

	function onCalendarScroll() {
		if (!isDraggingCalendarHorizontalScrollbar && !isDraggingCalendarVerticalScrollbar) {
			updateCalendarScrollbars();
		}
	}

	function onCalendarHorizontalDragMove(event: MouseEvent) {
		if (!isDraggingCalendarHorizontalScrollbar || !calendarScrollEl || !calendarHorizontalRailEl) return;
		const railWidth = calendarHorizontalRailEl.clientWidth;
		const maxThumbLeft = Math.max(railWidth - calendarHorizontalThumbWidthPx, 0);
		const nextThumbLeft = clamp(
			calendarDragStartHorizontalThumbLeftPx + (event.clientX - calendarDragStartX),
			0,
			maxThumbLeft
		);
		const maxScrollLeft = Math.max(calendarScrollEl.scrollWidth - calendarScrollEl.clientWidth, 0);
		calendarHorizontalThumbLeftPx = nextThumbLeft;
		calendarScrollEl.scrollLeft = maxThumbLeft > 0 ? (nextThumbLeft / maxThumbLeft) * maxScrollLeft : 0;
	}

	function stopCalendarHorizontalDragging() {
		if (isDraggingCalendarHorizontalScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingCalendarHorizontalScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onCalendarHorizontalDragMove);
			window.removeEventListener('mouseup', stopCalendarHorizontalDragging);
		}
	}

	function startCalendarHorizontalThumbDrag(event: MouseEvent) {
		if (!showCalendarHorizontalScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingCalendarHorizontalScrollbar = true;
		setGlobalScrollbarDragging(true);
		calendarDragStartX = event.clientX;
		calendarDragStartHorizontalThumbLeftPx = calendarHorizontalThumbLeftPx;
		window.addEventListener('mousemove', onCalendarHorizontalDragMove);
		window.addEventListener('mouseup', stopCalendarHorizontalDragging);
	}

	function handleCalendarHorizontalRailClick(event: MouseEvent) {
		if (!calendarScrollEl || !calendarHorizontalRailEl || !showCalendarHorizontalScrollbar) return;
		if (event.target !== calendarHorizontalRailEl) return;
		const rect = calendarHorizontalRailEl.getBoundingClientRect();
		const desiredLeft = clamp(
			event.clientX - rect.left - calendarHorizontalThumbWidthPx / 2,
			0,
			Math.max(rect.width - calendarHorizontalThumbWidthPx, 0)
		);
		const maxThumbLeft = Math.max(rect.width - calendarHorizontalThumbWidthPx, 1);
		const maxScrollLeft = Math.max(calendarScrollEl.scrollWidth - calendarScrollEl.clientWidth, 0);
		calendarScrollEl.scrollLeft = (desiredLeft / maxThumbLeft) * maxScrollLeft;
		updateCalendarScrollbars();
	}

	function onCalendarVerticalDragMove(event: MouseEvent) {
		if (!isDraggingCalendarVerticalScrollbar || !calendarScrollEl || !calendarVerticalRailEl) return;
		const railHeight = calendarVerticalRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - calendarVerticalThumbHeightPx, 0);
		const nextThumbTop = clamp(
			calendarDragStartVerticalThumbTopPx + (event.clientY - calendarDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(calendarScrollEl.scrollHeight - calendarScrollEl.clientHeight, 0);
		calendarVerticalThumbTopPx = nextThumbTop;
		calendarScrollEl.scrollTop = maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopCalendarVerticalDragging() {
		if (isDraggingCalendarVerticalScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingCalendarVerticalScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onCalendarVerticalDragMove);
			window.removeEventListener('mouseup', stopCalendarVerticalDragging);
		}
	}

	function startCalendarVerticalThumbDrag(event: MouseEvent) {
		if (!showCalendarVerticalScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingCalendarVerticalScrollbar = true;
		setGlobalScrollbarDragging(true);
		calendarDragStartY = event.clientY;
		calendarDragStartVerticalThumbTopPx = calendarVerticalThumbTopPx;
		window.addEventListener('mousemove', onCalendarVerticalDragMove);
		window.addEventListener('mouseup', stopCalendarVerticalDragging);
	}

	function handleCalendarVerticalRailClick(event: MouseEvent) {
		if (!calendarScrollEl || !calendarVerticalRailEl || !showCalendarVerticalScrollbar) return;
		if (event.target !== calendarVerticalRailEl) return;
		const rect = calendarVerticalRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - calendarVerticalThumbHeightPx / 2,
			0,
			Math.max(rect.height - calendarVerticalThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - calendarVerticalThumbHeightPx, 1);
		const maxScrollTop = Math.max(calendarScrollEl.scrollHeight - calendarScrollEl.clientHeight, 0);
		calendarScrollEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateCalendarScrollbars();
	}

	$: monthDays = buildMonthDays(selectedYear, selectedMonthIndex, browser ? now() : null);
	$: monthCalendarLeadingCells = monthDays[0]?.dow ?? 0;
	$: monthCalendarLeadingIndices = buildLeadingIndices(monthCalendarLeadingCells);
	$: monthCalendarWeekCount = Math.max(
		1,
		Math.ceil((monthCalendarLeadingCells + monthDays.length) / 7)
	);
	$: monthCalendarTrailingCells = Math.max(
		0,
		monthCalendarWeekCount * 7 - (monthCalendarLeadingCells + monthDays.length)
	);
	$: monthCalendarTrailingIndices = buildLeadingIndices(monthCalendarTrailingCells);
	$: calendarActiveEventCodeItems = [
		{ value: 'custom', label: 'Custom' },
		...calendarEventCodeOptions.map((eventCode) => ({
			value: eventCode.eventCodeId,
			label: `${eventCode.code} - ${eventCode.name}`,
			color: eventCode.color
		}))
	] satisfies PickerOption[];
	$: calendarSelectedEventCodeLabel =
		calendarActiveEventCodeItems.find((item) => String(item.value) === calendarAddEventCodeId)?.label ??
		'Select event code';
	$: calendarIsCustomEventCodeSelected = calendarAddEventCodeId === 'custom';
	$: calendarSelectedCustomDisplayModeLabel =
		eventDisplayModeItems.find((item) => item.value === calendarAddCustomEventDisplayMode)?.label ??
		'Select display type';
	$: calendarPopupUserShiftItems = calendarPopupUserShiftOptions().map((shift) => ({
		value: shift.employeeTypeId,
		label: shift.name
	})) satisfies PickerOption[];
	$: calendarShowUserScopeShiftPicker =
		calendarPopupScope === 'user' && calendarPopupUserShiftItems.length > 1;
	$: calendarSelectedUserScopeShiftLabel =
		calendarPopupUserShiftItems.find((item) => Number(item.value) === calendarPopupUserScopeShiftId())
			?.label ?? 'Select shift';
	$: calendarScopeSelectionValidationError = calendarScopeSelectionValidationMessage();
	$: calendarScopeSelectionMissing = calendarScopeSelectionValidationError.length > 0;
	$: if (calendarPopupScope !== 'user') {
		calendarPopupUserShiftId = null;
		calendarPopupUserShiftPickerOpen = false;
	}
	$: calendarCanAddScheduledReminderDraft = calendarScheduledReminderDrafts.length < MAX_SCHEDULED_REMINDERS;
	$: if (calendarAddReminderScheduled && calendarScheduledReminderDrafts.length === 0) {
		calendarScheduledReminderDrafts = [createDefaultCalendarScheduledReminderDraft()];
	}
	$: calendarScheduledReminderSummaryLines = (() => {
		if (!calendarAddReminderScheduled) return [] as string[];
		const lines: string[] = [];
		const seen = new Set<string>();
		for (const reminderDraft of calendarScheduledReminderDrafts) {
			const key = `${reminderDraft.amount}|${reminderDraft.unit}|${reminderDraft.hour}|${reminderDraft.meridiem}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const unitLabel =
				reminderDraft.unit === 'days'
					? reminderDraft.amount === 1
						? 'day'
						: 'days'
					: reminderDraft.unit === 'weeks'
						? reminderDraft.amount === 1
							? 'week'
							: 'weeks'
						: reminderDraft.amount === 1
							? 'month'
							: 'months';
			lines.push(`${reminderDraft.amount} ${unitLabel} before at ${reminderDraft.hour}:00 ${reminderDraft.meridiem}`);
		}
		return lines;
	})();
	$: calendarScheduledReminderSummaryTitle = `${calendarScheduledReminderSummaryLines.length} Scheduled Reminder${calendarScheduledReminderSummaryLines.length === 1 ? '' : 's'}`;
	$: calendarAddEventPrimaryButtonLabel = calendarEventSaveInProgress
		? calendarPopupMode === 'edit'
			? 'Saving...'
			: 'Adding...'
		: calendarPopupMode === 'edit'
			? 'Save'
			: 'Add';
	$: {
		const next: Record<number, CalendarDayIndicator[]> = {};
		const selectedMonthKey = `${selectedYear}-${selectedMonthIndex}`;
		const eventsForSelectedMonth =
			loadedScheduleEventsMonthKey === selectedMonthKey ? scheduleEvents : [];
		for (const day of monthDays) {
			const dayIso = toIsoDate(selectedYear, selectedMonthIndex, day.day);
				const dayEvents = eventsForSelectedMonth
					.filter((event) => dateIntersectsDay(event.startDate, event.endDate, dayIso))
					.map((event) => ({
						eventId: event.eventId,
						scopeType: event.scopeType,
						eventDisplayMode: normalizeEventDisplayMode(event.eventDisplayMode),
						eventCodeColor: event.eventCodeColor,
						startDate: event.startDate
					}))
					.sort((left, right) => {
						const scopeDelta = scopeSortRank(left.scopeType) - scopeSortRank(right.scopeType);
						if (scopeDelta !== 0) return scopeDelta;
						const startDelta = left.startDate.localeCompare(right.startDate);
						if (startDelta !== 0) return startDelta;
						return left.eventId - right.eventId;
					});
				next[day.day] = dayEvents;
			}
			monthEventIndicatorsByDay = next;
			monthIndicatorRenderVersion += 1;
		}

	$: if (browser) {
		document.title = `${scheduleName} — ${monthNames[selectedMonthIndex]} ${selectedYear}`;
	}

	$: if (browser) {
		document.documentElement.dataset.theme = theme;
	}

	$: if (browser && initialThemeReady && activeScheduleId !== lastSyncedActiveScheduleId) {
		lastSyncedActiveScheduleId = activeScheduleId;
		showScheduleGridView = true;
		setToToday();
	}
	$: activeScheduleThemeSignature = `${activeScheduleId ?? 'none'}|${scheduleMemberships
		.map(
			(membership) =>
				`${membership.ScheduleId}:${membership.IsDefault ? 1 : 0}:${membership.ThemeJson ?? ''}`
		)
		.join('|')}`;
	$: if (
		browser &&
		initialThemeReady &&
		activeScheduleThemeSignature !== lastAppliedThemeSignature
	) {
		lastAppliedThemeSignature = activeScheduleThemeSignature;
		applyActiveScheduleTheme();
	}

	function setTheme(next: Theme) {
		theme = next;
	}

	function resolveSystemTheme(): Theme {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return 'dark';
		}
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}

	function resolveEffectiveTheme(preference: ThemePreference): Theme {
		if (preference === 'system') {
			return systemTheme;
		}
		return preference;
	}

	function setThemePreferenceState(nextPreference: ThemePreference) {
		themePreferenceState = nextPreference;
		setTheme(resolveEffectiveTheme(nextPreference));
	}

	function getNextThemePreference(preference: ThemePreference): ThemePreference {
		if (preference === 'system') return 'dark';
		if (preference === 'dark') return 'light';
		return 'system';
	}

	async function persistThemePreference(nextPreference: ThemePreference): Promise<boolean> {
		try {
			const response = await fetchWithAuthRedirect(
				`${base}/api/schedules/theme-preference`,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ themePreference: nextPreference })
				},
				base
			);
			if (!response) return false;
			return response.ok;
		} catch {
			return false;
		}
	}

	function toggleTheme() {
		const nextPreference = getNextThemePreference(themePreferenceState);
		setThemePreferenceState(nextPreference);
		void persistThemePreference(nextPreference);
	}

	function handleScheduleSetupThemeModeChange(nextMode: ThemeMode) {
		setThemePreferenceState(nextMode);
		void persistThemePreference(nextMode);
	}

	function setToToday() {
		const d = now();
		selectedYear = d.getFullYear();
		selectedMonthIndex = d.getMonth();
	}

	function setSelectedMonthIndex(nextValue: unknown) {
		const parsed = Number(nextValue);
		if (!Number.isInteger(parsed)) return;
		if (parsed < 0 || parsed > 11) return;
		selectedMonthIndex = parsed;
	}

	function setSelectedYear(nextValue: unknown) {
		const parsed = Number(nextValue);
		if (!Number.isInteger(parsed)) return;
		if (parsed < 1900 || parsed > 3000) return;
		selectedYear = parsed;
	}

	function toggleScheduleView() {
		showScheduleGridView = !showScheduleGridView;
	}

	function buildLeadingIndices(count: number): number[] {
		return [...Array(Math.max(0, count)).keys()];
	}

	function scopeSortRank(scopeType: EventScopeType): number {
		if (scopeType === 'global') return 1;
		if (scopeType === 'shift') return 2;
		return 3;
	}

	function normalizeEventDisplayMode(value: unknown): EventDisplayMode {
		if (typeof value !== 'string') return 'Schedule Overlay';
		const normalized = value.trim().toLowerCase();
		const compact = normalized.replace(/[\s_-]+/g, '');
		if (compact.includes('shift') && compact.includes('override')) return 'Shift Override';
		if (compact.includes('badge') && compact.includes('indicator')) return 'Badge Indicator';
		if (compact === 'badge') return 'Badge Indicator';
		if (compact === 'shiftoverride') return 'Shift Override';
		if (compact.includes('schedule') && compact.includes('overlay')) return 'Schedule Overlay';
		return 'Schedule Overlay';
	}

	function toIsoDate(year: number, monthIndex: number, day: number): string {
		const month = String(monthIndex + 1).padStart(2, '0');
		const dayText = String(day).padStart(2, '0');
		return `${year}-${month}-${dayText}`;
	}

	function dateIntersectsDay(startDate: string, endDate: string, dayIso: string): boolean {
		return startDate <= dayIso && endDate >= dayIso;
	}

	function sortCalendarScopedEvents(entries: CalendarScopedEventEntry[]): CalendarScopedEventEntry[] {
		return [...entries].sort((left, right) => {
			const scopeDelta = scopeSortRank(left.scopeType) - scopeSortRank(right.scopeType);
			if (scopeDelta !== 0) return scopeDelta;
			const startDelta = left.startDate.localeCompare(right.startDate);
			if (startDelta !== 0) return startDelta;
			const endDelta = left.endDate.localeCompare(right.endDate);
			if (endDelta !== 0) return endDelta;
			return left.eventId - right.eventId;
		});
	}

	function eventScopeSuffix(eventRow: CalendarScopedEventEntry, dayData: CalendarDayDetails | null): string {
		if (eventRow.scopeType === 'global') return 'Everyone';
		if (eventRow.scopeType === 'shift') {
			return (
				dayData?.shifts.find((shift) => shift.employeeTypeId === eventRow.employeeTypeId)?.name ?? 'Shift'
			);
		}
		return dayData?.users.find((user) => user.userOid === eventRow.userOid)?.name ?? 'User';
	}

	function monthDayIndicators(day: number): CalendarDayIndicator[] {
		return monthEventIndicatorsByDay[day] ?? [];
	}

	function indicatorDisplayModeClass(displayMode: ScheduleEvent['eventDisplayMode'] | string): string {
		const normalizedDisplayMode = normalizeEventDisplayMode(displayMode);
		if (normalizedDisplayMode === 'Shift Override') return 'mode-shift-override';
		if (normalizedDisplayMode === 'Schedule Overlay') return 'mode-schedule-overlay';
		return 'mode-badge-indicator';
	}

	function formatEventDateOrRange(startDate: string, endDate: string): string {
		if (!startDate || !endDate) return '';
		if (startDate === endDate) return startDate;
		return `${startDate} to ${endDate}`;
	}

	function popupDateTitle(dayIso: string): string {
		const [yearRaw, monthRaw, dayRaw] = dayIso.split('-');
		const month = Number(monthRaw);
		const day = Number(dayRaw);
		const year = Number(yearRaw);
		if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
			return `${dayIso} Events`;
		}
		return `${monthNames[month - 1]} ${day}, ${year} Events`;
	}

	function parseErrorMessage(result: Response, fallback: string): Promise<string> {
		return result
			.json()
			.then((payload) => {
				if (payload && typeof payload === 'object') {
					const candidate = payload as Record<string, unknown>;
					const message =
						typeof candidate.message === 'string'
							? candidate.message
							: typeof candidate.error === 'string'
								? candidate.error
								: '';
					if (message.trim()) return message;
				}
				return fallback;
			})
			.catch(() => fallback);
	}

	async function loadCalendarDayDetails(dayIso: string): Promise<CalendarDayDetails> {
		const cached = calendarDayDetailsCache[dayIso];
		if (cached) return cached;
		const response = await fetchWithAuthRedirect(
			`${base}/api/team/events/day?day=${encodeURIComponent(dayIso)}`,
			{ method: 'GET', headers: { accept: 'application/json' } },
			base
		);
		if (!response) {
			const fallback: CalendarDayDetails = { events: [], shifts: [], users: [] };
			calendarDayDetailsCache[dayIso] = fallback;
			return fallback;
		}
		if (!response.ok) {
			throw new Error(await parseErrorMessage(response, 'Failed to load day events'));
		}
		const payload = (await response.json()) as Partial<CalendarDayDetails>;
			const dayData: CalendarDayDetails = {
				events: sortCalendarScopedEvents(
					(Array.isArray(payload.events) ? payload.events : []).map((eventRow) => ({
						...eventRow,
						eventDisplayMode: normalizeEventDisplayMode(eventRow.eventDisplayMode)
					}))
				),
				shifts: Array.isArray(payload.shifts) ? payload.shifts : [],
				users: Array.isArray(payload.users) ? payload.users : []
			};
		calendarDayDetailsCache[dayIso] = dayData;
		return dayData;
	}

	function positionCalendarHoverTooltip(clientX: number, clientY: number) {
		if (typeof window === 'undefined') return;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const tooltipWidth = calendarHoverTooltipEl?.offsetWidth ?? 420;
		const tooltipHeight = calendarHoverTooltipEl?.offsetHeight ?? 220;
		const margin = 12;
		const pointerOffset = 14;
		let left = clientX + pointerOffset;
		if (left + tooltipWidth + margin > viewportWidth) {
			left = viewportWidth - tooltipWidth - margin;
		}
		left = Math.max(margin, left);
		const belowTop = clientY + pointerOffset;
		const canFitBelow = belowTop + tooltipHeight + margin <= viewportHeight;
		const aboveTop = clientY - pointerOffset - tooltipHeight;
		let top = canFitBelow ? belowTop : Math.max(margin, aboveTop);
		if (!canFitBelow && aboveTop < margin) {
			top = Math.max(margin, Math.min(belowTop, viewportHeight - tooltipHeight - margin));
		}
		calendarHoverTooltipLeftPx = Math.round(left);
		calendarHoverTooltipTopPx = Math.round(top);
	}

	function hideCalendarHoverTooltip() {
		if (calendarHoverHideTimer !== null) {
			clearTimeout(calendarHoverHideTimer);
			calendarHoverHideTimer = null;
		}
		calendarHoverTooltipOpen = false;
		calendarHoverTooltipLoading = false;
		calendarHoverTooltipEntries = [];
		calendarHoverTooltipTitle = '';
		calendarHoverTooltipData = null;
	}

	function cancelCalendarHoverHide() {
		if (calendarHoverHideTimer !== null) {
			clearTimeout(calendarHoverHideTimer);
			calendarHoverHideTimer = null;
		}
	}

	function scheduleCalendarHoverHide() {
		cancelCalendarHoverHide();
		calendarHoverHideTimer = setTimeout(() => {
			hideCalendarHoverTooltip();
		}, 140);
	}

	async function showCalendarHoverTooltip(day: number, pointer: { clientX: number; clientY: number }) {
		if (!canUseHoverTooltips || calendarPopupOpen || showScheduleGridView) return;
		cancelCalendarHoverHide();
		const dayIso = toIsoDate(selectedYear, selectedMonthIndex, day);
		calendarHoverTooltipTitle = popupDateTitle(dayIso);
		calendarHoverTooltipOpen = true;
		positionCalendarHoverTooltip(pointer.clientX, pointer.clientY);
		calendarHoverTooltipLoading = true;
		const fetchToken = ++calendarHoverFetchToken;
		try {
			const dayData = await loadCalendarDayDetails(dayIso);
			if (fetchToken !== calendarHoverFetchToken) return;
			calendarHoverTooltipData = dayData;
			calendarHoverTooltipEntries = sortCalendarScopedEvents(dayData.events);
			calendarHoverTooltipLoading = false;
			positionCalendarHoverTooltip(pointer.clientX, pointer.clientY);
		} catch {
			if (fetchToken !== calendarHoverFetchToken) return;
			hideCalendarHoverTooltip();
		}
	}

	function calendarPopupEvents(): CalendarScopedEventEntry[] {
		return calendarPopupData?.events ?? [];
	}

	function calendarPopupScopeLabel(scope: EventScopeType): string {
		if (scope === 'global') return 'Everyone';
		if (scope === 'shift') return 'Shift';
		return 'User';
	}

	function cycleCalendarPopupScope() {
		if (calendarPopupScope === 'global') {
			calendarPopupScope = 'shift';
		} else if (calendarPopupScope === 'shift') {
			calendarPopupScope = 'user';
		} else {
			calendarPopupScope = 'global';
		}
		closeCalendarPopupScopeOptions();
		calendarPopupShiftId = null;
		calendarPopupUserOid = null;
		calendarPopupUserShiftId = null;
		calendarPopupScopeInputResetToken += 1;
	}

	function filteredCalendarPopupScopeOptions(): Array<{ id: string; label: string }> {
		if (!calendarPopupData) return [];
		const query = calendarPopupScopeQuery.trim().toLowerCase();
		if (calendarPopupScope === 'shift') {
			return calendarPopupData.shifts
				.filter((shift) => (query ? shift.name.toLowerCase().includes(query) : true))
				.map((shift) => ({ id: String(shift.employeeTypeId), label: shift.name }));
		}
		if (calendarPopupScope === 'user') {
			return calendarPopupData.users
				.filter((user) => (query ? user.name.toLowerCase().includes(query) : true))
				.map((user) => ({ id: user.userOid, label: user.name }));
		}
		return [];
	}

	function resetCalendarPopupScopeOptionsScrollbarState() {
		calendarPopupScopeOptionsShowScrollbar = false;
		calendarPopupScopeOptionsThumbHeightPx = 0;
		calendarPopupScopeOptionsThumbTopPx = 0;
	}

	function stopCalendarPopupScopeOptionsDragging() {
		isDraggingCalendarPopupScopeOptionsScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onCalendarPopupScopeOptionsDragMove);
			window.removeEventListener('mouseup', stopCalendarPopupScopeOptionsDragging);
		}
	}

	function closeCalendarPopupScopeOptions() {
		stopCalendarPopupScopeOptionsDragging();
		calendarPopupScopeOptionsOpen = false;
		calendarPopupScopeQuery = '';
		resetCalendarPopupScopeOptionsScrollbarState();
	}

	function openCalendarPopupScopeOptions() {
		if (calendarPopupScope === 'global') return;
		calendarPopupScopeOptionsOpen = true;
		resetCalendarPopupScopeOptionsScrollbarState();
		requestAnimationFrame(() => {
			updateCalendarPopupScopeOptionsScrollbar();
		});
	}

	function updateCalendarPopupScopeOptionsScrollbar() {
		if (!calendarPopupScopeOptionsScrollEl || !calendarPopupScopeOptionsOpen) return;
		const scrollHeight = calendarPopupScopeOptionsScrollEl.scrollHeight;
		const clientHeight = calendarPopupScopeOptionsScrollEl.clientHeight;
		const scrollTop = calendarPopupScopeOptionsScrollEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;

		calendarPopupScopeOptionsShowScrollbar = hasOverflow;
		if (!hasOverflow) {
			calendarPopupScopeOptionsThumbHeightPx = 0;
			calendarPopupScopeOptionsThumbTopPx = 0;
			return;
		}

		const railHeight =
			calendarPopupScopeOptionsRailEl?.clientHeight ?? Math.max(clientHeight - 16, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		calendarPopupScopeOptionsThumbHeightPx = nextThumbHeight;
		calendarPopupScopeOptionsThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onCalendarPopupScopeOptionsScroll() {
		if (!isDraggingCalendarPopupScopeOptionsScrollbar) {
			updateCalendarPopupScopeOptionsScrollbar();
		}
	}

	function onCalendarPopupScopeOptionsDragMove(event: MouseEvent) {
		if (
			!isDraggingCalendarPopupScopeOptionsScrollbar ||
			!calendarPopupScopeOptionsScrollEl ||
			!calendarPopupScopeOptionsRailEl
		)
			return;
		const railHeight = calendarPopupScopeOptionsRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - calendarPopupScopeOptionsThumbHeightPx, 0);
		const nextThumbTop = clamp(
			calendarPopupScopeOptionsDragStartThumbTopPx +
				(event.clientY - calendarPopupScopeOptionsDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(
			calendarPopupScopeOptionsScrollEl.scrollHeight - calendarPopupScopeOptionsScrollEl.clientHeight,
			0
		);
		calendarPopupScopeOptionsThumbTopPx = nextThumbTop;
		calendarPopupScopeOptionsScrollEl.scrollTop =
			maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function startCalendarPopupScopeOptionsThumbDrag(event: MouseEvent) {
		if (!calendarPopupScopeOptionsShowScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingCalendarPopupScopeOptionsScrollbar = true;
		calendarPopupScopeOptionsDragStartY = event.clientY;
		calendarPopupScopeOptionsDragStartThumbTopPx = calendarPopupScopeOptionsThumbTopPx;
		window.addEventListener('mousemove', onCalendarPopupScopeOptionsDragMove);
		window.addEventListener('mouseup', stopCalendarPopupScopeOptionsDragging);
	}

	function handleCalendarPopupScopeOptionsRailClick(event: MouseEvent) {
		if (
			!calendarPopupScopeOptionsScrollEl ||
			!calendarPopupScopeOptionsRailEl ||
			!calendarPopupScopeOptionsShowScrollbar
		)
			return;
		if (event.target !== calendarPopupScopeOptionsRailEl) return;
		const rect = calendarPopupScopeOptionsRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - calendarPopupScopeOptionsThumbHeightPx / 2,
			0,
			Math.max(rect.height - calendarPopupScopeOptionsThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - calendarPopupScopeOptionsThumbHeightPx, 1);
		const maxScrollTop = Math.max(
			calendarPopupScopeOptionsScrollEl.scrollHeight - calendarPopupScopeOptionsScrollEl.clientHeight,
			0
		);
		calendarPopupScopeOptionsScrollEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateCalendarPopupScopeOptionsScrollbar();
	}

	function onCalendarPopupScopeComboMouseDown(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (target?.closest('.setupUserComboItem')) return;
		openCalendarPopupScopeOptions();
	}

	function updateCalendarPopupModalScrollbar() {
		if (!calendarPopupModalScrollEl || !calendarPopupOpen) return;
		const scrollHeight = calendarPopupModalScrollEl.scrollHeight;
		const clientHeight = calendarPopupModalScrollEl.clientHeight;
		const scrollTop = calendarPopupModalScrollEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;

		showCalendarPopupModalScrollbar = hasOverflow;
		if (!hasOverflow) {
			calendarPopupModalThumbHeightPx = 0;
			calendarPopupModalThumbTopPx = 0;
			return;
		}

		const railHeight = calendarPopupModalRailEl?.clientHeight ?? Math.max(clientHeight - 24, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		calendarPopupModalThumbHeightPx = nextThumbHeight;
		calendarPopupModalThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onCalendarPopupModalScroll() {
		if (!isDraggingCalendarPopupModalScrollbar) {
			updateCalendarPopupModalScrollbar();
		}
	}

	function onCalendarPopupModalDragMove(event: MouseEvent) {
		if (
			!isDraggingCalendarPopupModalScrollbar ||
			!calendarPopupModalScrollEl ||
			!calendarPopupModalRailEl
		)
			return;

		const railHeight = calendarPopupModalRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - calendarPopupModalThumbHeightPx, 0);
		const nextThumbTop = clamp(
			calendarPopupModalDragStartThumbTopPx + (event.clientY - calendarPopupModalDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(
			calendarPopupModalScrollEl.scrollHeight - calendarPopupModalScrollEl.clientHeight,
			0
		);

		calendarPopupModalThumbTopPx = nextThumbTop;
		calendarPopupModalScrollEl.scrollTop =
			maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopCalendarPopupModalDragging() {
		if (isDraggingCalendarPopupModalScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingCalendarPopupModalScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onCalendarPopupModalDragMove);
			window.removeEventListener('mouseup', stopCalendarPopupModalDragging);
		}
	}

	function startCalendarPopupModalThumbDrag(event: MouseEvent) {
		if (!showCalendarPopupModalScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingCalendarPopupModalScrollbar = true;
		setGlobalScrollbarDragging(true);
		calendarPopupModalDragStartY = event.clientY;
		calendarPopupModalDragStartThumbTopPx = calendarPopupModalThumbTopPx;
		window.addEventListener('mousemove', onCalendarPopupModalDragMove);
		window.addEventListener('mouseup', stopCalendarPopupModalDragging);
	}

	function handleCalendarPopupModalRailClick(event: MouseEvent) {
		if (!calendarPopupModalScrollEl || !calendarPopupModalRailEl || !showCalendarPopupModalScrollbar)
			return;
		if (event.target !== calendarPopupModalRailEl) return;

		const rect = calendarPopupModalRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - calendarPopupModalThumbHeightPx / 2,
			0,
			Math.max(rect.height - calendarPopupModalThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - calendarPopupModalThumbHeightPx, 1);
		const maxScrollTop = Math.max(
			calendarPopupModalScrollEl.scrollHeight - calendarPopupModalScrollEl.clientHeight,
			0
		);
		calendarPopupModalScrollEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateCalendarPopupModalScrollbar();
	}

	function calendarPopupScopeSelectionLabel(): string {
		if (!calendarPopupData) return '';
		if (calendarPopupScope === 'shift') {
			const shift = calendarPopupData.shifts.find((entry) => entry.employeeTypeId === calendarPopupShiftId);
			return shift?.name ?? '';
		}
		if (calendarPopupScope === 'user') {
			const selectedUserOid = normalizeOid(calendarPopupUserOid);
			const user = calendarPopupData.users.find(
				(entry) => normalizeOid(entry.userOid) === selectedUserOid
			);
			return user?.name ?? '';
		}
		return '';
	}

	function selectCalendarPopupScopeOption(optionId: string) {
		if (calendarPopupScope === 'shift') {
			const parsed = Number(optionId);
			calendarPopupShiftId = Number.isInteger(parsed) ? parsed : null;
		} else if (calendarPopupScope === 'user') {
			calendarPopupUserOid = optionId.trim() || null;
			calendarPopupUserShiftId = calendarPopupUserScopeShiftId();
		}
		closeCalendarPopupScopeOptions();
	}

	function calendarPopupUserShiftOptions(): CalendarShiftOption[] {
		if (!calendarPopupData || !calendarPopupUserOid) return [];
		const selectedUserOid = normalizeOid(calendarPopupUserOid);
		const user = calendarPopupData.users.find(
			(entry) => normalizeOid(entry.userOid) === selectedUserOid
		);
		if (!user) return [];
		const shiftsById = new Map(
			calendarPopupData.shifts.map((shift) => [shift.employeeTypeId, shift.name] as const)
		);
		return user.employeeTypeIds.map((employeeTypeId) => ({
			employeeTypeId,
			name: shiftsById.get(employeeTypeId) ?? `Shift ${employeeTypeId}`
		}));
	}

	function calendarPopupUserScopeShiftId(): number | null {
		const options = calendarPopupUserShiftOptions();
		if (options.length === 0) return null;
		if (
			calendarPopupUserShiftId !== null &&
			options.some((option) => option.employeeTypeId === calendarPopupUserShiftId)
		) {
			return calendarPopupUserShiftId;
		}
		return options[0]?.employeeTypeId ?? null;
	}

	function calendarScopeSelectionValidationMessage(): string {
		if (calendarPopupMode === 'list') return '';
		if (calendarPopupScope === 'shift' && !calendarPopupShiftId) {
			return 'Select a shift.';
		}
		if (calendarPopupScope === 'user' && !calendarPopupUserOid) {
			return 'Select a user.';
		}
		if (calendarPopupScope === 'user' && !calendarPopupUserScopeShiftId()) {
			return 'Select a shift.';
		}
		return '';
	}

	function setCalendarEventCodePickerOpen(next: boolean) {
		calendarEventCodePickerOpen = next;
	}

	function setCalendarPopupUserShiftPickerOpen(next: boolean) {
		calendarPopupUserShiftPickerOpen = next;
	}

	function setCalendarAddStartDatePickerOpen(next: boolean) {
		calendarAddStartDatePickerOpen = next;
	}

	function setCalendarCustomDisplayModePickerOpen(next: boolean) {
		calendarCustomDisplayModePickerOpen = next;
	}

	function setCalendarAddEndDatePickerOpen(next: boolean) {
		calendarAddEndDatePickerOpen = next;
	}

	function hasOpenCalendarPopupPopover(): boolean {
		if (
			calendarEventCodePickerOpen ||
			calendarPopupUserShiftPickerOpen ||
			calendarCustomDisplayModePickerOpen ||
			calendarAddStartDatePickerOpen ||
			calendarAddEndDatePickerOpen ||
			calendarPopupScopeOptionsOpen
		) {
			return true;
		}
		return Boolean(document.querySelector('.monthCalendarEventsModal .colorPickerPopover'));
	}

	function handleCalendarPopupBackdropMouseDown(event: MouseEvent) {
		if (event.target !== event.currentTarget) return;
		if (hasOpenCalendarPopupPopover()) {
			closeCalendarPopupScopeOptions();
			calendarPopupUserShiftPickerOpen = false;
			calendarEventCodePickerOpen = false;
			calendarCustomDisplayModePickerOpen = false;
			calendarAddStartDatePickerOpen = false;
			calendarAddEndDatePickerOpen = false;
			return;
		}
		closeCalendarDayPopup();
	}

	function handleCalendarPopupMouseDown(event: MouseEvent) {
		event.stopPropagation();
		if (!calendarPopupScopeOptionsOpen || !calendarPopupScopeComboEl) return;
		const target = event.target as Node | null;
		if (target && !calendarPopupScopeComboEl.contains(target)) {
			closeCalendarPopupScopeOptions();
		}
	}

	function resetCalendarEventForm() {
		calendarAddEventCodeId = 'custom';
		calendarAddEventComments = '';
		calendarAddEventStartDate = calendarPopupDayIso;
		calendarAddEventEndDate = calendarPopupDayIso;
		calendarAddCustomEventCode = '';
		calendarAddCustomEventName = '';
		calendarAddCustomEventDisplayMode = 'Schedule Overlay';
		calendarAddCustomEventColor = '#22c55e';
		calendarAddReminderImmediate = false;
		calendarAddReminderScheduled = false;
		calendarScheduledReminderDrafts = [createDefaultCalendarScheduledReminderDraft()];
		calendarAddEventError = '';
		calendarPopupEditingEventId = null;
		calendarPopupEditingEventVersionStamp = '';
		calendarEventCodePickerOpen = false;
		calendarPopupUserShiftPickerOpen = false;
		calendarCustomDisplayModePickerOpen = false;
		calendarAddStartDatePickerOpen = false;
		calendarAddEndDatePickerOpen = false;
	}

	function createDefaultCalendarScheduledReminderDraft(): ScheduledReminderDraft {
		return {
			id: nextCalendarScheduledReminderDraftId++,
			amount: 1,
			unit: 'days',
			hour: 12,
			meridiem: 'PM'
		};
	}

	function addCalendarScheduledReminderDraft() {
		if (calendarScheduledReminderDrafts.length >= MAX_SCHEDULED_REMINDERS) return;
		calendarScheduledReminderDrafts = [
			...calendarScheduledReminderDrafts,
			createDefaultCalendarScheduledReminderDraft()
		];
	}

	function removeCalendarScheduledReminderDraft(id: number) {
		if (calendarScheduledReminderDrafts.length <= 1) {
			calendarAddReminderScheduled = false;
			calendarScheduledReminderDrafts = [createDefaultCalendarScheduledReminderDraft()];
			return;
		}
		calendarScheduledReminderDrafts = calendarScheduledReminderDrafts.filter((draft) => draft.id !== id);
	}

	function updateCalendarScheduledReminderDraft(
		id: number,
		field: 'amount' | 'unit' | 'hour' | 'meridiem',
		nextValue: string | number
	) {
		calendarScheduledReminderDrafts = calendarScheduledReminderDrafts.map((draft) => {
			if (draft.id !== id) return draft;
			if (field === 'amount') return { ...draft, amount: Number(nextValue) };
			if (field === 'hour') return { ...draft, hour: Number(nextValue) };
			if (field === 'unit') return { ...draft, unit: String(nextValue) };
			return { ...draft, meridiem: String(nextValue) };
		});
	}

	function applyCalendarReminderDefaultsFromEventCode(eventCode: EventCodeOption | null) {
		if (!eventCode) {
			calendarAddReminderImmediate = false;
			calendarAddReminderScheduled = false;
			calendarScheduledReminderDrafts = [createDefaultCalendarScheduledReminderDraft()];
			return;
		}
		calendarAddReminderImmediate = Boolean(eventCode.notifyImmediately);
		const reminders = Array.isArray(eventCode.scheduledReminders) ? eventCode.scheduledReminders : [];
		if (reminders.length > 0) {
			calendarAddReminderScheduled = true;
			calendarScheduledReminderDrafts = reminders.map((reminder) => ({
				id: nextCalendarScheduledReminderDraftId++,
				amount: reminder.amount,
				unit: reminder.unit,
				hour: reminder.hour,
				meridiem: reminder.meridiem
			}));
			return;
		}
		calendarAddReminderScheduled = false;
		calendarScheduledReminderDrafts = [createDefaultCalendarScheduledReminderDraft()];
	}

	function handleCalendarEventCodeSelection(nextValue: string | number) {
		calendarAddEventCodeId = String(nextValue);
		if (calendarPopupMode !== 'add') return;
		if (calendarAddEventCodeId === 'custom') {
			applyCalendarReminderDefaultsFromEventCode(null);
			return;
		}
		const selectedEventCodeId = Number(calendarAddEventCodeId);
		const selectedEventCode = calendarEventCodeOptions.find(
			(eventCode) => eventCode.eventCodeId === selectedEventCodeId
		);
		applyCalendarReminderDefaultsFromEventCode(selectedEventCode ?? null);
	}

	async function loadCalendarActiveEventCodes(forceReload = false) {
		if (!canMaintainTeam || calendarEventCodesLoading) return;
		if (!forceReload && calendarEventCodeOptions.length > 0) return;
		calendarEventCodesLoading = true;
		calendarEventCodesError = '';
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/event-codes`, { method: 'GET' }, base);
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to load active event codes'));
			}
			const data = (await result.json()) as {
				eventCodes?: Array<{
					eventCodeId: number;
					code: string;
					name: string;
					displayMode: EventDisplayMode;
					color: string;
					isActive: boolean;
					notifyImmediately?: boolean;
					scheduledReminders?: Array<{
						amount: number;
						unit: 'days' | 'weeks' | 'months';
						hour: number;
						meridiem: 'AM' | 'PM';
					}>;
				}>;
			};
			calendarEventCodeOptions = (Array.isArray(data.eventCodes) ? data.eventCodes : [])
				.filter((eventCode) => eventCode.isActive)
				.map((eventCode) => ({
					eventCodeId: eventCode.eventCodeId,
					code: eventCode.code,
					name: eventCode.name,
					displayMode: eventCode.displayMode ?? 'Schedule Overlay',
					color: eventCode.color,
					isActive: Boolean(eventCode.isActive),
					notifyImmediately: Boolean(eventCode.notifyImmediately),
					scheduledReminders: Array.isArray(eventCode.scheduledReminders)
						? eventCode.scheduledReminders
						: []
				}));
		} catch (error) {
			calendarEventCodesError =
				error instanceof Error ? error.message : 'Failed to load active event codes';
		} finally {
			calendarEventCodesLoading = false;
		}
	}

	async function fetchCalendarScopedEvents(
		scopeType: EventScopeType,
		scopeShiftId: number | null,
		scopeUserOid: string | null,
		dayIso: string
	): Promise<CalendarEditorEventEntry[]> {
		const queryParts = [`scope=${encodeURIComponent(scopeType)}`, `day=${encodeURIComponent(dayIso)}`];
		if (scopeShiftId) queryParts.push(`employeeTypeId=${encodeURIComponent(String(scopeShiftId))}`);
		if (scopeType === 'user' && scopeUserOid) queryParts.push(`userOid=${encodeURIComponent(scopeUserOid)}`);
		const result = await fetchWithAuthRedirect(
			`${base}/api/team/events?${queryParts.join('&')}`,
			{ method: 'GET', headers: { accept: 'application/json' } },
			base
		);
		if (!result) return [];
		if (!result.ok) {
			throw new Error(await parseErrorMessage(result, 'Failed to load events'));
		}
		const payload = (await result.json()) as { events?: CalendarEditorEventEntry[] };
		return Array.isArray(payload.events) ? payload.events : [];
	}

	async function openCalendarDayPopup(day: number) {
		const dayIso = toIsoDate(selectedYear, selectedMonthIndex, day);
		calendarPopupDayIso = dayIso;
		calendarPopupTitle = popupDateTitle(dayIso);
		calendarPopupOpen = true;
		calendarPopupMode = 'list';
		calendarPopupLoading = true;
		calendarPopupError = '';
		calendarPopupScope = 'global';
			calendarPopupShiftId = null;
			calendarPopupUserOid = null;
			calendarPopupUserShiftId = null;
			closeCalendarPopupScopeOptions();
			resetCalendarEventForm();
		hideCalendarHoverTooltip();
		try {
			const dayData = await loadCalendarDayDetails(dayIso);
			calendarPopupData = dayData;
		} catch (error) {
			calendarPopupData = null;
			calendarPopupError = error instanceof Error ? error.message : 'Failed to load events';
		} finally {
			calendarPopupLoading = false;
		}
	}

	function closeCalendarDayPopup() {
		calendarPopupOpen = false;
		calendarPopupLoading = false;
		calendarPopupError = '';
		calendarPopupMode = 'list';
		stopCalendarPopupModalDragging();
		showCalendarPopupModalScrollbar = false;
		calendarPopupModalThumbHeightPx = 0;
		calendarPopupModalThumbTopPx = 0;
		closeCalendarPopupScopeOptions();
		calendarPopupUserShiftPickerOpen = false;
		calendarAddEventError = '';
	}

	async function openCalendarAddEventView() {
		if (!canMaintainTeam) return;
		calendarPopupMode = 'add';
		calendarPopupScope = 'global';
			calendarPopupShiftId = null;
			calendarPopupUserOid = null;
			calendarPopupUserShiftId = null;
			closeCalendarPopupScopeOptions();
			resetCalendarEventForm();
		await loadCalendarActiveEventCodes(true);
	}

	async function openCalendarEditEventView(eventRow: CalendarScopedEventEntry) {
		if (!canMaintainTeam || !calendarPopupDayIso) return;
		await loadCalendarActiveEventCodes(true);
		const detailedEvents = await fetchCalendarScopedEvents(
			eventRow.scopeType,
			eventRow.employeeTypeId,
			eventRow.userOid,
			calendarPopupDayIso
		);
		const detailedEvent = detailedEvents.find((entry) => entry.eventId === eventRow.eventId) ?? null;
		if (!detailedEvent) {
			calendarAddEventError = 'This event can no longer be edited. Refresh and try again.';
			return;
		}

		calendarPopupMode = 'edit';
		calendarPopupScope = detailedEvent.scopeType;
			calendarPopupShiftId = detailedEvent.employeeTypeId;
			calendarPopupUserOid = detailedEvent.userOid;
			calendarPopupUserShiftId = detailedEvent.scopeType === 'user' ? detailedEvent.employeeTypeId : null;
			closeCalendarPopupScopeOptions();
			calendarAddEventError = '';
		calendarPopupEditingEventId = detailedEvent.eventId;
		calendarPopupEditingEventVersionStamp = detailedEvent.versionStamp ?? '';
		calendarAddEventComments = detailedEvent.comments;
		calendarAddEventStartDate = detailedEvent.startDate;
		calendarAddEventEndDate = detailedEvent.endDate;

		const matchedEventCode =
			typeof detailedEvent.eventCodeId === 'number' && detailedEvent.eventCodeId > 0
				? calendarEventCodeOptions.find((item) => item.eventCodeId === detailedEvent.eventCodeId)
				: null;
		if (matchedEventCode) {
			calendarAddEventCodeId = String(matchedEventCode.eventCodeId);
			calendarAddCustomEventCode = '';
			calendarAddCustomEventName = '';
			calendarAddCustomEventDisplayMode = 'Schedule Overlay';
			calendarAddCustomEventColor = '#22c55e';
		} else {
			calendarAddEventCodeId = 'custom';
			calendarAddCustomEventCode = detailedEvent.eventCodeCode;
			calendarAddCustomEventName = detailedEvent.eventCodeName;
			calendarAddCustomEventDisplayMode = detailedEvent.eventDisplayMode;
			calendarAddCustomEventColor = detailedEvent.eventCodeColor;
		}

		calendarEventCodePickerOpen = false;
		calendarCustomDisplayModePickerOpen = false;
		calendarAddStartDatePickerOpen = false;
		calendarAddEndDatePickerOpen = false;
		calendarAddReminderImmediate = Boolean(detailedEvent.notifyImmediately);
		const reminders = Array.isArray(detailedEvent.scheduledReminders)
			? detailedEvent.scheduledReminders
			: [];
		if (reminders.length > 0) {
			calendarAddReminderScheduled = true;
			calendarScheduledReminderDrafts = reminders.map((reminder) => ({
				id: nextCalendarScheduledReminderDraftId++,
				amount: reminder.amount,
				unit: reminder.unit,
				hour: reminder.hour,
				meridiem: reminder.meridiem
			}));
		} else {
			calendarAddReminderScheduled = false;
			calendarScheduledReminderDrafts = [createDefaultCalendarScheduledReminderDraft()];
		}
	}

		function cancelCalendarAddEdit() {
			calendarPopupMode = 'list';
			closeCalendarPopupScopeOptions();
			calendarPopupUserShiftPickerOpen = false;
			resetCalendarEventForm();
		}

	function isIsoDate(value: string): boolean {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
		const [yearRaw, monthRaw, dayRaw] = value.split('-');
		const year = Number(yearRaw);
		const month = Number(monthRaw);
		const day = Number(dayRaw);
		if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
		const parsed = new Date(year, month - 1, day);
		return (
			parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
		);
	}

	async function saveCalendarEvent() {
		if (calendarEventSaveInProgress || !calendarPopupDayIso) return;
		calendarAddEventError = '';

		const scopeShiftId =
			calendarPopupScope === 'shift'
				? calendarPopupShiftId
				: calendarPopupScope === 'user'
					? calendarPopupUserScopeShiftId()
					: null;

		if (calendarPopupScope === 'shift' && !scopeShiftId) {
			calendarAddEventError = 'Please select a shift.';
			return;
		}
		if (calendarPopupScope === 'user' && !calendarPopupUserOid) {
			calendarAddEventError = 'Please select a user.';
			return;
		}
		if (calendarPopupScope === 'user' && !scopeShiftId) {
			calendarAddEventError = 'Please select a shift.';
			return;
		}

		const isCustomCode = calendarAddEventCodeId === 'custom';
		if (!isIsoDate(calendarAddEventStartDate) || !isIsoDate(calendarAddEventEndDate)) {
			calendarAddEventError = 'Please choose a valid start and end date.';
			return;
		}
		if (calendarAddEventEndDate < calendarAddEventStartDate) {
			calendarAddEventError = 'End date cannot be before start date.';
			return;
		}

		let coverageCodeId: number | null = null;
		let customCode: string | null = null;
		let customName: string | null = null;
		let customDisplayMode: EventDisplayMode | null = null;
		let customColor: string | null = null;

		if (isCustomCode) {
			const normalizedCode = calendarAddCustomEventCode.trim().toUpperCase().replace(/\s+/g, '-');
			if (!normalizedCode) {
				calendarAddEventError = 'Custom event code is required.';
				return;
			}
			if (!/^[A-Z0-9_-]{1,16}$/.test(normalizedCode)) {
				calendarAddEventError = 'Custom event code must be 1-16 chars using A-Z, 0-9, _ or -.';
				return;
			}
			const normalizedColor = calendarAddCustomEventColor.trim().toLowerCase();
			if (!/^#[0-9a-f]{6}$/.test(normalizedColor)) {
				calendarAddEventError = 'Custom event color must be a valid hex value.';
				return;
			}
			customCode = normalizedCode;
			customName = calendarAddCustomEventName.trim() || normalizedCode;
			customDisplayMode = calendarAddCustomEventDisplayMode;
			customColor = normalizedColor;
		} else {
			const selectedCodeId = Number(calendarAddEventCodeId);
			if (!Number.isInteger(selectedCodeId) || selectedCodeId <= 0) {
				calendarAddEventError = 'Please select an event code.';
				return;
			}
			const eventCode = calendarEventCodeOptions.find((item) => item.eventCodeId === selectedCodeId);
			if (!eventCode) {
				calendarAddEventError = 'Selected event code is no longer available.';
				return;
			}
			coverageCodeId = eventCode.eventCodeId;
		}

		const payload: Record<string, unknown> = {
			scope: calendarPopupScope,
			employeeTypeId: scopeShiftId,
			userOid: calendarPopupScope === 'user' ? calendarPopupUserOid : null,
			startDate: calendarAddEventStartDate,
			endDate: calendarAddEventEndDate,
			comments: calendarAddEventComments.trim(),
			coverageCodeId,
			notifyImmediately: calendarAddReminderImmediate,
			scheduledReminders: calendarAddReminderScheduled
				? calendarScheduledReminderDrafts.map((reminderDraft) => ({
						amount: reminderDraft.amount,
						unit: reminderDraft.unit,
						hour: reminderDraft.hour,
						meridiem: reminderDraft.meridiem
					}))
				: []
		};

		if (customCode) {
			payload.customCode = customCode;
			payload.customName = customName;
			payload.customDisplayMode = customDisplayMode;
			payload.customColor = customColor;
		}

		const isEditing = calendarPopupMode === 'edit' && calendarPopupEditingEventId !== null;
		if (isEditing) {
			const expectedVersionStamp = calendarPopupEditingEventVersionStamp.trim();
			if (!expectedVersionStamp) {
				calendarAddEventError = 'This event can no longer be edited. Refresh and try again.';
				return;
			}
			payload.eventId = calendarPopupEditingEventId;
			payload.expectedVersionStamp = expectedVersionStamp;
		}

		calendarEventSaveInProgress = true;
		try {
			const result = await fetchWithAuthRedirect(
				`${base}/api/team/events`,
				{
					method: isEditing ? 'PATCH' : 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify(payload)
				},
				base
			);
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to save event'));
			}

			calendarDayDetailsCache = {};
			await refreshScheduleInBackground();
			calendarPopupData = await loadCalendarDayDetails(calendarPopupDayIso);
			calendarPopupMode = 'list';
			resetCalendarEventForm();
		} catch (error) {
			calendarAddEventError = error instanceof Error ? error.message : 'Failed to save event';
		} finally {
			calendarEventSaveInProgress = false;
		}
	}

	async function removeCalendarEvent() {
		if (calendarEventSaveInProgress || calendarPopupEditingEventId === null) return;
		const expectedVersionStamp = calendarPopupEditingEventVersionStamp.trim();
		if (!expectedVersionStamp) {
			calendarAddEventError = 'This event can no longer be removed. Refresh and try again.';
			return;
		}
		calendarAddEventError = '';
		calendarEventSaveInProgress = true;
		try {
			const result = await fetchWithAuthRedirect(
				`${base}/api/team/events`,
				{
					method: 'DELETE',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({
						eventId: calendarPopupEditingEventId,
						expectedVersionStamp
					})
				},
				base
			);
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to remove event'));
			}

			calendarDayDetailsCache = {};
			await refreshScheduleInBackground();
			calendarPopupData = await loadCalendarDayDetails(calendarPopupDayIso);
			calendarPopupMode = 'list';
			resetCalendarEventForm();
		} catch (error) {
			calendarAddEventError = error instanceof Error ? error.message : 'Failed to remove event';
		} finally {
			calendarEventSaveInProgress = false;
		}
	}

	function cloneCollapsedBySchedule(
		source: Record<number, Record<string, boolean>>
	): Record<number, Record<string, boolean>> {
		const output: Record<number, Record<string, boolean>> = {};
		for (const [scheduleId, groupState] of Object.entries(source)) {
			output[Number(scheduleId)] = { ...(groupState ?? {}) };
		}
		return output;
	}

	function groupCollapseKey(group: Group): string {
		if (typeof group.employeeTypeId === 'number' && Number.isInteger(group.employeeTypeId)) {
			return `shift:${group.employeeTypeId}`;
		}
		return `name:${group.category.trim().toLowerCase()}`;
	}

	function groupLegacyCollapseKey(groupName: string): string {
		return groupName.trim();
	}

	function updateSessionCollapsedState(
		scheduleId: number,
		groupKey: string,
		collapsedState: boolean
	) {
		const nextScheduleState = {
			...(sessionCollapsedBySchedule[scheduleId] ?? {}),
			[groupKey]: collapsedState
		};
		sessionCollapsedBySchedule = {
			...sessionCollapsedBySchedule,
			[scheduleId]: nextScheduleState
		};
	}

	function updatePersistedCollapsedState(
		scheduleId: number,
		groupKey: string,
		collapsedState: boolean
	) {
		const nextScheduleState = {
			...(persistedCollapsedBySchedule[scheduleId] ?? {}),
			[groupKey]: collapsedState
		};
		persistedCollapsedBySchedule = {
			...persistedCollapsedBySchedule,
			[scheduleId]: nextScheduleState
		};
	}

	function missingPersistedCollapseKeys(scheduleId: number, nextGroups: Group[]): string[] {
		const persisted = persistedCollapsedBySchedule[scheduleId] ?? {};
		const missingKeys: string[] = [];
		for (const group of nextGroups) {
			const key = groupCollapseKey(group);
			const legacyKey = groupLegacyCollapseKey(group.category);
			if (!(key in persisted) && !(legacyKey in persisted)) {
				missingKeys.push(key);
			}
		}
		return missingKeys;
	}

	function currentCollapsedForGroup(
		scheduleId: number,
		group: Group,
		sessionState: Record<number, Record<string, boolean>> = sessionCollapsedBySchedule
	): boolean {
		const key = groupCollapseKey(group);
		const legacyKey = groupLegacyCollapseKey(group.category);
		const scheduleState = sessionState[scheduleId] ?? {};
		if (key in scheduleState) return scheduleState[key] === true;
		if (legacyKey in scheduleState) return scheduleState[legacyKey] === true;
		return false;
	}

	function toggleGroup(group: Group) {
		if (activeScheduleId === null) return;
		const key = groupCollapseKey(group);
		const nextCollapsed = !currentCollapsedForGroup(activeScheduleId, group);
		updateSessionCollapsedState(activeScheduleId, key, nextCollapsed);
		updatePersistedCollapsedState(activeScheduleId, key, nextCollapsed);
		void persistCollapsedGroupPreference(activeScheduleId, key, nextCollapsed);
	}

	async function persistCollapsedGroupPreference(
		scheduleId: number,
		groupKey: string,
		collapsedState: boolean
	): Promise<boolean> {
		try {
			const response = await fetch(`${base}/api/schedules/collapsed-groups`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({
					scheduleId,
					groupKey,
					collapsed: collapsedState
				})
			});
			if (!response.ok) {
				throw new Error('Failed to persist collapsed-group preference');
			}
			return true;
		} catch {
			// ignore save failures and keep the local UI state
			return false;
		}
	}

	async function ensurePersistedCollapsedDefaults(scheduleId: number, nextGroups: Group[]) {
		const existingSyncState = collapsedDefaultsSyncStateBySchedule[scheduleId] ?? 'idle';
		if (existingSyncState === 'syncing' || existingSyncState === 'synced') return;
		const missingKeys = missingPersistedCollapseKeys(scheduleId, nextGroups);
		if (missingKeys.length === 0) {
			collapsedDefaultsSyncStateBySchedule = {
				...collapsedDefaultsSyncStateBySchedule,
				[scheduleId]: 'synced'
			};
			return;
		}

		collapsedDefaultsSyncStateBySchedule = {
			...collapsedDefaultsSyncStateBySchedule,
			[scheduleId]: 'syncing'
		};
		for (const key of missingKeys) {
			updatePersistedCollapsedState(scheduleId, key, false);
		}

		try {
			const results = await Promise.all(
				missingKeys.map((groupKey) => persistCollapsedGroupPreference(scheduleId, groupKey, false))
			);
			const status: 'idle' | 'synced' = results.every((result) => result) ? 'synced' : 'idle';
			collapsedDefaultsSyncStateBySchedule = {
				...collapsedDefaultsSyncStateBySchedule,
				[scheduleId]: status
			};
		} catch {
			collapsedDefaultsSyncStateBySchedule = {
				...collapsedDefaultsSyncStateBySchedule,
				[scheduleId]: 'idle'
			};
		}
	}

	function openTeamSetup() {
		if (!canMaintainTeam) return;
		teamSetupOpen = true;
	}

	function closeTeamSetup() {
		teamSetupOpen = false;
	}

	async function openScheduleSetup() {
		if (!canOpenScheduleSetup) return;
		await refreshScheduleContextInBackground();
		scheduleSetupOpen = true;
	}

	function closeScheduleSetup() {
		scheduleSetupOpen = false;
	}

	function resetOnboardingModalToServerSlides() {
		onboardingSlidesSource = 'auto';
		onboardingSlidesForModal = onboarding.slides;
		onboardingTargetTierForModal = onboarding.targetTier;
	}

	async function openOnboardingFromHelp() {
		if (onboardingSaving) return;
		onboardingSaveError = '';
		try {
			const response = await fetchWithAuthRedirect(
				`${base}/api/onboarding/slides`,
				{ headers: { accept: 'application/json' } },
				base
			);
			if (!response) return;
			if (!response.ok) {
				onboardingSaveError = 'Unable to load onboarding steps. Please try again.';
				return;
			}
			const payload = (await response.json().catch(() => null)) as
				| { slides?: OnboardingSlide[]; targetTier?: number; currentTier?: number }
				| null;
			const fetchedSlides = Array.isArray(payload?.slides) ? payload.slides : [];
			const fetchedTargetTier = Number.isInteger(payload?.targetTier)
				? Number(payload?.targetTier)
				: onboarding.targetTier;
			const fetchedCurrentTier = Number.isInteger(payload?.currentTier)
				? Number(payload?.currentTier)
				: onboardingCurrentTierState;
			onboardingSlidesSource = 'manual';
			onboardingSlidesForModal = fetchedSlides;
			onboardingTargetTierForModal = Math.max(0, Math.min(3, fetchedTargetTier));
			onboardingCurrentTierState = Math.max(
				onboardingCurrentTierState,
				Math.max(0, Math.min(3, fetchedCurrentTier))
			);
			onboardingSlideIndex = 0;
			onboardingDontShowAgain = false;
			onboardingDismissedForSession = false;
			onboardingOpen = onboardingSlidesForModal.length > 0;
			if (!onboardingOpen) {
				resetOnboardingModalToServerSlides();
			}
		} catch {
			onboardingSaveError = 'Unable to load onboarding steps. Please try again.';
		}
	}

	async function persistOnboardingToTargetRole(): Promise<boolean> {
		if (onboardingSaving || onboardingTargetTierForModal <= onboardingCurrentTierState) {
			return true;
		}
		onboardingSaving = true;
		onboardingSaveError = '';
		try {
			const response = await fetchWithAuthRedirect(
				`${base}/api/onboarding/role`,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ onboardingRole: onboardingTargetTierForModal })
				},
				base
			);
			if (!response || !response.ok) {
				onboardingSaveError = 'Unable to save onboarding progress. Please try again.';
				return false;
			}
			onboardingCurrentTierState = Math.max(
				onboardingCurrentTierState,
				onboardingTargetTierForModal
			);
			return true;
		} finally {
			onboardingSaving = false;
		}
	}

	async function handleOnboardingClose(event: CustomEvent<{ markComplete: boolean }>) {
		const shouldMarkComplete = Boolean(event.detail?.markComplete);
		if (shouldMarkComplete) {
			const success = await persistOnboardingToTargetRole();
			if (!success) return;
		}
		onboardingOpen = false;
		onboardingDismissedForSession = true;
		onboardingDontShowAgain = false;
		onboardingSaveError = '';
		resetOnboardingModalToServerSlides();
	}

	async function handleOnboardingComplete() {
		const success = await persistOnboardingToTargetRole();
		if (!success) return;
		onboardingOpen = false;
		onboardingDismissedForSession = true;
		onboardingDontShowAgain = false;
		onboardingSaveError = '';
		resetOnboardingModalToServerSlides();
	}

	function closeDisplayNameEditor(force = false) {
		if (displayNameEditorSaving && !force) return;
		displayNameEditorOpen = false;
		displayNameEditorUserOid = '';
		displayNameEditorCurrentName = '';
		displayNameEditorDraft = '';
		displayNameEditorError = '';
	}

	function normalizeOid(value: string | null | undefined): string {
		return value?.trim().toLowerCase() ?? '';
	}

	function canEditDisplayName(employee: Employee): boolean {
		const employeeOid = employee.userOid?.trim();
		if (!employeeOid) return false;
		return normalizeOid(employeeOid) === normalizeOid(currentUserOid);
	}

	function openDisplayNameEditor(employee: Employee) {
		if (!canEditDisplayName(employee)) return;
		const userOid = employee.userOid?.trim();
		if (!userOid) return;
		displayNameEditorUserOid = userOid;
		displayNameEditorCurrentName = employee.name.trim();
		displayNameEditorDraft = employee.name.trim();
		displayNameEditorError = '';
		displayNameEditorOpen = true;
	}

	async function saveDisplayName() {
		if (!displayNameEditorOpen || displayNameEditorSaving) return;
		const nextDisplayName = displayNameEditorDraft.trim();
		if (!nextDisplayName) {
			displayNameEditorError = 'Display name is required.';
			return;
		}

		displayNameEditorSaving = true;
		displayNameEditorError = '';
		try {
			const response = await fetchWithAuthRedirect(
				`${base}/api/team/display-name`,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({
						userOid: displayNameEditorUserOid,
						displayName: nextDisplayName
					})
				},
				base
			);
			if (!response) return;
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message?.trim() || 'Failed to update display name');
			}
			closeDisplayNameEditor(true);
			await refreshScheduleInBackground();
		} catch (error) {
			displayNameEditorError =
				error instanceof Error && error.message.trim().length > 0
					? error.message
					: 'Failed to update display name';
		} finally {
			displayNameEditorSaving = false;
		}
	}

	async function loadScheduleGroupsForMonth(
		year: number,
		monthIndex: number,
		withTransition = false
		) {
			if (!browser || activeScheduleId === null) {
				scheduleGroups = [];
				scheduleEvents = [];
				loadedScheduleEventsMonthKey = '';
				scheduleGroupsLoaded = true;
				isScheduleTransitioning = false;
				return;
			}

		scheduleGroupsRequestId += 1;
		const requestId = scheduleGroupsRequestId;
		if (withTransition) {
			isScheduleTransitioning = true;
		}
		try {
			const response = await fetch(
				`${base}/api/schedule/month?year=${year}&monthIndex=${monthIndex}`,
				{ headers: { accept: 'application/json' } }
			);
			if (requestId !== scheduleGroupsRequestId) return;
			if (!response.ok) {
				if (response.status === 400 || response.status === 403) {
					await goto(`${base}/`, { invalidateAll: true, replaceState: true, noScroll: true });
					}
					scheduleGroups = [];
					scheduleEvents = [];
					loadedScheduleEventsMonthKey = '';
					scheduleGroupsLoaded = true;
					return;
				}
				const payload = (await response.json()) as {
					groups?: Group[];
					events?: ScheduleEvent[];
				};
					scheduleGroups = Array.isArray(payload.groups) ? payload.groups : [];
						scheduleEvents = (Array.isArray(payload.events) ? payload.events : []).map((eventRow) => ({
							...eventRow,
							eventDisplayMode: normalizeEventDisplayMode(eventRow.eventDisplayMode)
						}));
						loadedScheduleEventsMonthKey = `${year}-${monthIndex}`;
				if (activeScheduleId !== null) {
					void ensurePersistedCollapsedDefaults(activeScheduleId, scheduleGroups);
				}
			scheduleGroupsLoaded = true;
			} catch {
				if (requestId !== scheduleGroupsRequestId) return;
				scheduleGroups = [];
				scheduleEvents = [];
				loadedScheduleEventsMonthKey = '';
				scheduleGroupsLoaded = true;
			} finally {
			if (withTransition && requestId === scheduleGroupsRequestId) {
				await tick();
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				if (requestId === scheduleGroupsRequestId) {
					isScheduleTransitioning = false;
				}
			}
		}
	}

	async function refreshScheduleInBackground() {
		await Promise.all([
			loadScheduleGroupsForMonth(selectedYear, selectedMonthIndex),
			refreshScheduleContextInBackground()
		]);
	}

	function syncCollapsedWithGroups(scheduleId: number, nextGroups: Group[]) {
		const nextScheduleState = { ...(sessionCollapsedBySchedule[scheduleId] ?? {}) };
		let changed = false;
		for (const group of nextGroups) {
			const key = groupCollapseKey(group);
			const legacyKey = groupLegacyCollapseKey(group.category);
			if (!(key in nextScheduleState)) {
				if (legacyKey in nextScheduleState) {
					nextScheduleState[key] = nextScheduleState[legacyKey] === true;
				} else {
					nextScheduleState[key] = false;
				}
				changed = true;
			}
		}
		if (changed) {
			sessionCollapsedBySchedule = {
				...sessionCollapsedBySchedule,
				[scheduleId]: nextScheduleState
			};
		}
	}

	$: effectiveGroups = scheduleGroupsLoaded ? scheduleGroups : groups;
	$: {
		const sessionStateSnapshot = sessionCollapsedBySchedule;
		if (activeScheduleId === null) {
			collapsed = {};
		} else {
			syncCollapsedWithGroups(activeScheduleId, effectiveGroups);
			collapsed = Object.fromEntries(
				effectiveGroups.map((group) => [
					group.category,
					currentCollapsedForGroup(activeScheduleId, group, sessionStateSnapshot)
				])
			);
		}
	}
	$: scheduleLoadKey = `${activeScheduleId ?? 'none'}:${selectedYear}-${selectedMonthIndex}`;
	$: if (browser && scheduleLoadKey) {
		const monthViewKey = `${selectedYear}-${selectedMonthIndex}`;
		const withTransition = monthViewKey !== lastRequestedMonthViewKey;
		lastRequestedMonthViewKey = monthViewKey;
		void loadScheduleGroupsForMonth(selectedYear, selectedMonthIndex, withTransition);
	}
	$: if (scheduleLoadKey) {
		calendarDayDetailsCache = {};
		if (calendarPopupOpen && calendarPopupDayIso) {
			const [yearRaw, monthRaw] = calendarPopupDayIso.split('-');
			if (
				Number(yearRaw) !== selectedYear ||
				Number(monthRaw) !== selectedMonthIndex + 1
			) {
				closeCalendarDayPopup();
			}
		}
	}

	onMount(() => {
		document.body.classList.add('app-shell-route');
		setToToday();
		sessionCollapsedBySchedule = cloneCollapsedBySchedule(collapsedGroupsBySchedule);
		persistedCollapsedBySchedule = cloneCollapsedBySchedule(collapsedGroupsBySchedule);
		systemTheme = resolveSystemTheme();
		setThemePreferenceState(themePreference);

		let themeMediaQuery: MediaQueryList | null = null;
		let hoverCapabilityMediaQuery: MediaQueryList | null = null;
		const handleSystemThemeChange = (event: MediaQueryListEvent) => {
			systemTheme = event.matches ? 'dark' : 'light';
			if (themePreferenceState === 'system') {
				setTheme(systemTheme);
			}
		};
		const applyHoverCapability = () => {
			const canHover =
				typeof window !== 'undefined' &&
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(hover: hover) and (pointer: fine)').matches;
			canUseHoverTooltips = canHover;
			if (!canHover) {
				hideCalendarHoverTooltip();
			}
		};
		if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
			themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
			hoverCapabilityMediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
			applyHoverCapability();
			if (typeof themeMediaQuery.addEventListener === 'function') {
				themeMediaQuery.addEventListener('change', handleSystemThemeChange);
			} else {
				themeMediaQuery.addListener(handleSystemThemeChange);
			}
			if (typeof hoverCapabilityMediaQuery.addEventListener === 'function') {
				hoverCapabilityMediaQuery.addEventListener('change', applyHoverCapability);
			} else {
				hoverCapabilityMediaQuery.addListener(applyHoverCapability);
			}
		}

		applyActiveScheduleTheme();
		lastAppliedThemeSignature = activeScheduleThemeSignature;
		initialThemeReady = true;
		if (onboarding.slides.length > 0 && !onboardingDismissedForSession) {
			onboardingSlidesSource = 'auto';
			onboardingSlidesForModal = onboarding.slides;
			onboardingTargetTierForModal = onboarding.targetTier;
			onboardingOpen = true;
		}
		scheduleContextPollTimer = setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			void refreshScheduleInBackground();
		}, 30000);
		const handleVisibilityOrFocus = () => {
			if (document.visibilityState === 'visible') {
				void refreshScheduleInBackground();
			}
		};
		document.addEventListener('visibilitychange', handleVisibilityOrFocus);
		window.addEventListener('focus', handleVisibilityOrFocus);
		requestAnimationFrame(updateAppScrollbar);
		const onResize = () => {
			updateAppScrollbar();
			updateCalendarScrollbars();
		};
		window.addEventListener('resize', onResize);
		return () => {
			if (scheduleContextPollTimer) {
				clearInterval(scheduleContextPollTimer);
				scheduleContextPollTimer = null;
			}
			document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
			window.removeEventListener('focus', handleVisibilityOrFocus);
			window.removeEventListener('resize', onResize);
			if (themeMediaQuery) {
				if (typeof themeMediaQuery.removeEventListener === 'function') {
					themeMediaQuery.removeEventListener('change', handleSystemThemeChange);
				} else {
					themeMediaQuery.removeListener(handleSystemThemeChange);
				}
			}
			if (hoverCapabilityMediaQuery) {
				if (typeof hoverCapabilityMediaQuery.removeEventListener === 'function') {
					hoverCapabilityMediaQuery.removeEventListener('change', applyHoverCapability);
				} else {
					hoverCapabilityMediaQuery.removeListener(applyHoverCapability);
				}
			}
		};
	});

	afterUpdate(() => {
		if (typeof window !== 'undefined') {
			requestAnimationFrame(() => {
				updateAppScrollbar();
				updateCalendarScrollbars();
				updateCalendarPopupModalScrollbar();
				if (calendarPopupScopeOptionsOpen) {
					updateCalendarPopupScopeOptionsScrollbar();
				}
			});
		}
	});

	onDestroy(() => {
		stopAppDragging();
		stopCalendarHorizontalDragging();
		stopCalendarVerticalDragging();
		stopCalendarPopupModalDragging();
		stopCalendarPopupScopeOptionsDragging();
		cancelCalendarHoverHide();
		if (typeof document !== 'undefined') {
			document.body.classList.remove('app-shell-route');
		}
	});

	$: if (
		initialThemeReady &&
		onboarding.slides.length > 0 &&
		!onboardingDismissedForSession &&
		!onboardingOpen
	) {
		onboardingSlidesSource = 'auto';
		onboardingSlidesForModal = onboarding.slides;
		onboardingTargetTierForModal = onboarding.targetTier;
		onboardingOpen = true;
	}
	$: if (
		onboardingSlidesSource === 'auto' &&
		!onboardingOpen &&
		onboardingSlidesForModal !== onboarding.slides
	) {
		onboardingSlidesForModal = onboarding.slides;
		onboardingTargetTierForModal = onboarding.targetTier;
	}
	$: onboardingCurrentTierState = Math.max(onboardingCurrentTierState, onboarding.currentTier);
	$: if (onboardingSlideIndex >= onboardingSlidesForModal.length) {
		onboardingSlideIndex = Math.max(0, onboardingSlidesForModal.length - 1);
	}
</script>

{#if !initialThemeReady}
	<div class="appLoading" role="status" aria-live="polite">
		<div class="appLoadingCard">
			<div class="appLoadingSpinner" aria-hidden="true"></div>
			<div>Loading Schedule...</div>
		</div>
	</div>
{:else}
	<div class="app">
		<div class="card">
			<div class="cardScroll" bind:this={cardScrollEl} on:scroll={onCardScroll}>
				<div class="topbar">
					<div class="topbarTitleSlot">
						{#if canOpenScheduleSetup}
							<button
								type="button"
								class="title titleButton"
								on:click={openScheduleSetup}
								aria-label="Open schedule setup"
							>
								{scheduleName}
							</button>
						{:else}
							<div class="title">{scheduleName}</div>
						{/if}
					</div>
					<div class="topbarCenter">
						<MonthYearBar
							{selectedMonthIndex}
							{selectedYear}
							showCalendarIcon={showScheduleGridView}
							onMonthSelect={setSelectedMonthIndex}
							onYearSelect={setSelectedYear}
							onToggleView={toggleScheduleView}
						/>
					</div>
					<div class="topbarActions">
						<ThemeToggle
							mode="cycle"
							themePreference={themePreferenceState}
							effectiveTheme={theme}
							onToggle={toggleTheme}
						/>
						<button
							type="button"
							class="onboardingHelpBtn"
							aria-label="Open onboarding guide"
							title="Open onboarding guide"
							on:click={openOnboardingFromHelp}
						>
							?
						</button>
					</div>
				</div>

				{#if showLegend}
					<div class="legend" aria-label="Legend">
						<span class="pill work"><span class="dot"></span>WORK</span>
						<span class="pill off"><span class="dot"></span>OFF</span>
						<span class="pill vac"><span class="dot"></span>VAC</span>
						<span class="pill hldy"><span class="dot"></span>HLDY</span>
						<span class="pill oot"><span class="dot"></span>OOT</span>
					</div>
				{/if}

				<div class="scheduleViewport">
					{#if showScheduleGridView}
						<ScheduleGrid
							groups={effectiveGroups}
							events={scheduleEvents}
							{overrides}
							{collapsed}
							{monthDays}
							{selectedYear}
							{selectedMonthIndex}
							{theme}
							{popupResetToken}
							onToggleGroup={toggleGroup}
							{canMaintainTeam}
							onTeamClick={openTeamSetup}
							onEmployeeDoubleClick={openDisplayNameEditor}
							onScheduleRefresh={refreshScheduleInBackground}
						/>
					{:else}
						<div class="monthCalendarShell">
							<div class="monthCalendarScrollViewport" bind:this={calendarScrollEl} on:scroll={onCalendarScroll}>
								<section class="monthCalendarView" aria-label="Month calendar view">
									<div class="monthCalendarWeekdays" aria-hidden="true">
										{#each dowLong as dayLabel, index (dayLabel)}
											<div class="monthCalendarWeekday">
												<span class="monthCalendarWeekdayLong">{dayLabel}</span>
												<span class="monthCalendarWeekdayShort">{dowShort[index]}</span>
											</div>
										{/each}
									</div>
									<div
										class="monthCalendarGrid"
										style={`--month-calendar-week-count:${monthCalendarWeekCount};`}
									>
									{#each monthCalendarLeadingIndices as index (index)}
										<div class="monthCalendarSpacer" aria-hidden="true"></div>
									{/each}
									{#each monthDays as day (`${selectedYear}-${selectedMonthIndex}-${day.day}-${monthIndicatorRenderVersion}`)}
										<article
											class="monthCalendarCell"
											class:weekend={day.isWeekend}
											class:today={day.isToday}
											on:mouseenter={(event) => {
												cancelCalendarHoverHide();
												if (monthDayIndicators(day.day).length === 0) {
													hideCalendarHoverTooltip();
													return;
												}
												void showCalendarHoverTooltip(day.day, {
													clientX: event.clientX,
													clientY: event.clientY
												});
											}}
											on:mousemove={(event) => {
												cancelCalendarHoverHide();
												if (monthDayIndicators(day.day).length === 0) {
													hideCalendarHoverTooltip();
													return;
												}
												if (!calendarHoverTooltipOpen) return;
												positionCalendarHoverTooltip(event.clientX, event.clientY);
											}}
											on:mouseleave={scheduleCalendarHoverHide}
											on:contextmenu|preventDefault={() => {
												void openCalendarDayPopup(day.day);
											}}
											>
												<div class="monthCalendarCellDay">{day.day}</div>
												<div class="monthCalendarIndicators" aria-hidden="true">
													{#if monthDayIndicators(day.day).length === 0}
														<span class="monthCalendarNoEvents">No Events</span>
													{:else}
															{#each monthDayIndicators(day.day) as eventIndicator (`${day.day}-${eventIndicator.eventId}`)}
																<span
																	class={`monthCalendarIndicator ${indicatorDisplayModeClass(eventIndicator.eventDisplayMode)}`}
																	style={`background:${eventIndicator.eventCodeColor};`}
																title={eventIndicator.eventDisplayMode}
															></span>
														{/each}
												{/if}
											</div>
										</article>
									{/each}
									{#each monthCalendarTrailingIndices as index (index)}
										<div class="monthCalendarSpacer" aria-hidden="true"></div>
									{/each}
								</div>
								</section>
							</div>
							{#if showCalendarHorizontalScrollbar}
								<div
									class="monthCalendarScrollRailHorizontal"
									role="presentation"
									aria-hidden="true"
									bind:this={calendarHorizontalRailEl}
									on:mousedown={handleCalendarHorizontalRailClick}
								>
									<div
										class="monthCalendarScrollThumbHorizontal"
										class:dragging={isDraggingCalendarHorizontalScrollbar}
										role="presentation"
										style={`width:${calendarHorizontalThumbWidthPx}px;transform:translateX(${calendarHorizontalThumbLeftPx}px);`}
										on:mousedown={startCalendarHorizontalThumbDrag}
									></div>
								</div>
							{/if}
							{#if showCalendarVerticalScrollbar}
								<div
									class="monthCalendarScrollRailVertical"
									role="presentation"
									aria-hidden="true"
									bind:this={calendarVerticalRailEl}
									on:mousedown={handleCalendarVerticalRailClick}
								>
									<div
										class="monthCalendarScrollThumbVertical"
										class:dragging={isDraggingCalendarVerticalScrollbar}
										role="presentation"
										style={`height:${calendarVerticalThumbHeightPx}px;transform:translateY(${calendarVerticalThumbTopPx}px);`}
										on:mousedown={startCalendarVerticalThumbDrag}
									></div>
								</div>
							{/if}
						</div>
						{/if}
					{#if isScheduleTransitioning}
						<div class="scheduleViewportLoading" role="status" aria-live="polite">
							<div class="appLoadingCard">
								<div class="appLoadingSpinner scheduleViewportSpinner" aria-hidden="true"></div>
								<div>Loading Schedule...</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
			{#if showAppScrollbar}
				<div
					class="appScrollRail"
					role="presentation"
					aria-hidden="true"
					bind:this={appRailEl}
					on:mousedown={handleAppRailClick}
				>
					<div
						class="appScrollThumb"
						class:dragging={isDraggingAppScrollbar}
						role="presentation"
						style={`height:${appThumbHeightPx}px;transform:translateY(${appThumbTopPx}px);`}
						on:mousedown={startAppThumbDrag}
					></div>
				</div>
			{/if}
			</div>
		</div>

		{#if calendarHoverTooltipOpen}
			<div
				class="monthCalendarHoverTooltip"
				role="status"
				aria-live="polite"
				style={`left:${calendarHoverTooltipLeftPx}px;top:${calendarHoverTooltipTopPx}px;`}
				bind:this={calendarHoverTooltipEl}
				on:mouseenter={cancelCalendarHoverHide}
				on:mouseleave={scheduleCalendarHoverHide}
			>
				<div class="monthCalendarHoverTooltipTitle">{calendarHoverTooltipTitle}</div>
				{#if calendarHoverTooltipLoading}
					<div class="monthCalendarEventEmptyRow">Loading events...</div>
				{:else}
					<div class="monthCalendarEventRows">
						{#if calendarHoverTooltipEntries.length === 0}
							<div class="monthCalendarEventEmptyRow">No Events</div>
						{:else}
								{#each calendarHoverTooltipEntries as eventRow (eventRow.eventId)}
									<div class="monthCalendarEventRow">
										<div class="monthCalendarEventCodeLine">
											<span
												class={`monthCalendarEventColorDot ${indicatorDisplayModeClass(eventRow.eventDisplayMode)}`}
												style={`background:${eventRow.eventCodeColor};`}
												aria-hidden="true"
											></span>
										<strong>{eventRow.eventCodeCode}</strong>
										<span>{eventRow.eventCodeName} - {eventScopeSuffix(eventRow, calendarHoverTooltipData)}</span>
									</div>
									{#if eventRow.startDate !== eventRow.endDate}
										<div class="monthCalendarEventDates">
											{formatEventDateOrRange(eventRow.startDate, eventRow.endDate)}
										</div>
									{/if}
									{#if eventRow.comments}
										<div class="monthCalendarEventComment">{eventRow.comments}</div>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		{#if calendarPopupOpen}
			<div
				class="displayNameModalBackdrop"
				role="presentation"
				on:mousedown={handleCalendarPopupBackdropMouseDown}
			>
				<div
					class="displayNameModal monthCalendarEventsModal"
					role="dialog"
					aria-modal="true"
					aria-labelledby="month-calendar-events-title"
					on:mousedown={handleCalendarPopupMouseDown}
				>
					<div
						class="monthCalendarEventsModalScroll"
						class:hasScrollbar={showCalendarPopupModalScrollbar}
						bind:this={calendarPopupModalScrollEl}
						on:scroll={onCalendarPopupModalScroll}
					>
					<h2 id="month-calendar-events-title">{calendarPopupTitle}</h2>
							{#if calendarPopupMode === 'list'}
							<div class="monthCalendarEventRows">
								{#if calendarPopupLoading}
									<div class="monthCalendarEventEmptyRow">Loading events...</div>
								{:else if calendarPopupError}
									<div class="monthCalendarEventError" role="alert">{calendarPopupError}</div>
								{:else if calendarPopupEvents().length === 0}
									<div class="monthCalendarEventEmptyRow">No Events</div>
									{#if canMaintainTeam}
										<button
											type="button"
											class="monthCalendarEventAddRowBtn"
											aria-label="Add event"
											on:click={() => void openCalendarAddEventView()}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								{:else}
									{#each calendarPopupEvents() as eventRow (eventRow.eventId)}
										<div
											class={`monthCalendarEventRow${canMaintainTeam ? ' editable' : ''}`}
											role={canMaintainTeam ? 'button' : undefined}
											tabindex={canMaintainTeam ? 0 : undefined}
											aria-label={canMaintainTeam ? `Edit event ${eventRow.eventCodeCode}` : undefined}
											on:click={() => {
												if (canMaintainTeam) void openCalendarEditEventView(eventRow);
											}}
											on:keydown={(event) => {
												if (!canMaintainTeam) return;
												if (event.key === 'Enter' || event.key === ' ') {
													event.preventDefault();
													void openCalendarEditEventView(eventRow);
												}
											}}
										>
											<div class="monthCalendarEventCodeLine">
												<span
													class={`monthCalendarEventColorDot ${indicatorDisplayModeClass(eventRow.eventDisplayMode)}`}
													style={`background:${eventRow.eventCodeColor};`}
													aria-hidden="true"
												></span>
												<strong>{eventRow.eventCodeCode}</strong>
												<span>{eventRow.eventCodeName} - {eventScopeSuffix(eventRow, calendarPopupData)}</span>
											</div>
											{#if eventRow.startDate !== eventRow.endDate}
												<div class="monthCalendarEventDates">
													{formatEventDateOrRange(eventRow.startDate, eventRow.endDate)}
												</div>
											{/if}
											{#if eventRow.comments}
												<div class="monthCalendarEventComment">{eventRow.comments}</div>
											{/if}
											{#if canMaintainTeam}
												<div class="monthCalendarEventEditOverlay" aria-hidden="true">
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path
															d="M2.75 21.25l3.85-.96L18.83 8.06l-2.89-2.89L3.71 17.4l-.96 3.85z M16.98 3.88L19.87 6.77L20.91 5.73A2.0435 2.0435 0 0 0 18.02 2.84Z"
															fill="currentColor"
															fill-rule="evenodd"
															clip-rule="evenodd"
														/>
													</svg>
											</div>
										{/if}
									</div>
								{/each}
									{#if canMaintainTeam}
										<button
											type="button"
											class="monthCalendarEventAddRowBtn"
											aria-label="Add event"
											on:click={() => void openCalendarAddEventView()}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								{/if}
							</div>
							<div class="displayNameModalActions">
								<button type="button" class="btn actionBtn" on:click={closeCalendarDayPopup}>Close</button>
							</div>
						{:else}
							<div
								class="monthCalendarScopeRow memberEventField"
								class:hasScopeSelector={calendarPopupScope !== 'global'}
							>
								<span class="memberEventFieldLabel">Scope</span>
								<button
									type="button"
									class="btn actionBtn monthCalendarScopeBtn"
									on:click={cycleCalendarPopupScope}
								>
									{calendarPopupScopeLabel(calendarPopupScope)}
								</button>
									{#if calendarPopupScope !== 'global'}
										{#key `${calendarPopupScope}-${calendarPopupScopeInputResetToken}`}
											<div
												class="setupUserCombo monthCalendarScopeCombo monthCalendarScopeSelectorCombo"
												role="combobox"
												aria-expanded={calendarPopupScopeOptionsOpen}
												bind:this={calendarPopupScopeComboEl}
												on:mousedown={onCalendarPopupScopeComboMouseDown}
										>
												<input
													class="input"
													type="text"
													value={calendarPopupScopeOptionsOpen ? calendarPopupScopeQuery : calendarPopupScopeSelectionLabel()}
													placeholder={calendarPopupScope === 'shift' ? 'Select shift' : 'Select user'}
													aria-label={calendarPopupScope === 'shift' ? 'Shift' : 'User'}
													aria-invalid={calendarScopeSelectionMissing}
													on:focus={openCalendarPopupScopeOptions}
													on:input={(event) => {
														const target = event.currentTarget as HTMLInputElement;
														calendarPopupScopeQuery = target.value;
													openCalendarPopupScopeOptions();
												}}
											/>
											{#if calendarPopupScopeOptionsOpen}
												<div class="setupUserComboList setupUserComboListCustom" role="listbox">
													<div
														class="setupUserComboListScroll"
														class:hasScrollbar={calendarPopupScopeOptionsShowScrollbar}
														bind:this={calendarPopupScopeOptionsScrollEl}
														on:scroll={onCalendarPopupScopeOptionsScroll}
													>
														{#if filteredCalendarPopupScopeOptions().length === 0}
															<div class="setupUserComboItem setupUserComboStatus">No matches</div>
														{:else}
															{#each filteredCalendarPopupScopeOptions() as option (option.id)}
																<button
																	type="button"
																	class="setupUserComboItem"
																	role="option"
																	on:mousedown|preventDefault={() => selectCalendarPopupScopeOption(option.id)}
																>
																	{option.label}
																</button>
															{/each}
														{/if}
													</div>
													{#if calendarPopupScopeOptionsShowScrollbar}
														<div
															class="setupUserComboScrollRail"
															role="presentation"
															aria-hidden="true"
															bind:this={calendarPopupScopeOptionsRailEl}
															on:mousedown={handleCalendarPopupScopeOptionsRailClick}
														>
															<div
																class={`setupUserComboScrollThumb${isDraggingCalendarPopupScopeOptionsScrollbar ? ' dragging' : ''}`}
																style={`height:${calendarPopupScopeOptionsThumbHeightPx}px;transform:translateY(${calendarPopupScopeOptionsThumbTopPx}px);`}
																on:mousedown={startCalendarPopupScopeOptionsThumbDrag}
															></div>
														</div>
													{/if}
												</div>
											{/if}
										</div>
									{/key}
								{/if}
								{#if calendarShowUserScopeShiftPicker}
									<div class="memberEventPickerWrap monthCalendarScopeCombo">
										<Picker
											id="calendarUserScopeShiftBtn"
											menuId="calendarUserScopeShiftMenu"
											label="Shift"
											items={calendarPopupUserShiftItems}
											fullWidth={true}
											selectedValue={calendarPopupUserScopeShiftId() ?? ''}
											selectedLabel={calendarSelectedUserScopeShiftLabel}
											open={calendarPopupUserShiftPickerOpen}
											onOpenChange={setCalendarPopupUserShiftPickerOpen}
											on:select={(event) => {
												const selectedShift = Number(event.detail);
												calendarPopupUserShiftId = Number.isInteger(selectedShift)
													? selectedShift
													: null;
											}}
										/>
										</div>
									{/if}
								</div>
								{#if calendarScopeSelectionMissing}
									<div class="memberEventError" role="alert">{calendarScopeSelectionValidationError}</div>
								{/if}
								<div class="memberEventForm">
								<div class="memberEventField">
									<span class="memberEventFieldLabel">Event Code</span>
									<div class="memberEventPickerWrap">
										<Picker
											id="calendarEventCodeBtn"
											menuId="calendarEventCodeMenu"
											label="Event Code"
											items={calendarActiveEventCodeItems}
											fullWidth={true}
											selectedValue={calendarAddEventCodeId === 'custom'
												? 'custom'
												: calendarAddEventCodeId
													? Number(calendarAddEventCodeId)
													: ''}
											selectedLabel={calendarSelectedEventCodeLabel}
											open={calendarEventCodePickerOpen}
											onOpenChange={setCalendarEventCodePickerOpen}
											on:select={(event) => handleCalendarEventCodeSelection(event.detail)}
										/>
									</div>
								</div>
								<div class="memberEventDateFields">
									<div class="memberEventField">
										<span class="memberEventFieldLabel">Start Date</span>
										<DatePicker
											id="calendarEventStartDateBtn"
											menuId="calendarEventStartDateMenu"
											label="Start Date"
											placeholder="Select start date"
											value={calendarAddEventStartDate}
											open={calendarAddStartDatePickerOpen}
											onOpenChange={setCalendarAddStartDatePickerOpen}
											on:change={(event) => (calendarAddEventStartDate = event.detail)}
										/>
									</div>
									<div class="memberEventField">
										<span class="memberEventFieldLabel">End Date</span>
										<DatePicker
											id="calendarEventEndDateBtn"
											menuId="calendarEventEndDateMenu"
											label="End Date"
											placeholder="Select end date"
											value={calendarAddEventEndDate}
											min={calendarAddEventStartDate}
											open={calendarAddEndDatePickerOpen}
											onOpenChange={setCalendarAddEndDatePickerOpen}
											on:change={(event) => (calendarAddEventEndDate = event.detail)}
										/>
									</div>
								</div>
								{#if calendarIsCustomEventCodeSelected}
									<div class="memberEventCustomSection">
										<div class="memberEventCustomTitle">Custom Event</div>
										<div class="memberEventCustomFields">
											<label class="memberEventField">
												<span class="memberEventFieldLabel">Code</span>
												<input
													class="input"
													type="text"
													maxlength="16"
													placeholder="e.g. MTG"
													bind:value={calendarAddCustomEventCode}
													on:input={(event) => {
														const target = event.currentTarget as HTMLInputElement;
														calendarAddCustomEventCode = target.value.toUpperCase();
													}}
												/>
											</label>
											<label class="memberEventField">
												<span class="memberEventFieldLabel">Display Name (optional)</span>
												<input
													class="input"
													type="text"
													maxlength="60"
													placeholder="e.g. Team Meeting"
													bind:value={calendarAddCustomEventName}
												/>
											</label>
											<label class="memberEventField">
												<span class="memberEventFieldLabel">Display Type</span>
												<div class="memberEventPickerWrap">
													<Picker
														id="calendarEventDisplayModeBtn"
														menuId="calendarEventDisplayModeMenu"
														label="Display Type"
														items={eventDisplayModeItems}
														fullWidth={true}
														selectedValue={calendarAddCustomEventDisplayMode}
														selectedLabel={calendarSelectedCustomDisplayModeLabel}
														open={calendarCustomDisplayModePickerOpen}
														onOpenChange={setCalendarCustomDisplayModePickerOpen}
														on:select={(event) =>
															(calendarAddCustomEventDisplayMode = event.detail as EventDisplayMode)}
													/>
												</div>
											</label>
											<label class="memberEventField memberEventCustomColorField">
												<span class="memberEventFieldLabel">Color</span>
												<ColorPicker
													id="calendarEventCustomColorPicker"
													label="Custom event color"
													value={calendarAddCustomEventColor}
													on:change={(event) => (calendarAddCustomEventColor = event.detail)}
												/>
											</label>
										</div>
									</div>
								{/if}
								<div class="memberEventReminderSection">
									<div class="memberEventCustomTitle">Reminders</div>
									<ThemedCheckbox
										id="calendar-event-reminder-immediate"
										bind:checked={calendarAddReminderImmediate}
										label="Notify Immediately"
									/>
									<ThemedCheckbox
										id="calendar-event-reminder-scheduled"
										bind:checked={calendarAddReminderScheduled}
										label="Scheduled Reminders"
									/>
									{#if calendarAddReminderScheduled}
										<div class="memberEventReminderPickerStack">
											<div class="memberEventReminderHeaderRow" aria-hidden="true">
												<span>Amount</span>
												<span>Unit</span>
												<span>Time</span>
												<span>AM/PM</span>
												<span class="memberEventReminderHeaderAction"></span>
											</div>
											{#each calendarScheduledReminderDrafts as reminderDraft (reminderDraft.id)}
												<div class="memberEventReminderRowWrap">
													<div class="memberEventReminderPickerRow">
														<ThemedSpinPicker
															id={`calendar-event-reminder-amount-${reminderDraft.id}`}
															options={reminderAmountOptions}
															value={reminderDraft.amount}
															on:value={(event) =>
																updateCalendarScheduledReminderDraft(
																	reminderDraft.id,
																	'amount',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`calendar-event-reminder-unit-${reminderDraft.id}`}
															options={reminderUnitOptions}
															value={reminderDraft.unit}
															on:value={(event) =>
																updateCalendarScheduledReminderDraft(
																	reminderDraft.id,
																	'unit',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`calendar-event-reminder-hour-${reminderDraft.id}`}
															options={reminderHourOptions}
															value={reminderDraft.hour}
															on:value={(event) =>
																updateCalendarScheduledReminderDraft(
																	reminderDraft.id,
																	'hour',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`calendar-event-reminder-meridiem-${reminderDraft.id}`}
															options={reminderMeridiemOptions}
															value={reminderDraft.meridiem}
															on:value={(event) =>
																updateCalendarScheduledReminderDraft(
																	reminderDraft.id,
																	'meridiem',
																	event.detail
																)}
														/>
													</div>
													<button
														type="button"
														class="memberEventReminderRemoveBtn"
														on:click={() => removeCalendarScheduledReminderDraft(reminderDraft.id)}
														aria-label="Remove scheduled reminder"
													>
														<svg viewBox="0 0 24 24" aria-hidden="true">
															<path d="M6 6l12 12M18 6L6 18" />
														</svg>
													</button>
												</div>
											{/each}
											{#if calendarCanAddScheduledReminderDraft}
												<button
													type="button"
													class="memberEventAddRowBtn memberEventReminderAddBtn"
													on:click={addCalendarScheduledReminderDraft}
													aria-label="Add another scheduled reminder"
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path d="M12 5v14M5 12h14" />
													</svg>
												</button>
											{/if}
											<div class="memberEventReminderSummary">
												<div class="memberEventReminderSummaryTitle">
													{calendarScheduledReminderSummaryTitle}
												</div>
												{#each calendarScheduledReminderSummaryLines as reminderSummaryLine}
													<div class="memberEventReminderSummaryLine">{reminderSummaryLine}</div>
												{/each}
											</div>
										</div>
									{/if}
								</div>
								<label class="memberEventField">
									<span class="memberEventFieldLabel">Comments</span>
									<textarea
										class="input memberEventTextarea"
										rows="3"
										placeholder="Reason or timing details"
										bind:value={calendarAddEventComments}
									></textarea>
								</label>
								{#if calendarEventCodesError}
									<div class="memberEventError" role="alert">{calendarEventCodesError}</div>
								{/if}
								{#if calendarAddEventError}
									<div class="memberEventError" role="alert">{calendarAddEventError}</div>
								{/if}
							</div>
							<div class="displayNameModalActions">
								{#if calendarPopupMode === 'edit'}
									<button
										type="button"
										class="iconActionBtn danger actionBtn"
										on:click={removeCalendarEvent}
										disabled={calendarEventSaveInProgress}
									>
										<svg viewBox="0 0 24 24" aria-hidden="true">
											<path d="M 2 4 h 20 M 6 4 V 1 h 12 v 3 M 2 6 h 20 M 4 6 l 1 15 h 13 L 20 6 M 9.5 8.5 v 10 M 14.5 8.5 v 10" />
										</svg>
										Remove
									</button>
								{/if}
								<button type="button" class="btn actionBtn" on:click={cancelCalendarAddEdit}>Cancel</button>
								<button
									type="button"
									class="btn primary actionBtn"
									on:click={saveCalendarEvent}
									disabled={calendarEventSaveInProgress || calendarScopeSelectionMissing}
								>
									{calendarAddEventPrimaryButtonLabel}
								</button>
								</div>
							{/if}
					</div>
					{#if showCalendarPopupModalScrollbar}
						<div
							class="teamSetupScrollRail"
							role="presentation"
							aria-hidden="true"
							bind:this={calendarPopupModalRailEl}
							on:mousedown={handleCalendarPopupModalRailClick}
						>
							<div
								class={`teamSetupScrollThumb${isDraggingCalendarPopupModalScrollbar ? ' dragging' : ''}`}
								style={`height:${calendarPopupModalThumbHeightPx}px;transform:translateY(${calendarPopupModalThumbTopPx}px);`}
								on:mousedown={startCalendarPopupModalThumbDrag}
							></div>
						</div>
					{/if}
						</div>
					</div>
				{/if}

		<TeamSetupModal
			open={teamSetupOpen}
			{activeScheduleId}
		{canAssignManagerRole}
		{currentUserOid}
		onClose={closeTeamSetup}
		onScheduleRefresh={refreshScheduleInBackground}
	/>

	<ScheduleSetupModal
		open={scheduleSetupOpen}
		{activeScheduleId}
		{scheduleMemberships}
		currentThemeMode={theme}
		onThemeModeChange={handleScheduleSetupThemeModeChange}
		onMembershipsRefresh={handleScheduleMembershipsRefresh}
		onClose={closeScheduleSetup}
	/>

	{#if displayNameEditorOpen}
		<div
			class="displayNameModalBackdrop"
			role="presentation"
			on:mousedown={(event) => {
				if (event.target === event.currentTarget) {
					closeDisplayNameEditor();
				}
			}}
		>
			<div
				class="displayNameModal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="display-name-modal-title"
			>
				<h2 id="display-name-modal-title">Set Display Name - {displayNameEditorCurrentName}</h2>
				<input
					id="display-name-input"
					class="displayNameModalInput"
					type="text"
					maxlength="200"
					bind:value={displayNameEditorDraft}
					disabled={displayNameEditorSaving}
					on:keydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							void saveDisplayName();
						}
					}}
				/>
				{#if displayNameEditorError}
					<p class="displayNameModalError" role="alert">{displayNameEditorError}</p>
				{/if}
				<div class="displayNameModalActions">
					<button
						type="button"
						class="btn actionBtn"
						on:click={closeDisplayNameEditor}
						disabled={displayNameEditorSaving}
					>
						Cancel
					</button>
					<button
						type="button"
						class="btn primary actionBtn"
						on:click={saveDisplayName}
						disabled={displayNameEditorSaving}
					>
						{displayNameEditorSaving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<OnboardingTourModal
		open={onboardingOpen}
		slides={onboardingSlidesForModal}
		currentIndex={onboardingSlideIndex}
		dontShowAgain={onboardingDontShowAgain}
		isSaving={onboardingSaving}
		errorMessage={onboardingSaveError}
		on:indexChange={(event) => (onboardingSlideIndex = event.detail)}
		on:dontShowAgainChange={(event) => (onboardingDontShowAgain = event.detail)}
		on:close={handleOnboardingClose}
		on:complete={handleOnboardingComplete}
	/>
{/if}
