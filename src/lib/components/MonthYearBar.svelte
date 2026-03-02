<script lang="ts">
	import DatePicker from '$lib/components/DatePicker.svelte';

	export let selectedMonthIndex: number;
	export let selectedYear: number;
	export let onMonthSelect: (value: number) => void = () => {};
	export let onYearSelect: (value: number) => void = () => {};
	export let showCalendarIcon = true;
	export let onToggleView: () => void = () => {};

	let monthPickerOpen = false;

	$: monthValue = `${selectedYear}-${String(selectedMonthIndex + 1).padStart(2, '0')}`;

	function handleMonthChange(event: CustomEvent<string>) {
		const value = event.detail;
		const match = value.match(/^(\d{4})-(\d{2})$/);
		if (!match) return;
		const nextYear = Number(match[1]);
		const nextMonthNumber = Number(match[2]);
		if (
			!Number.isInteger(nextYear) ||
			!Number.isInteger(nextMonthNumber) ||
			nextMonthNumber < 1 ||
			nextMonthNumber > 12
		) {
			return;
		}
		onYearSelect(nextYear);
		onMonthSelect(nextMonthNumber - 1);
	}
</script>

<div class="monthbar-inner">
	<div class="monthbar-controls">
		<DatePicker
			id="monthBtn"
			menuId="monthMenu"
			label="Month"
			depth="month"
			value={monthValue}
			open={monthPickerOpen}
			allowNone={false}
			onOpenChange={(next) => (monthPickerOpen = next)}
			on:change={handleMonthChange}
		/>
	</div>
	<div class="monthbar-heading">
		<button
			type="button"
			class="monthbar-viewToggle"
			aria-label={showCalendarIcon
				? 'Switch to month calendar view'
				: 'Switch to schedule grid view'}
			title={showCalendarIcon ? 'Switch to month calendar view' : 'Switch to schedule grid view'}
			on:click={onToggleView}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				{#if showCalendarIcon}
					<path
						d="M 7 2 a 1 1 0 0 1 1 1 v 1 h 8 V 3 a 1 1 0 1 1 2 0 v 1 h 1 a 3 3 0 0 1 3 3 v 13 a 3 3 0 0 1 -3 3 H 5 a 3 3 0 0 1 -3 -3 V 7 a 3 3 0 0 1 3 -3 h 1 V 3 a 1 1 0 0 1 1 -1 Z m 13 8 H 4 v 10 a 1 1 0 0 0 1 1 h 14 a 1 1 0 0 0 1 -1 V 10 Z M 6 12 h 2 v 2 H 6 v -2 Z m 5 0 h 2 v 2 h -2 Z m 5 0 h 2 v 2 h -2 v -2 Z M 6 16 h 2 v 2 H 6 v -2 Z m 5 0 h 2 v 2 h -2 v -2 Z m 5 0 h 2 v 2 h -2 v -2 Z M 5 6 a 1 1 0 0 0 -1 1 v 1 h 16 V 7 a 1 1 0 0 0 -1 -1 h -1 v 1 a 1 1 0 1 1 -2 0 V 6 H 8 v 1 a 1 1 0 1 1 -2 0 V 6 H 5 Z"
					></path>
				{:else}
					<path
						fill-rule="evenodd"
						clip-rule="evenodd"
						d="M 5 4 H 19 a 2 2 0 0 1 2 2 V 18 a 2 2 0 0 1 -2 2 H 5 a 2 2 0 0 1 -2 -2 V 6 a 2 2 0 0 1 2 -2 Z M 5 7 H 19 V 10 H 5 Z M 5 11 H 19 V 14 H 5 Z M 5 15 H 19 V 18 H 5 Z M 10 4 V 20 H 13 V 4 Z M 15 4 V 20 H 18 V 4 Z"
					></path>
					<path
						fill="none"
						stroke="currentColor"
						stroke-width="1.25"
						stroke-linejoin="round"
						d="M 5 4 H 19 a 2 2 0 0 1 2 2 V 18 a 2 2 0 0 1 -2 2 H 5 a 2 2 0 0 1 -2 -2 V 6 a 2 2 0 0 1 2 -2 Z M 5 7 H 19 V 10 H 5 Z M 5 11 H 19 V 14 H 5 Z M 5 15 H 19 V 18 H 5 Z M 10 4 V 20 H 13 V 4 Z M 15 4 V 20 H 18 V 4 Z"
					></path>
				{/if}
			</svg>
		</button>
	</div>
</div>
