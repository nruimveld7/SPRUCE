<script lang="ts">
  export let mode: 'binary' | 'cycle' = 'binary';
  export let theme: 'light' | 'dark' = 'dark';
  export let themePreference: 'system' | 'light' | 'dark' = 'system';
  export let effectiveTheme: 'light' | 'dark' = 'dark';
  export let onToggle: () => void = () => {};

  const SUN = {
    viewBox: '0 0 24 24',
    circle: { cx: 12, cy: 12, r: 4 },
    path:
      'M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12'
  };

  const MOON = {
    viewBox: '0 0 24 24',
    path: 'M21 14.5A8.5 8.5 0 0 1 9.5 3a6.5 6.5 0 1 0 11.5 11.5Z'
  };

  const SYSTEM = {
    viewBox: '0 0 24 24',
    path:
      'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9.5a1.5 1.5 0 0 1-1.5 1.5H13v1.5h2.5a1 1 0 1 1 0 2h-7a1 1 0 1 1 0-2H11v-1.5H5.5A1.5 1.5 0 0 1 4 15V5.5Z'
  };

  $: isCycleMode = mode === 'cycle';
  $: currentTheme = isCycleMode ? effectiveTheme : theme;
  $: currentPreference = isCycleMode ? themePreference : currentTheme;
  $: currentLabel = currentPreference === 'system' ? 'System' : currentPreference === 'light' ? 'Light' : 'Dark';
  $: nextTheme = isCycleMode
    ? currentPreference === 'system'
      ? 'dark'
      : currentPreference === 'dark'
        ? 'light'
        : 'system'
    : currentTheme === 'light'
      ? 'dark'
      : 'light';
  $: nextLabel = nextTheme === 'system' ? 'System' : nextTheme === 'light' ? 'Light' : 'Dark';
  $: isLight = currentTheme === 'light';
</script>

<button
  class="modeToggle"
  type="button"
  aria-label={`Switch to ${nextLabel} theme mode`}
  aria-pressed={isCycleMode ? currentPreference !== 'system' : isLight}
  title={`Switch to ${nextLabel} theme mode`}
  on:click={onToggle}
>
  <span class="modeIcon" aria-hidden="true">
    {#if isCycleMode && currentPreference === 'system'}
      <svg viewBox={SYSTEM.viewBox} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d={SYSTEM.path} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
      </svg>
    {:else if isLight}
      <svg viewBox={SUN.viewBox} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx={SUN.circle.cx} cy={SUN.circle.cy} r={SUN.circle.r} stroke="currentColor" stroke-width="2" />
        <path
          d={SUN.path}
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    {:else}
      <svg viewBox={MOON.viewBox} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d={MOON.path} stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      </svg>
    {/if}
  </span>
  <span class="modeText">{currentLabel}</span>
</button>
