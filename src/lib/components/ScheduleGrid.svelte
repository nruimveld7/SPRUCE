<script lang="ts">
	import { base } from '$app/paths';
	import { afterUpdate, onDestroy, onMount } from 'svelte';
	import { dowShort, monthNames } from '$lib/utils/date';
	import type { MonthDay } from '$lib/utils/date';
	import DatePicker from '$lib/components/DatePicker.svelte';
	import Picker from '$lib/components/Picker.svelte';
	import ColorPicker from '$lib/components/ColorPicker.svelte';
	import ThemedCheckbox from '$lib/components/ThemedCheckbox.svelte';
	import ThemedSpinPicker from '$lib/components/ThemedSpinPicker.svelte';
	import GroupRow from '$lib/components/GroupRow.svelte';
	import EmployeeRow from '$lib/components/EmployeeRow.svelte';
	import type { Employee, Group, ScheduleEvent, Status } from '$lib/types/schedule';
	import { fetchWithAuthRedirect } from '$lib/utils/fetchWithAuthRedirect';
	import { resolveCellEventVisuals } from '$lib/utils/scheduleEvents';

	type EventScopeType = 'global' | 'shift' | 'user';
	type PopupMode = 'list' | 'add' | 'edit';
	type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';
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
	type ScopedEventEntry = {
		eventId: number;
		eventCodeId: number | null;
		eventCodeCode: string;
		eventCodeName: string;
		scopeType: EventScopeType;
		employeeTypeId: number | null;
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
	type HoverCellScope = {
		day: MonthDay;
		scopeType: EventScopeType;
		scopeLabel: string | null;
		scopeShiftId: number | null;
		scopeUserOid: string | null;
	};
	type PickerOption = { value: number | string; label: string; color?: string };

	export let groups: Group[] = [];
	export let events: ScheduleEvent[] = [];
	export let overrides: Record<string, { day: number; status: Status }[]> = {};
	export let collapsed: Record<string, boolean> = {};
	export let monthDays: MonthDay[] = [];
	export let theme: 'light' | 'dark' = 'dark';
	export let onToggleGroup: (group: Group) => void = () => {};
	export let canMaintainTeam = false;
	export let onTeamClick: () => void = () => {};
	export let onEmployeeDoubleClick: (employee: Employee) => void = () => {};
	export let onScheduleRefresh: () => void | Promise<void> = () => {};
	export let selectedYear = new Date().getFullYear();
	export let selectedMonthIndex = new Date().getMonth();
	export let popupResetToken = 0;

	let gridEl: HTMLDivElement | null = null;
	let bandEl: HTMLDivElement | null = null;
	let selectedBandEl: HTMLDivElement | null = null;
	let scopedSelectedBandEl: HTMLDivElement | null = null;
	let gridWrapEl: HTMLDivElement | null = null;
	let horizontalRailEl: HTMLDivElement | null = null;
	let verticalRailEl: HTMLDivElement | null = null;
	let gridResizeObserver: ResizeObserver | null = null;
	let observedGridWrapEl: HTMLDivElement | null = null;
	let observedGridEl: HTMLDivElement | null = null;
	let scrollbarUpdateQueued = false;
	let lastGridSizingLogKey = '';
	let resizeQueued = false;
	let mounted = false;
	let useCustomGridScrollbars = true;
	let showHorizontalScrollbar = false;
	let horizontalThumbWidthPx = 0;
	let horizontalThumbLeftPx = 0;
	let horizontalRailStyle = '';
	let showVerticalScrollbar = false;
	let verticalThumbHeightPx = 0;
	let verticalThumbTopPx = 0;
	let verticalRailStyle = '';
	let effectiveUserRowHeightPx = 44;
	let isDraggingHorizontalScrollbar = false;
	let isDraggingVerticalScrollbar = false;
	let dragStartX = 0;
	let dragStartHorizontalThumbLeftPx = 0;
	let dragStartY = 0;
	let dragStartVerticalThumbTopPx = 0;
	let selectedRowKey: string | null = null;
	let selectedDay: number | null = null;
	let selectedGroupIndex: number | null = null;
	let selectedCellKey: string | null = null;
	let shiftPropagatedBadgeSizeByGroupIndex = new Map<number, number>();
	let userBadgeSizeByGroupIndex = new Map<number, number>();
	let lastSelectionContextKey = `${selectedYear}-${selectedMonthIndex}`;
	let memberEventsPopupOpen = false;
	let memberEventsPopupTitle = '';
	let memberEventsPopupDayIso = '';
	let memberEventsPopupStartIso = '';
	let memberEventsPopupEndIso = '';
	let memberEventsPopupWindowMode: 'day' | 'shift-month' = 'day';
	let memberEventsPopupScopeType: EventScopeType = 'global';
	let memberEventsPopupScopeShiftId: number | null = null;
	let memberEventsPopupScopeUserOid: string | null = null;
	let memberEventsPopupMode: PopupMode = 'list';
	let editingEventId: number | null = null;
	let editingEventVersionStamp = '';
	let memberEventsModalScrollEl: HTMLDivElement | null = null;
	let memberEventsModalEl: HTMLDivElement | null = null;
	let memberEventsRailEl: HTMLDivElement | null = null;
	let showMemberEventsModalScrollbar = false;
	let memberEventsThumbHeightPx = 0;
	let memberEventsThumbTopPx = 0;
	let isDraggingMemberEventsScrollbar = false;
	let memberEventsDragStartY = 0;
	let memberEventsDragStartThumbTopPx = 0;
	let teamColumnCollapsed = false;

	let scopedEventEntries: ScopedEventEntry[] = [];
	let memberEventsLoading = false;
	let memberEventsError = '';
	let eventSaveInProgress = false;

	let eventCodeOptions: EventCodeOption[] = [];
	let eventCodesLoading = false;
	let eventCodesError = '';
	let eventCodePickerOpen = false;
	let customDisplayModePickerOpen = false;
	let addStartDatePickerOpen = false;
	let addEndDatePickerOpen = false;

	let addEventCodeId = '';
	let addEventComments = '';
	let addEventStartDate = '';
	let addEventEndDate = '';
	let addCustomEventCode = '';
	let addCustomEventName = '';
	let addCustomEventDisplayMode: EventDisplayMode = 'Schedule Overlay';
	let addCustomEventColor = '#22c55e';
	let addReminderImmediate = false;
	let addReminderScheduled = false;
	let scheduledReminderDrafts: ScheduledReminderDraft[] = [];
	let nextScheduledReminderDraftId = 1;
	let addEventError = '';
	let hoverTooltipOpen = false;
	let hoverTooltipLeftPx = 0;
	let hoverTooltipTopPx = 0;
	let hoverTooltipPointerX = 0;
	let hoverTooltipPointerY = 0;
	let hoverTooltipTitle = '';
	let hoverTooltipScopeType: EventScopeType = 'global';
	let hoverTooltipWindowMode: 'day' | 'shift-month' = 'day';
	let hoverTooltipEntries: ScopedEventEntry[] = [];
	let hoverTooltipLoading = false;
	let hoverTooltipScope: HoverCellScope | null = null;
	let hoverTooltipEl: HTMLDivElement | null = null;
	let hoverTooltipFetchToken = 0;
	let canUseHoverTooltips = true;
	let memberEventsPopupPollTimer: ReturnType<typeof setInterval> | null = null;
	let lastPopupResetToken = popupResetToken;
	const scopedEventsCache = new Map<string, ScopedEventEntry[]>();
	const DOUBLE_TAP_WINDOW_MS = 320;
	let lastHeaderTouchTapDay: number | null = null;
	let lastHeaderTouchTapAtMs = 0;
	let suppressHeaderClickDay: number | null = null;
	const MAX_SCHEDULED_REMINDERS = 4;

	const eventDisplayModeItems: PickerOption[] = [
		{ value: 'Schedule Overlay', label: 'Schedule Overlay' },
		{ value: 'Badge Indicator', label: 'Badge Indicator' },
		{ value: 'Shift Override', label: 'Shift Override' }
	];
	const reminderAmountOptions = Array.from({ length: 31 }, (_, index) => index);
	const reminderHourOptions = Array.from({ length: 13 }, (_, index) => index);
	const reminderUnitOptions = ['days', 'weeks', 'months'];
	const reminderMeridiemOptions = ['AM', 'PM'];
	const DAY_COLUMN_MIN_WIDTH_PX = 34;
	const FIXED_COLUMNS_WIDTH_PX = 420;
	const COLLAPSED_FIXED_COLUMNS_WIDTH_PX = 14;
	const GRID_MIN_WIDTH_FLOOR_PX = 1100;
	const LOG_GRID_SIZING_DIAGNOSTICS = true;

	$: days = monthDays;
	$: dim = monthDays.length;
	$: showTeamColumnRailToggle =
		useCustomGridScrollbars && (showHorizontalScrollbar || teamColumnCollapsed);
	$: shiftColumnWidthCss =
		showTeamColumnRailToggle && teamColumnCollapsed ? '0px' : 'clamp(44px, 5vw, 64px)';
	$: teamColumnWidthCss = showTeamColumnRailToggle && teamColumnCollapsed ? '0px' : '27ch';
	$: teamToggleColumnWidthCss = showTeamColumnRailToggle ? '14px' : '0px';
	$: dayColumnMinWidthCss = `${DAY_COLUMN_MIN_WIDTH_PX}px`;
	$: gridLeadingColumnsCss = showTeamColumnRailToggle
		? 'var(--shift-col-width) var(--team-col-width) var(--team-toggle-col-width)'
		: 'var(--shift-col-width) var(--team-col-width)';
	$: minimumGridWidthFloor = GRID_MIN_WIDTH_FLOOR_PX;
	$: effectiveFixedColumnsWidthPx = teamColumnCollapsed
		? COLLAPSED_FIXED_COLUMNS_WIDTH_PX
		: FIXED_COLUMNS_WIDTH_PX;
	$: minimumGridWidthFromContent = effectiveFixedColumnsWidthPx + dim * DAY_COLUMN_MIN_WIDTH_PX;
	$: gridShellStyle = `--shift-col-width:${shiftColumnWidthCss}; --team-col-width:${teamColumnWidthCss}; --team-toggle-col-width:${teamToggleColumnWidthCss}; --day-col-min-width:${dayColumnMinWidthCss};`;
	$: gridTemplateRows = (() => {
		const tracks: string[] = ['var(--schedule-header-row-height)'];
		for (const group of groups) {
			if (collapsed[group.category] || group.employees.length === 0) {
				tracks.push('auto');
				continue;
			}
			for (let i = 0; i < group.employees.length; i += 1) {
				tracks.push(
					'minmax(var(--schedule-row-min-height), var(--schedule-row-effective-height, var(--schedule-row-max-height)))'
				);
			}
		}
		return tracks.join(' ');
	})();
	$: gridStyle = `--schedule-row-effective-height:${effectiveUserRowHeightPx}px; grid-template-columns: ${gridLeadingColumnsCss} repeat(${dim}, minmax(var(--day-col-min-width), 1fr)); grid-template-rows: ${gridTemplateRows}; min-width: ${Math.max(minimumGridWidthFromContent, minimumGridWidthFloor)}px;`;
	$: activeTodayDay = monthDays.find((item) => item.isToday)?.day ?? null;
	$: shiftNameByShiftId = (() => {
		const shiftNames = new Map<number, string>();
		for (const group of groups) {
			const nextShiftId = group.employeeTypeId;
			if (nextShiftId === null || nextShiftId === undefined) continue;
			if (!shiftNames.has(nextShiftId)) {
				shiftNames.set(nextShiftId, group.category);
			}
		}
		return shiftNames;
	})();
	$: dayHeaderEventVisuals = new Map(
		monthDays.map(
			(day) =>
				[
					day.day,
					resolveCellEventVisuals(events, toIsoDate(selectedYear, selectedMonthIndex, day.day), {
						scopeType: 'global',
						employeeTypeId: null,
						userOid: null
					})
				] as const
		)
	);

	function dayHeaderClass(day: MonthDay) {
		let cls = `cell hdr dayhdr${day.isWeekend ? ' wknd' : ''}`;
		if (day.isToday) cls += ' todayhdr';
		return cls;
	}

	function dayAriaLabel(day: MonthDay) {
		return `Day ${day.day} ${dowShort[day.dow]}`;
	}

	function dayDowShort(day: MonthDay) {
		return dowShort[day.dow];
	}

	function toggleTeamColumnVisibility() {
		if (!showTeamColumnRailToggle) return;
		teamColumnCollapsed = !teamColumnCollapsed;
		queueScrollbarUpdate(true);
	}

	function toIsoDate(year: number, monthIndex: number, day: number): string {
		const month = String(monthIndex + 1).padStart(2, '0');
		const dayPart = String(day).padStart(2, '0');
		return `${year}-${month}-${dayPart}`;
	}

	function formatIsoDate(iso: string): string {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
		const [yearRaw, monthRaw, dayRaw] = iso.split('-');
		const year = Number(yearRaw);
		const month = Number(monthRaw);
		const day = Number(dayRaw);
		if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return iso;
		return `${monthNames[month - 1]} ${day}, ${year}`;
	}

	function formatPopupDate(day: MonthDay): string {
		const cellDate = new Date(selectedYear, selectedMonthIndex, day.day);
		return `${monthNames[cellDate.getMonth()]} ${cellDate.getDate()}, ${cellDate.getFullYear()}`;
	}

	function monthWindowIso(year: number, monthIndex: number): { startIso: string; endIso: string } {
		const startIso = toIsoDate(year, monthIndex, 1);
		const lastDay = new Date(year, monthIndex + 1, 0).getDate();
		const endIso = toIsoDate(year, monthIndex, lastDay);
		return { startIso, endIso };
	}

	function formatReminderPreviewDate(date: Date): string {
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(date);
	}

	function formatEventDateOrRange(startDateIso: string, endDateIso: string): string {
		if (startDateIso === endDateIso) {
			return formatIsoDate(startDateIso);
		}
		return `${formatIsoDate(startDateIso)} to ${formatIsoDate(endDateIso)}`;
	}

	function shiftHasMonthEvents(group: Group): boolean {
		const shiftId = group.employeeTypeId ?? null;
		if (!shiftId) return false;
		const { startIso, endIso } = monthWindowIso(selectedYear, selectedMonthIndex);
		return events.some((eventRow) => {
			const appliesToScope =
				eventRow.scopeType === 'global' ||
				(eventRow.scopeType === 'shift' && eventRow.employeeTypeId === shiftId);
			if (!appliesToScope) return false;
			return eventRow.startDate <= endIso && eventRow.endDate >= startIso;
		});
	}

	function userHasMonthEvents(employee: Employee, groupShiftId: number | null): boolean {
		const userOid = employee.userOid ?? null;
		if (!userOid) return false;
		const { startIso, endIso } = monthWindowIso(selectedYear, selectedMonthIndex);
		const normalizedUserOid = userOid.trim().toLowerCase();
		return events.some((eventRow) => {
			const eventUserOid = eventRow.userOid?.trim().toLowerCase() ?? null;
			const appliesToScope =
				eventRow.scopeType === 'global' ||
				(groupShiftId !== null &&
					eventRow.scopeType === 'shift' &&
					eventRow.employeeTypeId === groupShiftId) ||
				(eventRow.scopeType === 'user' &&
					eventUserOid === normalizedUserOid &&
					(groupShiftId === null || eventRow.employeeTypeId === groupShiftId));
			if (!appliesToScope) return false;
			return eventRow.startDate <= endIso && eventRow.endDate >= startIso;
		});
	}

	function reminderKey(reminderDraft: ScheduledReminderDraft): string {
		return `${reminderDraft.amount}|${reminderDraft.unit}|${reminderDraft.hour}|${reminderDraft.meridiem}`;
	}

	function reminderTargetDate(
		startDateIso: string,
		reminderDraft: ScheduledReminderDraft
	): Date | null {
		if (!isIsoDate(startDateIso)) return null;
		const [yearRaw, monthRaw, dayRaw] = startDateIso.split('-');
		const year = Number(yearRaw);
		const month = Number(monthRaw);
		const day = Number(dayRaw);
		const target = new Date(year, month - 1, day, 12, 0, 0, 0);
		if (reminderDraft.unit === 'months') {
			target.setMonth(target.getMonth() - reminderDraft.amount);
			return target;
		}
		const dayOffset =
			reminderDraft.unit === 'weeks' ? reminderDraft.amount * 7 : reminderDraft.amount;
		target.setDate(target.getDate() - dayOffset);
		return target;
	}

	function refreshScheduleInBackground() {
		try {
			void onScheduleRefresh();
		} catch {
			// Keep event operations successful even if background refresh fails.
		}
	}

	async function openMemberEventsPopup(
		day: MonthDay,
		scopeType: EventScopeType,
		scopeLabel: string | null = null,
		scopeShiftId: number | null = null,
		scopeUserOid: string | null = null
	) {
		const dateLabel = formatPopupDate(day);
		const normalizedScopeLabel = scopeLabel?.trim() ?? '';
		memberEventsPopupTitle = `${dateLabel} Events${normalizedScopeLabel ? ` - ${normalizedScopeLabel}` : ''}`;
		memberEventsPopupDayIso = toIsoDate(selectedYear, selectedMonthIndex, day.day);
		memberEventsPopupStartIso = memberEventsPopupDayIso;
		memberEventsPopupEndIso = memberEventsPopupDayIso;
		memberEventsPopupWindowMode = 'day';
		memberEventsPopupScopeType = scopeType;
		memberEventsPopupScopeShiftId = scopeShiftId;
		memberEventsPopupScopeUserOid = scopeUserOid;
		memberEventsPopupMode = 'list';
		memberEventsError = '';
		resetAddEventForm();
		hideHoverEventsTooltip();
		memberEventsPopupOpen = true;
		await loadScopedEvents();
	}

	async function openShiftMonthEventsPopup(group: Group) {
		const normalizedScopeLabel = group.category?.trim() ?? '';
		const monthLabel = `${monthNames[selectedMonthIndex]} ${selectedYear}`;
		memberEventsPopupTitle = `${monthLabel} Events${normalizedScopeLabel ? ` - ${normalizedScopeLabel}` : ''}`;
		const { startIso, endIso } = monthWindowIso(selectedYear, selectedMonthIndex);
		memberEventsPopupDayIso = startIso;
		memberEventsPopupStartIso = startIso;
		memberEventsPopupEndIso = endIso;
		memberEventsPopupWindowMode = 'shift-month';
		memberEventsPopupScopeType = 'shift';
		memberEventsPopupScopeShiftId = group.employeeTypeId ?? null;
		memberEventsPopupScopeUserOid = null;
		memberEventsPopupMode = 'list';
		memberEventsError = '';
		resetAddEventForm();
		hideHoverEventsTooltip();
		memberEventsPopupOpen = true;
		await loadScopedEvents();
	}

	function closeMemberEventsPopup() {
		stopMemberEventsModalDragging();
		memberEventsPopupOpen = false;
		memberEventsPopupMode = 'list';
		scopedEventEntries = [];
		memberEventsLoading = false;
		memberEventsError = '';
		editingEventId = null;
		editingEventVersionStamp = '';
		showMemberEventsModalScrollbar = false;
		memberEventsThumbHeightPx = 0;
		memberEventsThumbTopPx = 0;
	}

	function eventsCacheKey(
		windowKey: string,
		scopeType: EventScopeType,
		scopeShiftId: number | null,
		scopeUserOid: string | null
	) {
		return `${windowKey}|${scopeType}|${scopeShiftId ?? ''}|${scopeUserOid ?? ''}`;
	}

	function eventListTitle(day: MonthDay, scopeLabel: string | null = null): string {
		const dateLabel = formatPopupDate(day);
		const normalizedScopeLabel = scopeLabel?.trim() ?? '';
		return `${dateLabel} Events${normalizedScopeLabel ? ` - ${normalizedScopeLabel}` : ''}`;
	}

	function parseErrorMessage(result: Response, fallback: string): Promise<string> {
		return result
			.json()
			.then((payload) => {
				if (payload && typeof payload === 'object') {
					const message =
						typeof (payload as Record<string, unknown>).message === 'string'
							? (payload as Record<string, string>).message
							: typeof (payload as Record<string, unknown>).error === 'string'
								? (payload as Record<string, string>).error
								: '';
					if (message.trim()) return message;
				}
				return fallback;
			})
			.catch(() => fallback);
	}

	function eventScopeSuffix(
		eventRow: ScopedEventEntry,
		referenceScopeType: EventScopeType
	): string | null {
		if (eventRow.scopeType === referenceScopeType) return null;
		if (eventRow.scopeType === 'global') return 'Everyone';
		if (eventRow.scopeType === 'shift') {
			if (eventRow.employeeTypeId === null) return 'Shift';
			return shiftNameByShiftId.get(eventRow.employeeTypeId) ?? 'Shift';
		}
		return null;
	}

	async function fetchScopedEvents(
		window:
			| { dayIso: string; startIso?: undefined; endIso?: undefined }
			| { dayIso?: undefined; startIso: string; endIso: string },
		scopeType: EventScopeType,
		scopeShiftId: number | null,
		scopeUserOid: string | null
	): Promise<ScopedEventEntry[]> {
		const queryParts = [`scope=${encodeURIComponent(scopeType)}`];
		if (window.dayIso) {
			queryParts.push(`day=${encodeURIComponent(window.dayIso)}`);
		} else {
			queryParts.push(`startDate=${encodeURIComponent(window.startIso)}`);
			queryParts.push(`endDate=${encodeURIComponent(window.endIso)}`);
		}
		if (scopeShiftId) {
			queryParts.push(`employeeTypeId=${encodeURIComponent(String(scopeShiftId))}`);
		}
		if (scopeType === 'user' && scopeUserOid) {
			queryParts.push(`userOid=${encodeURIComponent(scopeUserOid)}`);
		}

		const result = await fetchWithAuthRedirect(
			`${base}/api/team/events?${queryParts.join('&')}`,
			{
				method: 'GET',
				headers: { accept: 'application/json' }
			},
			base
		);
		if (!result) return [];
		if (!result.ok) {
			throw new Error(await parseErrorMessage(result, 'Failed to load events'));
		}
		const payload = (await result.json()) as {
			events?: ScopedEventEntry[];
		};
		return Array.isArray(payload.events) ? payload.events : [];
	}

	async function loadScopedEvents() {
		if (!memberEventsPopupStartIso || !memberEventsPopupEndIso) return;
		if (memberEventsPopupScopeType === 'shift' && !memberEventsPopupScopeShiftId) {
			memberEventsError = 'This shift cannot be resolved for event lookups.';
			scopedEventEntries = [];
			return;
		}
		if (memberEventsPopupScopeType === 'user' && !memberEventsPopupScopeUserOid) {
			memberEventsError = 'This user cannot be resolved for event lookups.';
			scopedEventEntries = [];
			return;
		}

		memberEventsLoading = true;
		memberEventsError = '';
		try {
			const window =
				memberEventsPopupStartIso === memberEventsPopupEndIso
					? ({ dayIso: memberEventsPopupStartIso } as const)
					: ({
							startIso: memberEventsPopupStartIso,
							endIso: memberEventsPopupEndIso
						} as const);
			scopedEventEntries = await fetchScopedEvents(
				window,
				memberEventsPopupScopeType,
				memberEventsPopupScopeShiftId,
				memberEventsPopupScopeUserOid
			);
		} catch (error) {
			scopedEventEntries = [];
			memberEventsError = error instanceof Error ? error.message : 'Failed to load events';
		} finally {
			memberEventsLoading = false;
		}
	}

	function sortScopedEvents(entries: ScopedEventEntry[]): ScopedEventEntry[] {
		return [...entries].sort((left, right) => {
			const scopeDelta = scopeSortRank(right.scopeType) - scopeSortRank(left.scopeType);
			if (scopeDelta !== 0) return scopeDelta;
			const startDelta = left.startDate.localeCompare(right.startDate);
			if (startDelta !== 0) return startDelta;
			const endDelta = left.endDate.localeCompare(right.endDate);
			if (endDelta !== 0) return endDelta;
			return left.eventId - right.eventId;
		});
	}

	function isSameHoverScope(left: HoverCellScope | null, right: HoverCellScope): boolean {
		if (!left) return false;
		return (
			left.day.day === right.day.day &&
			left.scopeType === right.scopeType &&
			left.scopeShiftId === right.scopeShiftId &&
			left.scopeUserOid === right.scopeUserOid &&
			left.scopeLabel === right.scopeLabel
		);
	}

	function positionHoverTooltipAtPointer(clientX: number, clientY: number) {
		hoverTooltipPointerX = clientX;
		hoverTooltipPointerY = clientY;
		if (typeof window === 'undefined') return;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const tooltipWidth = hoverTooltipEl?.offsetWidth ?? 460;
		const tooltipHeight = hoverTooltipEl?.offsetHeight ?? 220;
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

		hoverTooltipLeftPx = Math.round(left);
		hoverTooltipTopPx = Math.round(top);
	}

	function hideHoverEventsTooltip() {
		hoverTooltipOpen = false;
		hoverTooltipEntries = [];
		hoverTooltipLoading = false;
		hoverTooltipScope = null;
		hoverTooltipWindowMode = 'day';
	}

	async function showHoverEventsTooltip(
		scope: HoverCellScope,
		pointer: { clientX: number; clientY: number }
	) {
		if (!canUseHoverTooltips) return;
		if (memberEventsPopupOpen) return;
		const sameScope = isSameHoverScope(hoverTooltipScope, scope);
		if (sameScope && hoverTooltipOpen) {
			positionHoverTooltipAtPointer(pointer.clientX, pointer.clientY);
			return;
		}

		hoverTooltipScope = scope;
		hoverTooltipTitle = eventListTitle(scope.day, scope.scopeLabel);
		hoverTooltipScopeType = scope.scopeType;
		hoverTooltipWindowMode = 'day';
		positionHoverTooltipAtPointer(pointer.clientX, pointer.clientY);
		hoverTooltipOpen = true;
		const dayIso = toIsoDate(selectedYear, selectedMonthIndex, scope.day.day);
		const cacheKey = eventsCacheKey(
			`day:${dayIso}`,
			scope.scopeType,
			scope.scopeShiftId,
			scope.scopeUserOid
		);
		const cachedEntries = scopedEventsCache.get(cacheKey);
		if (cachedEntries) {
			hoverTooltipLoading = false;
			hoverTooltipEntries = cachedEntries;
			positionHoverTooltipAtPointer(hoverTooltipPointerX, hoverTooltipPointerY);
			if (cachedEntries.length === 0) {
				hideHoverEventsTooltip();
			}
			return;
		}

		hoverTooltipLoading = true;
		hoverTooltipEntries = [];
		const fetchToken = ++hoverTooltipFetchToken;
		try {
			const nextEntries = await fetchScopedEvents(
				{ dayIso },
				scope.scopeType,
				scope.scopeShiftId,
				scope.scopeUserOid
			);
			scopedEventsCache.set(cacheKey, nextEntries);
			if (
				fetchToken !== hoverTooltipFetchToken ||
				!hoverTooltipScope ||
				hoverTooltipScope !== scope ||
				memberEventsPopupOpen
			) {
				return;
			}
			hoverTooltipLoading = false;
			hoverTooltipEntries = nextEntries;
			positionHoverTooltipAtPointer(hoverTooltipPointerX, hoverTooltipPointerY);
			if (nextEntries.length === 0) {
				hideHoverEventsTooltip();
			}
		} catch (error) {
			if (fetchToken !== hoverTooltipFetchToken) return;
			void error;
			hideHoverEventsTooltip();
		}
	}

	async function loadActiveEventCodes(forceReload = false) {
		if (!canMaintainTeam || eventCodesLoading) return;
		if (!forceReload && eventCodeOptions.length > 0) return;

		eventCodesLoading = true;
		eventCodesError = '';
		try {
			const result = await fetchWithAuthRedirect(
				`${base}/api/team/event-codes`,
				{ method: 'GET' },
				base
			);
			if (!result) {
				return;
			}
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
			eventCodeOptions = (Array.isArray(data.eventCodes) ? data.eventCodes : [])
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
			eventCodesError =
				error instanceof Error ? error.message : 'Failed to load active event codes';
		} finally {
			eventCodesLoading = false;
		}
	}

	function resetAddEventForm() {
		addEventCodeId = 'custom';
		addEventComments = '';
		const firstOfMonthIso = toIsoDate(selectedYear, selectedMonthIndex, 1);
		const shouldDefaultShiftMonthStart =
			memberEventsPopupWindowMode === 'shift-month' && memberEventsPopupScopeType === 'shift';
		addEventStartDate = shouldDefaultShiftMonthStart ? firstOfMonthIso : memberEventsPopupDayIso;
		addEventEndDate = shouldDefaultShiftMonthStart ? firstOfMonthIso : memberEventsPopupDayIso;
		addCustomEventCode = '';
		addCustomEventName = '';
		addCustomEventDisplayMode = 'Schedule Overlay';
		addCustomEventColor = '#22c55e';
		addReminderImmediate = false;
		addReminderScheduled = false;
		scheduledReminderDrafts = [createDefaultScheduledReminderDraft()];
		addEventError = '';
		editingEventId = null;
		editingEventVersionStamp = '';
		eventCodePickerOpen = false;
		customDisplayModePickerOpen = false;
		addStartDatePickerOpen = false;
		addEndDatePickerOpen = false;
	}

	function createDefaultScheduledReminderDraft(): ScheduledReminderDraft {
		return {
			id: nextScheduledReminderDraftId++,
			amount: 1,
			unit: 'days',
			hour: 12,
			meridiem: 'PM'
		};
	}

	function addScheduledReminderDraft() {
		if (scheduledReminderDrafts.length >= MAX_SCHEDULED_REMINDERS) return;
		scheduledReminderDrafts = [...scheduledReminderDrafts, createDefaultScheduledReminderDraft()];
	}

	function removeScheduledReminderDraft(id: number) {
		if (scheduledReminderDrafts.length <= 1) {
			addReminderScheduled = false;
			scheduledReminderDrafts = [createDefaultScheduledReminderDraft()];
			return;
		}
		scheduledReminderDrafts = scheduledReminderDrafts.filter((draft) => draft.id !== id);
	}

	function updateScheduledReminderDraft(
		id: number,
		field: 'amount' | 'unit' | 'hour' | 'meridiem',
		nextValue: string | number
	) {
		scheduledReminderDrafts = scheduledReminderDrafts.map((draft) => {
			if (draft.id !== id) return draft;
			if (field === 'amount') {
				return { ...draft, amount: Number(nextValue) };
			}
			if (field === 'hour') {
				return { ...draft, hour: Number(nextValue) };
			}
			if (field === 'unit') {
				return { ...draft, unit: String(nextValue) };
			}
			return { ...draft, meridiem: String(nextValue) };
		});
	}

	function applyReminderDefaultsFromEventCode(eventCode: EventCodeOption | null) {
		if (!eventCode) {
			addReminderImmediate = false;
			addReminderScheduled = false;
			scheduledReminderDrafts = [createDefaultScheduledReminderDraft()];
			return;
		}

		addReminderImmediate = Boolean(eventCode.notifyImmediately);
		const reminders = Array.isArray(eventCode.scheduledReminders)
			? eventCode.scheduledReminders
			: [];
		if (reminders.length > 0) {
			addReminderScheduled = true;
			scheduledReminderDrafts = reminders.map((reminder) => ({
				id: nextScheduledReminderDraftId++,
				amount: reminder.amount,
				unit: reminder.unit,
				hour: reminder.hour,
				meridiem: reminder.meridiem
			}));
			return;
		}

		addReminderScheduled = false;
		scheduledReminderDrafts = [createDefaultScheduledReminderDraft()];
	}

	function handleEventCodeSelection(nextValue: string | number) {
		addEventCodeId = String(nextValue);
		if (memberEventsPopupMode !== 'add') return;
		if (addEventCodeId === 'custom') {
			applyReminderDefaultsFromEventCode(null);
			return;
		}
		const selectedEventCodeId = Number(addEventCodeId);
		const selectedEventCode = eventCodeOptions.find(
			(eventCode) => eventCode.eventCodeId === selectedEventCodeId
		);
		applyReminderDefaultsFromEventCode(selectedEventCode ?? null);
	}

	async function openAddEventView() {
		if (!canMaintainTeam) return;
		memberEventsPopupMode = 'add';
		resetAddEventForm();
		await loadActiveEventCodes(true);
	}

	async function openEditEventView(eventRow: ScopedEventEntry) {
		if (!canMaintainTeam) return;
		await loadActiveEventCodes(true);

		memberEventsPopupMode = 'edit';
		addEventError = '';
		editingEventId = eventRow.eventId;
		editingEventVersionStamp = eventRow.versionStamp ?? '';
		addEventComments = eventRow.comments;
		addEventStartDate = eventRow.startDate;
		addEventEndDate = eventRow.endDate;

		const matchedEventCode =
			typeof eventRow.eventCodeId === 'number' && eventRow.eventCodeId > 0
				? eventCodeOptions.find((item) => item.eventCodeId === eventRow.eventCodeId)
				: null;

		if (matchedEventCode) {
			addEventCodeId = String(matchedEventCode.eventCodeId);
			addCustomEventCode = '';
			addCustomEventName = '';
			addCustomEventDisplayMode = 'Schedule Overlay';
			addCustomEventColor = '#22c55e';
		} else {
			addEventCodeId = 'custom';
			addCustomEventCode = eventRow.eventCodeCode;
			addCustomEventName = eventRow.eventCodeName;
			addCustomEventDisplayMode = eventRow.eventDisplayMode;
			addCustomEventColor = eventRow.eventCodeColor;
		}

		eventCodePickerOpen = false;
		customDisplayModePickerOpen = false;
		addStartDatePickerOpen = false;
		addEndDatePickerOpen = false;
		addReminderImmediate = false;
		const reminders = Array.isArray(eventRow.scheduledReminders) ? eventRow.scheduledReminders : [];
		if (reminders.length > 0) {
			addReminderScheduled = true;
			scheduledReminderDrafts = reminders.map((reminder) => ({
				id: nextScheduledReminderDraftId++,
				amount: reminder.amount,
				unit: reminder.unit,
				hour: reminder.hour,
				meridiem: reminder.meridiem
			}));
		} else {
			addReminderScheduled = false;
			scheduledReminderDrafts = [createDefaultScheduledReminderDraft()];
		}
	}

	function cancelAddEvent() {
		memberEventsPopupMode = 'list';
		resetAddEventForm();
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

	async function saveEvent() {
		if (eventSaveInProgress) return;
		addEventError = '';

		if (memberEventsPopupScopeType === 'shift' && !memberEventsPopupScopeShiftId) {
			addEventError = 'This shift cannot be resolved for event updates.';
			return;
		}
		if (memberEventsPopupScopeType === 'user' && !memberEventsPopupScopeUserOid) {
			addEventError = 'This user cannot be resolved for event updates.';
			return;
		}

		const isCustomCode = addEventCodeId === 'custom';
		if (!isIsoDate(addEventStartDate) || !isIsoDate(addEventEndDate)) {
			addEventError = 'Please choose a valid start and end date.';
			return;
		}
		if (addEventEndDate < addEventStartDate) {
			addEventError = 'End date cannot be before start date.';
			return;
		}

		let coverageCodeId: number | null = null;
		let customCode: string | null = null;
		let customName: string | null = null;
		let customDisplayMode: EventDisplayMode | null = null;
		let customColor: string | null = null;

		if (isCustomCode) {
			const normalizedCode = addCustomEventCode.trim().toUpperCase().replace(/\s+/g, '-');
			if (!normalizedCode) {
				addEventError = 'Custom event code is required.';
				return;
			}
			if (!/^[A-Z0-9_-]{1,16}$/.test(normalizedCode)) {
				addEventError = 'Custom event code must be 1-16 chars using A-Z, 0-9, _ or -.';
				return;
			}
			const normalizedColor = addCustomEventColor.trim().toLowerCase();
			if (!/^#[0-9a-f]{6}$/.test(normalizedColor)) {
				addEventError = 'Custom event color must be a valid hex value.';
				return;
			}
			customCode = normalizedCode;
			customName = addCustomEventName.trim() || normalizedCode;
			customDisplayMode = addCustomEventDisplayMode;
			customColor = normalizedColor;
		} else {
			const selectedCodeId = Number(addEventCodeId);
			if (!Number.isInteger(selectedCodeId) || selectedCodeId <= 0) {
				addEventError = 'Please select an event code.';
				return;
			}

			const eventCode = eventCodeOptions.find((item) => item.eventCodeId === selectedCodeId);
			if (!eventCode) {
				addEventError = 'Selected event code is no longer available.';
				return;
			}

			coverageCodeId = eventCode.eventCodeId;
		}

		const payload: Record<string, unknown> = {
			scope: memberEventsPopupScopeType,
			employeeTypeId: memberEventsPopupScopeShiftId,
			userOid: memberEventsPopupScopeUserOid,
			startDate: addEventStartDate,
			endDate: addEventEndDate,
			comments: addEventComments.trim(),
			coverageCodeId,
			notifyImmediately: addReminderImmediate,
			scheduledReminders: addReminderScheduled
				? scheduledReminderDrafts.map((reminderDraft) => ({
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

		const isEditing = memberEventsPopupMode === 'edit' && editingEventId !== null;
		if (isEditing) {
			const expectedVersionStamp = editingEventVersionStamp.trim();
			if (!expectedVersionStamp) {
				addEventError = 'This event can no longer be edited. Refresh and try again.';
				return;
			}
			payload.eventId = editingEventId;
			payload.expectedVersionStamp = expectedVersionStamp;
		}

		eventSaveInProgress = true;
		try {
			const result = await fetchWithAuthRedirect(
				`${base}/api/team/events`,
				{
					method: isEditing ? 'PATCH' : 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json'
					},
					body: JSON.stringify(payload)
				},
				base
			);
			if (!result) {
				return;
			}
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to save event'));
			}

			memberEventsPopupMode = 'list';
			resetAddEventForm();
			scopedEventsCache.clear();
			refreshScheduleInBackground();
			await loadScopedEvents();
		} catch (error) {
			addEventError = error instanceof Error ? error.message : 'Failed to save event';
		} finally {
			eventSaveInProgress = false;
		}
	}

	async function removeEvent() {
		if (eventSaveInProgress || editingEventId === null) return;
		const expectedVersionStamp = editingEventVersionStamp.trim();
		if (!expectedVersionStamp) {
			addEventError = 'This event can no longer be removed. Refresh and try again.';
			return;
		}
		addEventError = '';
		eventSaveInProgress = true;
		try {
			const result = await fetchWithAuthRedirect(
				`${base}/api/team/events`,
				{
					method: 'DELETE',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json'
					},
					body: JSON.stringify({
						eventId: editingEventId,
						expectedVersionStamp
					})
				},
				base
			);
			if (!result) {
				return;
			}
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to remove event'));
			}
			memberEventsPopupMode = 'list';
			resetAddEventForm();
			scopedEventsCache.clear();
			refreshScheduleInBackground();
			await loadScopedEvents();
		} catch (error) {
			addEventError = error instanceof Error ? error.message : 'Failed to remove event';
		} finally {
			eventSaveInProgress = false;
		}
	}

	function handleDayHeaderDoubleClick(day: MonthDay) {
		void openMemberEventsPopup(day, 'global');
	}

	function handleDayHeaderClick(day: number, event: MouseEvent) {
		if (suppressHeaderClickDay === day) {
			suppressHeaderClickDay = null;
			return;
		}
		const key = `header-day:${day}`;
		if (selectedCellKey === key) {
			clearSelectionState();
			return;
		}
		handleDaySelect(day);
		selectedCellKey = key;
	}

	function handleDayHeaderTouchEnd(day: MonthDay, event: TouchEvent) {
		const now = Date.now();
		const isDoubleTap =
			lastHeaderTouchTapDay === day.day && now - lastHeaderTouchTapAtMs <= DOUBLE_TAP_WINDOW_MS;
		lastHeaderTouchTapDay = day.day;
		lastHeaderTouchTapAtMs = now;
		if (!isDoubleTap) return;
		event.preventDefault();
		suppressHeaderClickDay = day.day;
		lastHeaderTouchTapDay = null;
		lastHeaderTouchTapAtMs = 0;
		handleDayHeaderDoubleClick(day);
	}

	function handleGroupDayDoubleClick(group: Group, day: MonthDay) {
		void openMemberEventsPopup(day, 'shift', group.category, group.employeeTypeId ?? null, null);
	}

	function handleShiftCellContextMenu(event: MouseEvent, group: Group) {
		event.preventDefault();
		void openShiftMonthEventsPopup(group);
	}

	function handleEmployeeDayDoubleClick(
		employee: Employee,
		groupShiftId: number | null,
		day: MonthDay
	) {
		void openMemberEventsPopup(day, 'user', employee.name, groupShiftId, employee.userOid ?? null);
	}

	function handleDayHeaderHover(day: MonthDay, pointer: { clientX: number; clientY: number }) {
		const visuals = dayHeaderEventVisuals.get(day.day);
		if (!visuals?.overrideBackground && !visuals?.overlayBackground && !visuals?.badgeBackground) {
			hideHoverEventsTooltip();
			return;
		}
		void showHoverEventsTooltip(
			{
				day,
				scopeType: 'global',
				scopeLabel: null,
				scopeShiftId: null,
				scopeUserOid: null
			},
			pointer
		);
	}

	function handleGroupDayHover(
		group: Group,
		day: MonthDay,
		pointer: { clientX: number; clientY: number }
	) {
		void showHoverEventsTooltip(
			{
				day,
				scopeType: 'shift',
				scopeLabel: group.category,
				scopeShiftId: group.employeeTypeId ?? null,
				scopeUserOid: null
			},
			pointer
		);
	}

	async function showShiftMonthHoverTooltip(
		group: Group,
		pointer: { clientX: number; clientY: number }
	) {
		if (!canUseHoverTooltips) return;
		if (memberEventsPopupOpen) return;
		const shiftId = group.employeeTypeId ?? null;
		const { startIso, endIso } = monthWindowIso(selectedYear, selectedMonthIndex);
		const title = `${monthNames[selectedMonthIndex]} ${selectedYear} Events - ${group.category}`;
		positionHoverTooltipAtPointer(pointer.clientX, pointer.clientY);
		hoverTooltipTitle = title;
		hoverTooltipScopeType = 'shift';
		hoverTooltipWindowMode = 'shift-month';
		hoverTooltipOpen = true;
		if (!shiftId) {
			hoverTooltipLoading = false;
			hoverTooltipEntries = [];
			return;
		}
		const cacheKey = eventsCacheKey(`month:${startIso}:${endIso}`, 'shift', shiftId, null);
		const cachedEntries = scopedEventsCache.get(cacheKey);
		if (cachedEntries) {
			hoverTooltipLoading = false;
			hoverTooltipEntries = cachedEntries;
			positionHoverTooltipAtPointer(hoverTooltipPointerX, hoverTooltipPointerY);
			return;
		}

		hoverTooltipLoading = true;
		hoverTooltipEntries = [];
		const fetchToken = ++hoverTooltipFetchToken;
		try {
			const nextEntries = await fetchScopedEvents({ startIso, endIso }, 'shift', shiftId, null);
			scopedEventsCache.set(cacheKey, nextEntries);
			if (fetchToken !== hoverTooltipFetchToken || memberEventsPopupOpen) return;
			hoverTooltipLoading = false;
			hoverTooltipEntries = nextEntries;
			positionHoverTooltipAtPointer(hoverTooltipPointerX, hoverTooltipPointerY);
		} catch (error) {
			if (fetchToken !== hoverTooltipFetchToken) return;
			void error;
			hideHoverEventsTooltip();
		}
	}

	async function showUserMonthHoverTooltip(
		employee: Employee,
		groupShiftId: number | null,
		pointer: { clientX: number; clientY: number }
	) {
		if (!canUseHoverTooltips) return;
		if (memberEventsPopupOpen) return;
		const userOid = employee.userOid ?? null;
		const { startIso, endIso } = monthWindowIso(selectedYear, selectedMonthIndex);
		const title = `${monthNames[selectedMonthIndex]} ${selectedYear} Events - ${employee.name}`;
		positionHoverTooltipAtPointer(pointer.clientX, pointer.clientY);
		hoverTooltipTitle = title;
		hoverTooltipScopeType = 'user';
		hoverTooltipWindowMode = 'shift-month';
		hoverTooltipOpen = true;
		if (!userOid) {
			hoverTooltipLoading = false;
			hoverTooltipEntries = [];
			return;
		}
		const shiftKey = groupShiftId ?? 0;
		const cacheKey = eventsCacheKey(
			`month-user:${startIso}:${endIso}:${shiftKey}:${userOid}`,
			'user',
			groupShiftId,
			userOid
		);
		const cachedEntries = scopedEventsCache.get(cacheKey);
		if (cachedEntries) {
			hoverTooltipLoading = false;
			hoverTooltipEntries = cachedEntries;
			positionHoverTooltipAtPointer(hoverTooltipPointerX, hoverTooltipPointerY);
			return;
		}

		hoverTooltipLoading = true;
		hoverTooltipEntries = [];
		const fetchToken = ++hoverTooltipFetchToken;
		try {
			const nextEntries = await fetchScopedEvents(
				{ startIso, endIso },
				'user',
				groupShiftId,
				userOid
			);
			scopedEventsCache.set(cacheKey, nextEntries);
			if (fetchToken !== hoverTooltipFetchToken || memberEventsPopupOpen) return;
			hoverTooltipLoading = false;
			hoverTooltipEntries = nextEntries;
			positionHoverTooltipAtPointer(hoverTooltipPointerX, hoverTooltipPointerY);
		} catch (error) {
			if (fetchToken !== hoverTooltipFetchToken) return;
			void error;
			hideHoverEventsTooltip();
		}
	}

	function handleEmployeeDayHover(
		employee: Employee,
		groupShiftId: number | null,
		day: MonthDay,
		pointer: { clientX: number; clientY: number }
	) {
		void showHoverEventsTooltip(
			{
				day,
				scopeType: 'user',
				scopeLabel: employee.name,
				scopeShiftId: groupShiftId,
				scopeUserOid: employee.userOid ?? null
			},
			pointer
		);
	}

	function setEventCodePickerOpen(next: boolean) {
		eventCodePickerOpen = next;
	}

	function setAddStartDatePickerOpen(next: boolean) {
		addStartDatePickerOpen = next;
	}

	function setCustomDisplayModePickerOpen(next: boolean) {
		customDisplayModePickerOpen = next;
	}

	function setAddEndDatePickerOpen(next: boolean) {
		addEndDatePickerOpen = next;
	}

	function hasOpenMemberEventsPopover(): boolean {
		if (
			eventCodePickerOpen ||
			customDisplayModePickerOpen ||
			addStartDatePickerOpen ||
			addEndDatePickerOpen
		) {
			return true;
		}
		return Boolean(memberEventsModalEl?.querySelector('.colorPickerPopover'));
	}

	function handleMemberEventsBackdropMouseDown(event: MouseEvent) {
		if (event.target !== event.currentTarget) return;
		if (hasOpenMemberEventsPopover()) return;
		closeMemberEventsPopup();
	}

	function refreshBandMeasurements(
		_theme: 'light' | 'dark',
		_monthDays: MonthDay[],
		_activeDay: number | null
	) {
		void _theme;
		void _monthDays;
		void _activeDay;
		if (!mounted) return;
		queueMeasure();
	}

	function refreshScrollbarForData(
		_groups: Group[],
		_collapsed: Record<string, boolean>,
		_monthDays: MonthDay[]
	) {
		void _groups;
		void _collapsed;
		void _monthDays;
		queueScrollbarUpdate(true);
	}

	function queueScrollbarUpdate(settle = false) {
		if (typeof window === 'undefined') return;
		if (scrollbarUpdateQueued) return;
		scrollbarUpdateQueued = true;
		requestAnimationFrame(() => {
			scrollbarUpdateQueued = false;
			updateCustomScrollbar();
			if (settle) {
				requestAnimationFrame(updateCustomScrollbar);
			}
		});
	}

	function hasOverflow(scrollSize: number, clientSize: number): boolean {
		return scrollSize - clientSize > 0.5;
	}

	function syncGridResizeObserverTargets() {
		if (!gridResizeObserver) return;
		if (observedGridWrapEl && observedGridWrapEl !== gridWrapEl) {
			gridResizeObserver.unobserve(observedGridWrapEl);
			observedGridWrapEl = null;
		}
		if (observedGridEl && observedGridEl !== gridEl) {
			gridResizeObserver.unobserve(observedGridEl);
			observedGridEl = null;
		}
		if (gridWrapEl && observedGridWrapEl !== gridWrapEl) {
			gridResizeObserver.observe(gridWrapEl);
			observedGridWrapEl = gridWrapEl;
		}
		if (gridEl && observedGridEl !== gridEl) {
			gridResizeObserver.observe(gridEl);
			observedGridEl = gridEl;
		}
	}

	function logGridSizingDiagnostics(reason: string) {
		if (!LOG_GRID_SIZING_DIAGNOSTICS) return;
		if (!gridWrapEl || !gridEl || typeof window === 'undefined') return;

		const minDayWidthRaw = getComputedStyle(gridWrapEl)
			.getPropertyValue('--day-col-min-width')
			.trim();
		const minDayWidthPx = Number.parseFloat(minDayWidthRaw);
		const dayHeaderCells = Array.from(gridEl.querySelectorAll<HTMLElement>('.dayhdr'));
		const dayWidths = dayHeaderCells.map((element) => element.getBoundingClientRect().width);
		const firstDayWidth = dayWidths[0] ?? 0;
		const smallestDayWidth = dayWidths.length > 0 ? Math.min(...dayWidths) : 0;
		const largestDayWidth = dayWidths.length > 0 ? Math.max(...dayWidths) : 0;
		const hasHorizontalOverflow = hasOverflow(gridWrapEl.scrollWidth, gridWrapEl.clientWidth);
		const hasVerticalOverflow = hasOverflow(gridWrapEl.scrollHeight, gridWrapEl.clientHeight);
		const gridMinWidth = getComputedStyle(gridEl).minWidth;
		const gridTemplateColumns = getComputedStyle(gridEl).gridTemplateColumns;

		const logKey = [
			reason,
			Math.round(gridWrapEl.clientWidth),
			Math.round(gridWrapEl.scrollWidth),
			Math.round(gridWrapEl.clientHeight),
			Math.round(gridWrapEl.scrollHeight),
			Math.round(firstDayWidth * 10),
			Math.round(smallestDayWidth * 10),
			Math.round(largestDayWidth * 10),
			Math.round((Number.isFinite(minDayWidthPx) ? minDayWidthPx : 0) * 10),
			hasHorizontalOverflow ? '1' : '0',
			hasVerticalOverflow ? '1' : '0',
			showHorizontalScrollbar ? '1' : '0',
			showVerticalScrollbar ? '1' : '0',
			teamColumnCollapsed ? '1' : '0'
		].join('|');

		if (logKey === lastGridSizingLogKey) return;
		lastGridSizingLogKey = logKey;

		console.info('[ScheduleGrid sizing]', {
			reason,
			viewportWidth: window.innerWidth,
			gridClientWidth: gridWrapEl.clientWidth,
			gridScrollWidth: gridWrapEl.scrollWidth,
			gridClientHeight: gridWrapEl.clientHeight,
			gridScrollHeight: gridWrapEl.scrollHeight,
			effectiveFixedColumnsWidthPx,
			minimumGridWidthFromContent,
			minimumGridWidthFloor,
			gridMinWidth,
			minDayWidthPx: Number.isFinite(minDayWidthPx) ? minDayWidthPx : minDayWidthRaw,
			firstDayWidth,
			smallestDayWidth,
			largestDayWidth,
			dayColumnCount: dayHeaderCells.length,
			hasHorizontalOverflow,
			hasVerticalOverflow,
			showHorizontalScrollbar,
			showVerticalScrollbar,
			showTeamColumnRailToggle,
			teamColumnCollapsed,
			gridTemplateColumns
		});
	}

	$: activeEventCodeItems = [
		{ value: 'custom', label: 'Custom' },
		...eventCodeOptions.map((eventCode) => ({
			value: eventCode.eventCodeId,
			label: `${eventCode.code} - ${eventCode.name}`,
			color: eventCode.color
		}))
	] satisfies PickerOption[];

	$: selectedEventCodeLabel =
		activeEventCodeItems.find((item) => String(item.value) === addEventCodeId)?.label ??
		(eventCodesLoading ? 'Loading...' : 'Select event code');

	$: isCustomEventCodeSelected = addEventCodeId === 'custom';
	$: canAddScheduledReminderDraft = scheduledReminderDrafts.length < MAX_SCHEDULED_REMINDERS;
	$: if (addReminderScheduled && scheduledReminderDrafts.length === 0) {
		scheduledReminderDrafts = [createDefaultScheduledReminderDraft()];
	}
	$: scheduledReminderSummaryLines = (() => {
		if (!addReminderScheduled) return [] as string[];
		const seenReminderKeys = new Set<string>();
		const lines: string[] = [];
		for (const reminderDraft of scheduledReminderDrafts) {
			const key = reminderKey(reminderDraft);
			if (seenReminderKeys.has(key)) continue;
			seenReminderKeys.add(key);
			const targetDate = reminderTargetDate(addEventStartDate, reminderDraft);
			if (!targetDate) continue;
			lines.push(
				`${reminderDraft.hour} ${reminderDraft.meridiem} on ${formatReminderPreviewDate(targetDate)}`
			);
		}
		return lines;
	})();
	$: scheduledReminderSummaryTitle = `${scheduledReminderSummaryLines.length} Scheduled Reminder${scheduledReminderSummaryLines.length === 1 ? '' : 's'}`;

	$: selectedCustomDisplayModeLabel =
		eventDisplayModeItems.find((item) => item.value === addCustomEventDisplayMode)?.label ??
		'Schedule Overlay';

	$: addEventPrimaryButtonLabel = eventSaveInProgress
		? memberEventsPopupMode === 'edit'
			? 'Saving...'
			: 'Adding...'
		: memberEventsPopupMode === 'edit'
			? 'Save'
			: 'Add';

	function scopeSortRank(scopeType: EventScopeType): number {
		if (scopeType === 'user') return 3;
		if (scopeType === 'shift') return 2;
		return 1;
	}

	function eventDisplayModeClass(displayMode: EventDisplayMode): string {
		if (displayMode === 'Shift Override') return 'mode-shift-override';
		if (displayMode === 'Schedule Overlay') return 'mode-schedule-overlay';
		return 'mode-badge-indicator';
	}

	$: scopedPopupEvents = sortScopedEvents(scopedEventEntries);
	$: scopedHoverEvents = sortScopedEvents(hoverTooltipEntries);

	function activateTeamCell() {
		if (!canMaintainTeam) return;
		onTeamClick();
	}

	function makeRowKey(groupName: string, employeeId: string) {
		return `${groupName}::${employeeId}`;
	}

	function shiftAcronym(shiftName: string): string {
		const words = shiftName
			.trim()
			.split(/\s+/)
			.map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
			.filter((word) => word.length > 0);
		if (words.length === 0) return '';
		if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
		return words
			.map((word) => word[0])
			.join('')
			.slice(0, 4)
			.toUpperCase();
	}

	function handleRowSelect(rowKey: string) {
		if (selectedRowKey === rowKey) {
			selectedRowKey = null;
			return;
		}
		selectedRowKey = rowKey;
		selectedDay = null;
		selectedGroupIndex = null;
	}

	function handleSelectDayCell(rowKey: string, day: number) {
		const key = `day:${rowKey}:${day}`;
		if (
			selectedCellKey === key &&
			selectedRowKey === rowKey &&
			selectedDay === day &&
			selectedGroupIndex === null
		) {
			clearSelectionState();
			return;
		}
		selectedRowKey = rowKey;
		selectedDay = day;
		selectedGroupIndex = null;
		selectedCellKey = key;
	}

	function handleSelectCell(cellKey: string) {
		selectedCellKey = cellKey || null;
	}

	function handleDaySelect(day: number) {
		if (selectedDay === day && selectedGroupIndex === null) {
			selectedDay = null;
			selectedGroupIndex = null;
			return;
		}
		selectedRowKey = null;
		selectedDay = day;
		selectedGroupIndex = null;
		selectedCellKey = `header-day:${day}`;
	}

	function handleGroupDaySelect(groupIndex: number, day: number) {
		if (selectedDay === day && selectedGroupIndex === groupIndex) {
			selectedDay = null;
			selectedGroupIndex = null;
			return;
		}
		selectedRowKey = null;
		selectedDay = day;
		selectedGroupIndex = groupIndex;
	}

	function handleCollapsedShiftDaySelect(rowKey: string, groupIndex: number, day: number) {
		const key = `collapsed-shift-day:${groupIndex}:${day}`;
		if (
			selectedCellKey === key &&
			selectedRowKey === rowKey &&
			selectedDay === day &&
			selectedGroupIndex === null
		) {
			clearSelectionState();
			return;
		}
		selectedRowKey = rowKey;
		selectedDay = day;
		selectedGroupIndex = null;
		selectedCellKey = key;
	}

	function clearSelectionState() {
		selectedRowKey = null;
		selectedDay = null;
		selectedGroupIndex = null;
		selectedCellKey = null;
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function updateMemberEventsModalScrollbar() {
		if (!memberEventsModalScrollEl || !memberEventsPopupOpen) return;

		const scrollHeight = memberEventsModalScrollEl.scrollHeight;
		const clientHeight = memberEventsModalScrollEl.clientHeight;
		const scrollTop = memberEventsModalScrollEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;

		showMemberEventsModalScrollbar = hasOverflow;
		if (!hasOverflow) {
			memberEventsThumbHeightPx = 0;
			memberEventsThumbTopPx = 0;
			return;
		}

		const railHeight = memberEventsRailEl?.clientHeight ?? Math.max(clientHeight - 24, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		memberEventsThumbHeightPx = nextThumbHeight;
		memberEventsThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onMemberEventsModalScroll() {
		if (!isDraggingMemberEventsScrollbar) {
			updateMemberEventsModalScrollbar();
		}
	}

	function onMemberEventsModalDragMove(event: MouseEvent) {
		if (!isDraggingMemberEventsScrollbar || !memberEventsModalScrollEl || !memberEventsRailEl)
			return;

		const railHeight = memberEventsRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - memberEventsThumbHeightPx, 0);
		const nextThumbTop = clamp(
			memberEventsDragStartThumbTopPx + (event.clientY - memberEventsDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(
			memberEventsModalScrollEl.scrollHeight - memberEventsModalScrollEl.clientHeight,
			0
		);

		memberEventsThumbTopPx = nextThumbTop;
		memberEventsModalScrollEl.scrollTop =
			maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopMemberEventsModalDragging() {
		if (isDraggingMemberEventsScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingMemberEventsScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onMemberEventsModalDragMove);
			window.removeEventListener('mouseup', stopMemberEventsModalDragging);
		}
	}

	function startMemberEventsModalThumbDrag(event: MouseEvent) {
		if (!showMemberEventsModalScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingMemberEventsScrollbar = true;
		setGlobalScrollbarDragging(true);
		memberEventsDragStartY = event.clientY;
		memberEventsDragStartThumbTopPx = memberEventsThumbTopPx;
		window.addEventListener('mousemove', onMemberEventsModalDragMove);
		window.addEventListener('mouseup', stopMemberEventsModalDragging);
	}

	function handleMemberEventsModalRailClick(event: MouseEvent) {
		if (!memberEventsModalScrollEl || !memberEventsRailEl || !showMemberEventsModalScrollbar)
			return;
		if (event.target !== memberEventsRailEl) return;

		const rect = memberEventsRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - memberEventsThumbHeightPx / 2,
			0,
			Math.max(rect.height - memberEventsThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - memberEventsThumbHeightPx, 1);
		const maxScrollTop = Math.max(
			memberEventsModalScrollEl.scrollHeight - memberEventsModalScrollEl.clientHeight,
			0
		);
		memberEventsModalScrollEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateMemberEventsModalScrollbar();
	}

	function measureDayBand(day: number | null, band: HTMLDivElement | null) {
		if (!gridEl || !band || !day) return;
		const headerCell = gridEl.querySelector(`.dayhdr[data-day='${day}']`) as HTMLDivElement | null;
		if (!headerCell) return;
		const lastCell = gridEl.querySelector('.cell:last-of-type') as HTMLDivElement | null;
		if (!lastCell) return;
		const bandBottom = lastCell.offsetTop + lastCell.offsetHeight;
		const minBandBottom = headerCell.offsetTop + headerCell.offsetHeight;
		const bandHeight = Math.max(bandBottom, minBandBottom);
		band.style.left = `${headerCell.offsetLeft}px`;
		band.style.width = `${headerCell.offsetWidth}px`;
		band.style.top = '0px';
		band.style.height = `${bandHeight}px`;
	}

	function measureScopedDayBand(
		day: number | null,
		groupIndex: number | null,
		band: HTMLDivElement | null
	) {
		if (!gridEl || !band || !day || groupIndex === null) return;
		const shiftCell = gridEl.querySelector(
			`.cell[data-scope='shift-day'][data-day='${day}'][data-group-index='${groupIndex}']`
		) as HTMLDivElement | null;
		if (!shiftCell) return;
		const endEmployeeCell = gridEl.querySelector(
			`.cell[data-scope='employee-day'][data-day='${day}'][data-group-index='${groupIndex}'][data-group-end='true']`
		) as HTMLDivElement | null;
		const bandBottomCell = endEmployeeCell ?? shiftCell;
		const bandBottom = bandBottomCell.offsetTop + bandBottomCell.offsetHeight;
		band.style.left = `${shiftCell.offsetLeft}px`;
		band.style.width = `${shiftCell.offsetWidth}px`;
		band.style.top = `${shiftCell.offsetTop}px`;
		band.style.height = `${Math.max(bandBottom - shiftCell.offsetTop, shiftCell.offsetHeight)}px`;
	}

	function updateShiftPropagatedBadgeSizes() {
		if (!gridEl) {
			shiftPropagatedBadgeSizeByGroupIndex = new Map();
			userBadgeSizeByGroupIndex = new Map();
			return;
		}
		const nextShiftMap = new Map<number, number>();
		const nextUserMap = new Map<number, number>();
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const shiftCell = gridEl.querySelector(
				`.cell[data-scope='shift-day'][data-group-index='${groupIndex}']`
			) as HTMLDivElement | null;
			if (!shiftCell) continue;
			const userCell = gridEl.querySelector(
				`.cell[data-scope='employee-day'][data-group-index='${groupIndex}']`
			) as HTMLDivElement | null;

			const shiftWidth = shiftCell.clientWidth;
			const shiftHeight = shiftCell.clientHeight;
			const userWidth = userCell?.clientWidth ?? shiftWidth;
			const userHeight = userCell?.clientHeight ?? effectiveUserRowHeightPx;

			const userBadgeSizeRaw = Math.max(0, Math.min(userWidth * 0.62, userHeight * 0.56));
			const userBadgeSize = Math.max(0, Math.round(userBadgeSizeRaw));

			const shiftBaseSize = Math.max(0, Math.min(shiftWidth * 0.62, shiftHeight * 0.48));
			const heightDifference = Math.max(userHeight - shiftHeight, 0);
			const desiredGapPx = Math.round(clamp(4 + heightDifference * 0.1, 4, 7));
			const shiftBadgeMaxFromUser = Math.max(0, userBadgeSize - desiredGapPx);
			let shiftBadgeSize = Math.max(0, Math.round(Math.min(shiftBaseSize, shiftBadgeMaxFromUser)));
			if ((userBadgeSize - shiftBadgeSize) % 2 !== 0) {
				shiftBadgeSize = Math.max(0, shiftBadgeSize - 1);
			}

			nextUserMap.set(groupIndex, userBadgeSize);
			nextShiftMap.set(groupIndex, shiftBadgeSize);
		}
		shiftPropagatedBadgeSizeByGroupIndex = nextShiftMap;
		userBadgeSizeByGroupIndex = nextUserMap;
	}

	function queueMeasure() {
		if (resizeQueued) return;
		resizeQueued = true;
		requestAnimationFrame(() => {
			resizeQueued = false;
			measureDayBand(activeTodayDay, bandEl);
			measureDayBand(selectedDay, selectedBandEl);
			measureScopedDayBand(selectedDay, selectedGroupIndex, scopedSelectedBandEl);
			updateShiftPropagatedBadgeSizes();
		});
	}

	function readCssPx(varName: string, fallback: number): number {
		if (!gridWrapEl) return fallback;
		const raw = getComputedStyle(gridWrapEl).getPropertyValue(varName).trim();
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	function updateFixedScrollbarRailStyles() {
		if (!gridWrapEl || typeof window === 'undefined') return;

		const rect = gridWrapEl.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const railSize = readCssPx('--scrollbar-size', 8);
		const headerRowHeight = readCssPx('--schedule-header-row-height', 44);

		const horizontalMarginLeft = 12;
		const horizontalMarginRight = 12;
		const horizontalOffsetBottom = 5;
		const verticalMarginTop = 8;
		const verticalMarginBottom = 8;
		const verticalOffsetRight = 5;
		const stickyBoundaryEls = gridWrapEl.querySelectorAll<HTMLElement>(
			'.teamHeaderMerged, .teamColumnRailToggle'
		);
		let stickyBoundaryRight = rect.left;
		stickyBoundaryEls.forEach((element) => {
			stickyBoundaryRight = Math.max(stickyBoundaryRight, element.getBoundingClientRect().right);
		});

		const visibleTop = clamp(rect.top, 0, viewportHeight);
		const visibleBottom = clamp(rect.bottom, 0, viewportHeight);
		const visibleLeft = clamp(rect.left, 0, viewportWidth);
		const visibleRight = clamp(rect.right, 0, viewportWidth);

		const horizontalTop = Math.round(
			clamp(
				visibleBottom - horizontalOffsetBottom - railSize,
				0,
				Math.max(viewportHeight - railSize, 0)
			)
		);
		const horizontalLeft = Math.round(
			clamp(stickyBoundaryRight + horizontalMarginLeft, visibleLeft, visibleRight)
		);
		const horizontalRightInset =
			horizontalMarginRight + (showVerticalScrollbar ? railSize + verticalOffsetRight : 0);
		const horizontalRight = Math.round(
			clamp(rect.right - horizontalRightInset, visibleLeft, visibleRight)
		);
		const horizontalWidth = Math.max(horizontalRight - horizontalLeft, 0);

		const verticalLeft = Math.round(
			clamp(rect.right - verticalOffsetRight - railSize, visibleLeft, visibleRight)
		);
		const verticalTop = Math.round(
			clamp(rect.top + verticalMarginTop + headerRowHeight, visibleTop, visibleBottom)
		);
		const verticalBottomInset =
			verticalMarginBottom + (showHorizontalScrollbar ? railSize + horizontalOffsetBottom : 0);
		const verticalBottom = Math.round(
			clamp(rect.bottom - verticalBottomInset, visibleTop, visibleBottom)
		);
		const verticalHeight = Math.max(verticalBottom - verticalTop, 0);

		horizontalRailStyle = `left:${horizontalLeft}px;top:${horizontalTop}px;width:${horizontalWidth}px;`;
		verticalRailStyle = `left:${verticalLeft}px;top:${verticalTop}px;height:${verticalHeight}px;`;
	}

	function updateRowDensity() {
		if (!gridWrapEl || !gridEl) return;

		const minRowHeight = readCssPx('--schedule-row-min-height', 25);
		const maxRowHeight = readCssPx('--schedule-row-max-height', 44);
		const headerRowHeight = readCssPx('--schedule-header-row-height', 44);
		const userRowCount = groups.reduce((total, group) => {
			if (collapsed[group.category]) return total;
			return total + group.employees.length;
		}, 0);

		if (userRowCount <= 0) {
			const roundedMax = Math.round(maxRowHeight);
			if (effectiveUserRowHeightPx !== roundedMax) {
				effectiveUserRowHeightPx = roundedMax;
			}
			return;
		}

		let groupRowsHeight = 0;
		const groupRowEls = gridEl.querySelectorAll('.cell.shiftRowCell.namecol');
		groupRowEls.forEach((element) => {
			groupRowsHeight += (element as HTMLElement).offsetHeight;
		});

		const availableHeight = gridWrapEl.clientHeight;
		const availableForUsers = Math.max(availableHeight - headerRowHeight - groupRowsHeight, 0);
		const fittedHeight = Math.floor(availableForUsers / userRowCount);
		const nextRowHeight = Math.round(
			clamp(fittedHeight, Math.ceil(minRowHeight), Math.floor(maxRowHeight))
		);

		if (nextRowHeight !== effectiveUserRowHeightPx) {
			effectiveUserRowHeightPx = nextRowHeight;
		}
	}

	function updateCustomScrollbar() {
		if (!gridWrapEl) return;
		if (!useCustomGridScrollbars) {
			showHorizontalScrollbar = false;
			showVerticalScrollbar = false;
			horizontalThumbWidthPx = 0;
			horizontalThumbLeftPx = 0;
			verticalThumbHeightPx = 0;
			verticalThumbTopPx = 0;
			horizontalRailStyle = '';
			verticalRailStyle = '';
			logGridSizingDiagnostics('custom-scrollbars-disabled');
			return;
		}

		const scrollWidth = gridWrapEl.scrollWidth;
		const clientWidth = gridWrapEl.clientWidth;
		const scrollLeft = gridWrapEl.scrollLeft;
		const hasHorizontalOverflow = hasOverflow(scrollWidth, clientWidth);

		showHorizontalScrollbar = hasHorizontalOverflow;
		if (!hasHorizontalOverflow) {
			horizontalThumbWidthPx = 0;
			horizontalThumbLeftPx = 0;
		} else {
			const horizontalRailWidth = horizontalRailEl?.clientWidth ?? Math.max(clientWidth - 24, 0);
			if (horizontalRailWidth > 0) {
				const minThumbWidth = 48;
				const nextThumbWidth = Math.max(
					minThumbWidth,
					(horizontalRailWidth * clientWidth) / scrollWidth
				);
				const maxThumbLeft = Math.max(horizontalRailWidth - nextThumbWidth, 0);
				const maxScrollLeft = Math.max(scrollWidth - clientWidth, 1);
				const nextThumbLeft = (scrollLeft / maxScrollLeft) * maxThumbLeft;

				horizontalThumbWidthPx = nextThumbWidth;
				horizontalThumbLeftPx = clamp(nextThumbLeft, 0, maxThumbLeft);
			}
		}

		const scrollHeight = gridWrapEl.scrollHeight;
		const clientHeight = gridWrapEl.clientHeight;
		const scrollTop = gridWrapEl.scrollTop;
		const hasVerticalOverflow = hasOverflow(scrollHeight, clientHeight);

		showVerticalScrollbar = hasVerticalOverflow;
		if (!hasVerticalOverflow) {
			verticalThumbHeightPx = 0;
			verticalThumbTopPx = 0;
			updateFixedScrollbarRailStyles();
			logGridSizingDiagnostics('vertical-overflow-cleared');
			return;
		}

		const verticalRailHeight = verticalRailEl?.clientHeight ?? Math.max(clientHeight - 24, 0);
		if (verticalRailHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(
			minThumbHeight,
			(verticalRailHeight * clientHeight) / scrollHeight
		);
		const maxThumbTop = Math.max(verticalRailHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		verticalThumbHeightPx = nextThumbHeight;
		verticalThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
		updateFixedScrollbarRailStyles();
		logGridSizingDiagnostics('scrollbar-updated');
	}

	function onGridScroll() {
		hideHoverEventsTooltip();
		if (!useCustomGridScrollbars) return;
		if (!isDraggingHorizontalScrollbar && !isDraggingVerticalScrollbar) {
			updateCustomScrollbar();
		}
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

	function onHorizontalDragMove(event: MouseEvent) {
		if (!isDraggingHorizontalScrollbar || !gridWrapEl || !horizontalRailEl) return;

		const railWidth = horizontalRailEl.clientWidth;
		const maxThumbLeft = Math.max(railWidth - horizontalThumbWidthPx, 0);
		const nextThumbLeft = clamp(
			dragStartHorizontalThumbLeftPx + (event.clientX - dragStartX),
			0,
			maxThumbLeft
		);
		const maxScrollLeft = Math.max(gridWrapEl.scrollWidth - gridWrapEl.clientWidth, 0);

		horizontalThumbLeftPx = nextThumbLeft;
		gridWrapEl.scrollLeft = maxThumbLeft > 0 ? (nextThumbLeft / maxThumbLeft) * maxScrollLeft : 0;
	}

	function stopHorizontalDragging() {
		if (isDraggingHorizontalScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingHorizontalScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onHorizontalDragMove);
			window.removeEventListener('mouseup', stopHorizontalDragging);
		}
	}

	function startHorizontalThumbDrag(event: MouseEvent) {
		if (!showHorizontalScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingHorizontalScrollbar = true;
		setGlobalScrollbarDragging(true);
		dragStartX = event.clientX;
		dragStartHorizontalThumbLeftPx = horizontalThumbLeftPx;
		window.addEventListener('mousemove', onHorizontalDragMove);
		window.addEventListener('mouseup', stopHorizontalDragging);
	}

	function onVerticalDragMove(event: MouseEvent) {
		if (!isDraggingVerticalScrollbar || !gridWrapEl || !verticalRailEl) return;

		const railHeight = verticalRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - verticalThumbHeightPx, 0);
		const nextThumbTop = clamp(
			dragStartVerticalThumbTopPx + (event.clientY - dragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(gridWrapEl.scrollHeight - gridWrapEl.clientHeight, 0);

		verticalThumbTopPx = nextThumbTop;
		gridWrapEl.scrollTop = maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopVerticalDragging() {
		if (isDraggingVerticalScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingVerticalScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onVerticalDragMove);
			window.removeEventListener('mouseup', stopVerticalDragging);
		}
	}

	function startVerticalThumbDrag(event: MouseEvent) {
		if (!showVerticalScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingVerticalScrollbar = true;
		setGlobalScrollbarDragging(true);
		dragStartY = event.clientY;
		dragStartVerticalThumbTopPx = verticalThumbTopPx;
		window.addEventListener('mousemove', onVerticalDragMove);
		window.addEventListener('mouseup', stopVerticalDragging);
	}

	function handleVerticalRailClick(event: MouseEvent) {
		if (!gridWrapEl || !verticalRailEl || !showVerticalScrollbar) return;
		if (event.target !== verticalRailEl) return;

		const rect = verticalRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - verticalThumbHeightPx / 2,
			0,
			Math.max(rect.height - verticalThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - verticalThumbHeightPx, 1);
		const maxScrollTop = Math.max(gridWrapEl.scrollHeight - gridWrapEl.clientHeight, 0);
		gridWrapEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateCustomScrollbar();
	}

	function handleHorizontalRailClick(event: MouseEvent) {
		if (!gridWrapEl || !horizontalRailEl || !showHorizontalScrollbar) return;
		if (event.target !== horizontalRailEl) return;

		const rect = horizontalRailEl.getBoundingClientRect();
		const desiredLeft = clamp(
			event.clientX - rect.left - horizontalThumbWidthPx / 2,
			0,
			Math.max(rect.width - horizontalThumbWidthPx, 0)
		);
		const maxThumbLeft = Math.max(rect.width - horizontalThumbWidthPx, 1);
		const maxScrollLeft = Math.max(gridWrapEl.scrollWidth - gridWrapEl.clientWidth, 0);
		gridWrapEl.scrollLeft = (desiredLeft / maxThumbLeft) * maxScrollLeft;
		updateCustomScrollbar();
	}

	onMount(() => {
		mounted = true;
		let hoverCapabilityMediaQuery: MediaQueryList | null = null;
		const applyHoverCapability = () => {
			const canHover =
				typeof window !== 'undefined' &&
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches;
			canUseHoverTooltips = canHover;
			if (!canHover) {
				hideHoverEventsTooltip();
			}
		};
		if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
			useCustomGridScrollbars = true;
			hoverCapabilityMediaQuery = window.matchMedia('(any-hover: hover) and (any-pointer: fine)');
			applyHoverCapability();
			if (typeof hoverCapabilityMediaQuery.addEventListener === 'function') {
				hoverCapabilityMediaQuery.addEventListener('change', applyHoverCapability);
			} else {
				hoverCapabilityMediaQuery.addListener(applyHoverCapability);
			}
		}
		queueMeasure();
		updateRowDensity();
		queueScrollbarUpdate(true);
		if (typeof ResizeObserver !== 'undefined') {
			gridResizeObserver = new ResizeObserver(() => {
				queueScrollbarUpdate(true);
			});
			syncGridResizeObserverTargets();
		}
		const onResize = () => {
			queueMeasure();
			updateRowDensity();
			queueScrollbarUpdate(true);
			updateMemberEventsModalScrollbar();
		};
		const onViewportScroll = () => {
			updateFixedScrollbarRailStyles();
		};
		window.addEventListener('resize', onResize);
		window.addEventListener('scroll', onViewportScroll, true);
		return () => {
			window.removeEventListener('resize', onResize);
			window.removeEventListener('scroll', onViewportScroll, true);
			if (gridResizeObserver) {
				gridResizeObserver.disconnect();
				gridResizeObserver = null;
			}
			observedGridWrapEl = null;
			observedGridEl = null;
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
		queueMeasure();
		updateRowDensity();
		syncGridResizeObserverTargets();
		queueScrollbarUpdate(true);
		if (memberEventsPopupOpen) {
			updateMemberEventsModalScrollbar();
		}
	});

	$: refreshBandMeasurements(theme, monthDays, activeTodayDay);

	$: refreshScrollbarForData(groups, collapsed, monthDays);

	$: {
		void events;
		scopedEventsCache.clear();
	}

	$: if (
		memberEventsPopupOpen &&
		memberEventsPopupMode === 'list' &&
		memberEventsPopupPollTimer === null
	) {
		memberEventsPopupPollTimer = setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			void loadScopedEvents();
		}, 15000);
	}

	$: if (
		(!memberEventsPopupOpen || memberEventsPopupMode !== 'list') &&
		memberEventsPopupPollTimer !== null
	) {
		clearInterval(memberEventsPopupPollTimer);
		memberEventsPopupPollTimer = null;
	}

	$: {
		if (popupResetToken !== lastPopupResetToken) {
			lastPopupResetToken = popupResetToken;
			closeMemberEventsPopup();
			hideHoverEventsTooltip();
		}
	}

	$: {
		const nextSelectionContextKey = `${selectedYear}-${selectedMonthIndex}`;
		if (nextSelectionContextKey !== lastSelectionContextKey) {
			lastSelectionContextKey = nextSelectionContextKey;
			clearSelectionState();
			hideHoverEventsTooltip();
		}
	}

	onDestroy(() => {
		if (memberEventsPopupPollTimer !== null) {
			clearInterval(memberEventsPopupPollTimer);
			memberEventsPopupPollTimer = null;
		}
		stopHorizontalDragging();
		stopVerticalDragging();
		stopMemberEventsModalDragging();
		hideHoverEventsTooltip();
	});
</script>

<div
	class="gridwrapShell shiftMergeLayout"
	class:mobileTeamColumnCollapsed={teamColumnCollapsed}
	style={gridShellStyle}
>
	{#if showTeamColumnRailToggle}
		<div class="teamColumnRailViewportGlyph" aria-hidden="true">
			<svg viewBox="0 0 24 24" aria-hidden="true">
				{#if teamColumnCollapsed}
					<path d="M9 5L16 12L9 19" />
				{:else}
					<path d="M15 5L8 12L15 19" />
				{/if}
			</svg>
		</div>
	{/if}
	<div class="gridwrap" bind:this={gridWrapEl} on:scroll={onGridScroll}>
		<div
			class="grid"
			role="grid"
			aria-label="Shift schedule grid"
			style={gridStyle}
			bind:this={gridEl}
		>
			{#if activeTodayDay}
				<!-- div class="today-band" bind:this={bandEl}><!/div-->
			{/if}
			{#if selectedDay && selectedGroupIndex === null}
				<div class="selected-day-band" bind:this={selectedBandEl}></div>
			{/if}
			{#if selectedDay && selectedGroupIndex !== null}
				<div class="selected-day-band" bind:this={scopedSelectedBandEl}></div>
			{/if}

			{#if canMaintainTeam}
				<div
					class="cell hdr namecol teamHeader teamHeaderMerged clickable"
					role="button"
					tabindex="0"
					title="Team"
					aria-label="Configure team and schedule setup"
					on:click={activateTeamCell}
					on:keydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							activateTeamCell();
						}
					}}
				>
					<div class="groupRow">Team</div>
				</div>
			{:else}
				<div class="cell hdr namecol teamHeader teamHeaderMerged" role="columnheader" title="Team">
					<div class="groupRow">Team</div>
				</div>
			{/if}
			{#if showTeamColumnRailToggle}
				<div
					class="cell namecol teamColumnRailToggle"
					role="button"
					tabindex="0"
					aria-pressed={!teamColumnCollapsed}
					aria-label={teamColumnCollapsed ? 'Expand team columns' : 'Collapse team columns'}
					on:click={toggleTeamColumnVisibility}
					on:keydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							toggleTeamColumnVisibility();
						}
					}}
				></div>
			{/if}

			{#each days as day (day.day)}
				{@const headerVisuals = dayHeaderEventVisuals.get(day.day)}
				<div
					class={`${dayHeaderClass(day)} selectableColumnHeader${selectedDay === day.day && selectedGroupIndex === null ? ' columnSelected colStart' : ''}${selectedCellKey === `header-day:${day.day}` ? ' cellSelected' : ''}`}
					data-day={day.day}
					role="columnheader"
					aria-label={dayAriaLabel(day)}
					tabindex="0"
					on:click={(event) => handleDayHeaderClick(day.day, event)}
					on:keydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							handleDaySelect(day.day);
						}
					}}
					on:contextmenu={(event) => {
						event.preventDefault();
						handleDayHeaderDoubleClick(day);
					}}
					on:touchend={(event) => handleDayHeaderTouchEnd(day, event)}
					on:mouseenter={(event) =>
						handleDayHeaderHover(day, { clientX: event.clientX, clientY: event.clientY })}
					on:mousemove={(event) =>
						handleDayHeaderHover(day, { clientX: event.clientX, clientY: event.clientY })}
					on:mouseleave={hideHoverEventsTooltip}
				>
					{#if day.isToday}
						<div class="todayHeaderOverlay" aria-hidden="true"></div>
					{/if}
					{#if headerVisuals?.overrideBackground}
						<div
							class="cellShiftOverrideBg"
							style={`--event-shift-override-bg:${headerVisuals.overrideBackground};`}
							aria-hidden="true"
						></div>
					{/if}
					{#if headerVisuals?.overlayBackground}
						<div
							class="cellEventOverlay"
							style={`--event-overlay-bg:${headerVisuals.overlayBackground};`}
							aria-hidden="true"
						></div>
					{/if}
					{#if headerVisuals?.badgeBackground}
						<div
							class="dayHeaderEventBadge"
							style={`--event-badge-bg:${headerVisuals.badgeBackground};`}
							aria-hidden="true"
						>
							<span class="dayHeaderEventBadgeChip dayHeaderEventBadgeChipTopLeft"></span>
							<span class="dayHeaderEventBadgeChip dayHeaderEventBadgeChipTopRight"></span>
							<span class="dayHeaderEventBadgeChip dayHeaderEventBadgeChipBottomLeft"></span>
							<span class="dayHeaderEventBadgeChip dayHeaderEventBadgeChipBottomRight"></span>
						</div>
					{/if}
					<span class="daynum">{day.day}</span>
					<span class="dow">{dayDowShort(day)}</span>
				</div>
			{/each}

			{#each groups as group, groupIndex (group.category)}
				{#if collapsed[group.category] || group.employees.length === 0}
					{@const collapsedRowKey = `collapsed-shift:${group.category}:${groupIndex}`}
					<GroupRow
						groupName={group.category}
						employeeTypeId={group.employeeTypeId ?? null}
						{events}
						{selectedYear}
						{selectedMonthIndex}
						employeeCount={group.employees.length}
						collapsed={collapsed[group.category] === true}
						{monthDays}
						{selectedDay}
						{selectedGroupIndex}
						{selectedCellKey}
						{selectedRowKey}
						rowKey={collapsedRowKey}
						{groupIndex}
						mergeFirstTwoColumns={true}
						isLastVisibleRow={groupIndex === groups.length - 1}
						onSelectDay={(day) => handleSelectDayCell(collapsedRowKey, day)}
						onDoubleClickDay={(day) => handleGroupDayDoubleClick(group, day)}
						onShiftCellContextMenu={(event) => handleShiftCellContextMenu(event, group)}
						onHoverShiftCell={(pointer) => void showShiftMonthHoverTooltip(group, pointer)}
						onLeaveShiftCell={hideHoverEventsTooltip}
						onHoverDayCell={(day, _cellEl, pointer) => handleGroupDayHover(group, day, pointer)}
						onLeaveDayCell={hideHoverEventsTooltip}
						onToggle={() => onToggleGroup(group)}
					/>
				{:else}
					<div
						class={`cell shiftRowCell shiftMergeCol shiftMergeToggle groupBoundary${groupIndex === groups.length - 1 ? ' lastVisibleRowBoundary' : ''}${group.employees.length > 1 ? ' shiftMergeDiagonal' : ''}`}
						role="button"
						tabindex="0"
						aria-expanded="true"
						aria-label={`Collapse ${group.category}`}
						style={`grid-row: span ${group.employees.length};`}
						on:click={() => onToggleGroup(group)}
						on:contextmenu={(event) => handleShiftCellContextMenu(event, group)}
						on:mouseenter={(event) =>
							void showShiftMonthHoverTooltip(group, {
								clientX: event.clientX,
								clientY: event.clientY
							})}
						on:mousemove={(event) =>
							void showShiftMonthHoverTooltip(group, {
								clientX: event.clientX,
								clientY: event.clientY
							})}
						on:mouseleave={hideHoverEventsTooltip}
						on:keydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								onToggleGroup(group);
							}
						}}
					>
						<div class="shiftMergeLabel">
							<span class="caret" aria-hidden="true">▾</span>
							<strong class={group.employees.length > 1 ? 'diagonalShiftLabel' : ''}>
								{shiftAcronym(group.category)}
							</strong>
						</div>
					</div>
					{#each group.employees as employee, employeeIndex (employee.userOid ?? `${group.category}:${employee.name}:${employeeIndex}`)}
						<EmployeeRow
							{employee}
							groupName={group.category}
							employeeTypeId={group.employeeTypeId ?? null}
							{events}
							{selectedYear}
							{selectedMonthIndex}
							{monthDays}
							{overrides}
							{selectedDay}
							{selectedGroupIndex}
							{groupIndex}
							isLastVisibleRow={groupIndex === groups.length - 1 &&
								employeeIndex === group.employees.length - 1}
							isFirstInGroup={employeeIndex === 0}
							isLastInGroup={employeeIndex === group.employees.length - 1}
							onOpenDisplayNameEditor={onEmployeeDoubleClick}
							rowKey={makeRowKey(group.category, employee.userOid ?? employee.name)}
							{selectedRowKey}
							{selectedCellKey}
							onSelectRow={handleRowSelect}
							onSelectCell={handleSelectCell}
							onSelectDayCell={handleSelectDayCell}
							onDoubleClickDayCell={(employee, day) =>
								handleEmployeeDayDoubleClick(employee, group.employeeTypeId ?? null, day)}
							onHoverNameCell={(pointer) =>
								void showUserMonthHoverTooltip(employee, group.employeeTypeId ?? null, pointer)}
							onLeaveNameCell={hideHoverEventsTooltip}
							onHoverDayCell={(day, _cellEl, pointer) =>
								handleEmployeeDayHover(employee, group.employeeTypeId ?? null, day, pointer)}
							onLeaveDayCell={hideHoverEventsTooltip}
						/>
					{/each}
				{/if}
			{/each}
		</div>
	</div>
	{#if hoverTooltipOpen}
		<div
			class="memberEventsHoverTooltip"
			role="status"
			aria-live="polite"
			style={`left:${hoverTooltipLeftPx}px;top:${hoverTooltipTopPx}px;`}
			bind:this={hoverTooltipEl}
		>
			<div class="memberEventsHoverTooltipTitle">{hoverTooltipTitle}</div>
			{#if hoverTooltipLoading}
				<div class="memberEventEmptyRow">Loading events...</div>
			{:else}
				<div class="memberEventsRows">
					{#if scopedHoverEvents.length === 0}
						<div class="memberEventEmptyRow">No Events</div>
					{:else}
						{#each scopedHoverEvents as eventRow (eventRow.eventId)}
							{@const scopeSuffix = eventScopeSuffix(eventRow, hoverTooltipScopeType)}
							<div class="memberEventRow">
								<div class="memberEventCodeLine">
									<span
										class={`memberEventColorDot ${eventDisplayModeClass(eventRow.eventDisplayMode)}`}
										style={`background:${eventRow.eventCodeColor};`}
										aria-hidden="true"
									></span>
									<strong>{eventRow.eventCodeCode}</strong>
									<span>{eventRow.eventCodeName}{scopeSuffix ? ` - ${scopeSuffix}` : ''}</span>
								</div>
								{#if hoverTooltipWindowMode === 'shift-month' || eventRow.startDate !== eventRow.endDate}
									<div class="memberEventDates">
										{formatEventDateOrRange(eventRow.startDate, eventRow.endDate)}
									</div>
								{/if}
								{#if eventRow.comments}
									<div class="memberEventComment">{eventRow.comments}</div>
								{/if}
							</div>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
	{#if memberEventsPopupOpen}
		<div
			class="displayNameModalBackdrop"
			role="presentation"
			on:mousedown={handleMemberEventsBackdropMouseDown}
		>
			<div
				class="displayNameModal memberEventsModal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="member-events-modal-title"
				bind:this={memberEventsModalEl}
			>
				<div
					class="memberEventsModalScroll"
					class:hasScrollbar={showMemberEventsModalScrollbar}
					bind:this={memberEventsModalScrollEl}
					on:scroll={onMemberEventsModalScroll}
				>
					<h2 id="member-events-modal-title">{memberEventsPopupTitle}</h2>

					{#if memberEventsPopupMode === 'list'}
						<div class="memberEventsRows">
							{#if memberEventsLoading}
								<div class="memberEventEmptyRow">Loading events...</div>
							{:else if memberEventsError}
								<div class="memberEventError" role="alert">{memberEventsError}</div>
							{:else if scopedPopupEvents.length === 0}
								<div class="memberEventEmptyRow">No Events</div>
							{:else}
								{#each scopedPopupEvents as eventRow (eventRow.eventId)}
									{@const scopeSuffix = eventScopeSuffix(eventRow, memberEventsPopupScopeType)}
									<div
										class={`memberEventRow${canMaintainTeam ? ' editable' : ''}`}
										role={canMaintainTeam ? 'button' : undefined}
										tabindex={canMaintainTeam ? 0 : undefined}
										aria-label={canMaintainTeam
											? `Edit event ${eventRow.eventCodeCode}`
											: undefined}
										on:click={() => {
											if (canMaintainTeam) {
												void openEditEventView(eventRow);
											}
										}}
										on:keydown={(event) => {
											if (!canMaintainTeam) return;
											if (event.key === 'Enter' || event.key === ' ') {
												event.preventDefault();
												void openEditEventView(eventRow);
											}
										}}
									>
										<div class="memberEventCodeLine">
											<span
												class={`memberEventColorDot ${eventDisplayModeClass(eventRow.eventDisplayMode)}`}
												style={`background:${eventRow.eventCodeColor};`}
												aria-hidden="true"
											></span>
											<strong>{eventRow.eventCodeCode}</strong>
											<span>{eventRow.eventCodeName}{scopeSuffix ? ` - ${scopeSuffix}` : ''}</span>
										</div>
										{#if memberEventsPopupWindowMode === 'shift-month' || eventRow.startDate !== eventRow.endDate}
											<div class="memberEventDates">
												{formatEventDateOrRange(eventRow.startDate, eventRow.endDate)}
											</div>
										{/if}
										{#if eventRow.comments}
											<div class="memberEventComment">{eventRow.comments}</div>
										{/if}
										{#if canMaintainTeam}
											<div class="memberEventEditOverlay" aria-hidden="true">
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
							{/if}

							{#if canMaintainTeam}
								<button type="button" class="memberEventAddRowBtn" on:click={openAddEventView}>
									<svg viewBox="0 0 24 24" aria-hidden="true">
										<path d="M12 5v14M5 12h14" />
									</svg>
								</button>
							{/if}
						</div>
					{:else}
						<div class="memberEventForm">
							<div class="memberEventField">
								<span class="memberEventFieldLabel">Event Code</span>
								<div class="memberEventPickerWrap">
									<Picker
										id="memberEventCodeBtn"
										menuId="memberEventCodeMenu"
										label="Event Code"
										items={activeEventCodeItems}
										fullWidth={true}
										selectedValue={addEventCodeId === 'custom'
											? 'custom'
											: addEventCodeId
												? Number(addEventCodeId)
												: ''}
										selectedLabel={selectedEventCodeLabel}
										open={eventCodePickerOpen}
										onOpenChange={setEventCodePickerOpen}
										on:select={(event) => handleEventCodeSelection(event.detail)}
									/>
								</div>
							</div>

							<div class="memberEventDateFields">
								<div class="memberEventField">
									<span class="memberEventFieldLabel">Start Date</span>
									<DatePicker
										id="memberEventStartDateBtn"
										menuId="memberEventStartDateMenu"
										label="Start Date"
										placeholder="Select start date"
										value={addEventStartDate}
										open={addStartDatePickerOpen}
										onOpenChange={setAddStartDatePickerOpen}
										on:change={(event) => {
											addEventStartDate = event.detail;
										}}
									/>
								</div>
								<div class="memberEventField">
									<span class="memberEventFieldLabel">End Date</span>
									<DatePicker
										id="memberEventEndDateBtn"
										menuId="memberEventEndDateMenu"
										label="End Date"
										placeholder="Select end date"
										value={addEventEndDate}
										min={addEventStartDate}
										open={addEndDatePickerOpen}
										onOpenChange={setAddEndDatePickerOpen}
										on:change={(event) => {
											addEventEndDate = event.detail;
										}}
									/>
								</div>
							</div>

							{#if !isCustomEventCodeSelected}
								<div class="memberEventReminderSection">
									<div class="memberEventCustomTitle">Reminders</div>
									<ThemedCheckbox
										id="event-reminder-immediate"
										bind:checked={addReminderImmediate}
										label="Notify Immediately"
									/>
									<ThemedCheckbox
										id="event-reminder-scheduled"
										bind:checked={addReminderScheduled}
										label="Scheduled Reminders"
									/>
									{#if addReminderScheduled}
										<div class="memberEventReminderPickerStack">
											<div class="memberEventReminderHeaderRow" aria-hidden="true">
												<span>Amount</span>
												<span>Unit</span>
												<span>Time</span>
												<span>AM/PM</span>
												<span class="memberEventReminderHeaderAction"></span>
											</div>
											{#each scheduledReminderDrafts as reminderDraft (reminderDraft.id)}
												<div class="memberEventReminderRowWrap">
													<div class="memberEventReminderPickerRow">
														<ThemedSpinPicker
															id={`event-reminder-amount-${reminderDraft.id}`}
															options={reminderAmountOptions}
															value={reminderDraft.amount}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'amount',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`event-reminder-unit-${reminderDraft.id}`}
															options={reminderUnitOptions}
															value={reminderDraft.unit}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'unit',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`event-reminder-hour-${reminderDraft.id}`}
															options={reminderHourOptions}
															value={reminderDraft.hour}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'hour',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`event-reminder-meridiem-${reminderDraft.id}`}
															options={reminderMeridiemOptions}
															value={reminderDraft.meridiem}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'meridiem',
																	event.detail
																)}
														/>
													</div>
													<button
														type="button"
														class="memberEventReminderRemoveBtn"
														on:click={() => removeScheduledReminderDraft(reminderDraft.id)}
														aria-label="Remove scheduled reminder"
													>
														<svg viewBox="0 0 24 24" aria-hidden="true">
															<path d="M6 6l12 12M18 6L6 18" />
														</svg>
													</button>
												</div>
											{/each}
											{#if canAddScheduledReminderDraft}
												<button
													type="button"
													class="memberEventAddRowBtn memberEventReminderAddBtn"
													on:click={addScheduledReminderDraft}
													aria-label="Add another scheduled reminder"
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path d="M12 5v14M5 12h14" />
													</svg>
												</button>
											{/if}
											<div class="memberEventReminderSummary">
												<div class="memberEventReminderSummaryTitle">
													{scheduledReminderSummaryTitle}
												</div>
												{#each scheduledReminderSummaryLines as reminderSummaryLine}
													<div class="memberEventReminderSummaryLine">{reminderSummaryLine}</div>
												{/each}
											</div>
										</div>
									{/if}
								</div>
							{/if}

							{#if isCustomEventCodeSelected}
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
												bind:value={addCustomEventCode}
												on:input={(event) => {
													const target = event.currentTarget as HTMLInputElement;
													addCustomEventCode = target.value.toUpperCase();
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
												bind:value={addCustomEventName}
											/>
										</label>
										<label class="memberEventField">
											<span class="memberEventFieldLabel">Display Type</span>
											<div class="memberEventPickerWrap">
												<Picker
													id="memberEventDisplayModeBtn"
													menuId="memberEventDisplayModeMenu"
													label="Display Type"
													items={eventDisplayModeItems}
													fullWidth={true}
													selectedValue={addCustomEventDisplayMode}
													selectedLabel={selectedCustomDisplayModeLabel}
													open={customDisplayModePickerOpen}
													onOpenChange={setCustomDisplayModePickerOpen}
													on:select={(event) => {
														addCustomEventDisplayMode = event.detail as EventDisplayMode;
													}}
												/>
											</div>
										</label>
										<label class="memberEventField memberEventCustomColorField">
											<span class="memberEventFieldLabel">Color</span>
											<ColorPicker
												id="memberEventCustomColorPicker"
												label="Custom event color"
												value={addCustomEventColor}
												on:change={(event) => (addCustomEventColor = event.detail)}
											/>
										</label>
									</div>
								</div>

								<div class="memberEventReminderSection">
									<div class="memberEventCustomTitle">Reminders</div>
									<ThemedCheckbox
										id="event-reminder-immediate-custom"
										bind:checked={addReminderImmediate}
										label="Notify Immediately"
									/>
									<ThemedCheckbox
										id="event-reminder-scheduled-custom"
										bind:checked={addReminderScheduled}
										label="Scheduled Reminders"
									/>
									{#if addReminderScheduled}
										<div class="memberEventReminderPickerStack">
											<div class="memberEventReminderHeaderRow" aria-hidden="true">
												<span>Amount</span>
												<span>Unit</span>
												<span>Time</span>
												<span>AM/PM</span>
												<span class="memberEventReminderHeaderAction"></span>
											</div>
											{#each scheduledReminderDrafts as reminderDraft (reminderDraft.id)}
												<div class="memberEventReminderRowWrap">
													<div class="memberEventReminderPickerRow">
														<ThemedSpinPicker
															id={`event-reminder-amount-custom-${reminderDraft.id}`}
															options={reminderAmountOptions}
															value={reminderDraft.amount}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'amount',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`event-reminder-unit-custom-${reminderDraft.id}`}
															options={reminderUnitOptions}
															value={reminderDraft.unit}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'unit',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`event-reminder-hour-custom-${reminderDraft.id}`}
															options={reminderHourOptions}
															value={reminderDraft.hour}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'hour',
																	event.detail
																)}
														/>
														<ThemedSpinPicker
															id={`event-reminder-meridiem-custom-${reminderDraft.id}`}
															options={reminderMeridiemOptions}
															value={reminderDraft.meridiem}
															on:value={(event) =>
																updateScheduledReminderDraft(
																	reminderDraft.id,
																	'meridiem',
																	event.detail
																)}
														/>
													</div>
													<button
														type="button"
														class="memberEventReminderRemoveBtn"
														on:click={() => removeScheduledReminderDraft(reminderDraft.id)}
														aria-label="Remove scheduled reminder"
													>
														<svg viewBox="0 0 24 24" aria-hidden="true">
															<path d="M6 6l12 12M18 6L6 18" />
														</svg>
													</button>
												</div>
											{/each}
											{#if canAddScheduledReminderDraft}
												<button
													type="button"
													class="memberEventAddRowBtn memberEventReminderAddBtn"
													on:click={addScheduledReminderDraft}
													aria-label="Add another scheduled reminder"
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path d="M12 5v14M5 12h14" />
													</svg>
												</button>
											{/if}
											<div class="memberEventReminderSummary">
												<div class="memberEventReminderSummaryTitle">
													{scheduledReminderSummaryTitle}
												</div>
												{#each scheduledReminderSummaryLines as reminderSummaryLine}
													<div class="memberEventReminderSummaryLine">{reminderSummaryLine}</div>
												{/each}
											</div>
										</div>
									{/if}
								</div>
							{/if}

							<label class="memberEventField">
								<span class="memberEventFieldLabel">Comments</span>
								<textarea
									class="input memberEventTextarea"
									rows="3"
									placeholder="Reason or timing details"
									bind:value={addEventComments}
								></textarea>
							</label>

							{#if eventCodesError}
								<div class="memberEventError" role="alert">{eventCodesError}</div>
							{/if}
							{#if addEventError}
								<div class="memberEventError" role="alert">{addEventError}</div>
							{/if}
						</div>

						<div class="displayNameModalActions">
							{#if memberEventsPopupMode === 'edit'}
								<button
									type="button"
									class="iconActionBtn danger actionBtn"
									on:click={removeEvent}
									disabled={eventSaveInProgress}
								>
									<svg viewBox="0 0 24 24" aria-hidden="true">
										<path
											d="M 2 4 h 20 M 6 4 V 1 h 12 v 3 M 2 6 h 20 M 4 6 l 1 15 h 13 L 20 6 M 9.5 8.5 v 10 M 14.5 8.5 v 10"
										/>
									</svg>
									Remove
								</button>
							{/if}
							<button type="button" class="btn actionBtn" on:click={cancelAddEvent}>Cancel</button>
							<button
								type="button"
								class="btn primary actionBtn"
								on:click={saveEvent}
								disabled={eventSaveInProgress}
							>
								{addEventPrimaryButtonLabel}
							</button>
						</div>
					{/if}

					{#if memberEventsPopupMode === 'list'}
						<div class="displayNameModalActions">
							<button type="button" class="btn actionBtn" on:click={closeMemberEventsPopup}
								>Close</button
							>
						</div>
					{/if}
				</div>
				{#if showMemberEventsModalScrollbar}
					<div
						class="teamSetupScrollRail"
						role="presentation"
						aria-hidden="true"
						bind:this={memberEventsRailEl}
						on:mousedown={handleMemberEventsModalRailClick}
					>
						<div
							class="teamSetupScrollThumb"
							class:dragging={isDraggingMemberEventsScrollbar}
							role="presentation"
							style={`height:${memberEventsThumbHeightPx}px;transform:translateY(${memberEventsThumbTopPx}px);`}
							on:mousedown={startMemberEventsModalThumbDrag}
						></div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
	{#if showHorizontalScrollbar}
		<div
			class="gridScrollRailHorizontal"
			role="presentation"
			aria-hidden="true"
			style={horizontalRailStyle}
			bind:this={horizontalRailEl}
			on:mousedown={handleHorizontalRailClick}
		>
			<div
				class="gridScrollThumbHorizontal"
				class:dragging={isDraggingHorizontalScrollbar}
				role="presentation"
				style={`width:${horizontalThumbWidthPx}px;transform:translateX(${horizontalThumbLeftPx}px);`}
				on:mousedown={startHorizontalThumbDrag}
			></div>
		</div>
	{/if}
	{#if showVerticalScrollbar}
		<div
			class="gridScrollRailVertical"
			role="presentation"
			aria-hidden="true"
			style={verticalRailStyle}
			bind:this={verticalRailEl}
			on:mousedown={handleVerticalRailClick}
		>
			<div
				class="gridScrollThumbVertical"
				class:dragging={isDraggingVerticalScrollbar}
				role="presentation"
				style={`height:${verticalThumbHeightPx}px;transform:translateY(${verticalThumbTopPx}px);`}
				on:mousedown={startVerticalThumbDrag}
			></div>
		</div>
	{/if}
</div>

<style>
	:global(.shiftMergeLayout) {
		--group-divider-width: 1px;
		--group-divider-bottom-width: 2px;
		--group-divider-color: color-mix(in srgb, var(--table-border-color), #000 24%);
	}

	:global(:root[data-theme='dark'] .shiftMergeLayout) {
		--group-divider-color: color-mix(in srgb, var(--table-border-color), #fff 24%);
	}

	:global(.shiftMergeLayout .grid) {
		grid-auto-flow: row dense;
	}

	:global(.shiftMergeLayout .cell.cellSelected) {
		box-shadow: inset 0 0 0 2px var(--interactive-border-hover);
		z-index: 34;
	}

	:global(.shiftMergeLayout .namecol) {
		left: var(--shift-col-width, clamp(120px, 12vw, 180px));
		grid-column: 2;
	}

	:global(.shiftMergeLayout .teamColumnRailToggle) {
		left: calc(var(--shift-col-width, clamp(44px, 5vw, 64px)) + var(--team-col-width, 27ch));
		grid-column: 3;
	}

	:global(.shiftMergeLayout .shiftRowCell.namecol.mergeTwoCols) {
		left: 0;
		grid-column: 1 / span 2;
		z-index: 33;
	}

	:global(.shiftMergeLayout .teamHeaderMerged) {
		left: 0;
		grid-column: 1 / span 2;
		z-index: 42;
	}

	:global(.shiftMergeLayout .shiftMergeCol) {
		position: sticky;
		left: 0;
		z-index: 31;
		grid-column: 1;
		background: var(--table-team-cell-bg);
		border-right: 1px solid var(--table-border-color);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	:global(.shiftMergeLayout .shiftMergeCol.groupBoundary) {
		border-top: var(--group-divider-width) solid var(--group-divider-color);
	}

	:global(.shiftMergeLayout .employeeRowCell.groupStartBorder) {
		border-top: var(--group-divider-width) solid var(--group-divider-color);
	}

	:global(.shiftMergeLayout .shiftRowCell.collapsedGroupBoundary) {
		border-top: var(--group-divider-width) solid var(--group-divider-color);
	}

	:global(.shiftMergeLayout .employeeRowCell.lastVisibleRowBoundary) {
		border-bottom: var(--group-divider-bottom-width) solid var(--group-divider-color);
	}

	:global(.shiftMergeLayout .shiftMergeCol.lastVisibleRowBoundary) {
		border-bottom: var(--group-divider-bottom-width) solid var(--group-divider-color);
	}

	:global(.shiftMergeLayout .shiftRowCell.collapsedGroupBoundary.lastVisibleRowBoundary) {
		border-bottom: var(--group-divider-bottom-width) solid var(--group-divider-color);
	}

	:global(.shiftMergeLayout .shiftMergeToggle) {
		cursor: pointer;
		--cell-hover-overlay: var(--team-cell-hover);
	}

	:global(.shiftMergeLayout .shiftMergeToggle:active) {
		--cell-hover-overlay: var(--team-cell-active);
	}

	:global(.shiftMergeLayout .shiftMergeToggle:focus-visible) {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--interactive-border-hover);
	}

	:global(.shiftMergeLayout .shiftMergeLabel) {
		width: 100%;
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 4px 2px;
		overflow: hidden;
		text-align: center;
	}

	:global(.shiftMergeLayout .shiftMergeLabel .caret) {
		font-size: 0.72rem;
		line-height: 1;
	}

	:global(.shiftMergeLayout .shiftMergeLabel strong) {
		font-size: 0.68rem;
		line-height: 1.05;
		letter-spacing: 0.01em;
	}

	:global(.shiftMergeLayout .shiftMergeDiagonal .shiftMergeLabel) {
		padding: 4px 2px;
	}

	:global(.shiftMergeLayout .shiftMergeDiagonal .diagonalShiftLabel) {
		display: inline-block;
		transform: none;
		transform-origin: center;
		white-space: nowrap;
		font-size: 0.68rem;
		letter-spacing: 0.02em;
		margin-right: 5px;
	}
</style>
