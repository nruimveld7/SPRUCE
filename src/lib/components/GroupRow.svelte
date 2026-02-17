<script lang="ts">
	import type { MonthDay } from '$lib/utils/date';
	import type { ScheduleEvent } from '$lib/types/schedule';
	import { hasHoverEventsForCell, resolveCellEventVisuals } from '$lib/utils/scheduleEvents';

	export let groupName = '';
	export let employeeTypeId: number | null = null;
	export let events: ScheduleEvent[] = [];
	export let selectedYear = new Date().getFullYear();
	export let selectedMonthIndex = new Date().getMonth();
	export let employeeCount = 0;
	export let collapsed = false;
	export let monthDays: MonthDay[] = [];
	export let selectedDay: number | null = null;
	export let selectedGroupIndex: number | null = null;
	export let groupIndex = -1;
	export let isLastVisibleRow = false;
	export let onSelectDay: (day: number) => void = () => {};
	export let onDoubleClickDay: (day: MonthDay) => void = () => {};
	export let onHoverDayCell: (
		day: MonthDay,
		cellEl: HTMLElement,
		pointer: { clientX: number; clientY: number }
	) => void = () => {};
	export let onLeaveDayCell: () => void = () => {};
	export let onToggle: () => void = () => {};
	const DOUBLE_TAP_WINDOW_MS = 320;
	let lastTouchTapDay: number | null = null;
	let lastTouchTapAtMs = 0;
	let suppressClickDay: number | null = null;
	$: memberLabel = employeeCount === 1 ? 'member' : 'members';
	$: ariaLabel = `${groupName}. ${employeeCount} ${memberLabel}. ${collapsed ? 'Collapsed' : 'Expanded'}.`;
	$: caret = collapsed ? '▸' : '▾';
	function dayClass(day: MonthDay) {
		return `cell shiftRowCell${day.isWeekend ? ' wknd' : ''}`;
	}

	function dayIso(day: number): string {
		const month = String(selectedMonthIndex + 1).padStart(2, '0');
		const dayPart = String(day).padStart(2, '0');
		return `${selectedYear}-${month}-${dayPart}`;
	}

	$: dayEventVisuals = new Map(
		monthDays.map((day) => [
			day.day,
			resolveCellEventVisuals(events, dayIso(day.day), {
				scopeType: 'shift',
				employeeTypeId,
				userOid: null
			})
		] as const)
	);
	$: dayHasHoverEvents = new Map(
		monthDays.map((day) => [
			day.day,
			hasHoverEventsForCell(events, dayIso(day.day), {
				scopeType: 'shift',
				employeeTypeId,
				userOid: null
			})
		] as const)
	);

	function handleDayCellClick(day: number, event: MouseEvent) {
		if (suppressClickDay === day) {
			suppressClickDay = null;
			return;
		}
		// Ignore the second click of a double-click sequence.
		if (event.detail > 1) return;
		onSelectDay(day);
	}

	function handleDayCellTouchEnd(day: MonthDay, event: TouchEvent) {
		const now = Date.now();
		const isDoubleTap = lastTouchTapDay === day.day && now - lastTouchTapAtMs <= DOUBLE_TAP_WINDOW_MS;
		lastTouchTapDay = day.day;
		lastTouchTapAtMs = now;
		if (!isDoubleTap) return;
		event.preventDefault();
		suppressClickDay = day.day;
		lastTouchTapDay = null;
		lastTouchTapAtMs = 0;
		onDoubleClickDay(day);
	}
</script>

<div
	class="cell namecol shiftRowCell"
	role="button"
	style="cursor: pointer;"
	tabindex="0"
	aria-expanded={!collapsed}
	aria-label={ariaLabel}
	on:click={onToggle}
	on:keydown={(event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onToggle();
		}
	}}
>
	<div class="groupRow">
		<span style="display:flex;align-items:center;gap:10px;">
			<span class="caret" aria-hidden="true">{caret}</span>
			<span>{groupName}</span>
		</span>
		{#if employeeCount == 1}
			<span class="groupMeta">{employeeCount} member</span>
		{:else}
			<span class="groupMeta">{employeeCount} members</span>
		{/if}
	</div>
</div>

{#each monthDays as day}
	{@const visuals = dayEventVisuals.get(day.day)}
	{@const hasHoverEvents = dayHasHoverEvents.get(day.day) ?? false}
	<div
		class={dayClass(day)}
		data-scope="shift-day"
		data-group-index={groupIndex}
		data-day={day.day}
		role="button"
		tabindex="0"
		aria-label={`Select ${groupName} on day ${day.day}`}
		on:click={(event) => handleDayCellClick(day.day, event)}
		on:dblclick={() => onDoubleClickDay(day)}
		on:touchend={(event) => handleDayCellTouchEnd(day, event)}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onSelectDay(day.day);
			}
		}}
		on:mouseenter={(event) => {
			if (!hasHoverEvents) return;
			onHoverDayCell(day, event.currentTarget as HTMLElement, {
				clientX: event.clientX,
				clientY: event.clientY
			});
		}}
		on:mousemove={(event) => {
			if (!hasHoverEvents) return;
			onHoverDayCell(day, event.currentTarget as HTMLElement, {
				clientX: event.clientX,
				clientY: event.clientY
			});
		}}
		on:mouseleave={onLeaveDayCell}
	>
		{#if visuals?.overrideBackground}
			<div
				class="cellShiftOverrideBg"
				style={`--event-shift-override-bg:${visuals.overrideBackground};`}
				aria-hidden="true"
			></div>
		{/if}
		{#if visuals?.overlayBackground}
			<div
				class="cellEventOverlay"
				style={`--event-overlay-bg:${visuals.overlayBackground};`}
				aria-hidden="true"
			></div>
		{/if}
		{#if visuals?.badgeBackground}
			<div
				class="cellEventBadge"
				style={`--event-badge-bg:${visuals.badgeBackground};`}
				aria-hidden="true"
			></div>
		{/if}
	</div>
{/each}
