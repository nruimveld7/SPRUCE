<script lang="ts">
  import type { MonthDay } from '$lib/utils/date';
  import { indicatorFor } from '$lib/utils/status';
  import type { Employee, ScheduleEvent, Status } from '$lib/types/schedule';
  import { hasHoverEventsForCell, resolveCellEventVisuals } from '$lib/utils/scheduleEvents';

  export let employee: Employee;
  export let groupName = '';
  export let employeeTypeId: number | null = null;
  export let events: ScheduleEvent[] = [];
  export let selectedYear = new Date().getFullYear();
  export let selectedMonthIndex = new Date().getMonth();
  export let rowKey = '';
  export let selectedRowKey: string | null = null;
  export let selectedCellKey: string | null = null;
  export let onSelectRow: (rowKey: string) => void = () => {};
  export let onSelectCell: (cellKey: string) => void = () => {};
  export let onSelectDayCell: (rowKey: string, day: number) => void = () => {};
  export let onOpenDisplayNameEditor: (employee: Employee) => void = () => {};
  export let monthDays: MonthDay[] = [];
  export let overrides: Record<string, { day: number; status: Status }[]>;
  export let selectedDay: number | null = null;
  export let selectedGroupIndex: number | null = null;
  export let groupIndex = -1;
  export let isLastVisibleRow = false;
  export let isFirstInGroup = false;
  export let isLastInGroup = false;
  export let onDoubleClickDayCell: (employee: Employee, day: MonthDay) => void = () => {};
  export let onHoverDayCell: (
    day: MonthDay,
    cellEl: HTMLElement,
    pointer: { clientX: number; clientY: number }
  ) => void = () => {};
  export let onHoverNameCell: (pointer: { clientX: number; clientY: number }) => void = () => {};
  export let onLeaveNameCell: () => void = () => {};
  export let onLeaveDayCell: () => void = () => {};
  const DOUBLE_TAP_WINDOW_MS = 320;
  let lastTouchTapDay: number | null = null;
  let lastTouchTapAtMs = 0;

  $: overrideByDay = new Map(
    (overrides[employee.name] ?? []).map((item) => [item.day, item.status] as const)
  );

  $: rowData = monthDays.map((day) => {
    const eventStatus = overrideByDay.get(day.day) ?? null;
    const dayColor = employee.dayColors?.[day.day] ?? null;
    const month = String(selectedMonthIndex + 1).padStart(2, '0');
    const dayPart = String(day.day).padStart(2, '0');
    const dayIso = `${selectedYear}-${month}-${dayPart}`;
    const eventVisuals = resolveCellEventVisuals(events, dayIso, {
      scopeType: 'user',
      employeeTypeId,
      userOid: employee.userOid ?? null
    });
    const hasHoverEvents = hasHoverEventsForCell(events, dayIso, {
      scopeType: 'user',
      employeeTypeId,
      userOid: employee.userOid ?? null
    });
    return {
      day,
      status: eventStatus,
      indicator: eventStatus ? indicatorFor(eventStatus) : null,
      dayColor,
      eventVisuals,
      hasHoverEvents
    };
  });

  function dayClass(day: MonthDay) {
    return `cell center employeeRowCell${day.isWeekend ? ' wknd' : ''}`;
  }

  $: isRowSelected = selectedRowKey === rowKey;
  $: isNameCellSelected = selectedCellKey === `name:${rowKey}`;
  $: displayName = (() => {
    const trimmed = employee.name.trim();
    if (trimmed.length <= 25) return trimmed;
    return `${trimmed.slice(0, 22)}...`;
  })();

  function handleRowSelect() {
    const key = `name:${rowKey}`;
    if (selectedCellKey === key) {
      onSelectRow(rowKey);
      onSelectCell('');
      return;
    }
    onSelectRow(rowKey);
    onSelectCell(key);
  }

  function handleRowDoubleClick() {
    onOpenDisplayNameEditor(employee);
  }

  function handleDayCellTouchEnd(day: MonthDay, event: TouchEvent) {
    const now = Date.now();
    const isDoubleTap = lastTouchTapDay === day.day && now - lastTouchTapAtMs <= DOUBLE_TAP_WINDOW_MS;
    lastTouchTapDay = day.day;
    lastTouchTapAtMs = now;
    if (!isDoubleTap) return;
    event.preventDefault();
    lastTouchTapDay = null;
    lastTouchTapAtMs = 0;
    onDoubleClickDayCell(employee, day);
  }
</script>

<div
  class={`cell namecol selectableRowCell employeeRowCell${isFirstInGroup ? ' groupStartBorder' : ''}${isLastVisibleRow ? ' lastVisibleRowBoundary' : ''}${isRowSelected ? ' rowSelected rowStart' : ''}${isNameCellSelected ? ' cellSelected' : ''}`}
  role="button"
  tabindex="0"
  aria-pressed={isRowSelected}
  aria-label={`Select row for ${employee.name}`}
  on:click={handleRowSelect}
  on:dblclick={handleRowDoubleClick}
  on:contextmenu={(event) => {
    event.preventDefault();
    handleRowDoubleClick();
  }}
  on:mouseenter={(event) => onHoverNameCell({ clientX: event.clientX, clientY: event.clientY })}
  on:mousemove={(event) => onHoverNameCell({ clientX: event.clientX, clientY: event.clientY })}
  on:mouseleave={onLeaveNameCell}
  on:keydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleRowSelect();
    }
  }}
>
  <div class="person">
    <div class="n">{displayName}</div>
  </div>
</div>

{#each rowData as cell, cellIndex}
  {@const isDayCellSelected = selectedCellKey === `day:${rowKey}:${cell.day.day}`}
  <div
    class={`${dayClass(cell.day)}${isFirstInGroup ? ' groupStartBorder' : ''}${isLastVisibleRow ? ' lastVisibleRowBoundary' : ''}${cell.dayColor ? ' patternCell' : ''}${isRowSelected ? ` rowSelected${cellIndex === rowData.length - 1 ? ' rowEnd' : ''}` : ''}${isDayCellSelected ? ' cellSelected' : ''}`}
    data-scope="employee-day"
    data-group-index={groupIndex}
    data-day={cell.day.day}
    data-group-end={isLastInGroup ? 'true' : undefined}
    role="gridcell"
    tabindex="-1"
    style={cell.dayColor ? `--pattern-cell-bg:${cell.dayColor};` : undefined}
    on:click={() => onSelectDayCell(rowKey, cell.day.day)}
    on:contextmenu={(event) => {
      event.preventDefault();
      onDoubleClickDayCell(employee, cell.day);
    }}
    on:touchend={(event) => handleDayCellTouchEnd(cell.day, event)}
    on:mouseenter={(event) => {
      if (!cell.hasHoverEvents) return;
      onHoverDayCell(cell.day, event.currentTarget as HTMLElement, {
        clientX: event.clientX,
        clientY: event.clientY
      });
    }}
    on:mousemove={(event) => {
      if (!cell.hasHoverEvents) return;
      onHoverDayCell(cell.day, event.currentTarget as HTMLElement, {
        clientX: event.clientX,
        clientY: event.clientY
      });
    }}
    on:mouseleave={onLeaveDayCell}
  >
    {#if cell.eventVisuals.overrideBackground}
      <div
        class="cellShiftOverrideBg"
        style={`--event-shift-override-bg:${cell.eventVisuals.overrideBackground};`}
        aria-hidden="true"
      ></div>
    {/if}
    {#if cell.eventVisuals.overlayBackground}
      <div
        class="cellEventOverlay"
        style={`--event-overlay-bg:${cell.eventVisuals.overlayBackground};`}
        aria-hidden="true"
      ></div>
    {/if}
    {#if cell.indicator}
      {#if cell.indicator.txt}
      <div
        class={`indicator ${cell.indicator.cls}`}
        role="img"
        aria-label={cell.status ?? undefined}
        title={cell.status ?? undefined}
      >
        <span class={`glyph ${cell.indicator.g ?? ''}`}>{cell.indicator.txt}</span>
      </div>
      {:else}
      <div
        class={`indicator ${cell.indicator.cls}`}
        role="img"
        aria-label={cell.status ?? undefined}
        title={cell.status ?? undefined}
      >
      </div>
      {/if}
    {/if}
    {#if cell.eventVisuals.badgeBackground}
      <div
        class="cellEventBadge"
        style={`--event-badge-bg:${cell.eventVisuals.badgeBackground};`}
        aria-hidden="true"
      ></div>
    {/if}
  </div>
{/each}

<style>
  .n {
    white-space: nowrap;
  }
</style>
