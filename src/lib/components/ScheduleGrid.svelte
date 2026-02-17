<script lang="ts">
	import { base } from '$app/paths';
	import { afterUpdate, onDestroy, onMount } from 'svelte';
	import { dowShort, monthNames } from '$lib/utils/date';
	import type { MonthDay } from '$lib/utils/date';
	import DatePicker from '$lib/components/DatePicker.svelte';
	import Picker from '$lib/components/Picker.svelte';
	import ColorPicker from '$lib/components/ColorPicker.svelte';
	import GroupRow from '$lib/components/GroupRow.svelte';
	import EmployeeRow from '$lib/components/EmployeeRow.svelte';
	import type { Employee, Group, ScheduleEvent, Status } from '$lib/types/schedule';
	import { fetchWithAuthRedirect } from '$lib/utils/fetchWithAuthRedirect';
	import { resolveCellEventVisuals } from '$lib/utils/scheduleEvents';

	type EventScopeType = 'global' | 'shift' | 'user';
	type PopupMode = 'list' | 'add' | 'edit';
	type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';
	type EventCodeOption = {
		eventCodeId: number;
		code: string;
		name: string;
		displayMode: EventDisplayMode;
		color: string;
		isActive: boolean;
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
	};
	type HoverCellScope = {
		day: MonthDay;
		scopeType: EventScopeType;
		scopeLabel: string | null;
		scopeEmployeeTypeId: number | null;
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

	let gridEl: HTMLDivElement | null = null;
	let bandEl: HTMLDivElement | null = null;
	let selectedBandEl: HTMLDivElement | null = null;
	let scopedSelectedBandEl: HTMLDivElement | null = null;
	let gridWrapEl: HTMLDivElement | null = null;
	let horizontalRailEl: HTMLDivElement | null = null;
	let verticalRailEl: HTMLDivElement | null = null;
	let resizeQueued = false;
	let mounted = false;
	let useCustomGridScrollbars = true;
	let showHorizontalScrollbar = false;
	let horizontalThumbWidthPx = 0;
	let horizontalThumbLeftPx = 0;
	let showVerticalScrollbar = false;
	let verticalThumbHeightPx = 0;
	let verticalThumbTopPx = 0;
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
	let shiftPropagatedBadgeSizeByGroupIndex = new Map<number, number>();
	let userBadgeSizeByGroupIndex = new Map<number, number>();
	let lastSelectionContextKey = `${selectedYear}-${selectedMonthIndex}`;
	let memberEventsPopupOpen = false;
	let memberEventsPopupTitle = '';
	let memberEventsPopupDayIso = '';
	let memberEventsPopupScopeType: EventScopeType = 'global';
	let memberEventsPopupScopeEmployeeTypeId: number | null = null;
	let memberEventsPopupScopeUserOid: string | null = null;
	let memberEventsPopupMode: PopupMode = 'list';
	let editingEventId: number | null = null;
	let memberEventsModalScrollEl: HTMLDivElement | null = null;
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
	let addEventError = '';
	let hoverTooltipOpen = false;
	let hoverTooltipLeftPx = 0;
	let hoverTooltipTopPx = 0;
	let hoverTooltipPointerX = 0;
	let hoverTooltipPointerY = 0;
	let hoverTooltipTitle = '';
	let hoverTooltipScopeType: EventScopeType = 'global';
	let hoverTooltipEntries: ScopedEventEntry[] = [];
	let hoverTooltipLoading = false;
	let hoverTooltipScope: HoverCellScope | null = null;
	let hoverTooltipEl: HTMLDivElement | null = null;
	let hoverTooltipFetchToken = 0;
	const scopedEventsCache = new Map<string, ScopedEventEntry[]>();
	const DOUBLE_TAP_WINDOW_MS = 320;
	let lastHeaderTouchTapDay: number | null = null;
	let lastHeaderTouchTapAtMs = 0;
	let suppressHeaderClickDay: number | null = null;

	const eventDisplayModeItems: PickerOption[] = [
		{ value: 'Schedule Overlay', label: 'Schedule Overlay' },
		{ value: 'Badge Indicator', label: 'Badge Indicator' },
		{ value: 'Shift Override', label: 'Shift Override' }
	];

	$: days = monthDays;
	$: dim = monthDays.length;
	$: showTeamColumnRailToggle = showHorizontalScrollbar || teamColumnCollapsed;
	$: teamColumnWidthCss =
		showTeamColumnRailToggle && teamColumnCollapsed ? '0px' : 'clamp(220px, 20vw, 360px)';
	$: teamToggleColumnWidthCss = showTeamColumnRailToggle ? '14px' : '0px';
	$: minimumGridWidthFloor = showTeamColumnRailToggle ? 320 : 1100;
	$: minimumGridWidthFromContent =
		(showTeamColumnRailToggle ? (teamColumnCollapsed ? 0 : 260) + 14 : 260) + dim * 40;
	$: gridShellStyle = `--team-col-width:${teamColumnWidthCss}; --team-toggle-col-width:${teamToggleColumnWidthCss};`;
	$: gridTemplateRows = (() => {
		const tracks: string[] = ['var(--schedule-header-row-height)'];
		for (const group of groups) {
			// Shift/group rows should size to content.
			tracks.push('auto');
			if (!collapsed[group.category]) {
				// User rows should keep the existing min/max stretch behavior.
				for (let i = 0; i < group.employees.length; i += 1) {
					tracks.push(
						'minmax(var(--schedule-row-min-height), var(--schedule-row-effective-height, var(--schedule-row-max-height)))'
					);
				}
			}
		}
		return tracks.join(' ');
	})();
	$: gridStyle = `--schedule-row-effective-height:${effectiveUserRowHeightPx}px; grid-template-columns: ${showTeamColumnRailToggle ? 'var(--team-col-width) var(--team-toggle-col-width)' : 'var(--team-col-width)'} repeat(${dim}, minmax(34px, 1fr)); grid-template-rows: ${gridTemplateRows}; min-width: ${Math.max(minimumGridWidthFromContent, minimumGridWidthFloor)}px;`;
	$: activeTodayDay = monthDays.find((item) => item.isToday)?.day ?? null;
	$: shiftNameByEmployeeTypeId = (() => {
		const shiftNames = new Map<number, string>();
		for (const group of groups) {
			const nextEmployeeTypeId = group.employeeTypeId;
			if (nextEmployeeTypeId === null || nextEmployeeTypeId === undefined) continue;
			if (!shiftNames.has(nextEmployeeTypeId)) {
				shiftNames.set(nextEmployeeTypeId, group.category);
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
		scopeEmployeeTypeId: number | null = null,
		scopeUserOid: string | null = null
	) {
		const dateLabel = formatPopupDate(day);
		const normalizedScopeLabel = scopeLabel?.trim() ?? '';
		memberEventsPopupTitle = `${dateLabel} Events${normalizedScopeLabel ? ` - ${normalizedScopeLabel}` : ''}`;
		memberEventsPopupDayIso = toIsoDate(selectedYear, selectedMonthIndex, day.day);
		memberEventsPopupScopeType = scopeType;
		memberEventsPopupScopeEmployeeTypeId = scopeEmployeeTypeId;
		memberEventsPopupScopeUserOid = scopeUserOid;
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
		showMemberEventsModalScrollbar = false;
		memberEventsThumbHeightPx = 0;
		memberEventsThumbTopPx = 0;
	}

	function eventsCacheKey(
		dayIso: string,
		scopeType: EventScopeType,
		scopeEmployeeTypeId: number | null,
		scopeUserOid: string | null
	) {
		return `${dayIso}|${scopeType}|${scopeEmployeeTypeId ?? ''}|${scopeUserOid ?? ''}`;
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
			return shiftNameByEmployeeTypeId.get(eventRow.employeeTypeId) ?? 'Shift';
		}
		return null;
	}

	async function fetchScopedEvents(
		dayIso: string,
		scopeType: EventScopeType,
		scopeEmployeeTypeId: number | null,
		scopeUserOid: string | null
	): Promise<ScopedEventEntry[]> {
		const queryParts = [
			`day=${encodeURIComponent(dayIso)}`,
			`scope=${encodeURIComponent(scopeType)}`
		];
		if (scopeEmployeeTypeId) {
			queryParts.push(`employeeTypeId=${encodeURIComponent(String(scopeEmployeeTypeId))}`);
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
		if (!memberEventsPopupDayIso) return;
		if (memberEventsPopupScopeType === 'shift' && !memberEventsPopupScopeEmployeeTypeId) {
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
			scopedEventEntries = await fetchScopedEvents(
				memberEventsPopupDayIso,
				memberEventsPopupScopeType,
				memberEventsPopupScopeEmployeeTypeId,
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
			left.scopeEmployeeTypeId === right.scopeEmployeeTypeId &&
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
	}

	async function showHoverEventsTooltip(
		scope: HoverCellScope,
		pointer: { clientX: number; clientY: number }
	) {
		if (memberEventsPopupOpen) return;
		const sameScope = isSameHoverScope(hoverTooltipScope, scope);
		if (sameScope && hoverTooltipOpen) {
			positionHoverTooltipAtPointer(pointer.clientX, pointer.clientY);
			return;
		}

		hoverTooltipScope = scope;
		hoverTooltipTitle = eventListTitle(scope.day, scope.scopeLabel);
		hoverTooltipScopeType = scope.scopeType;
		positionHoverTooltipAtPointer(pointer.clientX, pointer.clientY);
		hoverTooltipOpen = true;
		const dayIso = toIsoDate(selectedYear, selectedMonthIndex, scope.day.day);
		const cacheKey = eventsCacheKey(
			dayIso,
			scope.scopeType,
			scope.scopeEmployeeTypeId,
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
				dayIso,
				scope.scopeType,
				scope.scopeEmployeeTypeId,
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
					isActive: Boolean(eventCode.isActive)
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
		addEventStartDate = memberEventsPopupDayIso;
		addEventEndDate = memberEventsPopupDayIso;
		addCustomEventCode = '';
		addCustomEventName = '';
		addCustomEventDisplayMode = 'Schedule Overlay';
		addCustomEventColor = '#22c55e';
		addEventError = '';
		editingEventId = null;
		eventCodePickerOpen = false;
		customDisplayModePickerOpen = false;
		addStartDatePickerOpen = false;
		addEndDatePickerOpen = false;
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

		if (memberEventsPopupScopeType === 'shift' && !memberEventsPopupScopeEmployeeTypeId) {
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
			employeeTypeId: memberEventsPopupScopeEmployeeTypeId,
			userOid: memberEventsPopupScopeUserOid,
			startDate: addEventStartDate,
			endDate: addEventEndDate,
			comments: addEventComments.trim(),
			coverageCodeId
		};

		if (customCode) {
			payload.customCode = customCode;
			payload.customName = customName;
			payload.customDisplayMode = customDisplayMode;
			payload.customColor = customColor;
		}

		const isEditing = memberEventsPopupMode === 'edit' && editingEventId !== null;
		if (isEditing) {
			payload.eventId = editingEventId;
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
					body: JSON.stringify({ eventId: editingEventId })
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
		// Ignore the second click of a double-click sequence.
		if (event.detail > 1) return;
		handleDaySelect(day);
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

	function handleEmployeeDayDoubleClick(
		employee: Employee,
		groupEmployeeTypeId: number | null,
		day: MonthDay
	) {
		void openMemberEventsPopup(
			day,
			'user',
			employee.name,
			groupEmployeeTypeId,
			employee.userOid ?? null
		);
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
				scopeEmployeeTypeId: null,
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
				scopeEmployeeTypeId: group.employeeTypeId ?? null,
				scopeUserOid: null
			},
			pointer
		);
	}

	function handleEmployeeDayHover(
		employee: Employee,
		groupEmployeeTypeId: number | null,
		day: MonthDay,
		pointer: { clientX: number; clientY: number }
	) {
		void showHoverEventsTooltip(
			{
				day,
				scopeType: 'user',
				scopeLabel: employee.name,
				scopeEmployeeTypeId: groupEmployeeTypeId,
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
		if (typeof window !== 'undefined') {
			requestAnimationFrame(updateCustomScrollbar);
		}
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

	$: scopedPopupEvents = sortScopedEvents(scopedEventEntries);
	$: scopedHoverEvents = sortScopedEvents(hoverTooltipEntries);

	function activateTeamCell() {
		if (!canMaintainTeam) return;
		onTeamClick();
	}

	function makeRowKey(groupName: string, employeeId: string) {
		return `${groupName}::${employeeId}`;
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

	function handleDaySelect(day: number) {
		if (selectedDay === day && selectedGroupIndex === null) {
			selectedDay = null;
			selectedGroupIndex = null;
			return;
		}
		selectedRowKey = null;
		selectedDay = day;
		selectedGroupIndex = null;
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

	function clearSelectionState() {
		selectedRowKey = null;
		selectedDay = null;
		selectedGroupIndex = null;
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

	function updateRowDensity() {
		if (!gridWrapEl || !gridEl) return;

		const minRowHeight = readCssPx('--schedule-row-min-height', 25);
		const maxRowHeight = readCssPx('--schedule-row-max-height', 44);
		const headerRowHeight = readCssPx('--schedule-header-row-height', 44);
		const userRowCount = groups.reduce(
			(total, group) => total + (collapsed[group.category] ? 0 : group.employees.length),
			0
		);

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
			return;
		}

		const scrollWidth = gridWrapEl.scrollWidth;
		const clientWidth = gridWrapEl.clientWidth;
		const scrollLeft = gridWrapEl.scrollLeft;
		const hasHorizontalOverflow = scrollWidth > clientWidth + 1;

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
		const hasVerticalOverflow = scrollHeight > clientHeight + 1;

		showVerticalScrollbar = hasVerticalOverflow;
		if (!hasVerticalOverflow) {
			verticalThumbHeightPx = 0;
			verticalThumbTopPx = 0;
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
		if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
			useCustomGridScrollbars = !window.matchMedia('(hover: none) and (pointer: coarse)').matches;
		}
		queueMeasure();
		updateRowDensity();
		requestAnimationFrame(updateCustomScrollbar);
		const onResize = () => {
			queueMeasure();
			updateRowDensity();
			updateCustomScrollbar();
			updateMemberEventsModalScrollbar();
		};
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
		};
	});

	afterUpdate(() => {
		queueMeasure();
		updateRowDensity();
		updateCustomScrollbar();
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

	$: {
		const nextSelectionContextKey = `${selectedYear}-${selectedMonthIndex}`;
		if (nextSelectionContextKey !== lastSelectionContextKey) {
			lastSelectionContextKey = nextSelectionContextKey;
			clearSelectionState();
			hideHoverEventsTooltip();
		}
	}

	onDestroy(() => {
		stopHorizontalDragging();
		stopVerticalDragging();
		stopMemberEventsModalDragging();
		hideHoverEventsTooltip();
	});
</script>

<div
	class="gridwrapShell"
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
				<div class="today-band" bind:this={bandEl}></div>
			{/if}
			{#if selectedDay && selectedGroupIndex === null}
				<div class="selected-day-band" bind:this={selectedBandEl}></div>
			{/if}
			{#if selectedDay && selectedGroupIndex !== null}
				<div class="selected-day-band" bind:this={scopedSelectedBandEl}></div>
			{/if}

			{#if canMaintainTeam}
				<div
					class="cell hdr namecol teamHeader clickable"
					role="button"
					tabindex="0"
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
				<div class="cell hdr namecol teamHeader" role="columnheader">
					<div class="groupRow">Team</div>
				</div>
			{/if}
			{#if showTeamColumnRailToggle}
				<div
					class="cell namecol teamColumnRailToggle"
					role="button"
					tabindex="0"
					aria-pressed={!teamColumnCollapsed}
					aria-label={teamColumnCollapsed ? 'Show team column' : 'Hide team column'}
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
					class={`${dayHeaderClass(day)} selectableColumnHeader${selectedDay === day.day && selectedGroupIndex === null ? ' columnSelected colStart' : ''}`}
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
					on:dblclick={() => handleDayHeaderDoubleClick(day)}
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
					{groupIndex}
					isLastVisibleRow={groupIndex === groups.length - 1 &&
						(collapsed[group.category] === true || group.employees.length === 0)}
					onSelectDay={(day) => handleGroupDaySelect(groupIndex, day)}
					onDoubleClickDay={(day) => handleGroupDayDoubleClick(group, day)}
					onHoverDayCell={(day, _cellEl, pointer) => handleGroupDayHover(group, day, pointer)}
					onLeaveDayCell={hideHoverEventsTooltip}
					onToggle={() => onToggleGroup(group)}
				/>

				{#if !collapsed[group.category]}
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
							isLastInGroup={employeeIndex === group.employees.length - 1}
							onOpenDisplayNameEditor={onEmployeeDoubleClick}
							rowKey={makeRowKey(group.category, employee.userOid ?? employee.name)}
							{selectedRowKey}
							onSelectRow={handleRowSelect}
							onDoubleClickDayCell={(employee, day) =>
								handleEmployeeDayDoubleClick(employee, group.employeeTypeId ?? null, day)}
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
					{#each scopedHoverEvents as eventRow (eventRow.eventId)}
						{@const scopeSuffix = eventScopeSuffix(eventRow, hoverTooltipScopeType)}
						<div class="memberEventRow">
							<div class="memberEventCodeLine">
								<span
									class="memberEventColorDot"
									style={`background:${eventRow.eventCodeColor};`}
									aria-hidden="true"
								></span>
								<strong>{eventRow.eventCodeCode}</strong>
								<span>{eventRow.eventCodeName}{scopeSuffix ? ` - ${scopeSuffix}` : ''}</span>
							</div>
							{#if eventRow.startDate !== eventRow.endDate}
								<div class="memberEventDates">
									{formatIsoDate(eventRow.startDate)} to {formatIsoDate(eventRow.endDate)}
								</div>
							{/if}
							{#if eventRow.comments}
								<div class="memberEventComment">{eventRow.comments}</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
	{#if memberEventsPopupOpen}
		<div
			class="displayNameModalBackdrop"
			role="presentation"
			on:mousedown={(event) => {
				if (event.target === event.currentTarget) {
					closeMemberEventsPopup();
				}
			}}
		>
			<div
				class="displayNameModal memberEventsModal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="member-events-modal-title"
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
												class="memberEventColorDot"
												style={`background:${eventRow.eventCodeColor};`}
												aria-hidden="true"
											></span>
											<strong>{eventRow.eventCodeCode}</strong>
											<span>{eventRow.eventCodeName}{scopeSuffix ? ` - ${scopeSuffix}` : ''}</span>
										</div>
										{#if eventRow.startDate !== eventRow.endDate}
											<div class="memberEventDates">
												{formatIsoDate(eventRow.startDate)} to {formatIsoDate(eventRow.endDate)}
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
										on:select={(event) => {
											addEventCodeId = String(event.detail);
										}}
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
										<path d="M4 7h16M9 7V5h6v2M9 10v8M15 10v8M7 7l1 13h8l1-13" />
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
