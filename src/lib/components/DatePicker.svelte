<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';

	type DayCell = {
		iso: string;
		day: number;
		inMonth: boolean;
		isToday: boolean;
		isSelected: boolean;
		isDisabled: boolean;
	};
	type PickerDepth = 'day' | 'month' | 'year';
	type ViewMode = 'days' | 'months' | 'years';

	export let id = '';
	export let menuId = '';
	export let label = 'Date';
	export let value = '';
	export let open = false;
	export let disabled = false;
	export let placeholder = 'Select date';
	export let min = '';
	export let max = '';
	export let depth: PickerDepth = 'day';
	export let allowNone = true;
	export let onOpenChange: (next: boolean) => void = () => {};

	const dispatch = createEventDispatcher<{ select: string; change: string }>();
	const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
	const monthShortFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });
	const selectedDayShortFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const selectedDayLongFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'long',
		day: 'numeric',
		year: 'numeric'
	});
	const selectedMonthShortFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		year: 'numeric'
	});
	const selectedMonthLongFormatter = new Intl.DateTimeFormat(undefined, {
		month: 'long',
		year: 'numeric'
	});
	const selectedYearFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric' });
	const weekdayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

	let rootEl: HTMLDivElement | null = null;
	let triggerValueEl: HTMLSpanElement | null = null;
	let measureValueEl: HTMLSpanElement | null = null;
	let labelResizeObserver: ResizeObserver | null = null;
	let lastOpen = false;
	let viewYear = 0;
	let viewMonth = 0;
	let yearGridDecadeStart = 0;
	let viewMode: ViewMode = 'days';
	let isTriggerPressed = false;
	let showLongLabel = false;
	let labelFitRafId = 0;

	$: resolvedMenuId = menuId || `${id}-menu`;
	$: selectedDate = parseValueForDepth(value, depth);
	$: selectedLabelShort = formatSelectedLabel(selectedDate, depth, placeholder, false);
	$: selectedLabelLong = formatSelectedLabel(selectedDate, depth, placeholder, true);
	$: selectedLabel = showLongLabel ? selectedLabelLong : selectedLabelShort;
	$: monthLabel = monthFormatter.format(new Date(viewYear, viewMonth, 1));
	$: yearLabel = String(viewYear);
	$: yearGridStart = yearGridDecadeStart - 1;
	$: yearRangeLabel = `${yearGridStart} - ${yearGridStart + 11}`;
	$: todayActionLabel =
		depth === 'year' ? 'This year' : depth === 'month' ? 'This month' : 'Today';
	$: dayCells = buildCalendarCells(viewYear, viewMonth, selectedDate, min, max);
	$: monthCells = buildMonthCells(viewYear, viewMonth, selectedDate, min, max);
	$: yearCells = buildYearCells(yearGridStart, viewYear, selectedDate, min, max);
	$: {
		if (open && !lastOpen) {
			const base = selectedDate ?? new Date();
			viewYear = base.getFullYear();
			viewMonth = base.getMonth();
			yearGridDecadeStart = decadeStartForYear(viewYear);
			viewMode = depth === 'year' ? 'years' : depth === 'month' ? 'months' : 'days';
		}
		lastOpen = open;
	}
	$: scheduleLabelFitCheck(selectedLabelShort, selectedLabelLong);

	function scheduleLabelFitCheck(shortLabel: string, longLabel: string) {
		if (typeof window === 'undefined') {
			showLongLabel = false;
			return;
		}
		if (shortLabel === longLabel) {
			showLongLabel = true;
			return;
		}
		if (labelFitRafId) {
			window.cancelAnimationFrame(labelFitRafId);
		}
		labelFitRafId = window.requestAnimationFrame(() => {
			labelFitRafId = 0;
			recomputeLabelFit();
		});
	}

	function parseYearMonth(value: string): { year: number; month: number } | null {
		const match = value.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
		if (!match) return null;
		const year = Number(match[1]);
		const monthNumber = Number(match[2]);
		if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) return null;
		if (monthNumber < 1 || monthNumber > 12) return null;
		if (match[3] !== undefined && !parseIsoDate(value)) return null;
		return { year, month: monthNumber - 1 };
	}

	function parseYear(value: string): number | null {
		const yearMatch = value.match(/^\d{4}$/);
		if (yearMatch) {
			return Number(yearMatch[0]);
		}
		const yearMonth = parseYearMonth(value);
		return yearMonth ? yearMonth.year : null;
	}

	function parseValueForDepth(raw: string, mode: PickerDepth): Date | null {
		const value = raw.trim();
		if (!value) return null;
		if (mode === 'day') return parseIsoDate(value);
		if (mode === 'month') {
			const parsed = parseYearMonth(value);
			return parsed ? new Date(parsed.year, parsed.month, 1) : null;
		}
		const parsedYear = parseYear(value);
		return parsedYear !== null ? new Date(parsedYear, 0, 1) : null;
	}

	function parseIsoDate(iso: string): Date | null {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
		const [yearRaw, monthRaw, dayRaw] = iso.split('-');
		const year = Number(yearRaw);
		const month = Number(monthRaw);
		const day = Number(dayRaw);
		if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
		const parsed = new Date(year, month - 1, day);
		if (
			parsed.getFullYear() !== year ||
			parsed.getMonth() !== month - 1 ||
			parsed.getDate() !== day
		) {
			return null;
		}
		return parsed;
	}

	function toIsoDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function toIsoMonth(year: number, month: number): string {
		return `${year}-${String(month + 1).padStart(2, '0')}`;
	}

	function toIsoYear(year: number): string {
		return String(year);
	}

	function normalizeValueForDepth(raw: string, mode: PickerDepth): string | null {
		const value = raw.trim();
		if (!value) return null;
		if (mode === 'day') {
			const parsed = parseIsoDate(value);
			return parsed ? toIsoDate(parsed) : null;
		}
		if (mode === 'month') {
			const parsed = parseYearMonth(value);
			return parsed ? toIsoMonth(parsed.year, parsed.month) : null;
		}
		const parsedYear = parseYear(value);
		return parsedYear !== null ? toIsoYear(parsedYear) : null;
	}

	function isOutOfBounds(value: string, mode: PickerDepth, minValue: string, maxValue: string): boolean {
		const normalized = normalizeValueForDepth(value, mode);
		if (!normalized) return false;
		const minNormalized = normalizeValueForDepth(minValue, mode);
		const maxNormalized = normalizeValueForDepth(maxValue, mode);
		if (minNormalized && normalized < minNormalized) return true;
		if (maxNormalized && normalized > maxNormalized) return true;
		return false;
	}

	function formatCompactMonthLabel(selected: Date): string {
		return selectedMonthShortFormatter.format(selected);
	}

	function formatSelectedLabel(
		selected: Date | null,
		mode: PickerDepth,
		emptyLabel: string,
		useLongMonth: boolean
	): string {
		if (!selected) return emptyLabel;
		if (mode === 'day') {
			return useLongMonth
				? selectedDayLongFormatter.format(selected)
				: selectedDayShortFormatter.format(selected);
		}
		if (mode === 'month') {
			return useLongMonth
				? selectedMonthLongFormatter.format(selected)
				: formatCompactMonthLabel(selected);
		}
		return selectedYearFormatter.format(selected);
	}

	function recomputeLabelFit() {
		if (selectedLabelShort === selectedLabelLong) {
			showLongLabel = true;
			return;
		}
		if (!triggerValueEl || !measureValueEl) {
			showLongLabel = false;
			return;
		}
		showLongLabel = measureValueEl.scrollWidth <= triggerValueEl.clientWidth;
	}

	function buildCalendarCells(
		year: number,
		month: number,
		selected: Date | null,
		minValue: string,
		maxValue: string
	): DayCell[] {
		const firstOfMonth = new Date(year, month, 1);
		const startOffset = firstOfMonth.getDay();
		const firstCellDate = new Date(year, month, 1 - startOffset);
		const todayIso = toIsoDate(new Date());
		const selectedIso = selected ? toIsoDate(selected) : '';
		const cells: DayCell[] = [];

		for (let index = 0; index < 42; index += 1) {
			const cellDate = new Date(firstCellDate);
			cellDate.setDate(firstCellDate.getDate() + index);
			const iso = toIsoDate(cellDate);
			const inMonth = cellDate.getMonth() === month && cellDate.getFullYear() === year;
			cells.push({
				iso,
				day: cellDate.getDate(),
				inMonth,
				isToday: iso === todayIso,
				isSelected: iso === selectedIso,
				isDisabled: isOutOfBounds(iso, 'day', minValue, maxValue)
			});
		}

		return cells;
	}

	function buildMonthCells(
		year: number,
		currentMonth: number,
		selected: Date | null,
		minValue: string,
		maxValue: string
	): Array<{
		monthIndex: number;
		label: string;
		isCurrent: boolean;
		isSelected: boolean;
		isDisabled: boolean;
	}> {
		const cells: Array<{
			monthIndex: number;
			label: string;
			isCurrent: boolean;
			isSelected: boolean;
			isDisabled: boolean;
		}> = [];
		const selectedYear = selected?.getFullYear();
		const selectedMonth = selected?.getMonth();
		for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
			cells.push({
				monthIndex,
				label: monthShortFormatter.format(new Date(year, monthIndex, 1)),
				isCurrent: monthIndex === currentMonth,
				isSelected: selectedYear === year && selectedMonth === monthIndex,
				isDisabled: isMonthDisabled(year, monthIndex, minValue, maxValue)
			});
		}
		return cells;
	}

	function isMonthDisabled(year: number, month: number, minValue: string, maxValue: string) {
		return isOutOfBounds(toIsoMonth(year, month), 'month', minValue, maxValue);
	}

	function buildYearCells(
		startYear: number,
		currentYear: number,
		selected: Date | null,
		minValue: string,
		maxValue: string
	): Array<{ year: number; isCurrent: boolean; isSelected: boolean; isDisabled: boolean }> {
		const cells: Array<{ year: number; isCurrent: boolean; isSelected: boolean; isDisabled: boolean }> =
			[];
		const selectedYear = selected?.getFullYear();
		for (let offset = 0; offset < 12; offset += 1) {
			const year = startYear + offset;
			cells.push({
				year,
				isCurrent: year === currentYear,
				isSelected: year === selectedYear,
				isDisabled: isYearDisabled(year, minValue, maxValue)
			});
		}
		return cells;
	}

	function decadeStartForYear(year: number) {
		return Math.floor(year / 10) * 10;
	}

	function isYearDisabled(year: number, minValue: string, maxValue: string) {
		return isOutOfBounds(toIsoYear(year), 'year', minValue, maxValue);
	}

	function setOpen(next: boolean) {
		if (disabled && next) return;
		if (open === next) return;
		open = next;
		onOpenChange(next);
	}

	function toggle() {
		setOpen(!open);
	}

	function onTriggerPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		isTriggerPressed = true;
	}

	function onTriggerPointerUp() {
		isTriggerPressed = false;
	}

	function selectDate(iso: string) {
		if (depth !== 'day') return;
		value = iso;
		dispatch('select', iso);
		dispatch('change', iso);
		setOpen(false);
	}

	function shiftMonth(delta: number) {
		const next = new Date(viewYear, viewMonth + delta, 1);
		viewYear = next.getFullYear();
		viewMonth = next.getMonth();
	}

	function shiftYear(delta: number) {
		viewYear += delta;
	}

	function shiftDecade(delta: number) {
		yearGridDecadeStart += delta;
	}

	function toggleHeaderView() {
		if (depth === 'year') return;
		if (depth === 'month') {
			viewMode = viewMode === 'years' ? 'months' : 'years';
			return;
		}
		if (viewMode === 'days') {
			viewMode = 'months';
			return;
		}
		if (viewMode === 'months') {
			yearGridDecadeStart = decadeStartForYear(viewYear);
			viewMode = 'years';
			return;
		}
		viewMode = 'months';
	}

	function selectMonth(monthIndex: number) {
		viewMonth = monthIndex;
		if (depth === 'month') {
			const nextValue = toIsoMonth(viewYear, monthIndex);
			value = nextValue;
			dispatch('select', nextValue);
			dispatch('change', nextValue);
			setOpen(false);
			return;
		}
		viewMode = 'days';
	}

	function selectYear(year: number) {
		if (depth === 'year') {
			const nextValue = toIsoYear(year);
			value = nextValue;
			dispatch('select', nextValue);
			dispatch('change', nextValue);
			setOpen(false);
			return;
		}
		viewYear = year;
		yearGridDecadeStart = decadeStartForYear(year);
		viewMode = 'months';
	}

	function selectToday() {
		const today = new Date();
		const todayYear = today.getFullYear();
		const todayMonth = today.getMonth();
		viewYear = todayYear;
		viewMonth = todayMonth;
		if (depth === 'day') {
			const nextValue = toIsoDate(today);
			if (isOutOfBounds(nextValue, 'day', min, max)) return;
			selectDate(nextValue);
			return;
		}
		if (depth === 'month') {
			const nextValue = toIsoMonth(todayYear, todayMonth);
			if (isOutOfBounds(nextValue, 'month', min, max)) return;
			value = nextValue;
			dispatch('select', nextValue);
			dispatch('change', nextValue);
			setOpen(false);
			return;
		}
		const nextValue = toIsoYear(todayYear);
		if (isOutOfBounds(nextValue, 'year', min, max)) return;
		value = nextValue;
		dispatch('select', nextValue);
		dispatch('change', nextValue);
		setOpen(false);
	}

	function clearSelection() {
		if (!value) return;
		value = '';
		dispatch('select', '');
		dispatch('change', '');
		setOpen(false);
	}

	function handleDocMouseDown(event: MouseEvent) {
		if (!open || !rootEl) return;
		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		if (path.includes(rootEl)) return;
		const target = event.target as Node | null;
		if (target && rootEl.contains(target)) return;
		setOpen(false);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			setOpen(false);
		}
	}

	onMount(() => {
		if (typeof ResizeObserver !== 'undefined') {
			labelResizeObserver = new ResizeObserver(() => {
				recomputeLabelFit();
			});
			if (triggerValueEl) {
				labelResizeObserver.observe(triggerValueEl);
			}
		}
		document.addEventListener('mousedown', handleDocMouseDown);
		document.addEventListener('keydown', handleKeydown);
		scheduleLabelFitCheck(selectedLabelShort, selectedLabelLong);
		return () => {
			if (labelResizeObserver) {
				labelResizeObserver.disconnect();
				labelResizeObserver = null;
			}
			if (typeof window !== 'undefined' && labelFitRafId) {
				window.cancelAnimationFrame(labelFitRafId);
				labelFitRafId = 0;
			}
			document.removeEventListener('mousedown', handleDocMouseDown);
			document.removeEventListener('keydown', handleKeydown);
		};
	});

	onDestroy(() => {
		if (typeof document !== 'undefined' && !document.body.dataset.scrollbarDragCount) {
			document.body.classList.remove('scrollbar-dragging');
		}
	});
</script>

<div
	class="datePicker picker"
	class:open
	bind:this={rootEl}
	on:mousedown|stopPropagation
	on:click|stopPropagation
>
	<button
		class="datePickerBtn pickerBtn"
		class:pressed={isTriggerPressed}
		{id}
		type="button"
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={resolvedMenuId}
		on:click|stopPropagation={toggle}
		on:pointerdown={onTriggerPointerDown}
		on:pointerup={onTriggerPointerUp}
		on:pointercancel={onTriggerPointerUp}
		on:pointerleave={onTriggerPointerUp}
		on:blur={onTriggerPointerUp}
		{disabled}
	>
		<span class="datePickerBtnValue" bind:this={triggerValueEl}>{selectedLabel}</span>
		<span class="datePickerBtnMeasure" aria-hidden="true" bind:this={measureValueEl}>
			{selectedLabelLong}
		</span>
		<span class="chev" aria-hidden="true">▾</span>
	</button>

	<div
		class={`datePickerMenu pickerMenu${open ? ' open' : ''}`}
		id={resolvedMenuId}
		role="dialog"
		aria-label={label}
		on:mousedown|stopPropagation
		on:click|stopPropagation
	>
		<div class="datePickerHeader">
			<button
				type="button"
				class="datePickerNavBtn"
				on:click={() =>
					viewMode === 'years'
						? shiftDecade(-10)
						: viewMode === 'months'
							? shiftYear(-1)
							: shiftMonth(-1)}
				aria-label={viewMode === 'years'
					? 'Previous decade'
					: viewMode === 'months'
						? 'Previous year'
						: 'Previous month'}
			>
				‹
			</button>
			<button
				type="button"
				class="datePickerMonthLabel datePickerHeaderLabelBtn"
				on:click={toggleHeaderView}
				aria-label={depth === 'year'
					? 'Year selection'
					: viewMode === 'days'
						? 'Choose month'
						: viewMode === 'months'
							? 'Choose year'
							: 'Show month selection'}
				aria-pressed={depth === 'year'
					? undefined
					: depth === 'month'
						? viewMode === 'years'
						: viewMode !== 'days'}
				disabled={depth === 'year'}
			>
				{viewMode === 'years' ? yearRangeLabel : viewMode === 'months' ? yearLabel : monthLabel}
			</button>
			<button
				type="button"
				class="datePickerNavBtn"
				on:click={() =>
					viewMode === 'years'
						? shiftDecade(10)
						: viewMode === 'months'
							? shiftYear(1)
							: shiftMonth(1)}
				aria-label={viewMode === 'years'
					? 'Next decade'
					: viewMode === 'months'
						? 'Next year'
						: 'Next month'}
			>
				›
			</button>
		</div>

		{#if viewMode === 'years'}
			<div class="datePickerYearGrid" role="grid" aria-label={yearRangeLabel}>
				{#each yearCells as cell (cell.year)}
					<button
						type="button"
						class="datePickerYearCell"
						class:selected={cell.isSelected}
						disabled={cell.isDisabled}
						aria-current={cell.isSelected ? 'date' : undefined}
						on:click={() => selectYear(cell.year)}
					>
						{cell.year}
					</button>
				{/each}
			</div>
		{:else if viewMode === 'months'}
			<div class="datePickerMonthGrid" role="grid" aria-label={yearLabel}>
				{#each monthCells as cell (cell.monthIndex)}
					<button
						type="button"
						class="datePickerMonthCell"
						class:selected={cell.isSelected}
						disabled={cell.isDisabled}
						aria-current={cell.isSelected ? 'date' : undefined}
						on:click={() => selectMonth(cell.monthIndex)}
					>
						{cell.label}
					</button>
				{/each}
			</div>
		{:else}
			<div class="datePickerWeekdays" aria-hidden="true">
				{#each weekdayLabels as dayLabel (dayLabel)}
					<span>{dayLabel}</span>
				{/each}
			</div>

			<div class="datePickerGrid" role="grid" aria-label={monthLabel}>
				{#each dayCells as cell (cell.iso)}
					<button
						type="button"
						class="datePickerDay"
						class:outside={!cell.inMonth}
						class:selected={cell.isSelected}
						class:today={cell.isToday}
						disabled={cell.isDisabled}
						aria-selected={cell.isSelected}
						aria-label={cell.iso}
						on:click={() => selectDate(cell.iso)}
					>
						{cell.day}
					</button>
				{/each}
			</div>
		{/if}

		<div class="datePickerFooter">
			{#if allowNone}
				<button
					type="button"
					class="datePickerFooterBtn datePickerFooterBtnNone"
					on:click={clearSelection}
					disabled={!value}
				>
					None
				</button>
			{/if}
			<button type="button" class="datePickerFooterBtn" on:click={selectToday}>
				{todayActionLabel}
			</button>
		</div>
	</div>
</div>
