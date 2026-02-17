<script lang="ts">
	import { afterUpdate, onDestroy, onMount } from 'svelte';

	let viewportEl: HTMLDivElement | null = null;
	let railEl: HTMLDivElement | null = null;
	let showScrollbar = false;
	let thumbWidthPx = 0;
	let thumbLeftPx = 0;
	let isDragging = false;
	let dragStartX = 0;
	let dragStartThumbLeftPx = 0;
	let viewportResizeObserver: ResizeObserver | null = null;
	let contentResizeObserver: ResizeObserver | null = null;
	let contentMutationObserver: MutationObserver | null = null;

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
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

	function updateScrollbar() {
		if (!viewportEl) return;
		const scrollWidth = viewportEl.scrollWidth;
		const clientWidth = viewportEl.clientWidth;
		const scrollLeft = viewportEl.scrollLeft;
		const hasOverflow = scrollWidth > clientWidth + 1;

		showScrollbar = hasOverflow;
		if (!hasOverflow) {
			thumbWidthPx = 0;
			thumbLeftPx = 0;
			return;
		}

		const railWidth = railEl?.clientWidth ?? Math.max(clientWidth - 16, 0);
		if (railWidth <= 0) return;

		const minThumbWidth = 48;
		const nextThumbWidth = Math.max(minThumbWidth, (railWidth * clientWidth) / scrollWidth);
		const maxThumbLeft = Math.max(railWidth - nextThumbWidth, 0);
		const maxScrollLeft = Math.max(scrollWidth - clientWidth, 1);
		const nextThumbLeft = (scrollLeft / maxScrollLeft) * maxThumbLeft;

		thumbWidthPx = nextThumbWidth;
		thumbLeftPx = clamp(nextThumbLeft, 0, maxThumbLeft);
	}

	function observeViewportContent() {
		if (!viewportEl || typeof window === 'undefined') return;
		disconnectViewportContentObservers();
		viewportResizeObserver = new ResizeObserver(() => updateScrollbar());
		viewportResizeObserver.observe(viewportEl);

		const contentEl = viewportEl.firstElementChild as HTMLElement | null;
		if (contentEl) {
			contentResizeObserver = new ResizeObserver(() => updateScrollbar());
			contentResizeObserver.observe(contentEl);
		}

		contentMutationObserver = new MutationObserver(() => updateScrollbar());
		contentMutationObserver.observe(viewportEl, { childList: true, subtree: true, characterData: true });
	}

	function disconnectViewportContentObservers() {
		if (viewportResizeObserver) {
			viewportResizeObserver.disconnect();
			viewportResizeObserver = null;
		}
		if (contentResizeObserver) {
			contentResizeObserver.disconnect();
			contentResizeObserver = null;
		}
		if (contentMutationObserver) {
			contentMutationObserver.disconnect();
			contentMutationObserver = null;
		}
	}

	function onViewportScroll() {
		if (!isDragging) {
			updateScrollbar();
		}
	}

	function onDragMove(event: MouseEvent) {
		if (!isDragging || !viewportEl || !railEl) return;
		const railWidth = railEl.clientWidth;
		const maxThumbLeft = Math.max(railWidth - thumbWidthPx, 0);
		const nextThumbLeft = clamp(dragStartThumbLeftPx + (event.clientX - dragStartX), 0, maxThumbLeft);
		const maxScrollLeft = Math.max(viewportEl.scrollWidth - viewportEl.clientWidth, 0);
		thumbLeftPx = nextThumbLeft;
		viewportEl.scrollLeft = maxThumbLeft > 0 ? (nextThumbLeft / maxThumbLeft) * maxScrollLeft : 0;
	}

	function stopDragging() {
		if (isDragging) {
			setGlobalScrollbarDragging(false);
		}
		isDragging = false;
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onDragMove);
			window.removeEventListener('mouseup', stopDragging);
		}
	}

	function startThumbDrag(event: MouseEvent) {
		if (!showScrollbar) return;
		event.preventDefault();
		event.stopPropagation();
		isDragging = true;
		setGlobalScrollbarDragging(true);
		dragStartX = event.clientX;
		dragStartThumbLeftPx = thumbLeftPx;
		window.addEventListener('mousemove', onDragMove);
		window.addEventListener('mouseup', stopDragging);
	}

	function onRailClick(event: MouseEvent) {
		if (!viewportEl || !railEl || !showScrollbar) return;
		if (event.target !== railEl) return;
		const rect = railEl.getBoundingClientRect();
		const desiredLeft = clamp(
			event.clientX - rect.left - thumbWidthPx / 2,
			0,
			Math.max(rect.width - thumbWidthPx, 0)
		);
		const maxThumbLeft = Math.max(rect.width - thumbWidthPx, 1);
		const maxScrollLeft = Math.max(viewportEl.scrollWidth - viewportEl.clientWidth, 0);
		viewportEl.scrollLeft = (desiredLeft / maxThumbLeft) * maxScrollLeft;
		updateScrollbar();
	}

	onMount(() => {
		updateScrollbar();
		observeViewportContent();
		requestAnimationFrame(() => {
			updateScrollbar();
			requestAnimationFrame(() => updateScrollbar());
		});
		if (typeof window === 'undefined') return;
		const onResize = () => updateScrollbar();
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			disconnectViewportContentObservers();
		};
	});

	afterUpdate(() => {
		updateScrollbar();
	});

	onDestroy(() => {
		stopDragging();
		disconnectViewportContentObservers();
	});
</script>

<div class="teamSetupHScrollWrap">
	<div class="teamSetupHScrollViewport" bind:this={viewportEl} on:scroll={onViewportScroll}>
		<slot />
	</div>
	{#if showScrollbar}
		<div
			class="teamSetupHScrollRail"
			bind:this={railEl}
			role="presentation"
			on:mousedown={onRailClick}
		>
			<div
				class={`teamSetupHScrollThumb${isDragging ? ' dragging' : ''}`}
				role="presentation"
				style={`width:${thumbWidthPx}px; transform: translateX(${thumbLeftPx}px);`}
				on:mousedown={startThumbDrag}
			></div>
		</div>
	{/if}
</div>

<style>
	.teamSetupHScrollWrap {
		position: relative;
		max-width: 100%;
	}

	.teamSetupHScrollViewport {
		overflow-x: auto;
		overflow-y: hidden;
		max-width: 100%;
		padding-bottom: calc(6px + var(--scrollbar-size));
		scrollbar-width: none;
		-ms-overflow-style: none;
	}

	.teamSetupHScrollViewport::-webkit-scrollbar {
		width: 0;
		height: 0;
	}

	.teamSetupHScrollRail {
		position: sticky;
		bottom: 4px;
		margin: 0 8px;
		height: var(--scrollbar-size);
		border-radius: var(--scrollbar-radius);
		background: var(--scrollbar-track-bg);
		z-index: 2;
	}

	.teamSetupHScrollThumb {
		height: 100%;
		border-radius: var(--scrollbar-radius);
		background: var(--scrollbar-thumb-bg);
		border: var(--scrollbar-thumb-border);
		cursor: grab;
	}

	.teamSetupHScrollThumb:hover {
		background: var(--scrollbar-thumb-bg-hover);
	}

	.teamSetupHScrollThumb.dragging {
		background: var(--scrollbar-thumb-bg-hover);
		cursor: grabbing;
	}
</style>
