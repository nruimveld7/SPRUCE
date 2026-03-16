<script lang="ts">
	import type { MonthDay } from '$lib/utils/date';
	import type { ScheduleEvent } from '$lib/types/schedule';
	import { hasHoverEventsForCell, resolveCellEventVisuals } from '$lib/utils/scheduleEvents';
	import { longPress } from '$lib/actions/longPress';

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
	export let selectedCellKey: string | null = null;
	export let selectedRowKey: string | null = null;
	export let rowKey = '';
	export let groupIndex = -1;
	export let isLastVisibleRow = false;
	export let mergeFirstTwoColumns = false;
	export let onSelectDay: (day: number) => void = () => {};
	export let onDoubleClickDay: (day: MonthDay) => void = () => {};
	export let onShiftCellContextMenu: (event?: MouseEvent) => void = () => {};
	export let onHoverShiftCell: (pointer: { clientX: number; clientY: number }) => void = () => {};
	export let onLeaveShiftCell: () => void = () => {};
	export let onHoverDayCell: (
		day: MonthDay,
		cellEl: HTMLElement,
		pointer: { clientX: number; clientY: number }
	) => void = () => {};
	export let onLeaveDayCell: () => void = () => {};
	export let onToggle: () => void = () => {};
	$: normalizedGroupWords = groupName
		.trim()
		.split(/\s+/)
		.map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
		.filter((word) => word.length > 0);
	$: normalizedGroupName = normalizedGroupWords.join(' ') || groupName.trim();
	$: memberLabel = employeeCount === 1 ? 'member' : 'members';
	$: ariaLabel = `${normalizedGroupName}. ${employeeCount} ${memberLabel}. ${collapsed ? 'Collapsed' : 'Expanded'}.`;
	$: caret = collapsed ? '▸' : '▾';
	$: showCaret = employeeCount > 0;
	$: isRowSelected =
		selectedRowKey === rowKey ||
		Boolean(selectedCellKey?.startsWith(`collapsed-shift-day:${groupIndex}:`));
	function dayClass(day: MonthDay) {
		return `cell shiftRowCell collapsedGroupBoundary${isLastVisibleRow ? ' lastVisibleRowBoundary' : ''}${day.isWeekend ? ' wknd' : ''}`;
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

	function handleDayCellClick(day: number) {
		onSelectDay(day);
	}

</script>

<div
	class={`cell namecol shiftRowCell collapsedGroupBoundary${isLastVisibleRow ? ' lastVisibleRowBoundary' : ''}${isRowSelected ? ' rowSelected rowStart' : ''}`}
	class:mergeTwoCols={mergeFirstTwoColumns}
	role="button"
	style="cursor: pointer;"
	tabindex="0"
	aria-expanded={!collapsed}
	aria-label={ariaLabel}
	on:click={onToggle}
	on:contextmenu={onShiftCellContextMenu}
	use:longPress={{ onLongPress: () => onShiftCellContextMenu() }}
	on:mouseenter={(event) => onHoverShiftCell({ clientX: event.clientX, clientY: event.clientY })}
	on:mousemove={(event) => onHoverShiftCell({ clientX: event.clientX, clientY: event.clientY })}
	on:mouseleave={onLeaveShiftCell}
	on:keydown={(event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onToggle();
		}
	}}
>
	<div class="groupRow">
		<span style="display:flex;align-items:center;gap:10px;">
			{#if showCaret}
				<span class="caret" aria-hidden="true">{caret}</span>
			{/if}
			<span>{normalizedGroupName}</span>
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
	{@const isCellSelected = selectedCellKey === `collapsed-shift-day:${groupIndex}:${day.day}`}
	<div
		class={`${dayClass(day)}${isCellSelected ? ' cellSelected' : ''}${isRowSelected ? ` rowSelected${day.day === monthDays[monthDays.length - 1]?.day ? ' rowEnd' : ''}` : ''}`}
		data-scope="shift-day"
		data-group-index={groupIndex}
		data-day={day.day}
		role="button"
		tabindex="0"
		aria-label={`Select ${normalizedGroupName} on day ${day.day}`}
		on:click={() => handleDayCellClick(day.day)}
		on:contextmenu={(event) => {
			event.preventDefault();
			onDoubleClickDay(day);
		}}
		use:longPress={{ onLongPress: () => onDoubleClickDay(day) }}
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
