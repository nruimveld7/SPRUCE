import type { Employee, Status } from '$lib/types/schedule';

export function indicatorFor(status: Status) {
  switch (status) {
    case 'WORK':
      return { cls: 'i-work', txt: '' };
    case 'OFF':
      return { cls: 'i-off', txt: '' };
    case 'VAC':
      return { cls: 'i-vac', txt: 'V', g: 'vac' };
    case 'HLDY':
      return { cls: 'i-hldy', txt: '★', g: 'hldy' };
    case 'OOT':
      return { cls: 'i-oot', txt: 'OT', g: 'oot' };
    default:
      return { cls: 'i-off', txt: '' };
  }
}

export function statusForEmployeeDay(
  emp: Employee,
  day1: number,
  dow: number,
  overrides: Record<string, { day: number; status: Status }[]>
) {
  const patternIndex =
    emp.pattern.length === 7
      ? dow
      : (day1 - 1) % emp.pattern.length;
  const base = emp.pattern[patternIndex] || 'OFF';
  const o = overrides[emp.name];
  if (o) {
    const hit = o.find((x) => x.day === day1);
    if (hit) return hit.status;
  }
  return base;
}
