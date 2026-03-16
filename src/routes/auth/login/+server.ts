import type { RequestHandler } from './$types';
import { isHttpError, isRedirect, redirect } from '@sveltejs/kit';
import { getAuthorizeUrl, setAuthState } from '$lib/server/auth';

export const GET: RequestHandler = async ({ cookies, url, request }) => {
	try {
		const { authorizeUrl, state, nonce, codeVerifier } = await getAuthorizeUrl(url, request.headers);

		setAuthState(cookies, { state, nonce, codeVerifier });

		throw redirect(302, authorizeUrl);
	} catch (err) {
		if (isRedirect(err)) {
			throw err;
		}
		const status = isHttpError(err) ? err.status : 500;
		const params = new URLSearchParams({
			reason: 'login_failed',
			status: String(status)
		});
		throw redirect(302, `/auth/error?${params.toString()}`);
	}
};
