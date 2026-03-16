import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function requireTrustedClientChain(request: Request): void {
	const mtlsVerify = request.headers.get('x-client-verify');
	const mtlsGate = request.headers.get('x-mtls-route');
	if (mtlsVerify !== 'SUCCESS' || mtlsGate !== 'notifications-v1') {
		throw error(403, 'mTLS client certificate validation failed');
	}
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireTrustedClientChain(request);

	return json({
		endpoint: '/Notifications',
		status: 'ok',
		timestamp: new Date().toISOString(),
		client: {
			subjectDn: request.headers.get('x-client-subject-dn'),
			issuerDn: request.headers.get('x-client-issuer-dn'),
			serial: request.headers.get('x-client-serial'),
			fingerprint: request.headers.get('x-client-fingerprint')
		},
		request: {
			method: request.method,
			path: url.pathname
		}
	});
};

