export function isAuthRedirectResponse(response: Response): boolean {
	if (response.type === 'opaqueredirect') return true;
	if (response.status === 302 || response.status === 401) return true;
	return response.redirected && response.url.includes('/auth/login');
}

export function redirectToLogin(basePath = ''): void {
	if (typeof window === 'undefined') return;
	window.location.assign(`${basePath}/auth/login`);
}

export async function fetchWithAuthRedirect(
	input: RequestInfo | URL,
	init: RequestInit = {},
	basePath = ''
): Promise<Response | null> {
	const response = await fetch(input, { ...init, redirect: 'manual' });
	if (isAuthRedirectResponse(response)) {
		redirectToLogin(basePath);
		return null;
	}
	return response;
}
