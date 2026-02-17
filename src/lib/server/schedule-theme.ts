type ThemeMode = 'dark' | 'light';
type ThemeFieldKey =
	| 'background'
	| 'text'
	| 'accent'
	| 'todayColor'
	| 'weekendColor'
	| 'weekdayColor'
	| 'pageBorderColor'
	| 'scheduleBorderColor'
	| 'primaryGradient1'
	| 'primaryGradient2'
	| 'secondaryGradient1'
	| 'secondaryGradient2';

export type ScheduleTheme = Record<ThemeMode, Record<ThemeFieldKey, string>>;

export const DEFAULT_SCHEDULE_THEME: ScheduleTheme = {
	dark: {
		background: '#07080b',
		text: '#ffffff',
		accent: '#c8102e',
		todayColor: '#c8102e',
		weekendColor: '#000000',
		weekdayColor: '#161a22',
		pageBorderColor: '#292a30',
		scheduleBorderColor: '#292a30',
		primaryGradient1: '#7a1b2c',
		primaryGradient2: '#2d1118',
		secondaryGradient1: '#361219',
		secondaryGradient2: '#0c0e12'
	},
	light: {
		background: '#f2f3f5',
		text: '#000000',
		accent: '#c8102e',
		todayColor: '#c8102e',
		weekendColor: '#d4d7de',
		weekdayColor: '#f5f6f8',
		pageBorderColor: '#bbbec6',
		scheduleBorderColor: '#bbbec6',
		primaryGradient1: '#f4d7dd',
		primaryGradient2: '#f8f9fb',
		secondaryGradient1: '#faeef0',
		secondaryGradient2: '#f5f6f8'
	}
};

export function getDefaultScheduleThemeJson(): string {
	return JSON.stringify(DEFAULT_SCHEDULE_THEME);
}
