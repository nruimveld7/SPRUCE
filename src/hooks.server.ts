import type { Handle } from '@sveltejs/kit';
import { error, json, redirect } from '@sveltejs/kit';
import { readSession } from '$lib/server/auth';
import { getAccessState } from '$lib/server/access';
import { isDatabaseConnectionError } from '$lib/server/db';

const PUBLIC_PATHS = ['/auth/login', '/auth/callback', '/auth/error', '/favicon.ico'];
const NOTIFICATIONS_PATH = '/Notifications';
const UNAUTHORIZED_PATH = '/unauthorized';
const SETUP_PATH = '/setup';
const INTERNAL_JOB_PATH_PREFIX = '/api/internal/jobs/';
const DEV_API_PATH_PREFIX = '/api/dev/';
const API_PATH_PREFIX = '/api/';
const DATABASE_DOWN_MESSAGE =
	'Unable To Connect To Database: Report To Schedule Administrator.';

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const isDevApiPath = pathname.startsWith(DEV_API_PATH_PREFIX);
	const isApiPath = pathname.startsWith(API_PATH_PREFIX);

	try {
		if (pathname.startsWith(INTERNAL_JOB_PATH_PREFIX)) {
			// Internal jobs are blocked at nginx and only reachable on the internal docker network.
			return resolve(event);
		}

		if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
			return resolve(event);
		}
		if (pathname === NOTIFICATIONS_PATH || pathname === `${NOTIFICATIONS_PATH}/`) {
			return resolve(event);
		}

		const session = await readSession(event);
		if (!session) {
			throw redirect(302, '/auth/login');
		}

		const access = await getAccessState(session.user.id);
		if (!isDevApiPath) {
			if (access.isBootstrap && !access.hasScheduleUsers && pathname !== SETUP_PATH) {
				throw redirect(302, SETUP_PATH);
			}
			if (!access.hasAccess && pathname !== UNAUTHORIZED_PATH) {
				throw redirect(302, UNAUTHORIZED_PATH);
			}
			if (access.hasAccess && pathname === UNAUTHORIZED_PATH) {
				throw redirect(302, '/');
			}
			if (pathname === SETUP_PATH && !access.isBootstrap) {
				throw redirect(302, '/');
			}
		}

		event.locals.user = session.user;
		return resolve(event);
	} catch (err: unknown) {
		if (isDatabaseConnectionError(err)) {
			if (isApiPath) {
				return json({ message: DATABASE_DOWN_MESSAGE }, { status: 503 });
			}
			throw error(503, DATABASE_DOWN_MESSAGE);
		}
		throw err;
	}
};
