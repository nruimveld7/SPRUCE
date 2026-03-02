<script lang="ts">
	import { base } from '$app/paths';
	import ColorPicker from '$lib/components/ColorPicker.svelte';
	import ConfirmDialog, { type ConfirmDialogOption } from '$lib/components/ConfirmDialog.svelte';
	import DatePicker from '$lib/components/DatePicker.svelte';
	import HorizontalScrollArea from '$lib/components/HorizontalScrollArea.svelte';
	import Picker, { type PickerItem } from '$lib/components/Picker.svelte';
	import ReorderTable from '$lib/components/ReorderTable.svelte';
	import ThemedCheckbox from '$lib/components/ThemedCheckbox.svelte';
	import ThemedSpinPicker from '$lib/components/ThemedSpinPicker.svelte';
	import { fetchWithAuthRedirect as fetchWithAuthRedirectUtil } from '$lib/utils/fetchWithAuthRedirect';
	import { onDestroy, onMount, tick } from 'svelte';

	type SetupSection = 'users' | 'shifts' | 'patterns' | 'eventCodes' | 'assignments';
	type UserRole = 'Member' | 'Maintainer' | 'Manager';
	type UsersViewMode = 'list' | 'add' | 'edit';
	type ShiftsViewMode = 'list' | 'add' | 'edit';
	type PatternsViewMode = 'list' | 'add' | 'edit';
	type AssignmentsViewMode = 'list' | 'add' | 'edit';
	type EventCodesViewMode = 'list' | 'add' | 'edit';
	type SortKey = 'name' | 'email' | 'role';
	type SortDirection = 'asc' | 'desc';
	type ShiftSortKey = 'order' | 'name' | 'pattern' | 'start';
	type EventCodeSortKey = 'code' | 'name' | 'displayMode' | 'status';
	type AccessUser = {
		userOid: string;
		name: string;
		displayName?: string;
		email: string;
		role: UserRole;
		versionStamp?: string;
	};
	type ShiftRow = {
		employeeTypeId: number;
		sortOrder: number;
		name: string;
		pattern: string;
		patternId: number | null;
		startDate: string;
		endDate?: string | null;
		versionStamp?: string;
		changes?: ShiftChangeRow[];
	};
	type ShiftChangeRow = {
		sortOrder?: number;
		startDate: string;
		endDate?: string | null;
		name: string;
		patternId: number | null;
		pattern: string;
		versionStamp?: string;
	};
	type AssignmentRow = {
		assignmentId: string;
		sortOrder: number;
		userOid: string;
		shiftId: number;
		startDate: string;
		endDate?: string | null;
		userName?: string;
		shiftName?: string;
		versionStamp?: string;
		timelineVersionStamp?: string;
		changes?: AssignmentChangeRow[];
	};
	type AssignmentChangeRow = {
		assignmentId: string;
		sortOrder: number;
		userOid: string;
		shiftId: number;
		startDate: string;
		endDate?: string | null;
		userName?: string;
		shiftName?: string;
		versionStamp?: string;
	};
	type PatternSwatch = { swatchIndex: number; color: string; onDays: number[] };
	type PatternListRow = {
		patternId: number;
		name: string;
		summary: string;
		swatches: PatternSwatch[];
		noShiftDays: number[];
		isInUse: boolean;
		isActivelyInUse: boolean;
		hasAnyUsage: boolean;
		versionStamp?: string;
	};
	type EventCodeDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';
	type EventCodeRow = {
		eventCodeId: number;
		code: string;
		name: string;
		displayMode: EventCodeDisplayMode;
		color: string;
		isActive: boolean;
		versionStamp?: string;
		notifyImmediately?: boolean;
		scheduledReminders?: Array<{
			amount: number;
			unit: 'days' | 'weeks' | 'months';
			hour: number;
			meridiem: 'AM' | 'PM';
		}>;
	};
	type EventCodeReminderDraft = {
		id: number;
		amount: number;
		unit: string;
		hour: number;
		meridiem: string;
	};
	type RemoveUserErrorPayload = {
		code?: string;
		message?: string;
		activeAssignmentCount?: number;
	};
	type RemoveShiftErrorPayload = {
		code?: string;
		message?: string;
		activeAssignmentCount?: number;
		assignmentCount?: number;
		shiftEventCount?: number;
		shiftChangeCount?: number;
	};
	type ConfirmDialogState = {
		title: string;
		message: string;
		options: ConfirmDialogOption[];
		cancelOptionId: string;
		resolve: (optionId: string) => void;
	};
	type EntraUser = {
		id: string;
		displayName?: string;
		givenName?: string;
		surname?: string;
		mail?: string;
		userPrincipalName?: string;
	};

	export let open = false;
	export let activeScheduleId: number | null = null;
	export let canAssignManagerRole = false;
	export let currentUserOid = '';
	export let onClose: () => void = () => {};
	export let onScheduleRefresh: () => void | Promise<void> = () => {};

	let activeSection: SetupSection = 'users';
	let usersViewMode: UsersViewMode = 'list';
	let shiftsViewMode: ShiftsViewMode = 'list';
	let patternsViewMode: PatternsViewMode = 'list';
	let eventCodesViewMode: EventCodesViewMode = 'list';
	let assignmentsViewMode: AssignmentsViewMode = 'list';
	let selectedUserForEdit: AccessUser | null = null;
	let selectedShiftForEdit: ShiftRow | null = null;
	let selectedAssignmentForEdit: AssignmentRow | null = null;
	let selectedAddRole: UserRole = 'Member';
	let selectedEditRole: UserRole = 'Member';
	let sortKey: SortKey = 'name';
	let sortDirection: SortDirection = 'asc';
	let shiftSortKey: ShiftSortKey = 'order';
	let shiftSortDirection: SortDirection = 'asc';
	let eventCodeSortKey: EventCodeSortKey = 'code';
	let eventCodeSortDirection: SortDirection = 'asc';
	let modalScrollEl: HTMLDivElement | null = null;
	let modalBodyEl: HTMLDivElement | null = null;
	let modalEl: HTMLDivElement | null = null;
	let railEl: HTMLDivElement | null = null;
	let modalResizeObserver: ResizeObserver | null = null;
	let modalMutationObserver: MutationObserver | null = null;
	let showCustomScrollbar = false;
	let thumbHeightPx = 0;
	let thumbTopPx = 0;
	let isDraggingScrollbar = false;
	let dragStartY = 0;
	let dragStartThumbTopPx = 0;
	let addUserQuery = '';
	let addUsers: EntraUser[] = [];
	let addUsersError = '';
	let addUsersLoading = false;
	let addUserSearchTimer: ReturnType<typeof setTimeout> | null = null;
	let showAddUserResults = false;
	let addUserComboEl: HTMLDivElement | null = null;
	let addUserResultsEl: HTMLDivElement | null = null;
	let addUserResultsRailEl: HTMLDivElement | null = null;
	let showAddUserResultsScrollbar = false;
	let addUserResultsThumbHeightPx = 0;
	let addUserResultsThumbTopPx = 0;
	let isDraggingAddUserResultsScrollbar = false;
	let addUserResultsDragStartY = 0;
	let addUserResultsDragStartThumbTopPx = 0;
	let addUserSelectionCommitted = false;
	let selectedAddUser: EntraUser | null = null;
	let teamUsers: AccessUser[] = [];
	let teamUsersLoading = false;
	let teamUsersError = '';
	let addUserActionError = '';
	let editUserActionError = '';
	let addUserActionLoading = false;
	let editUserActionLoading = false;
	let addShiftName = '';
	let addShiftSortOrder = '1';
	let addShiftPatternId = '';
	let addShiftStartDate = '';
	let addShiftEndDate = '';
	let shiftPatternPickerOpen = false;
	let shiftStartDatePickerOpen = false;
	let shiftEndDatePickerOpen = false;
	let shiftsMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
	let shiftsMonthPickerOpen = false;
	let addShiftActionError = '';
	let addShiftActionLoading = false;
	let isShiftReorderLoading = false;
	let shiftsTableEl: HTMLTableElement | null = null;
	let shiftsTbodyEl: HTMLTableSectionElement | null = null;
	let shiftReorderGhostEl: HTMLDivElement | null = null;
	const shiftReorderDebugEnabled = true;
	let shiftReorderMoveLogCount = 0;
	let shiftReorderLastMoveLogAt = 0;
	let lastGhostRenderState = false;
	type ShiftReorderState = {
		sourceId: number;
		handle: HTMLButtonElement;
		offsetX: number;
		offsetY: number;
		currentBeforeId: number | null;
		ghostX: number;
		ghostY: number;
		ghostWidth: number;
		rowHeight: number;
	};
	type AssignmentReorderState = {
		sourceId: string;
		handle: HTMLButtonElement;
		offsetX: number;
		offsetY: number;
		lastPointerY: number;
		movingDown: boolean;
		currentBeforeId: string | null;
		ghostX: number;
		ghostY: number;
		ghostWidth: number;
		rowHeight: number;
	};
	let shiftReorderState: ShiftReorderState | null = null;
	let shiftReorderGhostShift: ShiftRow | null = null;
	let shiftReorderOptimisticOrder: { month: string; orderedIds: number[] } | null = null;
	let addPatternName = '';
	let addPatternActionError = '';
	let addPatternActionLoading = false;
	let editingPatternId: number | null = null;
	let patterns: PatternListRow[] = [];
	let patternsLoading = false;
	let patternsError = '';
	let wasUsersListVisible = false;
	let wasShiftsListVisible = false;
	let wasPatternsListVisible = false;
	let wasAssignmentsListVisible = false;
	let teamShifts: ShiftRow[] = [];
	let teamShiftsLoading = false;
	let teamShiftsError = '';
	let assignmentRows: AssignmentRow[] = [];
	let assignmentDisplayRows: AssignmentRow[] = [];
	let assignmentRowsForActiveShift: AssignmentRow[] = [];
	let assignmentsTableEl: HTMLTableElement | null = null;
	let assignmentRowsLoading = false;
	let assignmentRowsError = '';
	let eventCodeRows: EventCodeRow[] = [];
	let selectedEventCodeForEdit: EventCodeRow | null = null;
	let eventCodeRowsLoading = false;
	let eventCodeRowsError = '';
	let addEventCodeCode = '';
	let addEventCodeName = '';
	let addEventCodeDisplayMode: EventCodeDisplayMode = 'Schedule Overlay';
	let addEventCodeColor = '#22c55e';
	let addEventCodeIsActive = true;
	let addEventCodeReminderImmediate = false;
	let addEventCodeReminderScheduled = false;
	let eventCodeReminderDrafts: EventCodeReminderDraft[] = [];
	let nextEventCodeReminderDraftId = 1;
	let eventCodeDisplayModePickerOpen = false;
	let eventCodeActionError = '';
	let eventCodeActionLoading = false;
	let wasEventCodesListVisible = false;
	let lastLoadedEventCodeScopeKey = '';
	let assignmentUserOid = '';
	let assignmentUserQuery = '';
	let assignmentShiftId = '';
	let assignmentStartDate = '';
	let assignmentEndDate = '';
	let assignmentUserResultsOpen = false;
	let assignmentUserComboEl: HTMLDivElement | null = null;
	let assignmentUserResultsEl: HTMLDivElement | null = null;
	let assignmentUserResultsRailEl: HTMLDivElement | null = null;
	let showAssignmentUserResultsScrollbar = false;
	let assignmentUserResultsThumbHeightPx = 0;
	let assignmentUserResultsThumbTopPx = 0;
	let isDraggingAssignmentUserResultsScrollbar = false;
	let assignmentUserResultsDragStartY = 0;
	let assignmentUserResultsDragStartThumbTopPx = 0;
	let assignmentsMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
	let assignmentsMonthPickerOpen = false;
	let assignmentListShiftId = '';
	let assignmentStartDatePickerOpen = false;
	let assignmentEndDatePickerOpen = false;
	let assignmentActionError = '';
	let assignmentActionLoading = false;
	let canAssignManagerRoleEffective = false;
	let expandedShiftRows = new Set<number>();
	let expandedAssignmentRows = new Set<string>();
	let assignmentReorderState: AssignmentReorderState | null = null;
	let assignmentReorderGhostAssignment: AssignmentRow | null = null;
	let assignmentReorderGhostEl: HTMLDivElement | null = null;
	let assignmentReorderPlaceholderGroupEl: HTMLTableSectionElement | null = null;
	let isAssignmentReorderLoading = false;
	let assignmentReorderOptimisticOrder: { shiftId: number; orderedIds: string[] } | null = null;
	let editingShiftHistoryStartDate = '';
	let editingShiftHistoryVersionStamp = '';
	let editingAssignmentHistoryStartDate = '';
	let editingAssignmentHistoryVersionStamp = '';
	let editingPatternVersionStamp = '';
	let isEditingShiftHistoryEntry = false;
	let isEditingAssignmentHistoryEntry = false;

	const sections: { id: SetupSection; label: string }[] = [
		{ id: 'users', label: 'Users' },
		{ id: 'shifts', label: 'Shifts' },
		{ id: 'patterns', label: 'Shift Patterns' },
		{ id: 'assignments', label: 'Assignments' },
		{ id: 'eventCodes', label: 'Event Codes' }
	];
	const EVENT_CODE_MAX_REMINDERS = 4;
	const eventCodeReminderAmountOptions = Array.from({ length: 31 }, (_, index) => index);
	const eventCodeReminderHourOptions = Array.from({ length: 13 }, (_, index) => index);
	const eventCodeReminderUnitOptions = ['days', 'weeks', 'months'];
	const eventCodeReminderMeridiemOptions = ['AM', 'PM'];

	const patternEditorDays = Array.from({ length: 28 }, (_, index) => index + 1);
	const noShiftOwner = -2;
	let patternDayAssignments: number[] = Array.from({ length: 28 }, () => -1);
	type PredictionModel = {
		onDays: number;
		offDays: number;
		anchor: number;
		predictedOn: Set<number>;
	};
	type PredictionSummary = {
		shiftCount: number;
		onDays: number | null;
		offDays: number | null;
	};
	let selectedPatternDaysBySwatch: number[][] = [];
	let patternPredictionsBySwatch: Array<PredictionModel | null> = [];
	let activePatternPrediction: PredictionModel | null = null;
	let patternPredictionSummary: PredictionSummary | null = null;
	let patternHasPredictionConflict = false;
	let predictedOwnerIndexByDay: number[] = [];
	let conflictedPredictionByDay: boolean[] = [];
	const defaultPatternColor = '#ffb000';
	const maxPatternSwatches = 4;
	const patternColorSeedPalette = [
		'#ffb000',
		'#00c1ff',
		'#22c55e',
		'#f97316',
		'#a855f7',
		'#ef4444',
		'#14b8a6'
	];
	let patternColors: string[] = [defaultPatternColor];
	let activePatternColorIndex = 0;
	let noShiftModeActive = false;
	type PatternColorPickerHandle = { openPicker: () => void };
	let patternColorPickerEls: Array<PatternColorPickerHandle | null> = [];
	let patternEditorCardEl: HTMLDivElement | null = null;
	let confirmDialog: ConfirmDialogState | null = null;

	function setSection(section: SetupSection) {
		activeSection = section;
		resetUsersPane();
		resetShiftsPane();
		resetPatternsPane();
		resetEventCodesPane();
		resetAssignmentsPane();
	}

	function isShiftsSection(section: SetupSection): boolean {
		return section === 'shifts';
	}

	function closeModal() {
		onClose();
	}

	async function refreshScheduleInBackground() {
		try {
			await onScheduleRefresh();
		} catch {
			// Keep setup actions successful even if background refresh fails.
		}
	}

	type TeamSetupDependency =
		| 'users'
		| 'shifts'
		| 'patterns'
		| 'assignments'
		| 'eventCodes'
		| 'schedule';

	async function refreshDependenciesAfterMutation(
		dependencies: TeamSetupDependency[]
	): Promise<void> {
		const refreshTasks: Promise<void>[] = [];
		if (dependencies.includes('users')) refreshTasks.push(loadTeamUsers());
		if (dependencies.includes('shifts')) refreshTasks.push(loadTeamShifts());
		if (dependencies.includes('patterns')) refreshTasks.push(loadPatterns());
		if (dependencies.includes('assignments')) refreshTasks.push(loadAssignmentRows());
		if (dependencies.includes('eventCodes')) refreshTasks.push(loadEventCodes());
		if (dependencies.includes('schedule')) refreshTasks.push(refreshScheduleInBackground());
		await Promise.all(refreshTasks);
	}

	function logShiftReorderDebug(message: string, details?: Record<string, unknown>) {
		if (!shiftReorderDebugEnabled || typeof console === 'undefined') return;
		if (details) {
			console.log(`[ShiftReorderDebug] ${message}`, details);
			return;
		}
		console.log(`[ShiftReorderDebug] ${message}`);
	}

	function applyShiftReorderGhostPosition(x: number, y: number, width: number) {
		if (!shiftReorderGhostEl) return;
		shiftReorderGhostEl.style.setProperty('width', `${Math.round(width)}px`, 'important');
		shiftReorderGhostEl.style.setProperty(
			'transform',
			`translate(${Math.round(x)}px, ${Math.round(y)}px) rotate(0.3deg) scale(1.008)`,
			'important'
		);
	}

	function applyAssignmentReorderGhostPosition(x: number, y: number, width: number) {
		if (!assignmentReorderGhostEl) return;
		assignmentReorderGhostEl.style.setProperty('width', `${Math.round(width)}px`, 'important');
		assignmentReorderGhostEl.style.setProperty(
			'transform',
			`translate(${Math.round(x)}px, ${Math.round(y)}px) rotate(0.3deg) scale(1.008)`,
			'important'
		);
	}

	function adjustNumericInput(
		value: string,
		delta: number,
		minValue: number,
		maxValue: number
	): string {
		const parsed = Number(value);
		const base = Number.isFinite(parsed) ? Math.round(parsed) : minValue;
		const boundedMax = Math.max(minValue, maxValue);
		const next = Math.min(Math.max(base + delta, minValue), boundedMax);
		return String(next);
	}

	function closeConfirmDialog(optionId: string) {
		const resolver = confirmDialog?.resolve;
		confirmDialog = null;
		if (resolver) resolver(optionId);
	}

	async function openConfirmDialog(config: {
		title: string;
		message: string;
		options: ConfirmDialogOption[];
		cancelOptionId: string;
	}): Promise<string> {
		if (confirmDialog) {
			closeConfirmDialog(confirmDialog.cancelOptionId);
		}
		return new Promise<string>((resolve) => {
			confirmDialog = {
				title: config.title,
				message: config.message,
				options: config.options,
				cancelOptionId: config.cancelOptionId,
				resolve
			};
		});
	}

	function handleBackdropMouseDown(event: MouseEvent) {
		if (confirmDialog) return;
		if (event.target !== event.currentTarget) return;
		if (hasOpenNestedPopover()) return;
		closeModal();
	}

	function hasOpenNestedPopover(): boolean {
		if (
			showAddUserResults ||
			shiftPatternPickerOpen ||
			shiftStartDatePickerOpen ||
			shiftEndDatePickerOpen ||
			shiftsMonthPickerOpen ||
			eventCodeDisplayModePickerOpen ||
			assignmentUserResultsOpen ||
			assignmentsMonthPickerOpen ||
			assignmentStartDatePickerOpen ||
			assignmentEndDatePickerOpen
		) {
			return true;
		}
		return Boolean(modalEl?.querySelector('.colorPickerPopover'));
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			if (confirmDialog) {
				event.preventDefault();
				closeConfirmDialog(confirmDialog.cancelOptionId);
				return;
			}
			if (shiftReorderState) {
				event.preventDefault();
				void stopShiftReorder(false);
				return;
			}
			closeModal();
		}
	}

	function resetAddUserResultsScrollbarState() {
		showAddUserResultsScrollbar = false;
		addUserResultsThumbHeightPx = 0;
		addUserResultsThumbTopPx = 0;
	}

	function resetAssignmentUserResultsScrollbarState() {
		showAssignmentUserResultsScrollbar = false;
		assignmentUserResultsThumbHeightPx = 0;
		assignmentUserResultsThumbTopPx = 0;
	}

	function resetUsersPane() {
		stopAddUserResultsDragging();
		usersViewMode = 'list';
		selectedUserForEdit = null;
		addUserQuery = '';
		addUsers = [];
		addUsersError = '';
		addUsersLoading = false;
		showAddUserResults = false;
		resetAddUserResultsScrollbarState();
		addUserSelectionCommitted = false;
		selectedAddUser = null;
		addUserActionError = '';
		editUserActionError = '';
		addUserActionLoading = false;
		editUserActionLoading = false;
		if (addUserSearchTimer) {
			clearTimeout(addUserSearchTimer);
			addUserSearchTimer = null;
		}
	}

	function openAddUserView() {
		stopAddUserResultsDragging();
		addUserQuery = '';
		addUsers = [];
		addUsersError = '';
		addUsersLoading = false;
		showAddUserResults = false;
		resetAddUserResultsScrollbarState();
		addUserSelectionCommitted = false;
		selectedAddUser = null;
		addUserActionError = '';
		addUserActionLoading = false;
		if (addUserSearchTimer) {
			clearTimeout(addUserSearchTimer);
			addUserSearchTimer = null;
		}
		selectedAddRole = 'Member';
		usersViewMode = 'add';
	}

	function openEditUserView(user: AccessUser) {
		selectedUserForEdit = user;
		selectedEditRole = user.role;
		editUserActionError = '';
		editUserActionLoading = false;
		usersViewMode = 'edit';
	}

	function resetShiftsPane() {
		shiftsViewMode = 'list';
		selectedShiftForEdit = null;
		isEditingShiftHistoryEntry = false;
		editingShiftHistoryStartDate = '';
		editingShiftHistoryVersionStamp = '';
		addShiftName = '';
		addShiftSortOrder = '1';
		addShiftPatternId = '';
		addShiftStartDate = '';
		addShiftEndDate = '';
		shiftPatternPickerOpen = false;
		shiftStartDatePickerOpen = false;
		shiftEndDatePickerOpen = false;
		addShiftActionError = '';
		addShiftActionLoading = false;
	}

	function openAddShiftView() {
		selectedShiftForEdit = null;
		isEditingShiftHistoryEntry = false;
		editingShiftHistoryStartDate = '';
		editingShiftHistoryVersionStamp = '';
		addShiftName = '';
		addShiftSortOrder = String(teamShifts.length + 1);
		addShiftPatternId = '';
		addShiftStartDate = '';
		addShiftEndDate = '';
		shiftPatternPickerOpen = false;
		shiftStartDatePickerOpen = false;
		shiftEndDatePickerOpen = false;
		addShiftActionError = '';
		addShiftActionLoading = false;
		if (!patterns.length && !patternsLoading) {
			void loadPatterns();
		}
		shiftsViewMode = 'add';
	}

	function openEditShiftView(shift: ShiftRow) {
		selectedShiftForEdit = shift;
		isEditingShiftHistoryEntry = false;
		editingShiftHistoryStartDate = '';
		editingShiftHistoryVersionStamp = '';
		addShiftName = shift.name;
		addShiftSortOrder = String(shift.sortOrder);
		addShiftPatternId = shift.patternId ? String(shift.patternId) : '';
		addShiftStartDate = shift.startDate;
		addShiftEndDate = shift.endDate ?? '';
		shiftPatternPickerOpen = false;
		shiftStartDatePickerOpen = false;
		shiftEndDatePickerOpen = false;
		addShiftActionError = '';
		addShiftActionLoading = false;
		if (!patterns.length && !patternsLoading) {
			void loadPatterns();
		}
		shiftsViewMode = 'edit';
	}

	function openEditShiftHistoryView(shift: ShiftRow, change: ShiftChangeRow) {
		selectedShiftForEdit = shift;
		isEditingShiftHistoryEntry = true;
		editingShiftHistoryStartDate = change.startDate;
		editingShiftHistoryVersionStamp = change.versionStamp ?? '';
		addShiftName = change.name;
		addShiftSortOrder = String(shift.sortOrder);
		addShiftPatternId = change.patternId ? String(change.patternId) : '';
		addShiftStartDate = change.startDate;
		addShiftEndDate = change.endDate ?? '';
		shiftPatternPickerOpen = false;
		shiftStartDatePickerOpen = false;
		shiftEndDatePickerOpen = false;
		addShiftActionError = '';
		addShiftActionLoading = false;
		if (!patterns.length && !patternsLoading) {
			void loadPatterns();
		}
		shiftsViewMode = 'edit';
	}

	function setShiftPatternPickerOpen(next: boolean) {
		shiftPatternPickerOpen = next;
	}

	function setShiftStartDatePickerOpen(next: boolean) {
		shiftStartDatePickerOpen = next;
	}

	function setShiftEndDatePickerOpen(next: boolean) {
		shiftEndDatePickerOpen = next;
	}

	function setShiftsMonthPickerOpen(next: boolean) {
		shiftsMonthPickerOpen = next;
	}

	function handleShiftsMonthChange(nextMonth: string) {
		shiftsMonth = nextMonth;
		if (open && isShiftsSection(activeSection) && shiftsViewMode === 'list') {
			void loadTeamShifts();
		}
	}

	function isValidDate(value: string): boolean {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
		const [yearText, monthText, dayText] = value.split('-');
		const year = Number(yearText);
		const month = Number(monthText);
		const day = Number(dayText);
		const parsed = new Date(Date.UTC(year, month - 1, day));
		if (Number.isNaN(parsed.getTime())) return false;
		return (
			parsed.getUTCFullYear() === year &&
			parsed.getUTCMonth() + 1 === month &&
			parsed.getUTCDate() === day
		);
	}

	function formatDateForDisplay(value: string): string {
		if (!isValidDate(value)) return value;
		const [yearText, monthText, dayText] = value.split('-');
		const month = Number(monthText);
		const day = Number(dayText);
		return `${month}/${day}/${yearText}`;
	}

	function formatOptionalDateForDisplay(
		value: string | null | undefined,
		emptyLabel: string
	): string {
		const normalized = value?.trim();
		if (!normalized) return emptyLabel;
		if (normalized.toLowerCase() === 'current') return emptyLabel;
		if (!isValidDate(normalized)) return emptyLabel;
		return formatDateForDisplay(normalized);
	}

	function monthBounds(monthValue: string): { start: string; end: string } | null {
		const trimmed = monthValue.trim();
		const match = /^(\d{4})-(\d{2})$/.exec(trimmed);
		if (!match) return null;
		const year = Number(match[1]);
		const month = Number(match[2]);
		if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
		const monthStart = new Date(Date.UTC(year, month - 1, 1));
		const monthEnd = new Date(Date.UTC(year, month, 0));
		const toIso = (value: Date) => {
			const y = value.getUTCFullYear();
			const m = String(value.getUTCMonth() + 1).padStart(2, '0');
			const d = String(value.getUTCDate()).padStart(2, '0');
			return `${y}-${m}-${d}`;
		};
		return { start: toIso(monthStart), end: toIso(monthEnd) };
	}

	function shiftChangeOverlapsMonth(change: ShiftChangeRow, monthValue: string): boolean {
		const bounds = monthBounds(monthValue);
		if (!bounds || !isValidDate(change.startDate)) return true;
		const effectiveEnd =
			change.endDate && isValidDate(change.endDate) ? change.endDate : '9999-12-31';
		return change.startDate <= bounds.end && effectiveEnd >= bounds.start;
	}

	function monthStartDate(monthValue: string): string | null {
		const trimmed = monthValue.trim();
		if (!/^\d{4}-\d{2}$/.test(trimmed)) return null;
		return `${trimmed}-01`;
	}

	function shiftSortOrderForMonth(shift: ShiftRow, monthValue: string): number {
		const matchingChanges = (shift.changes ?? [])
			.filter((change) => shiftChangeOverlapsMonth(change, monthValue))
			.sort((a, b) => a.startDate.localeCompare(b.startDate));
		const lastMatch = matchingChanges[matchingChanges.length - 1];
		const resolved = Number(lastMatch?.sortOrder ?? shift.sortOrder);
		return Number.isFinite(resolved) && resolved > 0 ? resolved : shift.sortOrder;
	}

	function shiftChangesForMonth(
		shift: ShiftRow,
		monthValue: string = shiftsMonth
	): ShiftChangeRow[] {
		return (shift.changes ?? [])
			.filter((change) => shiftChangeOverlapsMonth(change, monthValue))
			.sort((a, b) => a.startDate.localeCompare(b.startDate));
	}

	function primaryShiftChangeForMonth(
		shift: ShiftRow,
		monthValue: string = shiftsMonth
	): ShiftChangeRow | null {
		const matchingChanges = shiftChangesForMonth(shift, monthValue);
		if (matchingChanges.length === 0) return null;

		const monthStart = monthStartDate(monthValue);
		if (!monthStart) return matchingChanges[0] ?? null;

		for (let index = matchingChanges.length - 1; index >= 0; index -= 1) {
			const change = matchingChanges[index];
			const effectiveEnd =
				change.endDate && isValidDate(change.endDate) ? change.endDate : '9999-12-31';
			if (change.startDate <= monthStart && effectiveEnd >= monthStart) {
				return change;
			}
		}

		return matchingChanges[0] ?? null;
	}

	function displayShiftEndDate(shift: ShiftRow): string {
		if (!isShiftsSection(activeSection)) {
			return 'Indefinite';
		}
		const primaryChange = primaryShiftChangeForMonth(shift, shiftsMonth);
		return formatOptionalDateForDisplay(primaryChange?.endDate, 'Indefinite');
	}

	function shiftReorderRows(): HTMLTableRowElement[] {
		if (!shiftsTbodyEl) return [];
		return Array.from(shiftsTbodyEl.querySelectorAll('tr[data-shift-id]')).filter(
			(row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement
		);
	}

	function shiftIdFromRow(row: HTMLTableRowElement | null): number | null {
		if (!row) return null;
		const raw = row.dataset.shiftId;
		if (!raw) return null;
		const parsed = Number(raw);
		return Number.isInteger(parsed) ? parsed : null;
	}

	function shiftReorderBeforeId(pointerY: number): number | null {
		if (!shiftReorderState) return null;
		const rows = shiftReorderRows().filter(
			(row) => shiftIdFromRow(row) !== shiftReorderState?.sourceId
		);
		if (rows.length === 0) return null;

		const firstRect = rows[0].getBoundingClientRect();
		if (pointerY < firstRect.top) {
			return shiftIdFromRow(rows[0]);
		}

		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			const rect = row.getBoundingClientRect();
			if (pointerY <= rect.bottom) {
				return shiftIdFromRow(row);
			}
		}
		return null;
	}

	function shiftReorderOrderedIds(sourceId: number, beforeId: number | null): number[] {
		const orderedIds = displayedShifts
			.map((shift) => shift.employeeTypeId)
			.filter((id) => id !== sourceId);
		if (beforeId === null) {
			orderedIds.push(sourceId);
			return orderedIds;
		}
		const insertIndex = orderedIds.findIndex((id) => id === beforeId);
		if (insertIndex < 0) {
			orderedIds.push(sourceId);
			return orderedIds;
		}
		orderedIds.splice(insertIndex, 0, sourceId);
		return orderedIds;
	}

	function shiftReorderChanged(_sourceId: number, nextOrderedIds: number[]): boolean {
		const currentOrderedIds = displayedShifts.map((shift) => shift.employeeTypeId);
		if (currentOrderedIds.length !== nextOrderedIds.length) return false;
		return !arraysEqualNumber(currentOrderedIds, nextOrderedIds);
	}

	function shiftsForMonth(shifts: ShiftRow[], monthValue: string): ShiftRow[] {
		return shifts
			.filter((shift) => {
				const effectiveChanges =
					shift.changes && shift.changes.length > 0
						? shift.changes
						: [
								{
									startDate: shift.startDate,
									endDate: null,
									name: shift.name,
									patternId: shift.patternId,
									pattern: shift.pattern
								} satisfies ShiftChangeRow
							];
				return effectiveChanges.some((change) => shiftChangeOverlapsMonth(change, monthValue));
			})
			.sort((a, b) => {
				const orderDiff =
					shiftSortOrderForMonth(a, monthValue) - shiftSortOrderForMonth(b, monthValue);
				if (orderDiff !== 0) return orderDiff;
				const nameDiff = a.name.localeCompare(b.name);
				if (nameDiff !== 0) return nameDiff;
				return a.employeeTypeId - b.employeeTypeId;
			});
	}

	function applyOptimisticShiftOrderForMonth(shifts: ShiftRow[], monthValue: string): ShiftRow[] {
		if (
			!shiftReorderOptimisticOrder ||
			shiftReorderOptimisticOrder.month !== monthValue ||
			shiftReorderOptimisticOrder.orderedIds.length === 0
		) {
			return shifts;
		}
		const indexById = new Map(
			shiftReorderOptimisticOrder.orderedIds.map((id, index) => [id, index] as const)
		);
		return [...shifts].sort((a, b) => {
			const aIndex = indexById.get(a.employeeTypeId);
			const bIndex = indexById.get(b.employeeTypeId);
			const missingIndex = Number.MAX_SAFE_INTEGER;
			if ((aIndex ?? missingIndex) !== (bIndex ?? missingIndex)) {
				return (aIndex ?? missingIndex) - (bIndex ?? missingIndex);
			}
			const baseOrderDiff =
				shiftSortOrderForMonth(a, monthValue) - shiftSortOrderForMonth(b, monthValue);
			if (baseOrderDiff !== 0) return baseOrderDiff;
			return a.employeeTypeId - b.employeeTypeId;
		});
	}

	function normalizeShiftRows(rows: unknown): ShiftRow[] {
		if (!Array.isArray(rows)) return [];
		return rows.map((shift, index) => {
			const candidate = shift as ShiftRow;
			return {
				...candidate,
				sortOrder: Number(candidate.sortOrder ?? index + 1),
				endDate: candidate.endDate ?? null
			};
		});
	}

	function arraysEqualNumber(left: number[], right: number[]): boolean {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (left[index] !== right[index]) return false;
		}
		return true;
	}

	function arraysEqualString(left: string[], right: string[]): boolean {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (left[index] !== right[index]) return false;
		}
		return true;
	}

	async function fetchTeamShiftsSnapshot(
		monthValue: string | null = null
	): Promise<ShiftRow[] | null> {
		const monthQuery = monthValue ? `?month=${encodeURIComponent(monthValue)}` : '';
		const result = await fetchWithAuthRedirect(`${base}/api/team/shifts${monthQuery}`, {
			method: 'GET'
		});
		if (!result) return null;
		if (!result.ok) {
			throw new Error(await parseErrorMessage(result, 'Failed to load shifts'));
		}
		const data = await result.json();
		return normalizeShiftRows(data.shifts);
	}

	async function reconcileShiftReorderWithServer(
		expectedOrderedIds: number[],
		monthValue: string
	): Promise<void> {
		let serverShifts: ShiftRow[] | null = null;
		try {
			serverShifts = await fetchTeamShiftsSnapshot(monthValue);
		} catch {
			return;
		}
		if (!serverShifts) return;
		const serverIds = shiftsForMonth(serverShifts, monthValue).map((shift) => shift.employeeTypeId);
		logShiftReorderDebug('Reconcile snapshot loaded', {
			monthValue,
			expectedOrderedIds,
			serverIds
		});
		teamShifts = serverShifts;
		if (arraysEqualNumber(serverIds, expectedOrderedIds)) {
			shiftReorderOptimisticOrder = null;
			logShiftReorderDebug(
				'Reconcile confirmed expected order; committed server snapshot locally',
				{
					monthValue,
					serverIds
				}
			);
			return;
		}
		expandedShiftRows = new Set();
		shiftReorderOptimisticOrder = null;
		logShiftReorderDebug('Reconcile detected mismatch; reset optimistic order', {
			monthValue,
			expectedOrderedIds,
			serverIds
		});
	}

	async function saveShiftReorder(sourceId: number, nextOrderedIds: number[]): Promise<void> {
		const currentOrderedIds = displayedShifts.map((shift) => shift.employeeTypeId);
		const sourceIndex = currentOrderedIds.findIndex((id) => id === sourceId);
		const nextIndex = nextOrderedIds.findIndex((id) => id === sourceId);
		const changed = shiftReorderChanged(sourceId, nextOrderedIds);
		logShiftReorderDebug('saveShiftReorder invoked', {
			sourceId,
			sourceIndex,
			nextIndex,
			changed,
			currentOrderedIds,
			nextOrderedIds,
			activeMonth: shiftsMonth
		});
		if (!changed) {
			logShiftReorderDebug('saveShiftReorder no-op (unchanged source index)', {
				sourceId,
				sourceIndex,
				nextIndex
			});
			return;
		}
		const sourceShift = displayedShifts.find((shift) => shift.employeeTypeId === sourceId);
		if (!sourceShift) return;
		const effectiveStartDate = monthStartDate(shiftsMonth);
		if (!effectiveStartDate) {
			addShiftActionError = 'Selected month is invalid.';
			return;
		}
		const reorderMonth = shiftsMonth;
		const previousOptimisticOrder = shiftReorderOptimisticOrder;
		shiftReorderOptimisticOrder = { month: reorderMonth, orderedIds: [...nextOrderedIds] };
		isShiftReorderLoading = true;
		addShiftActionError = '';
		try {
			const payload = {
				reorderOnly: true,
				employeeTypeId: sourceShift.employeeTypeId,
				startDate: effectiveStartDate,
				orderedShiftIds: nextOrderedIds
			};
			logShiftReorderDebug('Sending shift reorder PATCH', {
				payload
			});
			const result = await fetchWithAuthRedirect(`${base}/api/team/shifts`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!result) {
				logShiftReorderDebug('Shift reorder PATCH returned null result (auth redirect?)');
				shiftReorderOptimisticOrder = previousOptimisticOrder;
				return;
			}
			logShiftReorderDebug('Shift reorder PATCH response', {
				ok: result.ok,
				status: result.status
			});
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to reorder shift'));
			}
			await reconcileShiftReorderWithServer(nextOrderedIds, reorderMonth);
			logShiftReorderDebug('Shift reorder reconciliation complete', {
				expectedOrderedIds: nextOrderedIds,
				reorderMonth
			});
			void refreshDependenciesAfterMutation(['assignments', 'schedule']).catch(() => {
				// Reorder save is already committed; keep background refresh best-effort.
			});
		} catch (error) {
			shiftReorderOptimisticOrder = previousOptimisticOrder;
			addShiftActionError = error instanceof Error ? error.message : 'Failed to reorder shift';
			logShiftReorderDebug('Shift reorder save failed', {
				sourceId,
				error: error instanceof Error ? error.message : String(error)
			});
		} finally {
			isShiftReorderLoading = false;
		}
	}

	function stopShiftReorderListeners() {
		if (typeof window === 'undefined') return;
		window.removeEventListener('mousemove', handleShiftReorderMouseMove);
		window.removeEventListener('mouseup', handleShiftReorderMouseUp);
		logShiftReorderDebug('Detached global mouse listeners');
	}

	function startShiftReorderListeners() {
		if (typeof window === 'undefined') return;
		window.addEventListener('mousemove', handleShiftReorderMouseMove);
		window.addEventListener('mouseup', handleShiftReorderMouseUp);
		logShiftReorderDebug('Attached global mouse listeners');
	}

	function handleShiftReorderMouseMove(event: MouseEvent) {
		if (!shiftReorderState) return;
		event.preventDefault();
		const { offsetX, offsetY } = shiftReorderState;
		const x = event.clientX - offsetX;
		const y = event.clientY - offsetY;
		const nextBeforeId = shiftReorderBeforeId(event.clientY);
		shiftReorderState = {
			...shiftReorderState,
			currentBeforeId: nextBeforeId,
			ghostX: x,
			ghostY: y
		};
		applyShiftReorderGhostPosition(x, y, shiftReorderState.ghostWidth);
		const now = Date.now();
		if (now - shiftReorderLastMoveLogAt >= 120) {
			shiftReorderMoveLogCount += 1;
			shiftReorderLastMoveLogAt = now;
			logShiftReorderDebug('mousemove', {
				count: shiftReorderMoveLogCount,
				clientX: event.clientX,
				clientY: event.clientY,
				ghostX: Math.round(x),
				ghostY: Math.round(y),
				currentBeforeId: nextBeforeId,
				sourceId: shiftReorderState.sourceId
			});
		}
	}

	async function stopShiftReorder(commit: boolean) {
		if (!shiftReorderState) return;
		const state = shiftReorderState;
		logShiftReorderDebug('Stopping drag', {
			commit,
			sourceId: state.sourceId,
			currentBeforeId: state.currentBeforeId,
			isShiftReorderLoading
		});
		shiftReorderState = null;
		stopShiftReorderListeners();
		document.body.classList.remove('teamShiftRowDragging');
		state.handle.blur();
		if (!commit || isShiftReorderLoading) return;
		const nextOrderedIds = shiftReorderOrderedIds(state.sourceId, state.currentBeforeId);
		logShiftReorderDebug('Computed next order', {
			sourceId: state.sourceId,
			nextOrderedIds
		});
		await saveShiftReorder(state.sourceId, nextOrderedIds);
	}

	function handleShiftReorderMouseUp(event: MouseEvent) {
		if (!shiftReorderState) return;
		event.preventDefault();
		logShiftReorderDebug('mouseup', {
			clientX: event.clientX,
			clientY: event.clientY,
			sourceId: shiftReorderState.sourceId
		});
		void stopShiftReorder(true);
	}

	function handleShiftReorderMouseDown(event: MouseEvent, shift: ShiftRow) {
		logShiftReorderDebug('mousedown', {
			shiftId: shift.employeeTypeId,
			activeSection,
			shiftsViewMode,
			isShiftReorderLoading,
			hasTbody: Boolean(shiftsTbodyEl),
			button: event.button,
			clientX: event.clientX,
			clientY: event.clientY
		});
		if (activeSection !== 'shifts' || isShiftReorderLoading || !shiftsTbodyEl) return;
		if (event.button !== 0) return;
		const handle = event.currentTarget as HTMLButtonElement | null;
		const row = handle?.closest('tr[data-shift-id]') as HTMLTableRowElement | null;
		if (!handle || !row) return;
		event.preventDefault();
		if (shiftReorderState) return;
		shiftReorderMoveLogCount = 0;
		shiftReorderLastMoveLogAt = 0;
		startShiftReorderListeners();
		const rowRect = row.getBoundingClientRect();
		logShiftReorderDebug('Row bounds captured', {
			shiftId: shift.employeeTypeId,
			rowLeft: Math.round(rowRect.left),
			rowTop: Math.round(rowRect.top),
			rowWidth: Math.round(rowRect.width),
			rowHeight: Math.round(rowRect.height)
		});
		const orderedIds = shiftReorderRows()
			.map((tableRow) => shiftIdFromRow(tableRow))
			.filter((id): id is number => id !== null);
		const sourceIndex = orderedIds.findIndex((id) => id === shift.employeeTypeId);
		const initialBeforeId = sourceIndex >= 0 ? (orderedIds[sourceIndex + 1] ?? null) : null;
		document.body.classList.add('teamShiftRowDragging');
		shiftReorderState = {
			sourceId: shift.employeeTypeId,
			handle,
			offsetX: event.clientX - rowRect.left,
			offsetY: event.clientY - rowRect.top,
			currentBeforeId: initialBeforeId,
			ghostX: rowRect.left,
			ghostY: rowRect.top,
			ghostWidth:
				Math.round(shiftsTableEl?.getBoundingClientRect().width ?? rowRect.width) || rowRect.width,
			rowHeight: rowRect.height
		};
		applyShiftReorderGhostPosition(
			rowRect.left,
			rowRect.top,
			Math.round(shiftsTableEl?.getBoundingClientRect().width ?? rowRect.width) || rowRect.width
		);
		logShiftReorderDebug('Drag state initialized', {
			sourceId: shift.employeeTypeId,
			initialBeforeId
		});
	}

	function showShiftPlaceholderBefore(shiftId: number): boolean {
		return (
			activeSection === 'shifts' &&
			shiftReorderState !== null &&
			shiftReorderState.currentBeforeId === shiftId
		);
	}

	function showShiftPlaceholderAtEnd(): boolean {
		return (
			activeSection === 'shifts' &&
			shiftReorderState !== null &&
			shiftReorderState.currentBeforeId === null
		);
	}

	function shiftReorderGhostStyle(): string {
		if (!shiftReorderState) return '';
		return `width:${Math.round(shiftReorderState.ghostWidth)}px;transform:translate(${Math.round(
			shiftReorderState.ghostX
		)}px, ${Math.round(shiftReorderState.ghostY)}px) rotate(0.3deg) scale(1.008);`;
	}

	function portalToBody(node: HTMLElement) {
		if (typeof document === 'undefined') return;
		logShiftReorderDebug('Mounting ghost into document.body');
		document.body.appendChild(node);
		const state = shiftReorderState;
		if (node instanceof HTMLDivElement && state) {
			shiftReorderGhostEl = node;
			applyShiftReorderGhostPosition(state.ghostX, state.ghostY, state.ghostWidth);
		}
		return {
			destroy() {
				logShiftReorderDebug('Unmounting ghost from document.body');
				if (shiftReorderGhostEl === node) {
					shiftReorderGhostEl = null;
				}
				node.remove();
			}
		};
	}

	async function handleAddShift() {
		addShiftActionError = '';
		if (addShiftActionLoading) return;

		const name = addShiftName.trim();
		const sortOrder = Number(addShiftSortOrder);
		const maxSortOrder = teamShifts.length + 1;
		const startDate = addShiftStartDate.trim();
		const endDate = addShiftEndDate.trim();
		const patternId = addShiftPatternId.trim();

		if (!name) {
			addShiftActionError = 'Shift name is required.';
			return;
		}
		if (!isValidDate(startDate)) {
			addShiftActionError = 'Start date must be in YYYY-MM-DD format.';
			return;
		}
		if (endDate && !isValidDate(endDate)) {
			addShiftActionError = 'End date must be in YYYY-MM-DD format.';
			return;
		}
		if (endDate && endDate < startDate) {
			addShiftActionError = 'End date must be on or after start date.';
			return;
		}
		if (!Number.isInteger(sortOrder) || sortOrder < 1 || sortOrder > maxSortOrder) {
			addShiftActionError = `Sort order must be between 1 and ${maxSortOrder}.`;
			return;
		}

		addShiftActionLoading = true;
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/shifts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					sortOrder,
					patternId: patternId ? Number(patternId) : null,
					startDate,
					endDate: endDate || null
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to save shift'));
			}
			await refreshDependenciesAfterMutation(['shifts', 'assignments', 'schedule']);
			resetShiftsPane();
		} catch (error) {
			addShiftActionError = error instanceof Error ? error.message : 'Failed to save shift';
		} finally {
			addShiftActionLoading = false;
		}
	}

	async function handleSaveShiftEdit() {
		addShiftActionError = '';
		if (addShiftActionLoading || !selectedShiftForEdit) return;

		const name = addShiftName.trim();
		const sortOrder = Number(addShiftSortOrder);
		const maxSortOrder = Math.max(teamShifts.length, 1);
		const startDate = addShiftStartDate.trim();
		const endDate = addShiftEndDate.trim();
		const patternId = addShiftPatternId.trim();

		if (!name) {
			addShiftActionError = 'Shift name is required.';
			return;
		}
		if (!isValidDate(startDate)) {
			addShiftActionError = 'Change effective date must be in YYYY-MM-DD format.';
			return;
		}
		if (endDate && !isValidDate(endDate)) {
			addShiftActionError = 'End date must be in YYYY-MM-DD format.';
			return;
		}
		if (endDate && endDate < startDate) {
			addShiftActionError = 'End date must be on or after change effective date.';
			return;
		}
		if (!Number.isInteger(sortOrder) || sortOrder < 1 || sortOrder > maxSortOrder) {
			addShiftActionError = `Sort order must be between 1 and ${maxSortOrder}.`;
			return;
		}
		const expectedShiftVersionStamp = selectedShiftForEdit.versionStamp?.trim() ?? '';
		if (!expectedShiftVersionStamp) {
			addShiftActionError = 'This shift is out of date. Refresh and try again.';
			return;
		}
		const expectedChangeVersionStamp = isEditingShiftHistoryEntry
			? editingShiftHistoryVersionStamp.trim()
			: '';
		if (isEditingShiftHistoryEntry && !expectedChangeVersionStamp) {
			addShiftActionError = 'This shift change is out of date. Refresh and try again.';
			return;
		}

		addShiftActionLoading = true;
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/shifts`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					employeeTypeId: selectedShiftForEdit.employeeTypeId,
					name,
					sortOrder,
					patternId: patternId ? Number(patternId) : null,
					startDate,
					endDate: endDate || null,
					editMode: isEditingShiftHistoryEntry ? 'history' : 'timeline',
					changeStartDate: isEditingShiftHistoryEntry ? editingShiftHistoryStartDate : null,
					expectedShiftVersionStamp,
					expectedChangeVersionStamp: isEditingShiftHistoryEntry ? expectedChangeVersionStamp : null
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to save shift'));
			}
			await refreshDependenciesAfterMutation(['shifts', 'assignments', 'schedule']);
			resetShiftsPane();
		} catch (error) {
			addShiftActionError = error instanceof Error ? error.message : 'Failed to save shift';
		} finally {
			addShiftActionLoading = false;
		}
	}

	async function handleRemoveShift() {
		addShiftActionError = '';
		if (addShiftActionLoading || !selectedShiftForEdit) return;
		const expectedShiftVersionStamp = selectedShiftForEdit.versionStamp?.trim() ?? '';
		if (!expectedShiftVersionStamp) {
			addShiftActionError = 'This shift is out of date. Refresh and try again.';
			return;
		}
		const expectedChangeVersionStamp = isEditingShiftHistoryEntry
			? editingShiftHistoryVersionStamp.trim()
			: '';
		if (isEditingShiftHistoryEntry && !expectedChangeVersionStamp) {
			addShiftActionError = 'This shift change is out of date. Refresh and try again.';
			return;
		}

		addShiftActionLoading = true;
		try {
			const removePayloadBase = {
				employeeTypeId: selectedShiftForEdit.employeeTypeId,
				editMode: isEditingShiftHistoryEntry ? 'history' : 'timeline',
				changeStartDate: isEditingShiftHistoryEntry ? editingShiftHistoryStartDate : null,
				expectedShiftVersionStamp,
				expectedChangeVersionStamp: isEditingShiftHistoryEntry ? expectedChangeVersionStamp : null
			};

			let result = await fetchWithAuthRedirect(`${base}/api/team/shifts`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(removePayloadBase)
			});
			if (!result) return;

			if (result.status === 409 && !isEditingShiftHistoryEntry) {
				const text = (await result.text().catch(() => '')).trim();
				let apiError: RemoveShiftErrorPayload = {};
				if (text) {
					try {
						apiError = JSON.parse(text) as RemoveShiftErrorPayload;
					} catch {
						apiError = { message: text };
					}
				}

				if (apiError.code === 'SHIFT_IN_USE_CONFIRMATION') {
					const assignmentCount = Number(apiError.assignmentCount ?? 0);
					const shiftEventCount = Number(apiError.shiftEventCount ?? 0);
					const shiftChangeCount = Number(apiError.shiftChangeCount ?? 0);
					const message = `This shift has historical usage and will be permanently deleted along with related records.\n\nAssignments: ${assignmentCount}\nShift events: ${shiftEventCount}\nShift changes: ${shiftChangeCount}\n\nContinue?`;
					const confirmChoice = await openConfirmDialog({
						title: 'Remove Shift?',
						message,
						options: [
							{ id: 'cancel', label: 'Cancel' },
							{ id: 'continue', label: 'Continue', tone: 'danger' }
						],
						cancelOptionId: 'cancel'
					});
					if (confirmChoice !== 'continue') {
						addShiftActionError = 'Shift removal canceled.';
						return;
					}

					result = await fetchWithAuthRedirect(`${base}/api/team/shifts`, {
						method: 'DELETE',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							...removePayloadBase,
							confirmUsedShiftRemoval: true
						})
					});
					if (!result) return;
				}
			}

			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to remove shift'));
			}
			await refreshDependenciesAfterMutation(['shifts', 'assignments', 'schedule']);
			resetShiftsPane();
		} catch (error) {
			addShiftActionError = error instanceof Error ? error.message : 'Failed to remove shift';
		} finally {
			addShiftActionLoading = false;
		}
	}

	function currentScheduleScopeKey(): string {
		if (activeScheduleId === null) return 'schedule:default';
		return `schedule:${activeScheduleId}`;
	}

	function normalizeEventCodeCode(value: string): string {
		return value.trim().toUpperCase().replace(/\s+/g, '-');
	}

	function normalizeEventCodeName(value: string): string {
		return value.trim();
	}

	function createDefaultEventCodeReminderDraft(): EventCodeReminderDraft {
		return {
			id: nextEventCodeReminderDraftId++,
			amount: 1,
			unit: 'days',
			hour: 12,
			meridiem: 'PM'
		};
	}

	function resetEventCodeReminderDrafts() {
		addEventCodeReminderImmediate = false;
		addEventCodeReminderScheduled = false;
		eventCodeReminderDrafts = [createDefaultEventCodeReminderDraft()];
	}

	function addEventCodeReminderDraft() {
		if (eventCodeReminderDrafts.length >= EVENT_CODE_MAX_REMINDERS) return;
		eventCodeReminderDrafts = [...eventCodeReminderDrafts, createDefaultEventCodeReminderDraft()];
	}

	function removeEventCodeReminderDraft(id: number) {
		if (eventCodeReminderDrafts.length <= 1) {
			addEventCodeReminderScheduled = false;
			eventCodeReminderDrafts = [createDefaultEventCodeReminderDraft()];
			return;
		}
		eventCodeReminderDrafts = eventCodeReminderDrafts.filter((draft) => draft.id !== id);
	}

	function updateEventCodeReminderDraft(
		id: number,
		field: 'amount' | 'unit' | 'hour' | 'meridiem',
		nextValue: string | number
	) {
		eventCodeReminderDrafts = eventCodeReminderDrafts.map((draft) => {
			if (draft.id !== id) return draft;
			if (field === 'amount') return { ...draft, amount: Number(nextValue) };
			if (field === 'hour') return { ...draft, hour: Number(nextValue) };
			if (field === 'unit') return { ...draft, unit: String(nextValue) };
			return { ...draft, meridiem: String(nextValue) };
		});
	}

	function eventCodeReminderSummaryKey(reminderDraft: EventCodeReminderDraft): string {
		return `${reminderDraft.amount}|${reminderDraft.unit}|${reminderDraft.hour}|${reminderDraft.meridiem}`;
	}

	function eventCodeReminderUnitLabel(unit: string, amount: number): string {
		if (amount === 1 && unit.endsWith('s')) return unit.slice(0, -1);
		return unit;
	}

	function resetEventCodesPane() {
		eventCodesViewMode = 'list';
		selectedEventCodeForEdit = null;
		addEventCodeCode = '';
		addEventCodeName = '';
		addEventCodeDisplayMode = 'Schedule Overlay';
		addEventCodeColor = '#22c55e';
		addEventCodeIsActive = true;
		resetEventCodeReminderDrafts();
		eventCodeDisplayModePickerOpen = false;
		eventCodeActionError = '';
		eventCodeActionLoading = false;
		lastLoadedEventCodeScopeKey = '';
	}

	function openAddEventCodeView() {
		selectedEventCodeForEdit = null;
		addEventCodeCode = '';
		addEventCodeName = '';
		addEventCodeDisplayMode = 'Schedule Overlay';
		addEventCodeColor = '#22c55e';
		addEventCodeIsActive = true;
		resetEventCodeReminderDrafts();
		eventCodeDisplayModePickerOpen = false;
		eventCodeActionError = '';
		eventCodeActionLoading = false;
		eventCodesViewMode = 'add';
	}

	function openEditEventCodeView(eventCode: EventCodeRow) {
		selectedEventCodeForEdit = eventCode;
		addEventCodeCode = eventCode.code;
		addEventCodeName = eventCode.name;
		addEventCodeDisplayMode = eventCode.displayMode;
		addEventCodeColor = eventCode.color;
		addEventCodeIsActive = eventCode.isActive;
		addEventCodeReminderImmediate = Boolean(eventCode.notifyImmediately);
		const reminders = Array.isArray(eventCode.scheduledReminders)
			? eventCode.scheduledReminders
			: [];
		if (reminders.length > 0) {
			addEventCodeReminderScheduled = true;
			eventCodeReminderDrafts = reminders.map((reminder) => ({
				id: nextEventCodeReminderDraftId++,
				amount: reminder.amount,
				unit: reminder.unit,
				hour: reminder.hour,
				meridiem: reminder.meridiem
			}));
		} else {
			addEventCodeReminderScheduled = false;
			eventCodeReminderDrafts = [createDefaultEventCodeReminderDraft()];
		}
		eventCodeDisplayModePickerOpen = false;
		eventCodeActionError = '';
		eventCodeActionLoading = false;
		eventCodesViewMode = 'edit';
	}

	function setEventCodeDisplayModePickerOpen(next: boolean) {
		eventCodeDisplayModePickerOpen = next;
	}

	function isEventCodeCodeTaken(code: string): boolean {
		const normalized = normalizeEventCodeCode(code);
		if (!normalized) return false;
		return eventCodeRows.some((row) => {
			if (selectedEventCodeForEdit && row.eventCodeId === selectedEventCodeForEdit.eventCodeId) {
				return false;
			}
			return row.code.toUpperCase() === normalized;
		});
	}

	async function loadEventCodes() {
		eventCodeRowsLoading = true;
		eventCodeRowsError = '';
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/event-codes`, { method: 'GET' });
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to load event codes'));
			}
			const data = (await result.json()) as {
				eventCodes?: Array<{
					eventCodeId: number;
					code: string;
					name: string;
					displayMode: EventCodeDisplayMode;
					color: string;
					isActive: boolean;
					versionStamp?: string;
					notifyImmediately?: boolean;
					scheduledReminders?: Array<{
						amount: number;
						unit: 'days' | 'weeks' | 'months';
						hour: number;
						meridiem: 'AM' | 'PM';
					}>;
				}>;
			};
			const scope = currentScheduleScopeKey();
			eventCodeRows = Array.isArray(data.eventCodes) ? data.eventCodes : [];
			lastLoadedEventCodeScopeKey = scope;
		} catch (error) {
			eventCodeRowsError =
				error instanceof Error ? error.message : 'Failed to load event codes for this schedule';
		} finally {
			eventCodeRowsLoading = false;
		}
	}

	async function handleSaveEventCode() {
		eventCodeActionError = '';
		if (eventCodeActionLoading) return;

		const code = normalizeEventCodeCode(addEventCodeCode);
		const name = normalizeEventCodeName(addEventCodeName);

		if (!code) {
			eventCodeActionError = 'Event code is required.';
			return;
		}
		if (!/^[A-Z0-9_-]{1,16}$/.test(code)) {
			eventCodeActionError =
				'Event code must be 1-16 characters and use uppercase letters, numbers, "_" or "-".';
			return;
		}
		if (isEventCodeCodeTaken(code)) {
			eventCodeActionError = 'An event code with this code already exists in this schedule.';
			return;
		}
		if (!name) {
			eventCodeActionError = 'Display name is required.';
			return;
		}

		eventCodeActionLoading = true;
		try {
			const isEdit = eventCodesViewMode === 'edit' && selectedEventCodeForEdit;
			const expectedVersionStamp = isEdit
				? (selectedEventCodeForEdit.versionStamp?.trim() ?? '')
				: '';
			if (isEdit && !expectedVersionStamp) {
				eventCodeActionError = 'This event code is out of date. Refresh and try again.';
				return;
			}
			const payload = {
				code,
				name,
				displayMode: addEventCodeDisplayMode,
				color: addEventCodeColor,
				isActive: addEventCodeIsActive,
				notifyImmediately: addEventCodeReminderImmediate,
				scheduledReminders: addEventCodeReminderScheduled
					? eventCodeReminderDrafts.map((reminderDraft) => ({
							amount: reminderDraft.amount,
							unit: reminderDraft.unit,
							hour: reminderDraft.hour,
							meridiem: reminderDraft.meridiem
						}))
					: []
			};
			const result = await fetchWithAuthRedirect(`${base}/api/team/event-codes`, {
				method: isEdit ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					isEdit
						? {
								eventCodeId: selectedEventCodeForEdit.eventCodeId,
								expectedVersionStamp,
								...payload
							}
						: payload
				)
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to save event code'));
			}
			await refreshDependenciesAfterMutation(['eventCodes', 'schedule']);
			resetEventCodesPane();
		} catch (error) {
			eventCodeActionError = error instanceof Error ? error.message : 'Failed to save event code';
		} finally {
			eventCodeActionLoading = false;
		}
	}

	function resetAssignmentsPane(options?: { preserveListShiftSelection?: boolean }) {
		const preserveListShiftSelection = options?.preserveListShiftSelection === true;
		stopAssignmentUserResultsDragging();
		assignmentsViewMode = 'list';
		selectedAssignmentForEdit = null;
		isEditingAssignmentHistoryEntry = false;
		editingAssignmentHistoryStartDate = '';
		editingAssignmentHistoryVersionStamp = '';
		assignmentUserOid = '';
		assignmentUserQuery = '';
		assignmentShiftId = '';
		assignmentStartDate = '';
		assignmentEndDate = '';
		assignmentUserResultsOpen = false;
		resetAssignmentUserResultsScrollbarState();
		if (!preserveListShiftSelection) {
			assignmentListShiftId = '';
		}
		assignmentStartDatePickerOpen = false;
		assignmentEndDatePickerOpen = false;
		assignmentActionError = '';
		assignmentActionLoading = false;
		void stopAssignmentReorder(false);
		isAssignmentReorderLoading = false;
		assignmentReorderOptimisticOrder = null;
	}

	function openAddAssignmentView() {
		stopAssignmentUserResultsDragging();
		selectedAssignmentForEdit = null;
		isEditingAssignmentHistoryEntry = false;
		editingAssignmentHistoryStartDate = '';
		editingAssignmentHistoryVersionStamp = '';
		assignmentUserOid = '';
		assignmentUserQuery = '';
		assignmentShiftId = '';
		assignmentStartDate = '';
		assignmentEndDate = '';
		assignmentUserResultsOpen = false;
		resetAssignmentUserResultsScrollbarState();
		assignmentStartDatePickerOpen = false;
		assignmentEndDatePickerOpen = false;
		assignmentActionError = '';
		assignmentActionLoading = false;
		assignmentsViewMode = 'add';
	}

	function openAddAssignmentViewForShift(shiftId: string) {
		openAddAssignmentView();
		assignmentShiftId = shiftId;
	}

	function openEditAssignmentView(assignment: AssignmentRow) {
		stopAssignmentUserResultsDragging();
		selectedAssignmentForEdit = assignment;
		isEditingAssignmentHistoryEntry = false;
		editingAssignmentHistoryStartDate = '';
		editingAssignmentHistoryVersionStamp = '';
		assignmentUserOid = assignment.userOid;
		assignmentUserQuery = resolveAssignmentUserName(assignment.userOid);
		assignmentShiftId = String(assignment.shiftId);
		assignmentStartDate = assignment.startDate;
		assignmentEndDate = assignment.endDate ?? '';
		assignmentUserResultsOpen = false;
		resetAssignmentUserResultsScrollbarState();
		assignmentStartDatePickerOpen = false;
		assignmentEndDatePickerOpen = false;
		assignmentActionError = '';
		assignmentActionLoading = false;
		assignmentsViewMode = 'edit';
	}

	function openEditAssignmentHistoryView(
		parentAssignment: AssignmentRow,
		assignment: AssignmentChangeRow
	) {
		stopAssignmentUserResultsDragging();
		selectedAssignmentForEdit = {
			...assignment,
			timelineVersionStamp: parentAssignment.timelineVersionStamp
		};
		isEditingAssignmentHistoryEntry = true;
		editingAssignmentHistoryStartDate = assignment.startDate;
		editingAssignmentHistoryVersionStamp = assignment.versionStamp ?? '';
		assignmentUserOid = assignment.userOid;
		assignmentUserQuery = assignment.userName ?? resolveAssignmentUserName(assignment.userOid);
		assignmentShiftId = String(assignment.shiftId);
		assignmentStartDate = assignment.startDate;
		assignmentEndDate = assignment.endDate ?? '';
		assignmentUserResultsOpen = false;
		resetAssignmentUserResultsScrollbarState();
		assignmentStartDatePickerOpen = false;
		assignmentEndDatePickerOpen = false;
		assignmentActionError = '';
		assignmentActionLoading = false;
		assignmentsViewMode = 'edit';
	}

	function setAssignmentsMonthPickerOpen(next: boolean) {
		assignmentsMonthPickerOpen = next;
	}

	function handleAssignmentListShiftChange(nextShiftId: string) {
		if (assignmentListShiftId === nextShiftId) return;
		void stopAssignmentReorder(false);
		assignmentListShiftId = nextShiftId;
		expandedAssignmentRows = new Set();
		assignmentReorderOptimisticOrder = null;
	}

	function clearAssignmentListShiftSelection() {
		handleAssignmentListShiftChange('');
	}

	function handleAssignmentsMonthChange(nextMonth: string) {
		assignmentsMonth = nextMonth;
		if (open && activeSection === 'assignments' && assignmentsViewMode === 'list') {
			void loadTeamShifts(nextMonth);
			void loadAssignmentRows(nextMonth);
		}
	}

	function setAssignmentStartDatePickerOpen(next: boolean) {
		assignmentStartDatePickerOpen = next;
	}

	function setAssignmentEndDatePickerOpen(next: boolean) {
		assignmentEndDatePickerOpen = next;
	}

	function handleAssignmentStartDateChange(value: string) {
		assignmentStartDate = value;
	}

	function resolveAssignmentUserName(userOid: string): string {
		const user = teamUsers.find((candidate) => candidate.userOid === userOid);
		return user?.name ?? 'Unknown user';
	}

	function resolveAssignmentShiftName(employeeTypeId: number): string {
		const shift = teamShifts.find((candidate) => candidate.employeeTypeId === employeeTypeId);
		return shift?.name ?? 'Unknown shift';
	}

	function assignmentUserLabel(user: AccessUser): string {
		const email = user.email?.trim();
		return email ? `${user.name} (${email})` : user.name;
	}

	function normalizeUserSearchQuery(value: string): string {
		return value.trim().replace(/\s+/g, ' ').toLowerCase();
	}

	function deriveNameParts(displayName: string): { givenName: string; surname: string } {
		const normalized = displayName.trim().replace(/\s+/g, ' ');
		if (!normalized) return { givenName: '', surname: '' };

		if (normalized.includes(',')) {
			const [surnamePart, givenPart] = normalized.split(',', 2);
			return {
				givenName: normalizeUserSearchQuery(givenPart ?? ''),
				surname: normalizeUserSearchQuery(surnamePart ?? '')
			};
		}

		const parts = normalized.split(' ').filter(Boolean);
		if (parts.length === 1) {
			return { givenName: normalizeUserSearchQuery(parts[0]), surname: '' };
		}

		return {
			givenName: normalizeUserSearchQuery(parts.slice(0, -1).join(' ')),
			surname: normalizeUserSearchQuery(parts[parts.length - 1] ?? '')
		};
	}

	function assignmentUserMatchesQuery(user: AccessUser, query: string): boolean {
		if (!query) return true;

		const normalizedName = normalizeUserSearchQuery(user.name);
		const normalizedLabel = normalizeUserSearchQuery(assignmentUserLabel(user));
		const normalizedDisplayName = normalizeUserSearchQuery(user.displayName ?? '');
		const normalizedEmail = normalizeUserSearchQuery(user.email);
		const normalizedOid = normalizeUserSearchQuery(user.userOid);

		if (
			normalizedName.includes(query) ||
			normalizedLabel.includes(query) ||
			normalizedDisplayName.includes(query) ||
			normalizedEmail.includes(query) ||
			normalizedOid.includes(query)
		) {
			return true;
		}

		const terms = query.split(' ').filter(Boolean);
		if (terms.length < 2) return false;

		const first = terms[0] ?? '';
		const last = terms[terms.length - 1] ?? '';
		const firstWithMiddle = terms.slice(0, -1).join(' ');
		const lastWithMiddle = terms.slice(1).join(' ');
		const { givenName, surname } = deriveNameParts(user.name);

		if (
			(givenName.startsWith(first) && surname.startsWith(last)) ||
			(givenName.startsWith(last) && surname.startsWith(first))
		) {
			return true;
		}

		const lastFirstDisplay = normalizeUserSearchQuery(
			surname && givenName ? `${surname}, ${givenName}` : user.name
		);
		const firstLastDisplay = normalizeUserSearchQuery(
			givenName && surname ? `${givenName}, ${surname}` : user.name
		);

		return (
			lastFirstDisplay.startsWith(`${last}, ${firstWithMiddle}`) ||
			firstLastDisplay.startsWith(`${first}, ${lastWithMiddle}`)
		);
	}

	function onAssignmentUserQueryInput(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		assignmentUserQuery = target.value;
		assignmentUserOid = '';
		assignmentUserResultsOpen = true;
		resetAssignmentUserResultsScrollbarState();
		assignmentActionError = '';
	}

	function onAssignmentUserFocus() {
		assignmentUserResultsOpen = true;
	}

	function onAssignmentUserComboMouseDown(event: MouseEvent) {
		if (isEditingAssignmentHistoryEntry) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('.setupUserComboItem')) return;
		assignmentUserResultsOpen = true;
	}

	function onAssignmentUserSelect(user: AccessUser) {
		assignmentUserOid = user.userOid;
		assignmentUserQuery = assignmentUserLabel(user);
		closeAssignmentUserResults();
		assignmentActionError = '';
	}

	function closeAssignmentUserResults() {
		stopAssignmentUserResultsDragging();
		assignmentUserResultsOpen = false;
		resetAssignmentUserResultsScrollbarState();
	}

	function updateAssignmentUserResultsScrollbar() {
		if (!assignmentUserResultsEl) return;
		const scrollHeight = assignmentUserResultsEl.scrollHeight;
		const clientHeight = assignmentUserResultsEl.clientHeight;
		const scrollTop = assignmentUserResultsEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;

		showAssignmentUserResultsScrollbar = hasOverflow;
		if (!hasOverflow) {
			assignmentUserResultsThumbHeightPx = 0;
			assignmentUserResultsThumbTopPx = 0;
			return;
		}

		const railHeight = assignmentUserResultsRailEl?.clientHeight ?? Math.max(clientHeight - 16, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		assignmentUserResultsThumbHeightPx = nextThumbHeight;
		assignmentUserResultsThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onAssignmentUserResultsScroll() {
		if (!isDraggingAssignmentUserResultsScrollbar) {
			updateAssignmentUserResultsScrollbar();
		}
	}

	function onAssignmentUserResultsDragMove(event: MouseEvent) {
		if (
			!isDraggingAssignmentUserResultsScrollbar ||
			!assignmentUserResultsEl ||
			!assignmentUserResultsRailEl
		)
			return;

		const railHeight = assignmentUserResultsRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - assignmentUserResultsThumbHeightPx, 0);
		const nextThumbTop = clamp(
			assignmentUserResultsDragStartThumbTopPx + (event.clientY - assignmentUserResultsDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(
			assignmentUserResultsEl.scrollHeight - assignmentUserResultsEl.clientHeight,
			0
		);

		assignmentUserResultsThumbTopPx = nextThumbTop;
		assignmentUserResultsEl.scrollTop =
			maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopAssignmentUserResultsDragging() {
		if (isDraggingAssignmentUserResultsScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingAssignmentUserResultsScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onAssignmentUserResultsDragMove);
			window.removeEventListener('mouseup', stopAssignmentUserResultsDragging);
		}
	}

	function startAssignmentUserResultsThumbDrag(event: MouseEvent) {
		if (!showAssignmentUserResultsScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingAssignmentUserResultsScrollbar = true;
		setGlobalScrollbarDragging(true);
		assignmentUserResultsDragStartY = event.clientY;
		assignmentUserResultsDragStartThumbTopPx = assignmentUserResultsThumbTopPx;
		window.addEventListener('mousemove', onAssignmentUserResultsDragMove);
		window.addEventListener('mouseup', stopAssignmentUserResultsDragging);
	}

	function handleAssignmentUserResultsRailClick(event: MouseEvent) {
		if (
			!assignmentUserResultsEl ||
			!assignmentUserResultsRailEl ||
			!showAssignmentUserResultsScrollbar
		)
			return;
		if (event.target !== assignmentUserResultsRailEl) return;

		const rect = assignmentUserResultsRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - assignmentUserResultsThumbHeightPx / 2,
			0,
			Math.max(rect.height - assignmentUserResultsThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - assignmentUserResultsThumbHeightPx, 1);
		const maxScrollTop = Math.max(
			assignmentUserResultsEl.scrollHeight - assignmentUserResultsEl.clientHeight,
			0
		);
		assignmentUserResultsEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateAssignmentUserResultsScrollbar();
	}

	async function handleSaveAssignment() {
		assignmentActionError = '';
		if (assignmentActionLoading) return;
		const userOid = assignmentUserOid.trim();
		const shiftId = assignmentShiftId.trim();
		const startDate = assignmentStartDate.trim();
		const endDate = assignmentEndDate.trim();
		if (!userOid) {
			assignmentActionError = 'Select a user.';
			return;
		}
		if (!shiftId) {
			assignmentActionError = 'Select a shift.';
			return;
		}
		if (!isValidDate(startDate)) {
			assignmentActionError = 'Start date must be in YYYY-MM-DD format.';
			return;
		}
		if (endDate && !isValidDate(endDate)) {
			assignmentActionError = 'End date must be in YYYY-MM-DD format.';
			return;
		}
		if (endDate && endDate < startDate) {
			assignmentActionError = 'End date must be on or after start date.';
			return;
		}
		const isEdit = assignmentsViewMode === 'edit';
		const expectedTimelineVersionStamp = isEdit
			? (
					selectedAssignmentForEdit?.timelineVersionStamp ??
					selectedAssignmentForEdit?.versionStamp ??
					''
				).trim()
			: '';
		if (isEdit && !expectedTimelineVersionStamp) {
			assignmentActionError = 'This assignment is out of date. Refresh and try again.';
			return;
		}
		const expectedChangeVersionStamp = isEditingAssignmentHistoryEntry
			? editingAssignmentHistoryVersionStamp.trim()
			: '';
		if (isEditingAssignmentHistoryEntry && !expectedChangeVersionStamp) {
			assignmentActionError = 'This assignment change is out of date. Refresh and try again.';
			return;
		}

		const submitAssignment = async (confirmShiftChange: boolean | null): Promise<Response | null> =>
			fetchWithAuthRedirect(`${base}/api/team/assignments`, {
				method: assignmentsViewMode === 'edit' ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userOid,
					shiftId: Number(shiftId),
					startDate,
					endDate: endDate || null,
					editMode: isEditingAssignmentHistoryEntry ? 'history' : 'timeline',
					changeStartDate: isEditingAssignmentHistoryEntry
						? editingAssignmentHistoryStartDate
						: null,
					expectedTimelineVersionStamp: isEdit ? expectedTimelineVersionStamp : null,
					expectedChangeVersionStamp: isEditingAssignmentHistoryEntry
						? expectedChangeVersionStamp
						: null,
					confirmShiftChange
				})
			});

		assignmentActionLoading = true;
		try {
			let result = await submitAssignment(null);
			if (!result) return;
			if (!result.ok) {
				const { text, payload } = await parseApiPayload<AssignmentOverlapApiPayload>(result);
				if (result.status === 409 && payload?.code === 'ASSIGNMENT_OVERLAP_CONFIRMATION') {
					const decision = await promptAssignmentOverlapDecision(payload);
					if (decision === 'cancel') return;
					result = await submitAssignment(decision === 'yes');
					if (!result) return;
					if (!result.ok) {
						throw new Error(await parseErrorMessage(result, 'Failed to save assignment'));
					}
				} else if (payload?.message?.trim()) {
					throw new Error(payload.message.trim());
				} else if (text) {
					throw new Error(text);
				} else {
					throw new Error('Failed to save assignment');
				}
			}
			await refreshDependenciesAfterMutation(['assignments', 'schedule']);
			resetAssignmentsPane({ preserveListShiftSelection: true });
		} catch (error) {
			assignmentActionError = error instanceof Error ? error.message : 'Failed to save assignment';
		} finally {
			assignmentActionLoading = false;
		}
	}

	async function handleRemoveAssignment() {
		assignmentActionError = '';
		if (assignmentActionLoading || !selectedAssignmentForEdit) return;
		const expectedTimelineVersionStamp = (
			selectedAssignmentForEdit.timelineVersionStamp ??
			selectedAssignmentForEdit.versionStamp ??
			''
		).trim();
		if (!expectedTimelineVersionStamp) {
			assignmentActionError = 'This assignment is out of date. Refresh and try again.';
			return;
		}
		const targetChangeStartDate = isEditingAssignmentHistoryEntry
			? editingAssignmentHistoryStartDate.trim()
			: selectedAssignmentForEdit.startDate.trim();
		if (!isValidDate(targetChangeStartDate)) {
			assignmentActionError = 'This assignment change is out of date. Refresh and try again.';
			return;
		}
		const expectedChangeVersionStamp = isEditingAssignmentHistoryEntry
			? editingAssignmentHistoryVersionStamp.trim()
			: (selectedAssignmentForEdit.versionStamp ?? '').trim();
		if (!expectedChangeVersionStamp) {
			assignmentActionError = 'This assignment change is out of date. Refresh and try again.';
			return;
		}

		assignmentActionLoading = true;
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/assignments`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userOid: selectedAssignmentForEdit.userOid,
					editMode: 'history',
					changeStartDate: targetChangeStartDate,
					expectedTimelineVersionStamp,
					expectedChangeVersionStamp
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to remove assignment'));
			}
			await refreshDependenciesAfterMutation(['assignments', 'schedule']);
			resetAssignmentsPane({ preserveListShiftSelection: true });
		} catch (error) {
			assignmentActionError =
				error instanceof Error ? error.message : 'Failed to remove assignment';
		} finally {
			assignmentActionLoading = false;
		}
	}

	function resetPatternsPane() {
		patternsViewMode = 'list';
		editingPatternId = null;
		editingPatternVersionStamp = '';
		addPatternName = '';
		addPatternActionError = '';
		addPatternActionLoading = false;
		patternDayAssignments = Array.from({ length: 28 }, () => -1);
		patternColors = [defaultPatternColor];
		activePatternColorIndex = 0;
		noShiftModeActive = false;
		patternColorPickerEls = [];
	}

	function openAddPatternView() {
		editingPatternId = null;
		editingPatternVersionStamp = '';
		addPatternName = '';
		addPatternActionError = '';
		addPatternActionLoading = false;
		patternDayAssignments = Array.from({ length: 28 }, () => -1);
		patternColors = [defaultPatternColor];
		activePatternColorIndex = 0;
		noShiftModeActive = false;
		patternColorPickerEls = [];
		patternsViewMode = 'add';
	}

	function openEditPatternView(pattern: PatternListRow) {
		editingPatternId = pattern.patternId;
		editingPatternVersionStamp = pattern.versionStamp ?? '';
		addPatternName = pattern.name;
		addPatternActionError = '';
		addPatternActionLoading = false;
		patternDayAssignments = Array.from({ length: 28 }, () => -1);
		const orderedSwatches = [...pattern.swatches].sort((a, b) => a.swatchIndex - b.swatchIndex);
		patternColors = orderedSwatches.map((swatch) => swatch.color);
		if (patternColors.length === 0) {
			patternColors = [defaultPatternColor];
		}
		if (patternColors.length > maxPatternSwatches) {
			patternColors = patternColors.slice(0, maxPatternSwatches);
		}
		for (const swatch of orderedSwatches) {
			if (swatch.swatchIndex < 0 || swatch.swatchIndex >= maxPatternSwatches) continue;
			for (const day of swatch.onDays) {
				if (!Number.isInteger(day) || day < 1 || day > patternEditorDays.length) continue;
				patternDayAssignments[day - 1] = swatch.swatchIndex;
			}
		}
		for (const day of pattern.noShiftDays) {
			if (!Number.isInteger(day) || day < 1 || day > patternEditorDays.length) continue;
			patternDayAssignments[day - 1] = noShiftOwner;
		}
		activePatternColorIndex = 0;
		noShiftModeActive = false;
		patternColorPickerEls = [];
		patternsViewMode = 'edit';
	}

	function togglePatternDay(index: number) {
		if (noShiftModeActive) {
			patternDayAssignments = patternDayAssignments.map((ownerIndex, currentIndex) => {
				if (currentIndex !== index) return ownerIndex;
				if (ownerIndex === noShiftOwner) return -1;
				return noShiftOwner;
			});
			return;
		}
		patternDayAssignments = patternDayAssignments.map((ownerIndex, currentIndex) => {
			if (currentIndex !== index) return ownerIndex;
			if (ownerIndex === activePatternColorIndex) return -1;
			return activePatternColorIndex;
		});
	}

	function ownerIndexForDay(dayIndex: number): number {
		return patternDayAssignments[dayIndex];
	}

	function isPatternDaySelected(dayIndex: number): boolean {
		return patternDayAssignments[dayIndex] !== -1;
	}

	function isPatternDayOwnedByActive(dayIndex: number): boolean {
		if (noShiftModeActive) return patternDayAssignments[dayIndex] === noShiftOwner;
		return patternDayAssignments[dayIndex] === activePatternColorIndex;
	}

	function buildSimplePatternPrediction(selectedOnDays: number[]): PredictionModel | null {
		if (selectedOnDays.length < 2) return null;
		const sorted = [...selectedOnDays].sort((a, b) => a - b);
		const runs: number[][] = [];
		let currentRun = [sorted[0]];
		for (let index = 1; index < sorted.length; index += 1) {
			const day = sorted[index];
			if (day === currentRun[currentRun.length - 1] + 1) {
				currentRun.push(day);
				continue;
			}
			runs.push(currentRun);
			currentRun = [day];
		}
		runs.push(currentRun);
		if (runs.length < 2) return null;

		let bestModel: PredictionModel | null = null;
		let bestScore = -1;

		for (let index = 0; index < runs.length - 1; index += 1) {
			const firstRun = runs[index];
			const secondRun = runs[index + 1];
			const offDays = secondRun[0] - firstRun[firstRun.length - 1] - 1;
			if (offDays <= 0) continue;

			// Allow partial leading/trailing runs by taking the larger adjacent run length.
			const onDays = Math.max(firstRun.length, secondRun.length);
			if (onDays <= 0) continue;

			const cycleLength = onDays + offDays;
			const anchor = secondRun[0];
			const predictedOn = new Set<number>();
			for (const day of patternEditorDays) {
				const offset = day - anchor;
				const cycleIndex = ((offset % cycleLength) + cycleLength) % cycleLength;
				if (cycleIndex < onDays) {
					predictedOn.add(day);
				}
			}

			let valid = true;
			for (const selectedDay of sorted) {
				if (!predictedOn.has(selectedDay)) {
					valid = false;
					break;
				}
			}
			if (!valid) continue;

			const score = firstRun.length + secondRun.length;
			if (score > bestScore) {
				bestScore = score;
				bestModel = { onDays, offDays, anchor, predictedOn };
			}
		}

		return bestModel;
	}

	function buildPredictionSummary(
		activePrediction: PredictionModel | null,
		predictionsBySwatch: Array<PredictionModel | null>
	): PredictionSummary | null {
		if (!activePrediction) return null;
		const validPredictions = predictionsBySwatch.filter(
			(prediction): prediction is PredictionModel => prediction !== null
		);
		const shiftCount = validPredictions.length;
		if (shiftCount <= 1) {
			return {
				shiftCount: 1,
				onDays: activePrediction.onDays,
				offDays: activePrediction.offDays
			};
		}

		const combinedPredictedOn = new Set<number>();
		for (const prediction of validPredictions) {
			for (const day of prediction.predictedOn) {
				combinedPredictedOn.add(day);
			}
		}

		const coverage = patternEditorDays.map((day) => combinedPredictedOn.has(day));
		if (coverage.every((value) => value)) {
			return {
				shiftCount,
				onDays: null,
				offDays: null
			};
		}
		const transitionStart = coverage.findIndex(
			(value, index) => value !== coverage[(index + coverage.length - 1) % coverage.length]
		);
		if (transitionStart === -1) {
			return {
				shiftCount,
				onDays: null,
				offDays: null
			};
		}

		const runs: Array<{ on: boolean; length: number }> = [];
		let current = coverage[transitionStart];
		let length = 0;
		for (let step = 0; step < coverage.length; step += 1) {
			const value = coverage[(transitionStart + step) % coverage.length];
			if (value === current) {
				length += 1;
				continue;
			}
			runs.push({ on: current, length });
			current = value;
			length = 1;
		}
		runs.push({ on: current, length });

		const onRunLengths = runs.filter((run) => run.on).map((run) => run.length);
		const offRunLengths = runs.filter((run) => !run.on).map((run) => run.length);
		if (onRunLengths.length === 0 || offRunLengths.length === 0) {
			return {
				shiftCount,
				onDays: null,
				offDays: null
			};
		}
		const mostFrequent = (values: number[]): number => {
			if (values.length === 0) return 0;
			const counts = new Map<number, number>();
			for (const value of values) {
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			let bestValue = values[0];
			let bestCount = counts.get(bestValue) ?? 0;
			for (const [value, count] of counts.entries()) {
				if (count > bestCount) {
					bestValue = value;
					bestCount = count;
				}
			}
			return bestValue;
		};

		return {
			shiftCount,
			onDays: mostFrequent(onRunLengths),
			offDays: mostFrequent(offRunLengths)
		};
	}

	function hexToRgb(color: string): { r: number; g: number; b: number } {
		const hex = color.replace('#', '');
		const normalized =
			hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
		const value = Number.parseInt(normalized, 16);
		return {
			r: (value >> 16) & 255,
			g: (value >> 8) & 255,
			b: value & 255
		};
	}

	function colorVarsForSwatch(index: number): {
		color: string;
		rgb: string;
		border: string;
		strongTop: string;
		strongBottom: string;
		lightTop: string;
		lightBottom: string;
	} {
		const color = patternColors[index] ?? defaultPatternColor;
		const rgb = hexToRgb(color);
		return {
			color,
			rgb: `${rgb.r}, ${rgb.g}, ${rgb.b}`,
			border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .62)`,
			strongTop: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .46)`,
			strongBottom: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .26)`,
			lightTop: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .24)`,
			lightBottom: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .14)`
		};
	}

	function applyPatternSwatchCssVars() {
		if (!patternEditorCardEl) return;
		for (let index = 0; index < maxPatternSwatches; index += 1) {
			const swatchIndex = index + 1;
			const vars = colorVarsForSwatch(index);
			patternEditorCardEl.style.setProperty(`--swatch-${swatchIndex}-color`, vars.color);
			patternEditorCardEl.style.setProperty(`--swatch-${swatchIndex}-rgb`, vars.rgb);
			patternEditorCardEl.style.setProperty(`--swatch-${swatchIndex}-border`, vars.border);
			patternEditorCardEl.style.setProperty(`--swatch-${swatchIndex}-strong-top`, vars.strongTop);
			patternEditorCardEl.style.setProperty(
				`--swatch-${swatchIndex}-strong-bottom`,
				vars.strongBottom
			);
			patternEditorCardEl.style.setProperty(`--swatch-${swatchIndex}-light-top`, vars.lightTop);
			patternEditorCardEl.style.setProperty(
				`--swatch-${swatchIndex}-light-bottom`,
				vars.lightBottom
			);
		}
	}

	function openPatternColorPicker(index: number) {
		patternColorPickerEls[index]?.openPicker();
	}

	function onPatternSwatchClick(index: number) {
		if (noShiftModeActive) {
			noShiftModeActive = false;
			activePatternColorIndex = index;
			return;
		}
		if (activePatternColorIndex !== index) {
			activePatternColorIndex = index;
			return;
		}
		openPatternColorPicker(index);
	}

	function activateNoShiftMode() {
		noShiftModeActive = true;
	}

	function updatePatternColor(index: number, nextColor: string) {
		patternColors = patternColors.map((color, colorIndex) =>
			colorIndex === index ? nextColor : color
		);
		activePatternColorIndex = index;
	}

	function nextUnusedPatternColor(): string {
		const used = new Set(patternColors.map((color) => color.toLowerCase()));
		for (const color of patternColorSeedPalette) {
			if (!used.has(color.toLowerCase())) return color;
		}
		for (let hue = 0; hue < 360; hue += 29) {
			const saturation = 90;
			const lightness = 50;
			const chroma = (1 - Math.abs((2 * lightness) / 100 - 1)) * (saturation / 100);
			const sector = hue / 60;
			const x = chroma * (1 - Math.abs((sector % 2) - 1));
			let [r1, g1, b1] = [0, 0, 0];
			if (sector >= 0 && sector < 1) [r1, g1, b1] = [chroma, x, 0];
			else if (sector < 2) [r1, g1, b1] = [x, chroma, 0];
			else if (sector < 3) [r1, g1, b1] = [0, chroma, x];
			else if (sector < 4) [r1, g1, b1] = [0, x, chroma];
			else if (sector < 5) [r1, g1, b1] = [x, 0, chroma];
			else [r1, g1, b1] = [chroma, 0, x];
			const m = lightness / 100 - chroma / 2;
			const rgb = [r1, g1, b1].map((value) => Math.round((value + m) * 255));
			const hex =
				`#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`.toLowerCase();
			if (!used.has(hex)) return hex;
		}
		return '#3b82f6';
	}

	async function addPatternColor() {
		if (patternColors.length >= maxPatternSwatches) return;
		const color = nextUnusedPatternColor();
		patternColors = [...patternColors, color];
		activePatternColorIndex = patternColors.length - 1;
	}

	function removePatternColor(index: number) {
		if (patternColors.length <= 1) return;

		// Pass 1: clear all days owned by the removed swatch.
		const clearedAssignments = patternDayAssignments.map((ownerIndex) =>
			ownerIndex === index ? -1 : ownerIndex
		);

		// Pass 2: shift ownership down for swatches above the removed index.
		const shiftedAssignments = clearedAssignments.map((ownerIndex) =>
			ownerIndex > index ? ownerIndex - 1 : ownerIndex
		);

		patternDayAssignments = shiftedAssignments;
		patternColors = patternColors.filter((_, colorIndex) => colorIndex !== index);
		// Keep refs aligned with Svelte's unkeyed each-block DOM reuse.
		// Removing by index can preserve a detached node reference at position 0.
		patternColorPickerEls = patternColorPickerEls.slice(0, patternColors.length);

		if (activePatternColorIndex > index) {
			activePatternColorIndex -= 1;
			return;
		}
		if (activePatternColorIndex === index) {
			activePatternColorIndex = Math.max(0, index - 1);
		}
	}

	async function loadPatterns() {
		patternsLoading = true;
		patternsError = '';
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/patterns`, { method: 'GET' });
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to load patterns'));
			}
			const data = (await result.json()) as {
				patterns?: Array<{
					patternId: number;
					name: string;
					versionStamp?: string;
					summary?: string | null;
					swatches?: PatternSwatch[] | null;
					noShiftDays?: number[] | null;
					isInUse?: boolean | null;
					isActivelyInUse?: boolean | null;
					hasAnyUsage?: boolean | null;
				}>;
			};
			patterns = (data.patterns ?? []).map((item) => ({
				patternId: item.patternId,
				name: item.name,
				summary: item.summary?.trim() || '0 shifts',
				swatches:
					Array.isArray(item.swatches) && item.swatches.length <= maxPatternSwatches
						? [...item.swatches]
								.filter(
									(swatch) =>
										Number.isInteger(swatch.swatchIndex) &&
										swatch.swatchIndex >= 0 &&
										swatch.swatchIndex < maxPatternSwatches
								)
								.sort((a, b) => a.swatchIndex - b.swatchIndex)
						: [],
				noShiftDays: Array.isArray(item.noShiftDays)
					? Array.from(
							new Set(
								item.noShiftDays
									.map((day) => Number(day))
									.filter(
										(day) => Number.isInteger(day) && day >= 1 && day <= patternEditorDays.length
									)
							)
						).sort((a, b) => a - b)
					: [],
				isInUse: item.isInUse === true,
				isActivelyInUse: item.isActivelyInUse === true,
				hasAnyUsage: item.hasAnyUsage === true,
				versionStamp: item.versionStamp
			}));
		} catch (error) {
			patternsError = error instanceof Error ? error.message : 'Failed to load patterns';
		} finally {
			patternsLoading = false;
		}
	}

	type RemovePatternErrorPayload = {
		message?: string;
		code?: string;
		activeShiftUsageCount?: number;
	};

	async function parseRemovePatternError(response: Response): Promise<RemovePatternErrorPayload> {
		let text = '';
		try {
			text = (await response.text()).trim();
		} catch {
			return {};
		}
		if (!text) return {};
		try {
			return JSON.parse(text) as RemovePatternErrorPayload;
		} catch {
			return { message: text };
		}
	}

	async function handleRemovePattern() {
		addPatternActionError = '';
		if (addPatternActionLoading || editingPatternId === null) return;
		const expectedVersionStamp = editingPatternVersionStamp.trim();
		if (!expectedVersionStamp) {
			addPatternActionError = 'This pattern is out of date. Refresh and try again.';
			return;
		}

		addPatternActionLoading = true;
		try {
			let result = await fetchWithAuthRedirect(`${base}/api/team/patterns`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ patternId: editingPatternId, expectedVersionStamp })
			});
			if (!result) return;

			if (result.status === 409) {
				const apiError = await parseRemovePatternError(result);
				if (apiError.code === 'PATTERN_ACTIVE_IN_USE') {
					const activeCount = Number(apiError.activeShiftUsageCount ?? 0);
					const message =
						activeCount > 0
							? `This pattern is currently assigned to ${activeCount} active ${
									activeCount === 1 ? 'shift' : 'shifts'
								}. If you continue, active shifts using this pattern will be switched to Unassigned effective today. Continue?`
							: 'This pattern is currently assigned to active shifts. If you continue, active shifts using this pattern will be switched to Unassigned effective today. Continue?';
					const confirmChoice = await openConfirmDialog({
						title: 'Remove Pattern?',
						message,
						options: [
							{ id: 'cancel', label: 'Cancel' },
							{ id: 'continue', label: 'Continue', tone: 'danger' }
						],
						cancelOptionId: 'cancel'
					});
					if (confirmChoice !== 'continue') {
						addPatternActionError = 'Pattern removal canceled.';
						return;
					}

					result = await fetchWithAuthRedirect(`${base}/api/team/patterns`, {
						method: 'DELETE',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							patternId: editingPatternId,
							confirmActiveRemoval: true,
							expectedVersionStamp
						})
					});
					if (!result) return;
				}
			}

			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to remove pattern'));
			}
			await refreshDependenciesAfterMutation(['patterns', 'shifts', 'schedule']);
			resetPatternsPane();
		} catch (error) {
			addPatternActionError = error instanceof Error ? error.message : 'Failed to remove pattern';
		} finally {
			addPatternActionLoading = false;
		}
	}

	function compiledPatternSwatches(): PatternSwatch[] {
		return patternColors.map((color, swatchIndex) => ({
			swatchIndex,
			color: (color ?? patternColorSeedPalette[swatchIndex] ?? defaultPatternColor).toLowerCase(),
			onDays: patternEditorDays.filter(
				(_, dayIndex) => patternDayAssignments[dayIndex] === swatchIndex
			)
		}));
	}

	function compiledNoShiftDays(): number[] {
		return patternEditorDays.filter(
			(_, dayIndex) => patternDayAssignments[dayIndex] === noShiftOwner
		);
	}

	function isPatternNameTaken(name: string): boolean {
		const normalizedName = name.trim().toLowerCase();
		if (!normalizedName) return false;
		return patterns.some((pattern) => {
			if (editingPatternId !== null && pattern.patternId === editingPatternId) return false;
			return pattern.name.trim().toLowerCase() === normalizedName;
		});
	}

	async function handleSavePattern() {
		addPatternActionError = '';
		if (addPatternActionLoading) return;
		if (patternHasPredictionConflict) {
			addPatternActionError = 'Conflicting schedules';
			return;
		}
		const name = addPatternName.trim();
		if (!name) {
			addPatternActionError = 'Pattern name is required.';
			return;
		}
		if (isPatternNameTaken(name)) {
			addPatternActionError = 'A pattern with this name already exists in this schedule.';
			return;
		}
		const swatches = compiledPatternSwatches();
		const noShiftDays = compiledNoShiftDays();
		const hasAnyOnDay = swatches.some((swatch) => swatch.onDays.length > 0);
		if (!hasAnyOnDay) {
			addPatternActionError = 'Select at least one on-shift day.';
			return;
		}

		addPatternActionLoading = true;
		try {
			const isEdit = patternsViewMode === 'edit' && editingPatternId !== null;
			const expectedVersionStamp = isEdit ? editingPatternVersionStamp.trim() : '';
			if (isEdit && !expectedVersionStamp) {
				addPatternActionError = 'This pattern is out of date. Refresh and try again.';
				return;
			}
			const result = await fetchWithAuthRedirect(`${base}/api/team/patterns`, {
				method: isEdit ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					patternId: editingPatternId,
					name,
					swatches,
					noShiftDays,
					expectedVersionStamp: isEdit ? expectedVersionStamp : null
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to save pattern'));
			}
			await refreshDependenciesAfterMutation(['patterns', 'shifts', 'schedule']);
			resetPatternsPane();
		} catch (error) {
			addPatternActionError = error instanceof Error ? error.message : 'Failed to save pattern';
		} finally {
			addPatternActionLoading = false;
		}
	}

	function toggleSort(nextKey: SortKey) {
		if (sortKey === nextKey) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
			return;
		}
		sortKey = nextKey;
		sortDirection = 'asc';
	}

	function ariaSortFor(key: SortKey): 'none' | 'ascending' | 'descending' {
		if (sortKey !== key) return 'none';
		return sortDirection === 'asc' ? 'ascending' : 'descending';
	}

	function toComparableValue(user: AccessUser, key: SortKey): string {
		if (key === 'name') return user.name;
		if (key === 'email') return user.email;
		return user.role;
	}

	function displayColumnValue(user: AccessUser): string {
		const displayName = user.displayName?.trim() ?? '';
		if (!displayName) return 'Unchanged';
		return displayName === user.name.trim() ? 'Unchanged' : displayName;
	}

	function rolePrivilegeRank(role: UserRole): number {
		if (role === 'Manager') return 0;
		if (role === 'Maintainer') return 1;
		return 2;
	}

	function toggleShiftSort(nextKey: ShiftSortKey) {
		if (shiftSortKey === nextKey) {
			shiftSortDirection = shiftSortDirection === 'asc' ? 'desc' : 'asc';
			return;
		}
		shiftSortKey = nextKey;
		shiftSortDirection = 'asc';
	}

	function ariaSortForShift(key: ShiftSortKey): 'none' | 'ascending' | 'descending' {
		if (shiftSortKey !== key) return 'none';
		return shiftSortDirection === 'asc' ? 'ascending' : 'descending';
	}

	function toComparableShiftValue(shift: ShiftRow, key: ShiftSortKey): string {
		if (key === 'order') return String(shift.sortOrder).padStart(6, '0');
		if (key === 'name') return shift.name;
		if (key === 'pattern') return shift.pattern;
		return shift.startDate;
	}

	function toggleShiftDetails(employeeTypeId: number) {
		console.log('[TeamSetupModal] toggleShiftDetails called', {
			employeeTypeId,
			wasExpanded: expandedShiftRows.has(employeeTypeId),
			sizeBefore: expandedShiftRows.size
		});
		const next = new Set(expandedShiftRows);
		if (next.has(employeeTypeId)) {
			next.delete(employeeTypeId);
		} else {
			next.add(employeeTypeId);
		}
		expandedShiftRows = next;
		console.log('[TeamSetupModal] toggleShiftDetails applied', {
			employeeTypeId,
			isExpandedNow: expandedShiftRows.has(employeeTypeId),
			sizeAfter: expandedShiftRows.size
		});
	}

	function toggleAssignmentDetails(assignmentId: string) {
		const next = new Set(expandedAssignmentRows);
		if (next.has(assignmentId)) {
			next.delete(assignmentId);
		} else {
			next.add(assignmentId);
		}
		expandedAssignmentRows = next;
	}

	function assignmentReorderOrderedIds(sourceId: string, beforeId: string | null): string[] {
		const current = assignmentRowsForActiveShift.map((assignment) => assignment.assignmentId);
		const withoutSource = current.filter((assignmentId) => assignmentId !== sourceId);
		if (beforeId === null) {
			withoutSource.push(sourceId);
			return withoutSource;
		}
		const insertIndex = withoutSource.findIndex((assignmentId) => assignmentId === beforeId);
		if (insertIndex < 0) {
			withoutSource.push(sourceId);
			return withoutSource;
		}
		withoutSource.splice(insertIndex, 0, sourceId);
		return withoutSource;
	}

	function assignmentReorderGroups(): HTMLTableSectionElement[] {
		if (!assignmentsTableEl) return [];
		return Array.from(
			assignmentsTableEl.querySelectorAll('tbody[data-assignment-group-id]')
		).filter((group): group is HTMLTableSectionElement => group instanceof HTMLTableSectionElement);
	}

	function assignmentIdFromGroup(group: HTMLTableSectionElement | null): string | null {
		if (!group) return null;
		const raw = group.dataset.assignmentGroupId;
		return raw?.trim() ? raw : null;
	}

	function assignmentReorderBeforeId(pointerY: number, movingDown: boolean): string | null {
		if (!assignmentReorderState) return null;
		const groups = assignmentReorderGroups().filter(
			(group) => assignmentIdFromGroup(group) !== assignmentReorderState?.sourceId
		);
		if (groups.length === 0) return null;

		const firstRect = groups[0].getBoundingClientRect();
		if (pointerY < firstRect.top) {
			return assignmentIdFromGroup(groups[0]);
		}

		for (let index = 0; index < groups.length; index += 1) {
			const group = groups[index];
			const rect = group.getBoundingClientRect();
			if (pointerY <= rect.bottom) {
				if (movingDown && pointerY > rect.top) {
					return assignmentIdFromGroup(groups[index + 1] ?? null) ?? null;
				}
				return assignmentIdFromGroup(group);
			}
		}
		return null;
	}

	function makeAssignmentReorderPlaceholderGroup(rowHeightPx: number): HTMLTableSectionElement {
		const tbody = document.createElement('tbody');
		tbody.className = 'shiftReorderPlaceholderGroup';
		const tr = document.createElement('tr');
		tr.className = 'shiftReorderPlaceholderRow';
		const td = document.createElement('td');
		td.colSpan = 6;
		td.innerHTML = `<div class="shiftReorderPlaceholderBox" style="--shift-ph-h:${Math.max(
			40,
			Math.round(rowHeightPx)
		)}px"></div>`;
		tr.appendChild(td);
		tbody.appendChild(tr);
		return tbody;
	}

	function moveAssignmentPlaceholder(beforeId: string | null) {
		if (!assignmentsTableEl || !assignmentReorderPlaceholderGroupEl) return;
		const beforeGroup =
			beforeId === null
				? null
				: (assignmentReorderGroups().find((group) => assignmentIdFromGroup(group) === beforeId) ??
					null);
		if (beforeGroup) {
			assignmentsTableEl.insertBefore(assignmentReorderPlaceholderGroupEl, beforeGroup);
			return;
		}
		assignmentsTableEl.appendChild(assignmentReorderPlaceholderGroupEl);
	}

	function assignmentReorderChanged(_sourceId: string, nextOrderedIds: string[]): boolean {
		const currentOrderedIds = assignmentRowsForActiveShift.map(
			(assignment) => assignment.assignmentId
		);
		if (currentOrderedIds.length !== nextOrderedIds.length) return false;
		return !arraysEqualString(currentOrderedIds, nextOrderedIds);
	}

	async function saveAssignmentReorder(
		sourceId: string,
		orderedAssignmentIds: string[]
	): Promise<void> {
		if (!assignmentSelectedShift) return;
		if (!assignmentReorderChanged(sourceId, orderedAssignmentIds)) return;
		const requestedMonth = assignmentsMonth.trim();
		if (!monthBounds(requestedMonth)) {
			assignmentRowsError = 'Selected month is invalid.';
			return;
		}
		assignmentRowsError = '';
		isAssignmentReorderLoading = true;
		assignmentReorderOptimisticOrder = {
			shiftId: assignmentSelectedShift.employeeTypeId,
			orderedIds: [...orderedAssignmentIds]
		};
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/assignments`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					reorderOnly: true,
					month: requestedMonth,
					shiftId: assignmentSelectedShift.employeeTypeId,
					orderedAssignmentIds
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to reorder assignments'));
			}
			await refreshDependenciesAfterMutation(['assignments', 'schedule']);
		} catch (error) {
			assignmentRowsError =
				error instanceof Error ? error.message : 'Failed to reorder assignments';
		} finally {
			isAssignmentReorderLoading = false;
			assignmentReorderOptimisticOrder = null;
		}
	}

	function stopAssignmentReorderListeners() {
		if (typeof window === 'undefined') return;
		window.removeEventListener('mousemove', handleAssignmentReorderMouseMove);
		window.removeEventListener('mouseup', handleAssignmentReorderMouseUp);
	}

	function startAssignmentReorderListeners() {
		if (typeof window === 'undefined') return;
		window.addEventListener('mousemove', handleAssignmentReorderMouseMove);
		window.addEventListener('mouseup', handleAssignmentReorderMouseUp);
	}

	function handleAssignmentReorderMouseMove(event: MouseEvent) {
		if (!assignmentReorderState) return;
		event.preventDefault();
		const { offsetX, offsetY } = assignmentReorderState;
		const x = event.clientX - offsetX;
		const y = event.clientY - offsetY;
		const deltaY = event.clientY - assignmentReorderState.lastPointerY;
		const movingDown =
			deltaY > 1 ? true : deltaY < -1 ? false : assignmentReorderState.movingDown;
		const nextBeforeId = assignmentReorderBeforeId(event.clientY, movingDown);
		assignmentReorderState = {
			...assignmentReorderState,
			lastPointerY: event.clientY,
			movingDown,
			currentBeforeId: nextBeforeId,
			ghostX: x,
			ghostY: y
		};
		moveAssignmentPlaceholder(nextBeforeId);
		applyAssignmentReorderGhostPosition(x, y, assignmentReorderState.ghostWidth);
	}

	async function stopAssignmentReorder(commit: boolean) {
		if (!assignmentReorderState) return;
		const state = assignmentReorderState;
		assignmentReorderState = null;
		stopAssignmentReorderListeners();
		document.body.classList.remove('teamShiftRowDragging');
		state.handle.blur();
		assignmentReorderPlaceholderGroupEl?.remove();
		assignmentReorderPlaceholderGroupEl = null;
		if (!commit || isAssignmentReorderLoading) return;
		const nextOrderedIds = assignmentReorderOrderedIds(state.sourceId, state.currentBeforeId);
		await saveAssignmentReorder(state.sourceId, nextOrderedIds);
	}

	function handleAssignmentReorderMouseUp(event: MouseEvent) {
		if (!assignmentReorderState) return;
		event.preventDefault();
		void stopAssignmentReorder(true);
	}

	function handleAssignmentReorderMouseDown(event: MouseEvent, assignment: AssignmentRow) {
		if (
			activeSection !== 'assignments' ||
			assignmentsViewMode !== 'list' ||
			isAssignmentReorderLoading ||
			!assignmentsTableEl
		) {
			return;
		}
		if (event.button !== 0) return;
		const handle = event.currentTarget as HTMLButtonElement | null;
		const row = handle?.closest('tr[data-assignment-id]') as HTMLTableRowElement | null;
		const group = row?.closest('tbody[data-assignment-group-id]') as HTMLTableSectionElement | null;
		if (!handle || !row || !group) return;
		event.preventDefault();
		if (assignmentReorderState) return;
		startAssignmentReorderListeners();
		const rowRect = row.getBoundingClientRect();
		const orderedIds = assignmentReorderGroups()
			.map((group) => assignmentIdFromGroup(group))
			.filter((id): id is string => id !== null);
		const sourceIndex = orderedIds.findIndex((id) => id === assignment.assignmentId);
		const initialBeforeId = sourceIndex >= 0 ? (orderedIds[sourceIndex + 1] ?? null) : null;
		document.body.classList.add('teamShiftRowDragging');
		assignmentReorderState = {
			sourceId: assignment.assignmentId,
			handle,
			offsetX: event.clientX - rowRect.left,
			offsetY: event.clientY - rowRect.top,
			lastPointerY: event.clientY,
			movingDown: true,
			currentBeforeId: initialBeforeId,
			ghostX: rowRect.left,
			ghostY: rowRect.top,
			ghostWidth:
				Math.round(assignmentsTableEl?.getBoundingClientRect().width ?? rowRect.width) ||
				rowRect.width,
			rowHeight: rowRect.height
		};
		assignmentReorderPlaceholderGroupEl = makeAssignmentReorderPlaceholderGroup(rowRect.height);
		if (assignmentsTableEl) {
			assignmentsTableEl.insertBefore(assignmentReorderPlaceholderGroupEl, group.nextSibling);
			moveAssignmentPlaceholder(initialBeforeId);
		}
	}

	function isAssignmentDropTarget(assignmentId: string): boolean {
		return (
			activeSection === 'assignments' &&
			assignmentsViewMode === 'list' &&
			assignmentReorderState !== null &&
			assignmentReorderState.currentBeforeId === assignmentId &&
			assignmentReorderState.sourceId !== assignmentId
		);
	}

	function assignmentReorderGhostStyle(): string {
		if (!assignmentReorderState) return '';
		return `width:${Math.round(assignmentReorderState.ghostWidth)}px;transform:translate(${Math.round(
			assignmentReorderState.ghostX
		)}px, ${Math.round(assignmentReorderState.ghostY)}px) rotate(0.3deg) scale(1.008);`;
	}

	function portalAssignmentGhostToBody(node: HTMLElement) {
		if (typeof document === 'undefined') return;
		document.body.appendChild(node);
		const state = assignmentReorderState;
		if (node instanceof HTMLDivElement && state) {
			assignmentReorderGhostEl = node;
			applyAssignmentReorderGhostPosition(state.ghostX, state.ghostY, state.ghostWidth);
		}
		return {
			destroy() {
				if (assignmentReorderGhostEl === node) {
					assignmentReorderGhostEl = null;
				}
				node.remove();
			}
		};
	}

	function hasShiftHistoryChanges(shift: ShiftRow): boolean {
		return shiftChangesForMonth(shift, shiftsMonth).length > 1;
	}

	function hasAssignmentHistoryChanges(assignment: AssignmentRow): boolean {
		return (assignment.changes?.length ?? 0) > 1;
	}

	function toggleEventCodeSort(nextKey: EventCodeSortKey) {
		if (eventCodeSortKey === nextKey) {
			eventCodeSortDirection = eventCodeSortDirection === 'asc' ? 'desc' : 'asc';
			return;
		}
		eventCodeSortKey = nextKey;
		eventCodeSortDirection = 'asc';
	}

	function ariaSortForEventCode(key: EventCodeSortKey): 'none' | 'ascending' | 'descending' {
		if (eventCodeSortKey !== key) return 'none';
		return eventCodeSortDirection === 'asc' ? 'ascending' : 'descending';
	}

	function toComparableEventCodeValue(eventCode: EventCodeRow, key: EventCodeSortKey): string {
		if (key === 'code') return eventCode.code;
		if (key === 'name') return eventCode.name;
		if (key === 'displayMode') return eventCode.displayMode;
		return eventCode.isActive ? '0' : '1';
	}

	function eventCodeIndicatorModeClass(displayMode: EventCodeDisplayMode): string {
		if (displayMode === 'Shift Override') return 'mode-shift-override';
		if (displayMode === 'Schedule Overlay') return 'mode-schedule-overlay';
		return 'mode-badge-indicator';
	}

	function resetModalState() {
		stopAddUserResultsDragging();
		usersViewMode = 'list';
		shiftsViewMode = 'list';
		patternsViewMode = 'list';
		eventCodesViewMode = 'list';
		assignmentsViewMode = 'list';
		selectedUserForEdit = null;
		selectedShiftForEdit = null;
		selectedAssignmentForEdit = null;
		selectedAddRole = 'Member';
		selectedEditRole = 'Member';
		sortKey = 'name';
		sortDirection = 'asc';
		shiftSortKey = 'order';
		shiftSortDirection = 'asc';
		eventCodeSortKey = 'code';
		eventCodeSortDirection = 'asc';
		addUserQuery = '';
		addUsers = [];
		addUsersError = '';
		addUsersLoading = false;
		showAddUserResults = false;
		resetAddUserResultsScrollbarState();
		addUserSelectionCommitted = false;
		selectedAddUser = null;
		addUserActionError = '';
		editUserActionError = '';
		addUserActionLoading = false;
		editUserActionLoading = false;
		addShiftName = '';
		addShiftSortOrder = '1';
		addShiftPatternId = '';
		addShiftStartDate = '';
		addShiftEndDate = '';
		shiftPatternPickerOpen = false;
		shiftStartDatePickerOpen = false;
		shiftEndDatePickerOpen = false;
		addShiftActionError = '';
		addShiftActionLoading = false;
		assignmentRows = [];
		assignmentRowsLoading = false;
		assignmentRowsError = '';
		eventCodeRows = [];
		eventCodeRowsLoading = false;
		eventCodeRowsError = '';
		selectedEventCodeForEdit = null;
		addEventCodeCode = '';
		addEventCodeName = '';
		addEventCodeDisplayMode = 'Schedule Overlay';
		addEventCodeColor = '#22c55e';
		addEventCodeIsActive = true;
		eventCodeDisplayModePickerOpen = false;
		eventCodeActionError = '';
		eventCodeActionLoading = false;
		assignmentUserOid = '';
		assignmentUserQuery = '';
		assignmentShiftId = '';
		assignmentStartDate = '';
		assignmentEndDate = '';
		assignmentUserResultsOpen = false;
		resetAssignmentUserResultsScrollbarState();
		assignmentsMonthPickerOpen = false;
		assignmentListShiftId = '';
		assignmentStartDatePickerOpen = false;
		assignmentEndDatePickerOpen = false;
		assignmentActionError = '';
		assignmentActionLoading = false;
		void stopAssignmentReorder(false);
		isAssignmentReorderLoading = false;
		assignmentReorderOptimisticOrder = null;
		expandedShiftRows = new Set();
		expandedAssignmentRows = new Set();
		editingShiftHistoryStartDate = '';
		editingAssignmentHistoryStartDate = '';
		isEditingShiftHistoryEntry = false;
		isEditingAssignmentHistoryEntry = false;
		addPatternName = '';
		addPatternActionError = '';
		addPatternActionLoading = false;
		editingPatternId = null;
		patternDayAssignments = Array.from({ length: 28 }, () => -1);
		patternColors = [defaultPatternColor];
		activePatternColorIndex = 0;
		noShiftModeActive = false;
		patternColorPickerEls = [];
		patterns = [];
		patternsLoading = false;
		patternsError = '';
		teamShifts = [];
		teamShiftsError = '';
		teamShiftsLoading = false;
		teamUsers = [];
		teamUsersError = '';
		teamUsersLoading = false;
		wasUsersListVisible = false;
		wasShiftsListVisible = false;
		wasPatternsListVisible = false;
		wasEventCodesListVisible = false;
		wasAssignmentsListVisible = false;
		if (addUserSearchTimer) {
			clearTimeout(addUserSearchTimer);
			addUserSearchTimer = null;
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

	type AssignmentOverlapApiPayload = {
		code?: string;
		message?: string;
		overlap?: {
			shiftId?: number;
			shiftName?: string;
			startDate?: string | null;
			endDate?: string | null;
			count?: number;
		};
	};

	async function parseApiPayload<T>(
		response: Response
	): Promise<{ text: string; payload: T | null }> {
		let text = '';
		try {
			text = (await response.text()).trim();
		} catch {
			return { text: '', payload: null };
		}
		if (!text) return { text: '', payload: null };
		try {
			return { text, payload: JSON.parse(text) as T };
		} catch {
			return { text, payload: null };
		}
	}

	type AssignmentOverlapDecision = 'yes' | 'no' | 'cancel';

	async function promptAssignmentOverlapDecision(
		payload: AssignmentOverlapApiPayload
	): Promise<AssignmentOverlapDecision> {
		const overlapShift = payload.overlap?.shiftName?.trim() || 'another shift';
		const overlapStart = payload.overlap?.startDate
			? formatDateForDisplay(payload.overlap.startDate)
			: '';
		const overlapEnd = payload.overlap?.endDate
			? formatDateForDisplay(payload.overlap.endDate)
			: 'Indefinite';
		const overlapWindow = overlapStart
			? `\nCurrent assignment window: ${overlapStart} - ${overlapEnd}`
			: '';
		const baseMessage =
			(payload.message?.trim() ||
				'This user is already assigned to another shift during that time period. Is this intended to be a shift change?') +
			`\n\nOverlapping shift: ${overlapShift}${overlapWindow}`;
		const choice = await openConfirmDialog({
			title: 'Confirm Shift Intent',
			message: baseMessage,
			options: [
				{ id: 'yes', label: 'Yes', tone: 'primary' },
				{ id: 'no', label: 'No' },
				{ id: 'cancel', label: 'Cancel' }
			],
			cancelOptionId: 'cancel'
		});
		return choice === 'yes' || choice === 'no' ? choice : 'cancel';
	}

	async function fetchWithAuthRedirect(
		input: RequestInfo | URL,
		init: RequestInit
	): Promise<Response | null> {
		return fetchWithAuthRedirectUtil(input, init, base);
	}

	function userLabel(user: EntraUser): string {
		const email = user.mail ?? user.userPrincipalName ?? '';
		const name = (user.displayName ?? '').trim();
		let formattedName = name;
		if (name) {
			if (name.includes(',')) {
				formattedName = name;
			} else {
				const parts = name.split(/\s+/);
				if (parts.length >= 2) {
					const last = parts.pop();
					const first = parts.join(' ');
					formattedName = `${last}, ${first}`;
				}
			}
		}
		if (formattedName && email) return `${formattedName} <${email}>`;
		return formattedName || email || user.id;
	}

	async function loadAddUsers(query = addUserQuery) {
		addUsersLoading = true;
		addUsersError = '';
		try {
			const queryParam = query ? `?q=${encodeURIComponent(query)}` : '';
			const result = await fetchWithAuthRedirect(`${base}/api/team/users${queryParam}`, {
				method: 'GET'
			});
			if (!result) return;
			if (!result.ok) {
				const text = await result.text();
				throw new Error(text || `Request failed: ${result.status}`);
			}
			const data = await result.json();
			addUsers = data.users ?? [];
		} catch (error) {
			addUsersError = error instanceof Error ? error.message : 'Failed to load users';
		} finally {
			addUsersLoading = false;
		}
	}

	async function loadTeamUsers() {
		teamUsersLoading = true;
		teamUsersError = '';
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/users`, { method: 'GET' });
			if (!result) return;
			if (!result.ok) {
				const text = await result.text();
				throw new Error(text || `Request failed: ${result.status}`);
			}
			const data = await result.json();
			teamUsers = data.users ?? [];
		} catch (error) {
			teamUsersError = error instanceof Error ? error.message : 'Failed to load team users';
		} finally {
			teamUsersLoading = false;
		}
	}

	async function loadTeamShifts(monthValue: string = shiftsMonth) {
		teamShiftsLoading = true;
		teamShiftsError = '';
		try {
			const shifts = await fetchTeamShiftsSnapshot(monthValue);
			if (!shifts) return;
			teamShifts = shifts;
			expandedShiftRows = new Set();
		} catch (error) {
			teamShiftsError = error instanceof Error ? error.message : 'Failed to load shifts';
		} finally {
			teamShiftsLoading = false;
		}
	}

	async function loadAssignmentRows(monthValue: string = assignmentsMonth) {
		assignmentRowsLoading = true;
		assignmentRowsError = '';
		try {
			const requestedMonth = monthValue.trim();
			if (!monthBounds(requestedMonth)) {
				throw new Error('Selected month is invalid.');
			}
			const monthQuery = `?month=${encodeURIComponent(requestedMonth)}`;
			const result = await fetchWithAuthRedirect(`${base}/api/team/assignments${monthQuery}`, {
				method: 'GET'
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to load assignments'));
			}
			const data = await result.json();
			assignmentRows = Array.isArray(data.assignments)
				? data.assignments.map((assignment: AssignmentRow, index: number) => ({
						...assignment,
						sortOrder: Number(assignment.sortOrder ?? index + 1)
					}))
				: [];
			expandedAssignmentRows = new Set();
		} catch (error) {
			assignmentRowsError = error instanceof Error ? error.message : 'Failed to load assignments';
		} finally {
			assignmentRowsLoading = false;
		}
	}

	function onAddUserQueryInput(event: Event) {
		const target = event.target as HTMLInputElement;
		addUserQuery = target.value;
		addUserSelectionCommitted = false;
		selectedAddUser = null;
		addUserActionError = '';
		if (addUserSearchTimer) clearTimeout(addUserSearchTimer);
		addUserSearchTimer = setTimeout(() => {
			void loadAddUsers(addUserQuery);
		}, 300);
	}

	function onAddUserSelect(user: EntraUser) {
		addUserQuery = userLabel(user);
		addUserSelectionCommitted = true;
		selectedAddUser = user;
		addUserActionError = '';
		closeAddUserResults();
	}

	function closeAddUserResults() {
		stopAddUserResultsDragging();
		showAddUserResults = false;
		resetAddUserResultsScrollbarState();
	}

	function onAddUserComboMouseDown(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (target?.closest('.setupUserComboItem')) return;
		if (addUserSelectionCommitted) return;
		showAddUserResults = true;
		if (addUsers.length === 0 && addUserQuery.trim().length > 0) {
			void loadAddUsers(addUserQuery);
		}
	}

	function updateAddUserResultsScrollbar() {
		if (!addUserResultsEl) return;
		const scrollHeight = addUserResultsEl.scrollHeight;
		const clientHeight = addUserResultsEl.clientHeight;
		const scrollTop = addUserResultsEl.scrollTop;
		const hasOverflow = scrollHeight > clientHeight + 1;

		showAddUserResultsScrollbar = hasOverflow;
		if (!hasOverflow) {
			addUserResultsThumbHeightPx = 0;
			addUserResultsThumbTopPx = 0;
			return;
		}

		const railHeight = addUserResultsRailEl?.clientHeight ?? Math.max(clientHeight - 16, 0);
		if (railHeight <= 0) return;

		const minThumbHeight = 36;
		const nextThumbHeight = Math.max(minThumbHeight, (railHeight * clientHeight) / scrollHeight);
		const maxThumbTop = Math.max(railHeight - nextThumbHeight, 0);
		const maxScrollTop = Math.max(scrollHeight - clientHeight, 1);
		const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop;

		addUserResultsThumbHeightPx = nextThumbHeight;
		addUserResultsThumbTopPx = clamp(nextThumbTop, 0, maxThumbTop);
	}

	function onAddUserResultsScroll() {
		if (!isDraggingAddUserResultsScrollbar) {
			updateAddUserResultsScrollbar();
		}
	}

	function onAddUserResultsDragMove(event: MouseEvent) {
		if (!isDraggingAddUserResultsScrollbar || !addUserResultsEl || !addUserResultsRailEl) return;

		const railHeight = addUserResultsRailEl.clientHeight;
		const maxThumbTop = Math.max(railHeight - addUserResultsThumbHeightPx, 0);
		const nextThumbTop = clamp(
			addUserResultsDragStartThumbTopPx + (event.clientY - addUserResultsDragStartY),
			0,
			maxThumbTop
		);
		const maxScrollTop = Math.max(addUserResultsEl.scrollHeight - addUserResultsEl.clientHeight, 0);

		addUserResultsThumbTopPx = nextThumbTop;
		addUserResultsEl.scrollTop = maxThumbTop > 0 ? (nextThumbTop / maxThumbTop) * maxScrollTop : 0;
	}

	function stopAddUserResultsDragging() {
		if (isDraggingAddUserResultsScrollbar) {
			setGlobalScrollbarDragging(false);
		}
		isDraggingAddUserResultsScrollbar = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onAddUserResultsDragMove);
			window.removeEventListener('mouseup', stopAddUserResultsDragging);
		}
	}

	function startAddUserResultsThumbDrag(event: MouseEvent) {
		if (!showAddUserResultsScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDraggingAddUserResultsScrollbar = true;
		setGlobalScrollbarDragging(true);
		addUserResultsDragStartY = event.clientY;
		addUserResultsDragStartThumbTopPx = addUserResultsThumbTopPx;
		window.addEventListener('mousemove', onAddUserResultsDragMove);
		window.addEventListener('mouseup', stopAddUserResultsDragging);
	}

	function handleAddUserResultsRailClick(event: MouseEvent) {
		if (!addUserResultsEl || !addUserResultsRailEl || !showAddUserResultsScrollbar) return;
		if (event.target !== addUserResultsRailEl) return;

		const rect = addUserResultsRailEl.getBoundingClientRect();
		const desiredTop = clamp(
			event.clientY - rect.top - addUserResultsThumbHeightPx / 2,
			0,
			Math.max(rect.height - addUserResultsThumbHeightPx, 0)
		);
		const maxThumbTop = Math.max(rect.height - addUserResultsThumbHeightPx, 1);
		const maxScrollTop = Math.max(addUserResultsEl.scrollHeight - addUserResultsEl.clientHeight, 0);
		addUserResultsEl.scrollTop = (desiredTop / maxThumbTop) * maxScrollTop;
		updateAddUserResultsScrollbar();
	}

	async function handleAddUser() {
		addUserActionError = '';
		if (addUserActionLoading) return;
		if (!selectedAddUser) {
			addUserActionError = 'Select a user from the list before adding.';
			return;
		}

		addUserActionLoading = true;
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/users`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userOid: selectedAddUser.id,
					name: selectedAddUser.displayName ?? null,
					givenName: selectedAddUser.givenName ?? null,
					surname: selectedAddUser.surname ?? null,
					email: selectedAddUser.mail ?? selectedAddUser.userPrincipalName ?? null,
					role: selectedAddRole
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to add user'));
			}
			await refreshDependenciesAfterMutation(['users', 'assignments', 'schedule']);
			resetUsersPane();
		} catch (error) {
			addUserActionError = error instanceof Error ? error.message : 'Failed to add user';
		} finally {
			addUserActionLoading = false;
		}
	}

	async function handleSaveUserEdit() {
		editUserActionError = '';
		if (editUserActionLoading || !selectedUserForEdit) return;
		const expectedVersionStamp = selectedUserForEdit.versionStamp?.trim() ?? '';
		if (!expectedVersionStamp) {
			editUserActionError = 'This user access entry is out of date. Refresh and try again.';
			return;
		}

		editUserActionLoading = true;
		try {
			const result = await fetchWithAuthRedirect(`${base}/api/team/users`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userOid: selectedUserForEdit.userOid,
					role: selectedEditRole,
					expectedVersionStamp
				})
			});
			if (!result) return;
			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to update user'));
			}
			await refreshDependenciesAfterMutation(['users', 'assignments', 'schedule']);
			resetUsersPane();
		} catch (error) {
			editUserActionError = error instanceof Error ? error.message : 'Failed to update user';
		} finally {
			editUserActionLoading = false;
		}
	}

	async function handleRemoveUser() {
		editUserActionError = '';
		if (editUserActionLoading || !selectedUserForEdit) return;
		const expectedVersionStamp = selectedUserForEdit.versionStamp?.trim() ?? '';
		if (!expectedVersionStamp) {
			editUserActionError = 'This user access entry is out of date. Refresh and try again.';
			return;
		}

		editUserActionLoading = true;
		try {
			let result = await fetchWithAuthRedirect(`${base}/api/team/users`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userOid: selectedUserForEdit.userOid,
					expectedVersionStamp
				})
			});
			if (!result) return;

			if (result.status === 409) {
				const text = (await result.text().catch(() => '')).trim();
				let apiError: RemoveUserErrorPayload = {};
				if (text) {
					try {
						apiError = JSON.parse(text) as RemoveUserErrorPayload;
					} catch {
						apiError = { message: text };
					}
				}

				if (apiError.code === 'USER_ACTIVE_ASSIGNMENTS') {
					const activeCount = Number(apiError.activeAssignmentCount ?? 0);
					const message =
						activeCount > 0
							? `This user is currently assigned to ${activeCount} active ${
									activeCount === 1 ? 'shift' : 'shifts'
								}. If you continue, active assignments will end effective today and future assignments will be removed. Continue?`
							: 'This user is currently assigned to active shifts. If you continue, active assignments will end effective today and future assignments will be removed. Continue?';
					const confirmChoice = await openConfirmDialog({
						title: 'Remove User?',
						message,
						options: [
							{ id: 'cancel', label: 'Cancel' },
							{ id: 'continue', label: 'Continue', tone: 'danger' }
						],
						cancelOptionId: 'cancel'
					});
					if (confirmChoice !== 'continue') {
						editUserActionError = 'User removal canceled.';
						return;
					}

					result = await fetchWithAuthRedirect(`${base}/api/team/users`, {
						method: 'DELETE',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							userOid: selectedUserForEdit.userOid,
							confirmActiveAssignmentRemoval: true,
							expectedVersionStamp
						})
					});
					if (!result) return;
				}
			}

			if (!result.ok) {
				throw new Error(await parseErrorMessage(result, 'Failed to remove user'));
			}
			await refreshDependenciesAfterMutation(['users', 'assignments', 'schedule']);
			resetUsersPane();
		} catch (error) {
			editUserActionError = error instanceof Error ? error.message : 'Failed to remove user';
		} finally {
			editUserActionLoading = false;
		}
	}

	function onDocumentMouseDown(event: MouseEvent) {
		const target = event.target as Node;
		if (showAddUserResults && addUserComboEl && !addUserComboEl.contains(target)) {
			closeAddUserResults();
		}
		if (
			assignmentUserResultsOpen &&
			assignmentUserComboEl &&
			!assignmentUserComboEl.contains(target)
		) {
			closeAssignmentUserResults();
		}
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

	function teardownModalOverflowObservers() {
		modalResizeObserver?.disconnect();
		modalResizeObserver = null;
		modalMutationObserver?.disconnect();
		modalMutationObserver = null;
	}

	function setupModalOverflowObservers() {
		teardownModalOverflowObservers();
		if (!open || !modalScrollEl) return;

		const syncScrollbar = () => {
			updateCustomScrollbar();
			requestAnimationFrame(updateCustomScrollbar);
		};

		if (typeof ResizeObserver !== 'undefined') {
			modalResizeObserver = new ResizeObserver(syncScrollbar);
			modalResizeObserver.observe(modalScrollEl);
			if (modalBodyEl) {
				modalResizeObserver.observe(modalBodyEl);
			}
		}

		if (typeof MutationObserver !== 'undefined') {
			modalMutationObserver = new MutationObserver(syncScrollbar);
			modalMutationObserver.observe(modalScrollEl, {
				childList: true,
				subtree: true,
				characterData: true
			});
		}
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

	$: sortedUsers = [...teamUsers].sort((a, b) => {
		if (sortKey === 'role') {
			const compareRole = rolePrivilegeRank(a.role) - rolePrivilegeRank(b.role);
			if (compareRole !== 0) {
				return sortDirection === 'asc' ? compareRole : -compareRole;
			}
			const compareName = a.name.localeCompare(b.name);
			return sortDirection === 'asc' ? compareName : -compareName;
		}

		const aValue = toComparableValue(a, sortKey);
		const bValue = toComparableValue(b, sortKey);
		const compare = aValue.localeCompare(bValue);
		return sortDirection === 'asc' ? compare : -compare;
	});

	$: sortedShifts = [...teamShifts]
		.sort((a, b) => {
			const aValue = toComparableShiftValue(a, shiftSortKey);
			const bValue = toComparableShiftValue(b, shiftSortKey);
			const compare = aValue.localeCompare(bValue);
			return shiftSortDirection === 'asc' ? compare : -compare;
		})
		.map((shift) => ({
			...shift,
			changes: (shift.changes ?? [])
				.map((change) => ({
					...change,
					pattern: change.pattern || 'Unassigned',
					sortOrder: Number(change.sortOrder ?? shift.sortOrder)
				}))
				.sort((a, b) => a.startDate.localeCompare(b.startDate))
		}));
	$: displayedShifts = isShiftsSection(activeSection)
		? applyOptimisticShiftOrderForMonth(shiftsForMonth(sortedShifts, shiftsMonth), shiftsMonth)
		: sortedShifts;
	$: {
		const activeReorder = shiftReorderState;
		shiftReorderGhostShift = activeReorder
			? (displayedShifts.find((shift) => shift.employeeTypeId === activeReorder.sourceId) ?? null)
			: null;
	}
	$: {
		const activeReorder = assignmentReorderState;
		assignmentReorderGhostAssignment = activeReorder
			? (assignmentRowsForActiveShift.find(
					(assignment) => assignment.assignmentId === activeReorder.sourceId
				) ?? null)
			: null;
	}
	$: {
		const nextGhostRenderState = Boolean(shiftReorderState && shiftReorderGhostShift);
		if (nextGhostRenderState !== lastGhostRenderState) {
			lastGhostRenderState = nextGhostRenderState;
			logShiftReorderDebug('Ghost render state changed', {
				isVisible: nextGhostRenderState,
				hasState: Boolean(shiftReorderState),
				hasGhostShift: Boolean(shiftReorderGhostShift),
				sourceId: shiftReorderState?.sourceId ?? null
			});
		}
	}
	$: sortedEventCodes = [...eventCodeRows].sort((a, b) => {
		const aValue = toComparableEventCodeValue(a, eventCodeSortKey);
		const bValue = toComparableEventCodeValue(b, eventCodeSortKey);
		const compare = aValue.localeCompare(bValue);
		return eventCodeSortDirection === 'asc' ? compare : -compare;
	});
	$: eventCodeDisplayModeItems = [
		{ value: 'Schedule Overlay', label: 'Schedule Overlay' },
		{ value: 'Badge Indicator', label: 'Badge Indicator' },
		{ value: 'Shift Override', label: 'Shift Override' }
	] satisfies PickerItem[];
	$: selectedEventCodeDisplayModeLabel =
		eventCodeDisplayModeItems.find((item) => item.value === addEventCodeDisplayMode)?.label ??
		'Schedule Overlay';
	$: canAddEventCodeReminderDraft = eventCodeReminderDrafts.length < EVENT_CODE_MAX_REMINDERS;
	$: if (addEventCodeReminderScheduled && eventCodeReminderDrafts.length === 0) {
		eventCodeReminderDrafts = [createDefaultEventCodeReminderDraft()];
	}
	$: eventCodeReminderSummaryLines = (() => {
		if (!addEventCodeReminderScheduled) return [] as string[];
		const seenReminderKeys = new Set<string>();
		const lines: string[] = [];
		for (const reminderDraft of eventCodeReminderDrafts) {
			const key = eventCodeReminderSummaryKey(reminderDraft);
			if (seenReminderKeys.has(key)) continue;
			seenReminderKeys.add(key);
			const unitLabel = eventCodeReminderUnitLabel(reminderDraft.unit, reminderDraft.amount);
			lines.push(
				`${reminderDraft.hour} ${reminderDraft.meridiem} ${reminderDraft.amount} ${unitLabel} before the event`
			);
		}
		return lines;
	})();
	$: eventCodeReminderSummaryTitle = `${eventCodeReminderSummaryLines.length} Scheduled Reminder${eventCodeReminderSummaryLines.length === 1 ? '' : 's'}`;
	$: shiftPatternItems = [
		{ value: '', label: 'Unassigned' },
		...patterns.map((pattern) => ({ value: String(pattern.patternId), label: pattern.name }))
	] satisfies PickerItem[];
	$: selectedShiftPatternLabel =
		shiftPatternItems.find((item) => item.value === addShiftPatternId)?.label ?? 'Unassigned';
	$: if (addShiftPatternId && !shiftPatternItems.some((item) => item.value === addShiftPatternId)) {
		addShiftPatternId = '';
	}
	$: assignmentUserQueryFilter = normalizeUserSearchQuery(assignmentUserQuery);
	$: assignmentUserOptions = sortedUsers.filter((user) =>
		assignmentUserMatchesQuery(user, assignmentUserQueryFilter)
	);
	$: if (assignmentUserOid && !sortedUsers.some((user) => user.userOid === assignmentUserOid)) {
		assignmentUserOid = '';
		assignmentUserQuery = '';
	}
	$: assignmentShiftSortIndexById = new Map(
		shiftsForMonth(teamShifts, assignmentsMonth).map((shift, index) => [
			shift.employeeTypeId,
			index + 1
		])
	);
	$: assignmentAvailableShifts = shiftsForMonth(teamShifts, assignmentsMonth);
	$: assignmentEditorShiftName = (() => {
		const parsedShiftId = Number(assignmentShiftId.trim());
		if (Number.isNaN(parsedShiftId)) return '';
		return resolveAssignmentShiftName(parsedShiftId);
	})();
	$: assignmentEditorBaseTitle =
		assignmentsViewMode === 'edit'
			? isEditingAssignmentHistoryEntry
				? 'Edit Assignment Change'
				: 'Edit Assignment'
			: 'Add Assignment';
	$: assignmentEditorTitle =
		(assignmentEditorBaseTitle === 'Add Assignment' ||
			assignmentEditorBaseTitle === 'Edit Assignment') &&
		assignmentEditorShiftName
			? `${assignmentEditorBaseTitle} - ${assignmentEditorShiftName}`
			: assignmentEditorBaseTitle;
	$: if (
		!teamShiftsLoading &&
		assignmentListShiftId &&
		!assignmentAvailableShifts.some(
			(shift) => String(shift.employeeTypeId) === assignmentListShiftId
		)
	) {
		assignmentListShiftId = '';
		expandedAssignmentRows = new Set();
		assignmentReorderOptimisticOrder = null;
	}
	$: assignmentSelectedShift =
		assignmentAvailableShifts.find(
			(shift) => String(shift.employeeTypeId) === assignmentListShiftId
		) ?? null;
	$: canAddAssignmentFromList = assignmentSelectedShift !== null;
	$: assignmentRowsForActiveShift = (() => {
		if (!assignmentSelectedShift) return [] as AssignmentRow[];
		const baseRows = assignmentDisplayRows
			.filter((assignment) => assignment.shiftId === assignmentSelectedShift.employeeTypeId)
			.sort((a, b) => {
				const orderDiff = a.sortOrder - b.sortOrder;
				if (orderDiff !== 0) return orderDiff;
				const userDiff = (a.userName ?? '').localeCompare(b.userName ?? '');
				if (userDiff !== 0) return userDiff;
				return a.assignmentId.localeCompare(b.assignmentId);
			});
		if (
			!assignmentReorderOptimisticOrder ||
			assignmentReorderOptimisticOrder.shiftId !== assignmentSelectedShift.employeeTypeId
		) {
			return baseRows;
		}

		const indexById = new Map(
			assignmentReorderOptimisticOrder.orderedIds.map((assignmentId, index) => [
				assignmentId,
				index
			])
		);
		return [...baseRows].sort((a, b) => {
			const missing = Number.MAX_SAFE_INTEGER;
			const aIndex = indexById.get(a.assignmentId) ?? missing;
			const bIndex = indexById.get(b.assignmentId) ?? missing;
			if (aIndex !== bIndex) return aIndex - bIndex;
			return a.assignmentId.localeCompare(b.assignmentId);
		});
	})();
	$: {
		const activeShiftId = assignmentSelectedShift?.employeeTypeId ?? null;
		if (
			assignmentReorderOptimisticOrder &&
			assignmentReorderOptimisticOrder.shiftId !== activeShiftId
		) {
			assignmentReorderOptimisticOrder = null;
		}
	}
	$: assignmentDisplayRows = [...assignmentRows]
		.sort((a, b) => {
			const aShiftIndex = assignmentShiftSortIndexById.get(a.shiftId) ?? Number.MAX_SAFE_INTEGER;
			const bShiftIndex = assignmentShiftSortIndexById.get(b.shiftId) ?? Number.MAX_SAFE_INTEGER;
			if (aShiftIndex !== bShiftIndex) return aShiftIndex - bShiftIndex;
			const orderDiff = a.sortOrder - b.sortOrder;
			if (orderDiff !== 0) return orderDiff;
			const userDiff = resolveAssignmentUserName(a.userOid).localeCompare(
				resolveAssignmentUserName(b.userOid)
			);
			if (userDiff !== 0) return userDiff;
			return a.assignmentId.localeCompare(b.assignmentId);
		})
		.map((assignment) => ({
			...assignment,
			userName: assignment.userName ?? resolveAssignmentUserName(assignment.userOid),
			shiftName: assignment.shiftName ?? resolveAssignmentShiftName(assignment.shiftId),
			changes: (assignment.changes ?? [])
				.map((change) => ({
					...change,
					userName:
						change.userName ?? assignment.userName ?? resolveAssignmentUserName(change.userOid),
					shiftName:
						change.shiftName ?? resolveAssignmentShiftName(change.shiftId) ?? 'Unknown shift'
				}))
				.sort((a, b) => a.startDate.localeCompare(b.startDate))
		}));
	$: selectedPatternDaysBySwatch = patternColors.map((_, swatchIndex) =>
		patternEditorDays.filter((_, dayIndex) => patternDayAssignments[dayIndex] === swatchIndex)
	);
	$: patternPredictionsBySwatch = selectedPatternDaysBySwatch.map((days) =>
		buildSimplePatternPrediction(days)
	);
	$: {
		const nextPredictedOwnerIndexByDay: number[] = [];
		const nextConflictedPredictionByDay: boolean[] = [];
		for (let dayIndex = 0; dayIndex < patternEditorDays.length; dayIndex += 1) {
			const day = patternEditorDays[dayIndex];
			if (patternDayAssignments[dayIndex] !== -1) {
				nextPredictedOwnerIndexByDay[dayIndex] = -1;
				nextConflictedPredictionByDay[dayIndex] = false;
				continue;
			}
			const owners: number[] = [];
			for (let swatchIndex = 0; swatchIndex < patternPredictionsBySwatch.length; swatchIndex += 1) {
				if (patternPredictionsBySwatch[swatchIndex]?.predictedOn.has(day)) {
					owners.push(swatchIndex);
				}
			}
			nextConflictedPredictionByDay[dayIndex] = owners.length > 1;
			if (owners.includes(activePatternColorIndex)) {
				nextPredictedOwnerIndexByDay[dayIndex] = activePatternColorIndex;
			} else {
				nextPredictedOwnerIndexByDay[dayIndex] = owners[0] ?? -1;
			}
		}
		predictedOwnerIndexByDay = nextPredictedOwnerIndexByDay;
		conflictedPredictionByDay = nextConflictedPredictionByDay;
	}
	$: activePatternPrediction = patternPredictionsBySwatch[activePatternColorIndex] ?? null;
	$: patternPredictionSummary = buildPredictionSummary(
		activePatternPrediction,
		patternPredictionsBySwatch
	);
	$: patternHasPredictionConflict = conflictedPredictionByDay.some(Boolean);
	$: {
		patternColors;
		patternEditorCardEl;
		applyPatternSwatchCssVars();
	}

	$: {
		const currentRole = teamUsers.find((user) => user.userOid === currentUserOid)?.role;
		canAssignManagerRoleEffective =
			currentRole === undefined ? canAssignManagerRole : currentRole === 'Manager';
	}

	$: {
		const isUsersListVisible = open && activeSection === 'users' && usersViewMode === 'list';
		if (isUsersListVisible && !wasUsersListVisible) {
			void loadTeamUsers();
		}
		wasUsersListVisible = isUsersListVisible;
	}

	$: {
		const isShiftsListVisible = open && activeSection === 'shifts' && shiftsViewMode === 'list';
		if (isShiftsListVisible && !wasShiftsListVisible) {
			void loadTeamShifts();
			if (!patterns.length && !patternsLoading) {
				void loadPatterns();
			}
		}
		wasShiftsListVisible = isShiftsListVisible;
	}

	$: {
		const isPatternsListVisible =
			open && activeSection === 'patterns' && patternsViewMode === 'list';
		if (isPatternsListVisible && !wasPatternsListVisible) {
			void loadPatterns();
		}
		wasPatternsListVisible = isPatternsListVisible;
	}

	$: {
		const isEventCodesListVisible =
			open && activeSection === 'eventCodes' && eventCodesViewMode === 'list';
		if (isEventCodesListVisible && !wasEventCodesListVisible) {
			void loadEventCodes();
		}
		wasEventCodesListVisible = isEventCodesListVisible;
	}

	$: if (open && activeSection === 'eventCodes' && eventCodesViewMode === 'list') {
		const scope = currentScheduleScopeKey();
		if (scope !== lastLoadedEventCodeScopeKey) {
			void loadEventCodes();
		}
	}

	$: {
		const isAssignmentsListVisible =
			open && activeSection === 'assignments' && assignmentsViewMode === 'list';
		if (isAssignmentsListVisible && !wasAssignmentsListVisible) {
			void loadTeamUsers();
			void loadTeamShifts(assignmentsMonth);
			void loadAssignmentRows(assignmentsMonth);
		}
		wasAssignmentsListVisible = isAssignmentsListVisible;
	}

	$: if (!open) {
		resetModalState();
	}

	$: if (typeof document !== 'undefined') {
		document.body.classList.toggle('team-modal-open', open);
	}

	$: if (open) {
		activeSection;
		usersViewMode;
		shiftsViewMode;
		patternsViewMode;
		eventCodesViewMode;
		assignmentsViewMode;
		sortedUsers.length;
		sortedShifts.length;
		sortedEventCodes.length;
		tick().then(() => {
			updateCustomScrollbar();
			requestAnimationFrame(updateCustomScrollbar);
		});
	}

	$: if (open && modalScrollEl) {
		modalBodyEl;
		setupModalOverflowObservers();
	} else {
		teardownModalOverflowObservers();
	}

	$: if (showAddUserResults && open && activeSection === 'users' && usersViewMode === 'add') {
		addUsers.length;
		addUsersLoading;
		addUsersError;
		tick().then(() => {
			updateAddUserResultsScrollbar();
			requestAnimationFrame(updateAddUserResultsScrollbar);
		});
	}

	$: if (assignmentUserResultsOpen && open && activeSection === 'assignments') {
		assignmentUserOptions.length;
		tick().then(() => {
			updateAssignmentUserResultsScrollbar();
			requestAnimationFrame(updateAssignmentUserResultsScrollbar);
		});
	}

	$: if (!open) {
		void stopShiftReorder(false);
		void stopAssignmentReorder(false);
		stopDragging();
		teardownModalOverflowObservers();
		stopAddUserResultsDragging();
		stopAssignmentUserResultsDragging();
		resetAddUserResultsScrollbarState();
		resetAssignmentUserResultsScrollbarState();
	}

	$: if (shiftReorderState && (!isShiftsSection(activeSection) || shiftsViewMode !== 'list')) {
		void stopShiftReorder(false);
	}
	$: if (
		assignmentReorderState &&
		(activeSection !== 'assignments' || assignmentsViewMode !== 'list')
	) {
		void stopAssignmentReorder(false);
	}
	$: if (
		assignmentReorderState &&
		(activeSection !== 'assignments' || assignmentsViewMode !== 'list')
	) {
		void stopAssignmentReorder(false);
	}

	onDestroy(() => {
		if (addUserSearchTimer) {
			clearTimeout(addUserSearchTimer);
		}
		if (confirmDialog) {
			closeConfirmDialog(confirmDialog.cancelOptionId);
		}
		void stopShiftReorder(false);
		void stopAssignmentReorder(false);
		stopDragging();
		teardownModalOverflowObservers();
		stopAddUserResultsDragging();
		stopAssignmentUserResultsDragging();
		if (typeof document !== 'undefined') {
			document.removeEventListener('mousedown', onDocumentMouseDown);
			document.body.classList.remove('team-modal-open');
			if (!document.body.dataset.scrollbarDragCount) {
				document.body.classList.remove('scrollbar-dragging');
			}
		}
	});

	onMount(() => {
		document.addEventListener('mousedown', onDocumentMouseDown);
		const onResize = () => {
			updateCustomScrollbar();
			updateAddUserResultsScrollbar();
			updateAssignmentUserResultsScrollbar();
		};
		window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('mousedown', onDocumentMouseDown);
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
			aria-labelledby="team-setup-title"
			bind:this={modalEl}
		>
			<div class="teamSetupModalScroll" bind:this={modalScrollEl} on:scroll={onModalScroll}>
				<header class="teamSetupHeader">
					<div>
						<h2 id="team-setup-title">Team Setup</h2>
					</div>
					<button class="btn" type="button" on:click={closeModal}>Close</button>
				</header>

				<div class="teamSetupBody" bind:this={modalBodyEl}>
					<nav class="teamSetupNav" aria-label="Team setup sections">
						{#each sections as section}
							<button
								type="button"
								class={`teamSetupNavBtn${activeSection === section.id ? ' active' : ''}`}
								on:click={() => setSection(section.id)}
							>
								{section.label}
							</button>
						{/each}
					</nav>

					<div class="teamSetupPanel">
						{#if activeSection === 'users'}
							<section class="setupSection">
								<div class="usersPaneHeader">
									<h3>Users</h3>
									{#if usersViewMode === 'list'}
										<button
											type="button"
											class="iconSquareBtn"
											aria-label="Add user"
											title="Add user"
											on:click={openAddUserView}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								</div>

								{#if usersViewMode === 'list'}
									<div class="setupCard">
										<HorizontalScrollArea>
											<table class="setupTable">
												<thead>
													<tr>
														<th aria-sort={ariaSortFor('name')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleSort('name')}
															>
																User
																<span
																	class={`sortIndicator${sortKey === 'name' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{sortKey === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
																</span>
															</button>
														</th>
														<th>Display</th>
														<th aria-sort={ariaSortFor('email')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleSort('email')}
															>
																Email
																<span
																	class={`sortIndicator${sortKey === 'email' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{sortKey === 'email'
																		? sortDirection === 'asc'
																			? '↑'
																			: '↓'
																		: '↕'}
																</span>
															</button>
														</th>
														<th aria-sort={ariaSortFor('role')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleSort('role')}
															>
																Role
																<span
																	class={`sortIndicator${sortKey === 'role' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{sortKey === 'role' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
																</span>
															</button>
														</th>
														<th></th>
													</tr>
												</thead>
												<tbody>
													{#if teamUsersLoading}
														<tr>
															<td colspan="5">Loading users...</td>
														</tr>
													{:else if teamUsersError}
														<tr>
															<td colspan="5">{teamUsersError}</td>
														</tr>
													{:else if sortedUsers.length === 0}
														<tr>
															<td colspan="5">No users found for this schedule.</td>
														</tr>
													{:else}
														{#each sortedUsers as user}
															<tr>
																<td>{user.name}</td>
																<td>{displayColumnValue(user)}</td>
																<td>{user.email}</td>
																<td>{user.role}</td>
																<td
																	><button
																		type="button"
																		class="btn"
																		on:click={() => openEditUserView(user)}>Edit</button
																	></td
																>
															</tr>
														{/each}
													{/if}
												</tbody>
											</table>
										</HorizontalScrollArea>
									</div>
								{:else if usersViewMode === 'add'}
									<div class="setupCard">
										<h4>Add User</h4>
										<div class="setupGrid">
											<div>
												<span class="srOnly">User search</span>
												<div
													class="setupUserCombo setupUserComboAddUser"
													role="combobox"
													aria-expanded={showAddUserResults}
													bind:this={addUserComboEl}
													on:mousedown={onAddUserComboMouseDown}
												>
													<input
														class="input"
														placeholder="Search by name or email"
														aria-label="User search"
														type="text"
														value={addUserQuery}
														on:input={onAddUserQueryInput}
														aria-autocomplete="list"
														aria-controls="add-user-results"
													/>
													{#if showAddUserResults}
														<div
															id="add-user-results"
															class="setupUserComboList setupUserComboListCustom"
															role="listbox"
														>
															<div
																class="setupUserComboListScroll"
																class:hasScrollbar={showAddUserResultsScrollbar}
																bind:this={addUserResultsEl}
																on:scroll={onAddUserResultsScroll}
															>
																{#if addUsersLoading}
																	<div class="setupUserComboItem setupUserComboStatus">
																		Loading...
																	</div>
																{:else if addUsersError}
																	<div class="setupUserComboItem setupUserComboError">
																		{addUsersError}
																	</div>
																{:else if addUsers.length === 0}
																	<button
																		class="setupUserComboItem setupUserComboStatus"
																		type="button"
																		on:mousedown|preventDefault={closeAddUserResults}
																	>
																		No matches
																	</button>
																{:else}
																	{#each addUsers as user}
																		<button
																			class="setupUserComboItem"
																			role="option"
																			type="button"
																			on:mousedown|preventDefault={() => onAddUserSelect(user)}
																		>
																			{userLabel(user)}
																		</button>
																	{/each}
																{/if}
															</div>
															{#if showAddUserResultsScrollbar}
																<div
																	class="setupUserComboScrollRail"
																	role="presentation"
																	aria-hidden="true"
																	bind:this={addUserResultsRailEl}
																	on:mousedown={handleAddUserResultsRailClick}
																>
																	<div
																		class="setupUserComboScrollThumb"
																		class:dragging={isDraggingAddUserResultsScrollbar}
																		role="presentation"
																		style={`height:${addUserResultsThumbHeightPx}px;transform:translateY(${addUserResultsThumbTopPx}px);`}
																		on:mousedown={startAddUserResultsThumbDrag}
																	></div>
																</div>
															{/if}
														</div>
													{/if}
												</div>
											</div>

											<fieldset class="roleFieldset">
												<legend>Access Level</legend>
												<label>
													<input
														type="radio"
														name="access-level-add"
														value="Member"
														bind:group={selectedAddRole}
													/>
													Member
												</label>
												<label>
													<input
														type="radio"
														name="access-level-add"
														value="Maintainer"
														bind:group={selectedAddRole}
													/>
													Maintainer
												</label>
												{#if canAssignManagerRoleEffective}
													<label>
														<input
															type="radio"
															name="access-level-add"
															value="Manager"
															bind:group={selectedAddRole}
														/>
														Manager
													</label>
												{/if}
											</fieldset>
										</div>
										<div class="setupActions">
											<button
												type="button"
												class="iconActionBtn actionBtn"
												on:click={resetUsersPane}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M6 6l12 12M18 6L6 18" />
												</svg>
												Cancel
											</button>
											<button
												type="button"
												class="iconActionBtn primary actionBtn"
												on:click={handleAddUser}
												disabled={addUserActionLoading}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true" class="calendarPlusIcon">
													<path
														d="M5 6h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"
													/>
													<path d="M7 3v6M15 3v6M3 11h16" />
													<path class="iconPlus" d="M18 4h6M21 1v6" />
												</svg>
												Add
											</button>
										</div>
										{#if addUserActionError}
											<div class="setupActionAlert" role="alert">{addUserActionError}</div>
										{/if}
									</div>
								{:else if selectedUserForEdit}
									<div class="setupCard">
										<h4>Edit User</h4>
										<div class="setupGrid">
											<div class="userSummaryCard" role="note" aria-label="Selected user">
												<div class="userSummaryName">{selectedUserForEdit.name}</div>
												<div class="userSummaryEmail">{selectedUserForEdit.email}</div>
											</div>

											<fieldset class="roleFieldset">
												<legend>Access Level</legend>
												<label>
													<input
														type="radio"
														name="access-level-edit"
														value="Member"
														bind:group={selectedEditRole}
													/>
													Member
												</label>
												<label>
													<input
														type="radio"
														name="access-level-edit"
														value="Maintainer"
														bind:group={selectedEditRole}
													/>
													Maintainer
												</label>
												<label>
													<input
														type="radio"
														name="access-level-edit"
														value="Manager"
														bind:group={selectedEditRole}
														disabled={!canAssignManagerRoleEffective}
													/>
													Manager
												</label>
											</fieldset>
										</div>

										<div class="setupActions">
											<button
												type="button"
												class="iconActionBtn danger actionBtn"
												on:click={handleRemoveUser}
												disabled={editUserActionLoading}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path
														d="M 2 4 h 20 M 6 4 V 1 h 12 v 3 M 2 6 h 20 M 4 6 l 1 15 h 13 L 20 6 M 9.5 8.5 v 10 M 14.5 8.5 v 10"
													/>
												</svg>
												Remove
											</button>
											<button
												type="button"
												class="iconActionBtn actionBtn"
												on:click={resetUsersPane}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M6 6l12 12M18 6L6 18" />
												</svg>
												Cancel
											</button>
											<button
												type="button"
												class="iconActionBtn primary actionBtn"
												on:click={handleSaveUserEdit}
												disabled={editUserActionLoading}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M4 12l5 5 11-11" />
												</svg>
												Save
											</button>
										</div>
										{#if editUserActionError}
											<div class="setupActionAlert" role="alert">{editUserActionError}</div>
										{/if}
									</div>
								{/if}
							</section>
						{:else if activeSection === 'shifts'}
							<section class="setupSection">
								<div class="usersPaneHeader">
									<h3>Shifts</h3>
									{#if shiftsViewMode === 'list'}
										<button
											type="button"
											class="iconSquareBtn"
											aria-label="Add shift"
											title="Add shift"
											on:click={openAddShiftView}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								</div>
								{#if shiftsViewMode === 'list'}
									<div class="setupCard">
										{#if isShiftsSection(activeSection)}
											<div class="shiftsMonthPickerRow">
												<div class="setupField shiftsMonthPickerField">
													<span class="setupFieldLabel">Month</span>
													<DatePicker
														id="shiftsMonthBtn"
														menuId="shiftsMonthMenu"
														label="Month"
														depth="month"
														allowNone={false}
														value={shiftsMonth}
														open={shiftsMonthPickerOpen}
														onOpenChange={setShiftsMonthPickerOpen}
														on:change={(event) => handleShiftsMonthChange(event.detail)}
													/>
												</div>
											</div>
										{/if}
										{#if teamShiftsLoading}
											<p>Loading shifts...</p>
										{:else if teamShiftsError}
											<div class="setupActionAlert" role="alert">{teamShiftsError}</div>
										{:else if displayedShifts.length === 0}
											<p>
												{isShiftsSection(activeSection)
													? 'No shifts active in the selected month.'
													: 'No shifts yet.'}
											</p>
										{:else}
											{#if isShiftsSection(activeSection)}
												<ReorderTable
													shifts={displayedShifts}
													{expandedShiftRows}
													{isShiftReorderLoading}
													{displayShiftEndDate}
													{hasShiftHistoryChanges}
													changesForShift={(shift) => shiftChangesForMonth(shift, shiftsMonth)}
													onToggleShiftDetails={toggleShiftDetails}
													onEditShift={openEditShiftView}
													onEditShiftHistory={openEditShiftHistoryView}
													onReorder={saveShiftReorder}
												/>
											{:else}
												<HorizontalScrollArea>
													<table
														class={`setupTable${activeSection === 'shifts' ? ' shiftsTimelineTable' : ''}`}
														bind:this={shiftsTableEl}
													>
														<thead>
															<tr>
																{#if activeSection !== 'shifts'}
																	<th aria-sort={ariaSortForShift('order')}>
																		<button
																			type="button"
																			class="tableSortBtn"
																			on:click={() => toggleShiftSort('order')}
																		>
																			Order
																			<span
																				class={`sortIndicator${shiftSortKey === 'order' ? ' active' : ''}`}
																				aria-hidden="true"
																			>
																				{shiftSortKey === 'order'
																					? shiftSortDirection === 'asc'
																						? '↑'
																						: '↓'
																					: '↕'}
																			</span>
																		</button>
																	</th>
																{/if}
																{#if activeSection === 'shifts'}
																	<th class="shiftHandleColHead">
																		<span class="srOnly">Reorder</span>
																	</th>
																	<th>Shift</th>
																	<th>Pattern</th>
																	<th>Start Date</th>
																{:else}
																	<th aria-sort={ariaSortForShift('name')}>
																		<button
																			type="button"
																			class="tableSortBtn"
																			on:click={() => toggleShiftSort('name')}
																		>
																			Shift
																			<span
																				class={`sortIndicator${shiftSortKey === 'name' ? ' active' : ''}`}
																				aria-hidden="true"
																			>
																				{shiftSortKey === 'name'
																					? shiftSortDirection === 'asc'
																						? '↑'
																						: '↓'
																					: '↕'}
																			</span>
																		</button>
																	</th>
																	<th aria-sort={ariaSortForShift('pattern')}>
																		<button
																			type="button"
																			class="tableSortBtn"
																			on:click={() => toggleShiftSort('pattern')}
																		>
																			Pattern
																			<span
																				class={`sortIndicator${shiftSortKey === 'pattern' ? ' active' : ''}`}
																				aria-hidden="true"
																			>
																				{shiftSortKey === 'pattern'
																					? shiftSortDirection === 'asc'
																						? '↑'
																						: '↓'
																					: '↕'}
																			</span>
																		</button>
																	</th>
																	<th aria-sort={ariaSortForShift('start')}>
																		<button
																			type="button"
																			class="tableSortBtn"
																			on:click={() => toggleShiftSort('start')}
																		>
																			Start Date
																			<span
																				class={`sortIndicator${shiftSortKey === 'start' ? ' active' : ''}`}
																				aria-hidden="true"
																			>
																				{shiftSortKey === 'start'
																					? shiftSortDirection === 'asc'
																						? '↑'
																						: '↓'
																					: '↕'}
																			</span>
																		</button>
																	</th>
																{/if}
																{#if activeSection === 'shifts'}
																	<th>End Date</th>
																{/if}
																<th>Changes</th>
																<th></th>
															</tr>
														</thead>
														<tbody bind:this={shiftsTbodyEl}>
															{#each displayedShifts as shift}
																{#if showShiftPlaceholderBefore(shift.employeeTypeId)}
																	<tr class="shiftReorderPlaceholderRow">
																		<td colspan={7}>
																			<div
																				class="shiftReorderPlaceholderBox"
																				style={`--shift-ph-h:${Math.max(
																					40,
																					Math.round(shiftReorderState?.rowHeight ?? 40)
																				)}px`}
																			></div>
																		</td>
																	</tr>
																{/if}
																<tr
																	data-shift-id={shift.employeeTypeId}
																	class:shiftDraggingRow={activeSection === 'shifts' &&
																		shiftReorderState?.sourceId === shift.employeeTypeId}
																>
																	{#if activeSection !== 'shifts'}
																		<td>{shift.sortOrder}</td>
																	{/if}
																	{#if activeSection === 'shifts'}
																		<td class="shiftHandleCell">
																			<button
																				type="button"
																				class="shiftReorderHandleBtn"
																				aria-label={`Move ${shift.name}`}
																				title="Drag to reorder shift"
																				on:mousedown={(event) =>
																					handleShiftReorderMouseDown(event, shift)}
																				disabled={isShiftReorderLoading}
																			>
																				<svg
																					class="shiftReorderHandleIcon"
																					viewBox="0 0 16 16"
																					aria-hidden="true"
																					focusable="false"
																				>
																					<path d="M3 4H13" />
																					<path d="M3 8H13" />
																					<path d="M3 12H13" />
																				</svg>
																			</button>
																		</td>
																	{/if}
																	<td>{shift.name}</td>
																	<td>{shift.pattern || 'Unassigned'}</td>
																	<td>{formatDateForDisplay(shift.startDate)}</td>
																	{#if activeSection === 'shifts'}
																		<td>{displayShiftEndDate(shift)}</td>
																	{/if}
																	<td>
																		{#if hasShiftHistoryChanges(shift)}
																			<button
																				type="button"
																				class="rowChevronBtn"
																				aria-label={expandedShiftRows.has(shift.employeeTypeId)
																					? 'Hide shift change history'
																					: 'Show shift change history'}
																				aria-expanded={expandedShiftRows.has(shift.employeeTypeId)}
																				on:click={() => toggleShiftDetails(shift.employeeTypeId)}
																			>
																				{expandedShiftRows.has(shift.employeeTypeId)
																					? 'Hide'
																					: 'Show'}
																			</button>
																		{:else}
																			None
																		{/if}
																	</td>
																	<td>
																		<button
																			type="button"
																			class="btn"
																			on:click={() => openEditShiftView(shift)}
																		>
																			Edit
																		</button>
																	</td>
																</tr>
																{#if hasShiftHistoryChanges(shift) && expandedShiftRows.has(shift.employeeTypeId) && shiftReorderState?.sourceId !== shift.employeeTypeId}
																	<tr class="setupDetailsRow">
																		<td colspan={activeSection === 'shifts' ? 7 : 6}>
																			<HorizontalScrollArea>
																				<table class="setupSubTable">
																					<thead>
																						<tr>
																							<th>Pattern</th>
																							<th>Effective Start</th>
																							<th>Effective End</th>
																							<th></th>
																						</tr>
																					</thead>
																					<tbody>
																						{#if shiftChangesForMonth(shift, shiftsMonth).length === 0}
																							<tr>
																								<td colspan="4">No changes found.</td>
																							</tr>
																						{:else}
																							{#each shiftChangesForMonth(shift, shiftsMonth) as change}
																								<tr>
																									<td>{change.pattern || 'Unassigned'}</td>
																									<td>{formatDateForDisplay(change.startDate)}</td>
																									<td
																										>{formatOptionalDateForDisplay(
																											change.endDate,
																											'Indefinite'
																										)}</td
																									>
																									<td>
																										<button
																											type="button"
																											class="btn"
																											on:click={() =>
																												openEditShiftHistoryView(shift, change)}
																										>
																											Edit
																										</button>
																									</td>
																								</tr>
																							{/each}
																						{/if}
																					</tbody>
																				</table>
																			</HorizontalScrollArea>
																		</td>
																	</tr>
																{/if}
															{/each}
															{#if showShiftPlaceholderAtEnd()}
																<tr class="shiftReorderPlaceholderRow">
																	<td colspan={7}>
																		<div
																			class="shiftReorderPlaceholderBox"
																			style={`--shift-ph-h:${Math.max(
																				40,
																				Math.round(shiftReorderState?.rowHeight ?? 40)
																			)}px`}
																		></div>
																	</td>
																</tr>
															{/if}
														</tbody>
													</table>
												</HorizontalScrollArea>
											{/if}
											{#if addShiftActionError}
												<div class="setupActionAlert" role="alert">{addShiftActionError}</div>
											{/if}
										{/if}
									</div>
								{:else}
									<div class="setupCard">
										<h4>
											{shiftsViewMode === 'edit'
												? isEditingShiftHistoryEntry
													? 'Edit Shift Change'
													: 'Edit Shift'
												: 'Add Shift'}
										</h4>
										<div class="setupShiftForm">
											{#if isShiftsSection(activeSection)}
												<div class="setupShiftSecondaryFields">
													<div class="setupField shiftsDateField shiftsDateFieldTransparent">
														<span class="setupFieldLabel">Shift Name</span>
														<input
															class="input"
															type="text"
															placeholder="e.g. Days Shift"
															bind:value={addShiftName}
														/>
													</div>
													<div class="setupField shiftsDateField shiftsDateFieldTransparent">
														<span class="setupFieldLabel">Pattern</span>
														<div class="setupPatternPicker">
															<Picker
																id="shiftPatternBtn"
																menuId="shiftPatternMenu"
																label="Pattern"
																items={shiftPatternItems}
																selectedValue={addShiftPatternId}
																selectedLabel={selectedShiftPatternLabel}
																open={shiftPatternPickerOpen}
																onOpenChange={setShiftPatternPickerOpen}
																on:select={(event) => (addShiftPatternId = String(event.detail))}
															/>
															<select
																class="nativeHidden"
																aria-hidden="true"
																tabindex="-1"
																aria-label="Pattern"
																bind:value={addShiftPatternId}
															>
																<option value="">Unassigned</option>
																{#each patterns as pattern}
																	<option value={String(pattern.patternId)}>{pattern.name}</option>
																{/each}
															</select>
														</div>
													</div>
												</div>
											{:else}
												<label class="setupShiftNameField">
													Shift Name
													<input
														class="input"
														type="text"
														placeholder="e.g. Days Shift"
														bind:value={addShiftName}
													/>
												</label>
												<div class="setupField">
													<span class="setupFieldLabel">Sort Order</span>
													<div class="numberInputWrap">
														<input
															class="input numberInput"
															type="number"
															min="1"
															max={shiftsViewMode === 'edit'
																? Math.max(teamShifts.length, 1)
																: teamShifts.length + 1}
															step="1"
															bind:value={addShiftSortOrder}
														/>
														<div class="numberStepper">
															<button
																type="button"
																class="numberStepperBtn"
																aria-label="Increase sort order"
																on:click={() =>
																	(addShiftSortOrder = adjustNumericInput(
																		addShiftSortOrder,
																		1,
																		1,
																		shiftsViewMode === 'edit'
																			? Math.max(teamShifts.length, 1)
																			: teamShifts.length + 1
																	))}
															>
																<span class="numberStepperGlyph">▲</span>
															</button>
															<button
																type="button"
																class="numberStepperBtn"
																aria-label="Decrease sort order"
																on:click={() =>
																	(addShiftSortOrder = adjustNumericInput(
																		addShiftSortOrder,
																		-1,
																		1,
																		shiftsViewMode === 'edit'
																			? Math.max(teamShifts.length, 1)
																			: teamShifts.length + 1
																	))}
															>
																<span class="numberStepperGlyph">▼</span>
															</button>
														</div>
													</div>
												</div>
											{/if}
											<div class="setupShiftSecondaryFields">
												{#if !isShiftsSection(activeSection)}
													<div class="setupField">
														<span class="setupFieldLabel">Pattern</span>
														<div class="setupPatternPicker">
															<Picker
																id="shiftPatternBtn"
																menuId="shiftPatternMenu"
																label="Pattern"
																items={shiftPatternItems}
																selectedValue={addShiftPatternId}
																selectedLabel={selectedShiftPatternLabel}
																open={shiftPatternPickerOpen}
																onOpenChange={setShiftPatternPickerOpen}
																on:select={(event) => (addShiftPatternId = String(event.detail))}
															/>
															<select
																class="nativeHidden"
																aria-hidden="true"
																tabindex="-1"
																aria-label="Pattern"
																bind:value={addShiftPatternId}
															>
																<option value="">Unassigned</option>
																{#each patterns as pattern}
																	<option value={String(pattern.patternId)}>{pattern.name}</option>
																{/each}
															</select>
														</div>
													</div>
													<div class="setupField">
														<span class="setupFieldLabel"
															>{shiftsViewMode === 'edit' ? 'Change Effective' : 'Start Date'}</span
														>
														<DatePicker
															id="shiftStartDateBtn"
															menuId="shiftStartDateMenu"
															label={shiftsViewMode === 'edit' ? 'Change Effective' : 'Start Date'}
															allowNone={false}
															value={addShiftStartDate}
															open={shiftStartDatePickerOpen}
															onOpenChange={setShiftStartDatePickerOpen}
															on:change={(event) => (addShiftStartDate = event.detail)}
														/>
													</div>
												{:else}
													<div class="setupField shiftsDateField shiftsDateFieldTransparent">
														<span class="setupFieldLabel"
															>{shiftsViewMode === 'edit' ? 'Change Effective' : 'Start Date'}</span
														>
														<DatePicker
															id="shiftStartDateBtn"
															menuId="shiftStartDateMenu"
															label={shiftsViewMode === 'edit' ? 'Change Effective' : 'Start Date'}
															allowNone={false}
															value={addShiftStartDate}
															open={shiftStartDatePickerOpen}
															onOpenChange={setShiftStartDatePickerOpen}
															on:change={(event) => (addShiftStartDate = event.detail)}
														/>
													</div>
													<div
														class="setupField shiftsDateField"
														class:shiftsDateFieldIndefinite={!addShiftEndDate.trim()}
													>
														<span class="setupFieldLabel">End Date</span>
														<DatePicker
															id="shiftEndDateBtn"
															menuId="shiftEndDateMenu"
															label="End Date"
															placeholder="Indefinite"
															value={addShiftEndDate}
															open={shiftEndDatePickerOpen}
															onOpenChange={setShiftEndDatePickerOpen}
															on:change={(event) => (addShiftEndDate = event.detail)}
														/>
													</div>
												{/if}
											</div>
										</div>
										<div class="setupActions">
											{#if shiftsViewMode === 'edit'}
												<button
													type="button"
													class="iconActionBtn danger actionBtn"
													on:click={handleRemoveShift}
													disabled={addShiftActionLoading}
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path
															d="M 2 4 h 20 M 6 4 V 1 h 12 v 3 M 2 6 h 20 M 4 6 l 1 15 h 13 L 20 6 M 9.5 8.5 v 10 M 14.5 8.5 v 10"
														/>
													</svg>
													Remove
												</button>
											{/if}
											<button
												type="button"
												class="iconActionBtn actionBtn"
												on:click={resetShiftsPane}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M6 6l12 12M18 6L6 18" />
												</svg>
												Cancel
											</button>
											<button
												type="button"
												class="iconActionBtn primary actionBtn"
												on:click={shiftsViewMode === 'edit' ? handleSaveShiftEdit : handleAddShift}
												disabled={addShiftActionLoading}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													{#if shiftsViewMode === 'edit'}
														<path d="M4 12l5 5 11-11" />
													{:else}
														<path d="M12 5v14M5 12h14" />
													{/if}
												</svg>
												{shiftsViewMode === 'edit' ? 'Save' : 'Add'}
											</button>
										</div>
										{#if addShiftActionError}
											<div class="setupActionAlert" role="alert">{addShiftActionError}</div>
										{/if}
									</div>
								{/if}
							</section>
						{:else if activeSection === 'patterns'}
							<section class="setupSection">
								<div class="usersPaneHeader">
									<h3>Shift Patterns</h3>
									{#if patternsViewMode === 'list'}
										<button
											type="button"
											class="iconSquareBtn"
											aria-label="Add pattern"
											title="Add pattern"
											on:click={openAddPatternView}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								</div>
								{#if patternsViewMode === 'list'}
									<div class="setupCard">
										<HorizontalScrollArea>
											<table class="setupTable">
												<thead>
													<tr>
														<th>Pattern</th>
														<th>Summary</th>
														<th></th>
													</tr>
												</thead>
												<tbody>
													{#if patternsLoading}
														<tr>
															<td colspan="3">Loading patterns...</td>
														</tr>
													{:else if patternsError}
														<tr>
															<td colspan="3">{patternsError}</td>
														</tr>
													{:else if patterns.length === 0}
														<tr>
															<td colspan="3">No patterns found for this schedule.</td>
														</tr>
													{:else}
														{#each patterns as pattern}
															<tr>
																<td>{pattern.name}</td>
																<td>{pattern.summary}</td>
																<td>
																	<button
																		type="button"
																		class="btn"
																		on:click={() => openEditPatternView(pattern)}
																	>
																		Edit
																	</button>
																</td>
															</tr>
														{/each}
													{/if}
												</tbody>
											</table>
										</HorizontalScrollArea>
									</div>
								{:else}
									<div class="setupCard">
										<h4>
											{patternsViewMode === 'edit' ? 'Edit Shift Pattern' : 'Add Shift Pattern'}
										</h4>
										<div class="setupGrid">
											<label>
												Pattern Name
												<input
													class="input"
													type="text"
													placeholder="e.g. 4 On / 4 Off"
													bind:value={addPatternName}
												/>
											</label>
										</div>
										<div class="patternEditorCard" bind:this={patternEditorCardEl}>
											<div class="patternColorTray" aria-label="Pattern color options">
												{#each patternColors as color, colorIndex}
													<div class="patternColorItem">
														<div class="patternColorPickerAnchor">
															<ColorPicker
																bind:this={patternColorPickerEls[colorIndex]}
																id={`pattern-color-${colorIndex}`}
																label={`Pattern color ${colorIndex + 1}`}
																value={color}
																on:change={(event) => updatePatternColor(colorIndex, event.detail)}
															/>
														</div>
														<button
															type="button"
															class="patternColorSwatch"
															class:active={activePatternColorIndex === colorIndex &&
																!noShiftModeActive}
															aria-label={`Select pattern color ${colorIndex + 1}`}
															title={`Shift ${colorIndex + 1}`}
															style={`--pattern-swatch-color:${color};`}
															on:click={() => onPatternSwatchClick(colorIndex)}
														></button>
														{#if patternColors.length > 1 && activePatternColorIndex === colorIndex && !noShiftModeActive}
															<button
																type="button"
																class="patternColorRemoveBtn"
																aria-label={`Remove pattern color ${colorIndex + 1}`}
																title="Remove color"
																on:click|stopPropagation={() => removePatternColor(colorIndex)}
															>
																<svg viewBox="0 0 24 24" aria-hidden="true">
																	<path d="M7 7l10 10M17 7L7 17" />
																</svg>
															</button>
														{/if}
													</div>
												{/each}
												{#if patternColors.length < maxPatternSwatches}
													<button
														type="button"
														class="patternColorAddBtn"
														aria-label="Add pattern color"
														title="Add pattern color"
														on:click={addPatternColor}
													>
														<svg viewBox="0 0 24 24" aria-hidden="true">
															<path d="M12 5v14M5 12h14" />
														</svg>
													</button>
												{/if}
												<button
													type="button"
													class="patternNoShiftBtn"
													class:active={noShiftModeActive}
													aria-label="Select no shift tool"
													title="No Shift"
													on:click={activateNoShiftMode}
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<circle cx="12" cy="12" r="7" />
														<path d="M7 17L17 7" />
													</svg>
												</button>
											</div>
											<div class="patternEditorHeader">Pattern Editor</div>
											<div
												class="patternEditorGrid"
												role="grid"
												aria-label="Shift pattern day grid"
											>
												{#each patternEditorDays as day, dayIndex}
													<button
														type="button"
														class="patternEditorDay"
														class:selected={isPatternDaySelected(dayIndex)}
														class:predicted={patternDayAssignments[dayIndex] === -1 &&
															(predictedOwnerIndexByDay[dayIndex] ?? -1) !== -1}
														class:conflicting={conflictedPredictionByDay[dayIndex] ?? false}
														class:activeOwner={isPatternDayOwnedByActive(dayIndex)}
														class:activePrediction={!noShiftModeActive &&
															patternDayAssignments[dayIndex] === -1 &&
															(predictedOwnerIndexByDay[dayIndex] ?? -1) ===
																activePatternColorIndex}
														class:noshift={ownerIndexForDay(dayIndex) === noShiftOwner}
														class:owner0={ownerIndexForDay(dayIndex) === 0}
														class:owner1={ownerIndexForDay(dayIndex) === 1}
														class:owner2={ownerIndexForDay(dayIndex) === 2}
														class:owner3={ownerIndexForDay(dayIndex) === 3}
														class:pred0={predictedOwnerIndexByDay[dayIndex] === 0}
														class:pred1={predictedOwnerIndexByDay[dayIndex] === 1}
														class:pred2={predictedOwnerIndexByDay[dayIndex] === 2}
														class:pred3={predictedOwnerIndexByDay[dayIndex] === 3}
														aria-label={`Pattern day ${day}`}
														aria-pressed={patternDayAssignments[dayIndex] !== -1}
														on:click={() => togglePatternDay(dayIndex)}
													>
														<span class="patternEditorDayLabel">Day</span>
														<span class="patternEditorDayValue">{day}</span>
														{#if conflictedPredictionByDay[dayIndex]}
															<span class="patternEditorConflictIcon" aria-hidden="true">!</span>
														{/if}
													</button>
												{/each}
											</div>
											<div
												class={`patternPredictionStatus${patternHasPredictionConflict ? ' conflict' : ''}`}
											>
												{#if patternHasPredictionConflict}
													Conflicting schedules
												{:else if patternPredictionSummary}
													{#if patternPredictionSummary.onDays !== null && patternPredictionSummary.offDays !== null}
														{patternPredictionSummary.shiftCount}
														{patternPredictionSummary.shiftCount === 1 ? 'shift' : 'shifts'} -
														{patternPredictionSummary.onDays} on / {patternPredictionSummary.offDays}
														off
													{:else}
														{patternPredictionSummary.shiftCount}
														{patternPredictionSummary.shiftCount === 1 ? 'shift' : 'shifts'}
													{/if}
												{:else}
													Add at least two full on-shift runs with a gap for the active swatch.
												{/if}
											</div>
										</div>
										<div class="setupActions">
											{#if patternsViewMode === 'edit'}
												<button
													type="button"
													class="iconActionBtn danger actionBtn"
													on:click={handleRemovePattern}
													disabled={addPatternActionLoading}
													title="Remove pattern"
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path
															d="M 2 4 h 20 M 6 4 V 1 h 12 v 3 M 2 6 h 20 M 4 6 l 1 15 h 13 L 20 6 M 9.5 8.5 v 10 M 14.5 8.5 v 10"
														/>
													</svg>
													Remove
												</button>
											{/if}
											<button
												type="button"
												class="iconActionBtn actionBtn"
												on:click={resetPatternsPane}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M6 6l12 12M18 6L6 18" />
												</svg>
												Cancel
											</button>
											<button
												type="button"
												class="iconActionBtn primary actionBtn"
												on:click={handleSavePattern}
												disabled={addPatternActionLoading || patternHasPredictionConflict}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													{#if patternsViewMode === 'edit'}
														<path d="M4 12l5 5 11-11" />
													{:else}
														<path d="M12 5v14M5 12h14" />
													{/if}
												</svg>
												{patternsViewMode === 'edit' ? 'Save' : 'Add'}
											</button>
										</div>
										{#if addPatternActionError}
											<div class="setupActionAlert" role="alert">{addPatternActionError}</div>
										{/if}
									</div>
								{/if}
							</section>
						{:else if activeSection === 'assignments'}
							<section class="setupSection">
								<div class="usersPaneHeader">
									<h3>Assignments</h3>
									{#if assignmentsViewMode === 'list'}
										<button
											type="button"
											class="iconSquareBtn"
											aria-label="Add assignment"
											title={canAddAssignmentFromList
												? 'Add assignment'
												: 'Select a valid shift for the selected month'}
											on:click={() => openAddAssignmentViewForShift(assignmentListShiftId)}
											disabled={!canAddAssignmentFromList}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								</div>

								{#if assignmentsViewMode === 'list'}
									<div class="setupCard">
										{#if teamShiftsLoading}
											<p>Loading shifts...</p>
										{:else if teamShiftsError}
											<div class="setupActionAlert" role="alert">{teamShiftsError}</div>
										{:else}
											<div class="shiftsMonthPickerRow">
												<div class="setupField shiftsMonthPickerField">
													<span class="setupFieldLabel">Month</span>
													<DatePicker
														id="assignmentsMonthBtn"
														menuId="assignmentsMonthMenu"
														label="Month"
														depth="month"
														allowNone={false}
														value={assignmentsMonth}
														open={assignmentsMonthPickerOpen}
														onOpenChange={setAssignmentsMonthPickerOpen}
														on:change={(event) => handleAssignmentsMonthChange(event.detail)}
													/>
												</div>
											</div>
											{#if assignmentAvailableShifts.length === 0}
												<p class="setupCardHint">No shifts active in the selected month.</p>
											{:else if !assignmentSelectedShift}
												<div class="assignmentShiftMenu">
													<p class="setupCardHint assignmentShiftMenuHint">
														Select a shift to manage assignments.
													</p>
													<div class="assignmentShiftMenuGrid">
														{#each assignmentAvailableShifts as shift}
															<button
																type="button"
																class="assignmentShiftMenuBtn"
																on:click={() =>
																	handleAssignmentListShiftChange(String(shift.employeeTypeId))}
															>
																<span>{shift.name}</span>
															</button>
														{/each}
													</div>
													<p class="setupCardHint assignmentShiftMenuHint">
														Don&apos;t see the shift you need? It may be inactive for this month.
														Try changing the month above.
													</p>
												</div>
											{:else}
												<div class="assignmentTableToolbar">
													<button
														type="button"
														class="assignmentBackBtn"
														on:click={clearAssignmentListShiftSelection}
													>
														<span aria-hidden="true">&larr;</span>
														Back to shifts
													</button>
													<span class="assignmentTableShiftLabel">{assignmentSelectedShift.name}</span>
												</div>
												<HorizontalScrollArea>
													<table
														class="setupTable shiftsTimelineTable"
														bind:this={assignmentsTableEl}
													>
														<thead>
															<tr>
																<th class="shiftHandleColHead">
																	<span class="srOnly">Reorder</span>
																</th>
																<th>User</th>
																<th>Start Date</th>
																<th>End Date</th>
																<th>Changes</th>
																<th></th>
															</tr>
														</thead>
														{#if assignmentRowsForActiveShift.length === 0}
															<tbody>
																<tr>
																	<td colspan="6">No assignments found for the selected shift.</td>
																</tr>
															</tbody>
														{:else}
															{#each assignmentRowsForActiveShift as assignment (assignment.assignmentId)}
																<tbody data-assignment-group-id={assignment.assignmentId}>
																<tr
																	data-assignment-id={assignment.assignmentId}
																	class:shiftDraggingRow={assignmentReorderState?.sourceId ===
																		assignment.assignmentId}
																	class:shiftReorderDropTarget={isAssignmentDropTarget(
																		assignment.assignmentId
																	)}
																>
																	<td class="shiftHandleCell">
																		<button
																			type="button"
																			class="shiftReorderHandleBtn"
																			aria-label={`Move ${assignment.userName}`}
																			title="Drag to reorder assignment"
																			on:mousedown={(event) =>
																				handleAssignmentReorderMouseDown(event, assignment)}
																			disabled={isAssignmentReorderLoading}
																		>
																			<svg
																				class="shiftReorderHandleIcon"
																				viewBox="0 0 16 16"
																				aria-hidden="true"
																				focusable="false"
																			>
																				<path d="M3 4H13" />
																				<path d="M3 8H13" />
																				<path d="M3 12H13" />
																			</svg>
																		</button>
																	</td>
																	<td>{assignment.userName}</td>
																	<td>{formatDateForDisplay(assignment.startDate)}</td>
																	<td
																		>{formatOptionalDateForDisplay(
																			assignment.endDate,
																			'Indefinite'
																		)}</td
																	>
																	<td>
																		{#if hasAssignmentHistoryChanges(assignment)}
																			<button
																				type="button"
																				class="rowChevronBtn"
																				aria-label={expandedAssignmentRows.has(
																					assignment.assignmentId
																				)
																					? 'Hide assignment change history'
																					: 'Show assignment change history'}
																				aria-expanded={expandedAssignmentRows.has(
																					assignment.assignmentId
																				)}
																				on:click={() =>
																					toggleAssignmentDetails(assignment.assignmentId)}
																			>
																				{expandedAssignmentRows.has(assignment.assignmentId)
																					? 'Hide'
																					: 'Show'}
																			</button>
																		{:else}
																			None
																		{/if}
																	</td>
																	<td>
																		<button
																			type="button"
																			class="btn"
																			on:click={() => openEditAssignmentView(assignment)}
																		>
																			Edit
																		</button>
																	</td>
																</tr>
																{#if hasAssignmentHistoryChanges(assignment) && expandedAssignmentRows.has(assignment.assignmentId) && assignmentReorderState?.sourceId !== assignment.assignmentId}
																	<tr class="setupDetailsRow">
																		<td colspan="6">
																			<HorizontalScrollArea>
																				<table class="setupSubTable">
																					<thead>
																						<tr>
																							<th>Shift</th>
																							<th>Start Date</th>
																							<th>End Date</th>
																							<th></th>
																						</tr>
																					</thead>
																					<tbody>
																						{#if !assignment.changes || assignment.changes.length === 0}
																							<tr>
																								<td colspan="4">No changes found.</td>
																							</tr>
																						{:else}
																							{#each assignment.changes as change}
																								<tr>
																									<td>{change.shiftName}</td>
																									<td>{formatDateForDisplay(change.startDate)}</td>
																									<td
																										>{formatOptionalDateForDisplay(
																											change.endDate,
																											'Indefinite'
																										)}</td
																									>
																									<td>
																										<button
																											type="button"
																											class="btn"
																											on:click={() =>
																												openEditAssignmentHistoryView(
																													assignment,
																													change
																												)}
																										>
																											Edit
																										</button>
																									</td>
																								</tr>
																							{/each}
																						{/if}
																					</tbody>
																				</table>
																			</HorizontalScrollArea>
																		</td>
																	</tr>
																{/if}
																</tbody>
															{/each}
														{/if}
													</table>
												</HorizontalScrollArea>
											{/if}
										{/if}
									</div>
								{:else}
									<div class="setupCard">
										<h4>{assignmentEditorTitle}</h4>
										<div class="setupShiftForm">
											<div class="setupField shiftsDateField shiftsDateFieldTransparent">
												<span class="setupFieldLabel">User</span>
												<div
													class="setupUserCombo"
													role="combobox"
													aria-expanded={assignmentUserResultsOpen}
													aria-haspopup="listbox"
													bind:this={assignmentUserComboEl}
													on:mousedown={onAssignmentUserComboMouseDown}
												>
													<input
														class="input"
														placeholder={teamUsers.length === 0
															? 'No users available'
															: 'Filter users'}
														aria-label="Assignment user"
														type="text"
														value={assignmentUserQuery}
														on:input={onAssignmentUserQueryInput}
														on:focus={onAssignmentUserFocus}
														aria-autocomplete="list"
														aria-controls="assignment-user-results"
														disabled={teamUsers.length === 0 || isEditingAssignmentHistoryEntry}
													/>
													{#if assignmentUserResultsOpen && teamUsers.length > 0 && !isEditingAssignmentHistoryEntry}
														<div
															id="assignment-user-results"
															class="setupUserComboList setupUserComboListCustom"
															role="listbox"
														>
															<div
																class="setupUserComboListScroll"
																class:hasScrollbar={showAssignmentUserResultsScrollbar}
																bind:this={assignmentUserResultsEl}
																on:scroll={onAssignmentUserResultsScroll}
															>
																{#if assignmentUserOptions.length === 0}
																	<button
																		class="setupUserComboItem setupUserComboStatus"
																		type="button"
																		on:mousedown|preventDefault={closeAssignmentUserResults}
																	>
																		No matches
																	</button>
																{:else}
																	{#each assignmentUserOptions as user}
																		<button
																			class="setupUserComboItem"
																			role="option"
																			type="button"
																			on:mousedown|preventDefault={() =>
																				onAssignmentUserSelect(user)}
																		>
																			{assignmentUserLabel(user)}
																		</button>
																	{/each}
																{/if}
															</div>
															{#if showAssignmentUserResultsScrollbar}
																<div
																	class="setupUserComboScrollRail"
																	role="presentation"
																	aria-hidden="true"
																	bind:this={assignmentUserResultsRailEl}
																	on:mousedown={handleAssignmentUserResultsRailClick}
																>
																	<div
																		class="setupUserComboScrollThumb"
																		class:dragging={isDraggingAssignmentUserResultsScrollbar}
																		role="presentation"
																		style={`height:${assignmentUserResultsThumbHeightPx}px;transform:translateY(${assignmentUserResultsThumbTopPx}px);`}
																		on:mousedown={startAssignmentUserResultsThumbDrag}
																	></div>
																</div>
															{/if}
														</div>
													{/if}
												</div>
											</div>
											<div class="setupShiftSecondaryFields">
												<div class="setupField shiftsDateField shiftsDateFieldTransparent">
													<span class="setupFieldLabel"
														>{assignmentsViewMode === 'edit'
															? 'Change Effective'
															: 'Start Date'}</span
													>
													<DatePicker
														id="assignmentStartDateBtn"
														menuId="assignmentStartDateMenu"
														label={assignmentsViewMode === 'edit'
															? 'Change Effective'
															: 'Start Date'}
														allowNone={false}
														value={assignmentStartDate}
														open={assignmentStartDatePickerOpen}
														onOpenChange={setAssignmentStartDatePickerOpen}
														on:change={(event) => handleAssignmentStartDateChange(event.detail)}
													/>
												</div>
												<div
													class="setupField shiftsDateField"
													class:shiftsDateFieldIndefinite={!assignmentEndDate.trim()}
												>
													<span class="setupFieldLabel">End Date</span>
													<DatePicker
														id="assignmentEndDateBtn"
														menuId="assignmentEndDateMenu"
														label="End Date"
														placeholder="Indefinite"
														value={assignmentEndDate}
														open={assignmentEndDatePickerOpen}
														onOpenChange={setAssignmentEndDatePickerOpen}
														on:change={(event) => (assignmentEndDate = event.detail)}
													/>
												</div>
											</div>
										</div>
										<div class="setupActions">
											{#if assignmentsViewMode === 'edit'}
												<button
													type="button"
													class="iconActionBtn danger actionBtn"
													on:click={handleRemoveAssignment}
													disabled={assignmentActionLoading}
												>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path
															d="M 2 4 h 20 M 6 4 V 1 h 12 v 3 M 2 6 h 20 M 4 6 l 1 15 h 13 L 20 6 M 9.5 8.5 v 10 M 14.5 8.5 v 10"
														/>
													</svg>
													Remove
												</button>
											{/if}
											<button
												type="button"
												class="iconActionBtn actionBtn"
												on:click={resetAssignmentsPane}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M6 6l12 12M18 6L6 18" />
												</svg>
												Cancel
											</button>
											<button
												type="button"
												class="iconActionBtn primary actionBtn"
												on:click={handleSaveAssignment}
												disabled={assignmentActionLoading}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													{#if assignmentsViewMode === 'edit'}
														<path d="M4 12l5 5 11-11" />
													{:else}
														<path d="M12 5v14M5 12h14" />
													{/if}
												</svg>
												{assignmentsViewMode === 'edit' ? 'Save' : 'Add'}
											</button>
										</div>
										{#if assignmentActionError}
											<div class="setupActionAlert" role="alert">{assignmentActionError}</div>
										{/if}
									</div>
								{/if}
							</section>
						{:else}
							<section class="setupSection">
								<div class="usersPaneHeader">
									<h3>Event Codes</h3>
									{#if eventCodesViewMode === 'list'}
										<button
											type="button"
											class="iconSquareBtn"
											aria-label="Add event code"
											title="Add event code"
											on:click={openAddEventCodeView}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M12 5v14M5 12h14" />
											</svg>
										</button>
									{/if}
								</div>

								{#if eventCodesViewMode === 'list'}
									<div class="setupCard">
										<HorizontalScrollArea>
											<table class="setupTable">
												<thead>
													<tr>
														<th aria-sort={ariaSortForEventCode('code')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleEventCodeSort('code')}
															>
																Code
																<span
																	class={`sortIndicator${eventCodeSortKey === 'code' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{eventCodeSortKey === 'code'
																		? eventCodeSortDirection === 'asc'
																			? '↑'
																			: '↓'
																		: '↕'}
																</span>
															</button>
														</th>
														<th aria-sort={ariaSortForEventCode('name')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleEventCodeSort('name')}
															>
																Name
																<span
																	class={`sortIndicator${eventCodeSortKey === 'name' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{eventCodeSortKey === 'name'
																		? eventCodeSortDirection === 'asc'
																			? '↑'
																			: '↓'
																		: '↕'}
																</span>
															</button>
														</th>
														<th aria-sort={ariaSortForEventCode('displayMode')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleEventCodeSort('displayMode')}
															>
																Display
																<span
																	class={`sortIndicator${eventCodeSortKey === 'displayMode' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{eventCodeSortKey === 'displayMode'
																		? eventCodeSortDirection === 'asc'
																			? '↑'
																			: '↓'
																		: '↕'}
																</span>
															</button>
														</th>
														<th aria-sort={ariaSortForEventCode('status')}>
															<button
																type="button"
																class="tableSortBtn"
																on:click={() => toggleEventCodeSort('status')}
															>
																Status
																<span
																	class={`sortIndicator${eventCodeSortKey === 'status' ? ' active' : ''}`}
																	aria-hidden="true"
																>
																	{eventCodeSortKey === 'status'
																		? eventCodeSortDirection === 'asc'
																			? '↑'
																			: '↓'
																		: '↕'}
																</span>
															</button>
														</th>
														<th></th>
													</tr>
												</thead>
												<tbody>
													{#if eventCodeRowsLoading}
														<tr>
															<td colspan="5">Loading event codes...</td>
														</tr>
													{:else if eventCodeRowsError}
														<tr>
															<td colspan="5">{eventCodeRowsError}</td>
														</tr>
													{:else if sortedEventCodes.length === 0}
														<tr>
															<td colspan="5">No event codes yet.</td>
														</tr>
													{:else}
														{#each sortedEventCodes as eventCode}
															<tr>
																	<td>
																		<div class="eventCodeInline">
																			<span
																				class={`eventCodeColorDot ${eventCodeIndicatorModeClass(eventCode.displayMode)}`}
																				aria-hidden="true"
																				style={`background:${eventCode.color};`}
																				title={eventCode.displayMode}
																			></span>
																			<span>{eventCode.code}</span>
																		</div>
																	</td>
																<td>{eventCode.name}</td>
																<td>
																	<span class="eventCodeMetaPill">{eventCode.displayMode}</span>
																</td>
																<td>
																	<span
																		class={`eventCodeStatusPill${eventCode.isActive ? ' active' : ''}`}
																	>
																		{eventCode.isActive ? 'Available' : 'Disabled'}
																	</span>
																</td>
																<td>
																	<button
																		type="button"
																		class="btn"
																		on:click={() => openEditEventCodeView(eventCode)}
																	>
																		Edit
																	</button>
																</td>
															</tr>
														{/each}
													{/if}
												</tbody>
											</table>
										</HorizontalScrollArea>
									</div>
								{:else}
									<div class="setupCard">
										<h4>{eventCodesViewMode === 'edit' ? 'Edit Event Code' : 'Add Event Code'}</h4>
										<div class="setupShiftForm">
											<div class="setupShiftSecondaryFields">
												<label class="setupField">
													<span class="setupFieldLabel">Code</span>
													<input
														class="input"
														type="text"
														maxlength="16"
														placeholder="e.g. VAC"
														bind:value={addEventCodeCode}
														on:input={(event) => {
															const target = event.currentTarget as HTMLInputElement;
															addEventCodeCode = normalizeEventCodeCode(target.value);
														}}
													/>
												</label>
												<label class="setupField">
													<span class="setupFieldLabel">Display Name</span>
													<input
														class="input"
														type="text"
														maxlength="60"
														placeholder="e.g. Vacation"
														bind:value={addEventCodeName}
													/>
												</label>
											</div>

											<div class="setupShiftSecondaryFields">
												<div class="setupField">
													<span class="setupFieldLabel">Display Mode</span>
													<div class="setupPatternPicker">
														<Picker
															id="eventCodeDisplayModeBtn"
															menuId="eventCodeDisplayModeMenu"
															label="Display Mode"
															items={eventCodeDisplayModeItems}
															selectedValue={addEventCodeDisplayMode}
															selectedLabel={selectedEventCodeDisplayModeLabel}
															open={eventCodeDisplayModePickerOpen}
															onOpenChange={setEventCodeDisplayModePickerOpen}
															on:select={(event) =>
																(addEventCodeDisplayMode = event.detail as EventCodeDisplayMode)}
														/>
													</div>
												</div>
												<div class="setupField eventCodeColorField">
													<span class="setupFieldLabel">Color</span>
													<ColorPicker
														id="event-code-color"
														label="Event code color"
														value={addEventCodeColor}
														on:change={(event) => (addEventCodeColor = event.detail)}
													/>
												</div>
											</div>

											<div class="setupShiftSecondaryFields">
												<div class="eventCodeFlagsField setupFieldFull">
													<span class="setupFieldLabel">Status</span>
													<button
														type="button"
														class={`eventCodeAvailabilityBtn${addEventCodeIsActive ? ' available' : ''}`}
														aria-pressed={addEventCodeIsActive}
														on:click={() => (addEventCodeIsActive = !addEventCodeIsActive)}
													>
														{addEventCodeIsActive ? 'Available' : 'Disabled'}
													</button>
												</div>
											</div>

											<div class="eventCodeReminderSection">
												<div class="eventCodeReminderTitle">Reminders</div>
												<ThemedCheckbox
													id="event-code-reminder-immediate"
													bind:checked={addEventCodeReminderImmediate}
													label="Notify Immediately"
												/>
												<ThemedCheckbox
													id="event-code-reminder-scheduled"
													bind:checked={addEventCodeReminderScheduled}
													label="Scheduled Reminders"
												/>
												{#if addEventCodeReminderScheduled}
													<div class="eventCodeReminderPickerStack">
														<div class="eventCodeReminderHeaderRow" aria-hidden="true">
															<span>Amount</span>
															<span>Unit</span>
															<span>Time</span>
															<span>AM/PM</span>
															<span class="eventCodeReminderHeaderAction"></span>
														</div>
														{#each eventCodeReminderDrafts as reminderDraft (reminderDraft.id)}
															<div class="eventCodeReminderRowWrap">
																<div class="eventCodeReminderPickerRow">
																	<ThemedSpinPicker
																		id={`event-code-reminder-amount-${reminderDraft.id}`}
																		options={eventCodeReminderAmountOptions}
																		value={reminderDraft.amount}
																		on:value={(event) =>
																			updateEventCodeReminderDraft(
																				reminderDraft.id,
																				'amount',
																				event.detail
																			)}
																	/>
																	<ThemedSpinPicker
																		id={`event-code-reminder-unit-${reminderDraft.id}`}
																		options={eventCodeReminderUnitOptions}
																		value={reminderDraft.unit}
																		on:value={(event) =>
																			updateEventCodeReminderDraft(
																				reminderDraft.id,
																				'unit',
																				event.detail
																			)}
																	/>
																	<ThemedSpinPicker
																		id={`event-code-reminder-hour-${reminderDraft.id}`}
																		options={eventCodeReminderHourOptions}
																		value={reminderDraft.hour}
																		on:value={(event) =>
																			updateEventCodeReminderDraft(
																				reminderDraft.id,
																				'hour',
																				event.detail
																			)}
																	/>
																	<ThemedSpinPicker
																		id={`event-code-reminder-meridiem-${reminderDraft.id}`}
																		options={eventCodeReminderMeridiemOptions}
																		value={reminderDraft.meridiem}
																		on:value={(event) =>
																			updateEventCodeReminderDraft(
																				reminderDraft.id,
																				'meridiem',
																				event.detail
																			)}
																	/>
																</div>
																<button
																	type="button"
																	class="eventCodeReminderRemoveBtn"
																	on:click={() => removeEventCodeReminderDraft(reminderDraft.id)}
																	aria-label="Remove scheduled reminder"
																>
																	<svg viewBox="0 0 24 24" aria-hidden="true">
																		<path d="M6 6l12 12M18 6L6 18" />
																	</svg>
																</button>
															</div>
														{/each}
														{#if canAddEventCodeReminderDraft}
															<button
																type="button"
																class="eventCodeReminderAddBtn"
																on:click={addEventCodeReminderDraft}
																aria-label="Add another scheduled reminder"
															>
																<svg viewBox="0 0 24 24" aria-hidden="true">
																	<path d="M12 5v14M5 12h14" />
																</svg>
															</button>
														{/if}
														<div class="eventCodeReminderSummary">
															<div class="eventCodeReminderSummaryTitle">
																{eventCodeReminderSummaryTitle}
															</div>
															{#each eventCodeReminderSummaryLines as reminderSummaryLine}
																<div class="eventCodeReminderSummaryLine">
																	{reminderSummaryLine}
																</div>
															{/each}
														</div>
													</div>
												{/if}
											</div>
										</div>

										<div class="setupActions">
											<button
												type="button"
												class="iconActionBtn actionBtn"
												on:click={resetEventCodesPane}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													<path d="M6 6l12 12M18 6L6 18" />
												</svg>
												Cancel
											</button>
											<button
												type="button"
												class="iconActionBtn primary actionBtn"
												on:click={handleSaveEventCode}
												disabled={eventCodeActionLoading}
											>
												<svg viewBox="0 0 24 24" aria-hidden="true">
													{#if eventCodesViewMode === 'edit'}
														<path d="M4 12l5 5 11-11" />
													{:else}
														<path d="M12 5v14M5 12h14" />
													{/if}
												</svg>
												{eventCodesViewMode === 'edit' ? 'Save' : 'Add'}
											</button>
										</div>
										{#if eventCodeActionError}
											<div class="setupActionAlert" role="alert">{eventCodeActionError}</div>
										{/if}
									</div>
								{/if}
							</section>
						{/if}
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
		<ConfirmDialog
			open={Boolean(confirmDialog)}
			title={confirmDialog?.title ?? ''}
			message={confirmDialog?.message ?? ''}
			options={confirmDialog?.options ?? []}
			cancelOptionId={confirmDialog?.cancelOptionId ?? 'cancel'}
			on:select={(event) => closeConfirmDialog(event.detail)}
		/>
	</div>
	{#if shiftReorderState && shiftReorderGhostShift}
		<div class="shiftReorderGhost" style={shiftReorderGhostStyle()} use:portalToBody>
			<table aria-hidden="true">
				<tbody>
					<tr>
						<td class="shiftHandleCell">
							<span class="shiftReorderHandleBtn" aria-hidden="true">
								<svg class="shiftReorderHandleIcon" viewBox="0 0 16 16" focusable="false">
									<path d="M3 4H13" />
									<path d="M3 8H13" />
									<path d="M3 12H13" />
								</svg>
							</span>
						</td>
						<td>{shiftReorderGhostShift.name}</td>
						<td>{shiftReorderGhostShift.pattern || 'Unassigned'}</td>
						<td>{formatDateForDisplay(shiftReorderGhostShift.startDate)}</td>
						<td>{displayShiftEndDate(shiftReorderGhostShift)}</td>
						<td>{hasShiftHistoryChanges(shiftReorderGhostShift) ? 'History' : 'None'}</td>
						<td>Moving...</td>
					</tr>
				</tbody>
			</table>
		</div>
	{/if}
	{#if assignmentReorderState && assignmentReorderGhostAssignment}
		<div
			class="shiftReorderGhost"
			style={assignmentReorderGhostStyle()}
			use:portalAssignmentGhostToBody
		>
			<table aria-hidden="true">
				<tbody>
					<tr>
						<td class="shiftHandleCell">
							<span class="shiftReorderHandleBtn" aria-hidden="true">
								<svg class="shiftReorderHandleIcon" viewBox="0 0 16 16" focusable="false">
									<path d="M3 4H13" />
									<path d="M3 8H13" />
									<path d="M3 12H13" />
								</svg>
							</span>
						</td>
						<td>{assignmentReorderGhostAssignment.userName}</td>
						<td>{formatDateForDisplay(assignmentReorderGhostAssignment.startDate)}</td>
						<td
							>{formatOptionalDateForDisplay(
								assignmentReorderGhostAssignment.endDate,
								'Indefinite'
							)}</td
						>
						<td>
							{hasAssignmentHistoryChanges(assignmentReorderGhostAssignment) ? 'History' : 'None'}
						</td>
						<td>Moving...</td>
					</tr>
				</tbody>
			</table>
		</div>
	{/if}
{/if}
