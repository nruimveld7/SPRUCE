<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  type ScheduleRole = 'Member' | 'Maintainer' | 'Manager';
  type ThemePreference = 'system' | 'dark' | 'light';
  type ScheduleMembership = {
    ScheduleId: number;
    Name: string;
    RoleName: ScheduleRole;
    IsDefault: boolean;
    IsActive: boolean;
    ThemeJson?: string | null;
  };
  export let data: {
    schedule: { ScheduleId: number; Name: string } | null;
    userRole: ScheduleRole | null;
    scheduleMemberships: ScheduleMembership[];
    currentUserOid: string | null;
    collapsedGroupsBySchedule: Record<number, Record<string, boolean>>;
    themePreference: ThemePreference;
  };

  let scheduleName = 'Shift Schedule';
  let canMaintainTeam = false;
  let canAssignManagerRole = false;
  let canOpenScheduleSetup = false;

  $: scheduleName = data.schedule?.Name ?? 'Shift Schedule';
  $: canMaintainTeam = data.userRole === 'Maintainer' || data.userRole === 'Manager';
  $: canAssignManagerRole = data.userRole === 'Manager';
  $: canOpenScheduleSetup = canAssignManagerRole || data.scheduleMemberships.length > 1;
</script>

<AppShell
  scheduleName={scheduleName}
  activeScheduleId={data.schedule?.ScheduleId ?? null}
  scheduleMemberships={data.scheduleMemberships}
  groups={[]}
  overrides={{}}
  showLegend={false}
  {canMaintainTeam}
  {canAssignManagerRole}
  {canOpenScheduleSetup}
  currentUserOid={data.currentUserOid ?? ''}
  collapsedGroupsBySchedule={data.collapsedGroupsBySchedule}
  themePreference={data.themePreference}
/>
