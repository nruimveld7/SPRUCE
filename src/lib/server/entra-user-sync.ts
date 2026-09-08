import { GetPool } from '$lib/server/db';

const ENTRA_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const MAX_GRAPH_CONCURRENCY = 6;

const nextAllowedSyncAtBySchedule = new Map<number, number>();
const inFlightSyncBySchedule = new Map<number, Promise<void>>();

type GraphUserById = {
	displayName?: string | null;
	givenName?: string | null;
	surname?: string | null;
	mail?: string | null;
	userPrincipalName?: string | null;
};

export type EntraEmailLookupResult = {
	found: boolean;
	email: string | null;
	fullName: string | null;
	givenName: string | null;
	surname: string | null;
};

function normalizeOptionalEmail(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function normalizeOptionalText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export async function fetchUserEmailByOid(
	accessToken: string,
	userOid: string
): Promise<EntraEmailLookupResult> {
	const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userOid)}?$select=id,displayName,givenName,surname,mail,userPrincipalName`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});

	if (response.status === 404) {
		return { found: false, email: null, fullName: null, givenName: null, surname: null };
	}
	if (!response.ok) {
		const details = await response.text();
		throw new Error(`Graph lookup failed for ${userOid}: ${response.status} ${details}`);
	}

	const payload = (await response.json()) as GraphUserById;
	const givenName = normalizeOptionalText(payload.givenName);
	const surname = normalizeOptionalText(payload.surname);
	const derivedFullName =
		[givenName, surname].filter((part): part is string => Boolean(part)).join(' ').trim() || null;
	const fullName =
		normalizeOptionalText(payload.displayName) ?? derivedFullName;
	const email =
		normalizeOptionalEmail(payload.mail) ?? normalizeOptionalEmail(payload.userPrincipalName);
	return { found: true, email, fullName, givenName, surname };
}

async function listScheduleUserOids(scheduleId: number): Promise<string[]> {
	const pool = await GetPool();
	const result = await pool.request().input('scheduleId', scheduleId).query(
		`SELECT DISTINCT su.UserOid
		 FROM dbo.ScheduleUsers su
		 WHERE su.ScheduleId = @scheduleId;`
	);

	return (result.recordset as Array<{ UserOid: string }>)
		.map((row) => row.UserOid?.trim())
		.filter((oid): oid is string => Boolean(oid));
}

export async function updateStoredUserFromEntra(
	userOid: string,
	lookup: EntraEmailLookupResult
): Promise<void> {
	// A missing Entra account is expected after someone leaves the organization. Keep the
	// application's last-known identity snapshot so historical schedules remain readable.
	if (!lookup.found) return;

	const pool = await GetPool();
	const email = lookup.email;
	const fullName = lookup.fullName;
	const givenName = lookup.givenName;
	const surname = lookup.surname;
	await pool
		.request()
		.input('userOid', userOid)
		.input('email', email)
		.input('fullName', fullName)
		.input('entraFirstName', givenName)
		.input('entraLastName', surname)
		.query(
			`UPDATE dbo.Users
			 SET DisplayName = CASE
					WHEN @fullName IS NOT NULL
					 AND (
						NULLIF(LTRIM(RTRIM(DisplayName)), '') IS NULL
						OR NULLIF(LTRIM(RTRIM(DisplayName)), '') = NULLIF(LTRIM(RTRIM(FullName)), '')
					 )
					THEN @fullName
					ELSE DisplayName
				 END,
				 Email = @email,
				 FullName = @fullName,
				 EntraFirstName = @entraFirstName,
				 EntraLastName = @entraLastName,
				 UpdatedAt = SYSUTCDATETIME()
			 WHERE UserOid = @userOid
			   AND (
					ISNULL(NULLIF(LTRIM(RTRIM(Email)), ''), '') <> ISNULL(NULLIF(LTRIM(RTRIM(@email)), ''), '')
					OR ISNULL(NULLIF(LTRIM(RTRIM(FullName)), ''), '') <> ISNULL(NULLIF(LTRIM(RTRIM(@fullName)), ''), '')
					OR ISNULL(NULLIF(LTRIM(RTRIM(EntraFirstName)), ''), '') <> ISNULL(NULLIF(LTRIM(RTRIM(@entraFirstName)), ''), '')
					OR ISNULL(NULLIF(LTRIM(RTRIM(EntraLastName)), ''), '') <> ISNULL(NULLIF(LTRIM(RTRIM(@entraLastName)), ''), '')
					OR (@fullName IS NOT NULL AND NULLIF(LTRIM(RTRIM(DisplayName)), '') IS NULL)
			   );`
		);

	// Session identity fields are a cache too. Updating them prevents the next request from
	// continuing to expose claims captured at an earlier login.
	await pool
		.request()
		.input('userOid', userOid)
		.input('email', email)
		.input('fullName', fullName)
		.query(
			`UPDATE dbo.UserSessions
			 SET Email = @email,
				 Name = @fullName
			 WHERE UserOid = @userOid
			   AND (
					ISNULL(NULLIF(LTRIM(RTRIM(Email)), ''), '') <> ISNULL(NULLIF(LTRIM(RTRIM(@email)), ''), '')
					OR ISNULL(NULLIF(LTRIM(RTRIM(Name)), ''), '') <> ISNULL(NULLIF(LTRIM(RTRIM(@fullName)), ''), '')
			   );`
		);
}

export async function reconcileUserProfileByOid(
	accessToken: string,
	userOid: string
): Promise<EntraEmailLookupResult> {
	const lookup = await fetchUserEmailByOid(accessToken, userOid);
	await updateStoredUserFromEntra(userOid, lookup);
	return lookup;
}

// Kept for the mail transport bundle, which resolves the same full profile while obtaining email.
export const reconcileUserEmailByOid = reconcileUserProfileByOid;

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	if (!items.length) return;
	const queue = [...items];

	const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) return;
			await worker(item);
		}
	});

	await Promise.all(runners);
}

async function syncScheduleUserProfiles(params: {
	scheduleId: number;
	accessToken: string;
}): Promise<void> {
	const oids = await listScheduleUserOids(params.scheduleId);
	if (!oids.length) return;

	await runWithConcurrency(oids, MAX_GRAPH_CONCURRENCY, async (userOid) => {
		await reconcileUserProfileByOid(params.accessToken, userOid);
	});
}

export function triggerScheduleUserProfileSync(params: {
	scheduleId: number;
	accessToken: string;
}): void {
	const now = Date.now();
	const nextAllowedAt = nextAllowedSyncAtBySchedule.get(params.scheduleId) ?? 0;
	if (now < nextAllowedAt) return;
	if (inFlightSyncBySchedule.has(params.scheduleId)) return;

	nextAllowedSyncAtBySchedule.set(params.scheduleId, now + ENTRA_SYNC_INTERVAL_MS);
	const syncPromise = syncScheduleUserProfiles(params)
		.catch((syncError) => {
			console.error(
				`[entra-user-sync] scheduleId=${params.scheduleId} profile sync failed:`,
				syncError
			);
		})
		.finally(() => {
			inFlightSyncBySchedule.delete(params.scheduleId);
		});

	inFlightSyncBySchedule.set(params.scheduleId, syncPromise);
}
