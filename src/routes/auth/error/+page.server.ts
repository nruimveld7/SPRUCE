import type { PageServerLoad } from './$types';

type AuthErrorContent = {
	title: string;
	description: string;
	helpText: string;
};

const FALLBACK_CONTENT: AuthErrorContent = {
	title: 'Sign-in could not be completed',
	description: 'We could not complete the login callback for this session.',
	helpText: 'Try signing in again. If this keeps happening, close other tabs and retry.'
};

const CONTENT_BY_REASON: Record<string, AuthErrorContent> = {
	invalid_state: {
		title: 'Sign-in attempt expired',
		description: 'Your sign-in response no longer matches the active login request for this browser.',
		helpText: 'Try signing in again with a fresh login attempt.'
	},
	missing_auth_state: {
		title: 'Sign-in session was not found',
		description: 'The login state is missing or expired.',
		helpText: 'Try signing in again with a fresh login attempt.'
	},
	invalid_nonce: {
		title: 'Sign-in verification failed',
		description: 'The identity check failed for this login response.',
		helpText: 'Try signing in again with a fresh login attempt.'
	},
	oidc_error: {
		title: 'Identity provider returned an error',
		description: 'Microsoft Entra returned an error while processing your sign-in.',
		helpText: 'Try signing in again with a fresh login attempt.'
	},
	login_failed: {
		title: 'Sign-in could not be started',
		description: 'The sign-in request could not be prepared for this environment.',
		helpText: 'Verify authentication configuration and try again.'
	},
	callback_failed: FALLBACK_CONTENT
};

export const load: PageServerLoad = async ({ url }) => {
	const reason = url.searchParams.get('reason') ?? 'callback_failed';
	const status = url.searchParams.get('status') ?? '401';
	const content = CONTENT_BY_REASON[reason] ?? FALLBACK_CONTENT;

	return {
		reason,
		status,
		...content
	};
};
