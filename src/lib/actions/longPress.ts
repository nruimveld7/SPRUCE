type LongPressHandler = () => void;

export type LongPressOptions = {
	onLongPress: LongPressHandler;
	delayMs?: number;
	moveTolerancePx?: number;
};

const DEFAULT_DELAY_MS = 550;
const DEFAULT_MOVE_TOLERANCE_PX = 12;
const DUPLICATE_CONTEXT_MENU_WINDOW_MS = 700;

export function longPress(node: HTMLElement, options: LongPressOptions) {
	let currentOptions = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let pointerId: number | null = null;
	let touchId: number | null = null;
	let suppressNextClick = false;
	let lastLongPressAt = 0;

	const clearTimer = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
	};

	const triggerLongPress = () => {
		clearTimer();
		lastLongPressAt = Date.now();
		suppressNextClick = true;
		currentOptions.onLongPress();
	};

	const moveExceededTolerance = (x: number, y: number) => {
		const tolerance = currentOptions.moveTolerancePx ?? DEFAULT_MOVE_TOLERANCE_PX;
		return Math.abs(x - startX) > tolerance || Math.abs(y - startY) > tolerance;
	};

	const startTimer = (x: number, y: number) => {
		startX = x;
		startY = y;
		clearTimer();
		timer = setTimeout(triggerLongPress, currentOptions.delayMs ?? DEFAULT_DELAY_MS);
	};

	const onClickCapture = (event: MouseEvent) => {
		if (!suppressNextClick) return;
		suppressNextClick = false;
		event.preventDefault();
		event.stopImmediatePropagation();
		event.stopPropagation();
	};

	const onContextMenuCapture = (event: MouseEvent) => {
		if (Date.now() - lastLongPressAt > DUPLICATE_CONTEXT_MENU_WINDOW_MS) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		event.stopPropagation();
	};

	const usePointerEvents =
		typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined';

	const onPointerDown = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		pointerId = event.pointerId;
		startTimer(event.clientX, event.clientY);
	};

	const onPointerMove = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		if (pointerId === null || event.pointerId !== pointerId) return;
		if (moveExceededTolerance(event.clientX, event.clientY)) clearTimer();
	};

	const onPointerEnd = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		if (pointerId !== null && event.pointerId !== pointerId) return;
		clearTimer();
		pointerId = null;
	};

	const findTrackedTouch = (touches: TouchList) => {
		if (touchId === null) return null;
		for (let index = 0; index < touches.length; index += 1) {
			const touch = touches.item(index);
			if (touch && touch.identifier === touchId) return touch;
		}
		return null;
	};

	const onTouchStart = (event: TouchEvent) => {
		if (event.touches.length !== 1) return;
		const touch = event.touches.item(0);
		if (!touch) return;
		touchId = touch.identifier;
		startTimer(touch.clientX, touch.clientY);
	};

	const onTouchMove = (event: TouchEvent) => {
		const touch = findTrackedTouch(event.touches);
		if (!touch) return;
		if (moveExceededTolerance(touch.clientX, touch.clientY)) clearTimer();
	};

	const onTouchEnd = () => {
		clearTimer();
		touchId = null;
	};

	node.addEventListener('click', onClickCapture, true);
	node.addEventListener('contextmenu', onContextMenuCapture, true);

	if (usePointerEvents) {
		node.addEventListener('pointerdown', onPointerDown);
		node.addEventListener('pointermove', onPointerMove);
		node.addEventListener('pointerup', onPointerEnd);
		node.addEventListener('pointercancel', onPointerEnd);
	} else {
		node.addEventListener('touchstart', onTouchStart, { passive: true });
		node.addEventListener('touchmove', onTouchMove, { passive: true });
		node.addEventListener('touchend', onTouchEnd);
		node.addEventListener('touchcancel', onTouchEnd);
	}

	return {
		update(nextOptions: LongPressOptions) {
			currentOptions = nextOptions;
		},
		destroy() {
			clearTimer();
			node.removeEventListener('click', onClickCapture, true);
			node.removeEventListener('contextmenu', onContextMenuCapture, true);
			if (usePointerEvents) {
				node.removeEventListener('pointerdown', onPointerDown);
				node.removeEventListener('pointermove', onPointerMove);
				node.removeEventListener('pointerup', onPointerEnd);
				node.removeEventListener('pointercancel', onPointerEnd);
			} else {
				node.removeEventListener('touchstart', onTouchStart);
				node.removeEventListener('touchmove', onTouchMove);
				node.removeEventListener('touchend', onTouchEnd);
				node.removeEventListener('touchcancel', onTouchEnd);
			}
		}
	};
}
