export type Status = 'WORK' | 'OFF' | 'VAC' | 'HLDY' | 'OOT';
export type EventScopeType = 'global' | 'shift' | 'user';
export type EventDisplayMode = 'Schedule Overlay' | 'Badge Indicator' | 'Shift Override';

export type ScheduleEvent = {
	eventId: number;
	scopeType: EventScopeType;
	employeeTypeId: number | null;
	userOid: string | null;
	startDate: string;
	endDate: string;
	eventDisplayMode: EventDisplayMode;
	eventCodeColor: string;
};

export type Employee = {
	name: string;
	role: string;
	pattern: Status[];
	userOid?: string;
	dayColors?: Record<number, string>;
};

export type Group = {
	category: string;
	employeeTypeId?: number;
	employees: Employee[];
};

export type DayOverride = {
	day: number;
	status: Status;
};
