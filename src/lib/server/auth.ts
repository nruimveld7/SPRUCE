import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
	SignJWT,
	base64url,
	createRemoteJWKSet,
	importPKCS8,
	jwtVerify
} from 'jose';
import { env } from '$env/dynamic/private';
import { GetPool } from '$lib/server/db';

export type Session = {
	user: {
		id: string;
		email?: string;
		name?: string;
	};
};

type OidcDiscovery = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
};

const AUTH_STATE_COOKIE = 'oidc_state';
const AUTH_NONCE_COOKIE = 'oidc_nonce';
const AUTH_VERIFIER_COOKIE = 'oidc_verifier';
const SESSION_COOKIE = 'app_session';

const AUTH_STATE_MAX_AGE_SEC = 5 * 60;
const SESSION_MAX_AGE_SEC = 8 * 60 * 60;
const COOKIE_SECURE = env.NODE_ENV === 'production';
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

let discoveryPromise: Promise<OidcDiscovery> | null = null;
let lastSessionCleanupAt = 0;

function requireEnv(name: string): string {
	const value = env[name];
	if (!value) {
		throw error(500, `Missing required env var: ${name}`);
	}
	return value;
}

function parseOidList(value: string | undefined): Set<string> {
	if (!value) return new Set();
	const tokens = value
		.split(/[,;\s]+/)
		.map((t) => t.trim())
		.filter(Boolean);
	return new Set(tokens);
}

async function getDiscovery(): Promise<OidcDiscovery> {
	if (!discoveryPromise) {
		const tenantId = requireEnv('ENTRA_TENANT_ID');
		const discoveryUrl = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
		discoveryPromise = fetch(discoveryUrl).then(async (res) => {
			if (!res.ok) {
				throw error(500, `OIDC discovery failed: ${res.status}`);
			}
			return res.json() as Promise<OidcDiscovery>;
		});
	}
	return discoveryPromise;
}

function base64urlFromBuffer(buf: Buffer): string {
	return base64url.encode(buf);
}

function newRandom(size = 32): string {
	return base64urlFromBuffer(randomBytes(size));
}

function pkceChallenge(verifier: string): string {
	const digest = createHash('sha256').update(verifier).digest();
	return base64urlFromBuffer(digest);
}

export async function getAuthorizeUrl(_url: URL) {
	const clientId = requireEnv('ENTRA_CLIENT_ID');
	const redirectUri = requireEnv('ENTRA_REDIRECT_URI');
	const { authorization_endpoint } = await getDiscovery();

	const state = newRandom(32);
	const nonce = newRandom(32);
	const codeVerifier = newRandom(64);
	const codeChallenge = pkceChallenge(codeVerifier);

	const params = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		redirect_uri: redirectUri,
		response_mode: 'query',
		scope: 'openid profile email offline_access User.ReadBasic.All',
		state,
		nonce,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256'
	});

	const authorizeUrl = `${authorization_endpoint}?${params.toString()}`;

	return {
		authorizeUrl,
		state,
		nonce,
		codeVerifier
	};
}

export function setAuthState(
	cookies: RequestEvent['cookies'],
	data: { state: string; nonce: string; codeVerifier: string }
) {
	const cookieOpts = {
		httpOnly: true,
		secure: COOKIE_SECURE,
		sameSite: 'lax' as const,
		path: '/',
		maxAge: AUTH_STATE_MAX_AGE_SEC
	};

	cookies.set(AUTH_STATE_COOKIE, data.state, cookieOpts);
	cookies.set(AUTH_NONCE_COOKIE, data.nonce, cookieOpts);
	cookies.set(AUTH_VERIFIER_COOKIE, data.codeVerifier, cookieOpts);
}

function clearAuthState(cookies: Cookies) {
	const cookieOpts = {
		httpOnly: true,
		secure: COOKIE_SECURE,
		sameSite: 'lax' as const,
		path: '/',
		maxAge: 0
	};
	cookies.set(AUTH_STATE_COOKIE, '', cookieOpts);
	cookies.set(AUTH_NONCE_COOKIE, '', cookieOpts);
	cookies.set(AUTH_VERIFIER_COOKIE, '', cookieOpts);
}

async function createClientAssertion(tokenEndpoint: string): Promise<string> {
	const clientId = requireEnv('ENTRA_CLIENT_ID');
	const keyPath = requireEnv('ENTRA_CLIENT_CERT_PRIVATE_KEY_PATH');
	const certPath = requireEnv('ENTRA_CLIENT_CERT_PUBLIC_CERT_PATH');
	const privateKeyPem = await readFile(keyPath, 'utf8');
	const certPem = await readFile(certPath, 'utf8');

	const privateKey = await importPKCS8(privateKeyPem, 'RS256');
	const now = Math.floor(Date.now() / 1000);
	const { x5t, x5tS256 } = certThumbprints(certPem);

	return new SignJWT({})
		.setProtectedHeader({
			alg: 'RS256',
			typ: 'JWT',
			x5t,
			'x5t#S256': x5tS256
		})
		.setIssuer(clientId)
		.setSubject(clientId)
		.setAudience(tokenEndpoint)
		.setJti(newRandom(16))
		.setIssuedAt(now)
		.setExpirationTime(now + 5 * 60)
		.sign(privateKey);
}

function certThumbprints(pem: string): { x5t: string; x5tS256: string } {
	const der = pemToDer(pem);
	const sha1 = createHash('sha1').update(der).digest();
	const sha256 = createHash('sha256').update(der).digest();
	return {
		x5t: base64url.encode(sha1),
		x5tS256: base64url.encode(sha256)
	};
}

function pemToDer(pem: string): Buffer {
	const cleaned = pem
		.replace(/-----BEGIN CERTIFICATE-----/g, '')
		.replace(/-----END CERTIFICATE-----/g, '')
		.replace(/\s+/g, '');
	return Buffer.from(cleaned, 'base64');
}

type TokenResponse = {
	id_token?: string;
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type?: string;
	scope?: string;
};

type SessionRow = {
	UserOid: string;
	Email: string | null;
	Name: string | null;
	AccessToken: string;
	RefreshToken: string | null;
	ExpiresAt: Date | string | null;
};

async function exchangeCodeForTokens(params: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
}): Promise<TokenResponse> {
	const clientId = requireEnv('ENTRA_CLIENT_ID');
	const { token_endpoint } = await getDiscovery();

	const clientAssertion = await createClientAssertion(token_endpoint);

	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: clientId,
		code: params.code,
		redirect_uri: params.redirectUri,
		code_verifier: params.codeVerifier,
		client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		client_assertion: clientAssertion
	});

	const res = await fetch(token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!res.ok) {
		const text = await res.text();
		throw error(500, `Token exchange failed: ${res.status} ${text}`);
	}

	return res.json() as Promise<TokenResponse>;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
	const clientId = requireEnv('ENTRA_CLIENT_ID');
	const { token_endpoint } = await getDiscovery();

	const clientAssertion = await createClientAssertion(token_endpoint);

	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: clientId,
		refresh_token: refreshToken,
		scope: 'openid profile email offline_access User.ReadBasic.All',
		client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		client_assertion: clientAssertion
	});

	const res = await fetch(token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!res.ok) {
		const text = await res.text();
		throw error(401, `Token refresh failed: ${res.status} ${text}`);
	}

	return res.json() as Promise<TokenResponse>;
}

async function verifyIdToken(params: {
	idToken: string;
	nonce: string;
}): Promise<Record<string, unknown>> {
	const clientId = requireEnv('ENTRA_CLIENT_ID');
	const { issuer, jwks_uri } = await getDiscovery();
	const jwks = createRemoteJWKSet(new URL(jwks_uri));

	const { payload } = await jwtVerify(params.idToken, jwks, {
		issuer,
		audience: clientId
	});

	if (payload.nonce !== params.nonce) {
		throw error(401, 'Invalid nonce');
	}

	return payload as Record<string, unknown>;
}

async function ensureSessionTable() {
	const pool = await GetPool();
	await pool.request().query(`
		IF OBJECT_ID('dbo.UserSessions', 'U') IS NULL
		BEGIN
			CREATE TABLE dbo.UserSessions (
				SessionId uniqueidentifier NOT NULL PRIMARY KEY,
				UserOid nvarchar(64) NOT NULL,
				Email nvarchar(320) NULL,
				Name nvarchar(256) NULL,
				AccessToken nvarchar(max) NOT NULL,
				RefreshToken nvarchar(max) NULL,
				ExpiresAt datetime2 NOT NULL,
				ActiveScheduleId int NULL,
				CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
			);
			CREATE INDEX IX_UserSessions_UserOid ON dbo.UserSessions(UserOid);
		END
		IF COL_LENGTH('dbo.UserSessions', 'ActiveScheduleId') IS NULL
		BEGIN
			ALTER TABLE dbo.UserSessions ADD ActiveScheduleId int NULL;
		END
	`);
}

async function ensureUsersTableExtensions() {
	const pool = await GetPool();
	await pool.request().query(`
		IF COL_LENGTH('dbo.Users', 'DefaultScheduleId') IS NULL
		BEGIN
			ALTER TABLE dbo.Users ADD DefaultScheduleId int NULL;
		END
		IF COL_LENGTH('dbo.Users', 'ScheduleUiStateJson') IS NULL
		BEGIN
			ALTER TABLE dbo.Users ADD ScheduleUiStateJson nvarchar(max) NULL;
		END
		IF COL_LENGTH('dbo.Users', 'ScheduleUiStateJson') IS NOT NULL
		BEGIN
			EXEC(N'
				UPDATE dbo.Users
				   SET ScheduleUiStateJson = NULL
				 WHERE ScheduleUiStateJson IS NOT NULL
				   AND ISJSON(ScheduleUiStateJson) <> 1;
			');
		END
		IF OBJECT_ID('dbo.CK_Users_ScheduleUiStateJson_IsJson', 'C') IS NULL
		BEGIN
			EXEC(N'
				ALTER TABLE dbo.Users
				ADD CONSTRAINT CK_Users_ScheduleUiStateJson_IsJson
				CHECK (ScheduleUiStateJson IS NULL OR ISJSON(ScheduleUiStateJson) = 1);
			');
		END
		IF NOT EXISTS (
			SELECT 1
			FROM sys.foreign_keys
			WHERE name = 'FK_Users_DefaultSchedule'
			  AND parent_object_id = OBJECT_ID('dbo.Users')
		)
		AND OBJECT_ID('dbo.Schedules', 'U') IS NOT NULL
		BEGIN
			ALTER TABLE dbo.Users WITH CHECK
			ADD CONSTRAINT FK_Users_DefaultSchedule FOREIGN KEY (DefaultScheduleId) REFERENCES dbo.Schedules(ScheduleId);
		END
		IF NOT EXISTS (
			SELECT 1
			FROM sys.indexes
			WHERE name = 'IX_Users_DefaultScheduleId'
			  AND object_id = OBJECT_ID('dbo.Users')
		)
		BEGIN
			CREATE INDEX IX_Users_DefaultScheduleId ON dbo.Users(DefaultScheduleId);
		END
	`);
}

async function cleanupSessions() {
	const now = Date.now();
	if (now - lastSessionCleanupAt < SESSION_CLEANUP_INTERVAL_MS) {
		return;
	}
	lastSessionCleanupAt = now;
	const pool = await GetPool();
	await pool
		.request()
		.query(
			'DELETE FROM dbo.UserSessions WHERE ExpiresAt < DATEADD(day, -30, SYSUTCDATETIME());'
		);
}

function isExpired(expiresAt: Date | string | null): boolean {
	if (!expiresAt) return true;
	const parsed = new Date(expiresAt).getTime();
	if (Number.isNaN(parsed)) return true;
	return parsed < Date.now();
}

async function refreshSessionIfExpired(
	pool: Awaited<ReturnType<typeof GetPool>>,
	sessionId: string,
	row: SessionRow
): Promise<SessionRow | null> {
	if (!isExpired(row.ExpiresAt)) return row;
	if (!row.RefreshToken) return null;

	const refreshed = await refreshTokens(row.RefreshToken);
	if (!refreshed.access_token || !Number.isFinite(refreshed.expires_in) || refreshed.expires_in <= 0) {
		return null;
	}

	const nextRefreshToken = refreshed.refresh_token ?? row.RefreshToken;
	const nextExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

	await pool
		.request()
		.input('sessionId', sessionId)
		.input('accessToken', refreshed.access_token)
		.input('refreshToken', nextRefreshToken)
		.input('expiresAt', nextExpiresAt)
		.query(
			`UPDATE dbo.UserSessions
			 SET AccessToken = @accessToken,
				 RefreshToken = @refreshToken,
				 ExpiresAt = @expiresAt
			 WHERE SessionId = @sessionId;`
		);

	return {
		...row,
		AccessToken: refreshed.access_token,
		RefreshToken: nextRefreshToken,
		ExpiresAt: nextExpiresAt
	};
}

async function upsertUserProfile(user: Session['user']) {
	await ensureUsersTableExtensions();
	const pool = await GetPool();
	await pool
		.request()
		.input('userOid', user.id)
		.input('fullName', user.name ?? null)
		.input('displayName', user.name ?? null)
		.input('email', user.email ?? null)
		.query(
			`MERGE dbo.Users AS target
			 USING (SELECT @userOid AS UserOid) AS source
			 ON target.UserOid = source.UserOid
			 WHEN MATCHED THEN
			   UPDATE SET FullName = @fullName,
						  DisplayName = CASE
							 WHEN NULLIF(LTRIM(RTRIM(target.DisplayName)), '') IS NULL
							 THEN @displayName
							 ELSE target.DisplayName
						  END,
						  Email = @email,
						  UpdatedAt = SYSUTCDATETIME()
			 WHEN NOT MATCHED THEN
			   INSERT (UserOid, FullName, DisplayName, Email)
			   VALUES (@userOid, @fullName, @displayName, @email);`
		);
}

async function ensureBootstrapManager(user: Session['user']) {
	const allowed = parseOidList(env.BOOTSTRAP_MANAGER_OIDS);
	if (!allowed.has(user.id)) return;
	const pool = await GetPool();
	await pool
		.request()
		.input('userOid', user.id)
		.query(
			`MERGE dbo.BootstrapManagers AS target
			 USING (SELECT @userOid AS UserOid) AS source
			 ON target.UserOid = source.UserOid
			 WHEN MATCHED THEN
			   UPDATE SET IsActive = 1,
						  DeletedAt = NULL,
						  DeletedBy = NULL
			 WHEN NOT MATCHED THEN
			   INSERT (UserOid)
			   VALUES (@userOid);`
		);
}

async function createSessionRecord(params: {
	user: Session['user'];
	accessToken: string;
	refreshToken?: string;
	expiresAt: Date;
}): Promise<string> {
	await ensureSessionTable();
	await cleanupSessions();
	const pool = await GetPool();
	const sessionId = randomUUID();
	await pool
		.request()
		.input('sessionId', sessionId)
		.input('userOid', params.user.id)
		.input('email', params.user.email ?? null)
		.input('name', params.user.name ?? null)
		.input('accessToken', params.accessToken)
		.input('refreshToken', params.refreshToken ?? null)
		.input('expiresAt', params.expiresAt)
		.query(
			`INSERT INTO dbo.UserSessions
			 (SessionId, UserOid, Email, Name, AccessToken, RefreshToken, ExpiresAt)
			 VALUES (@sessionId, @userOid, @email, @name, @accessToken, @refreshToken, @expiresAt);`
		);
	return sessionId;
}

function setSessionCookie(cookies: Cookies, token: string) {
	cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: COOKIE_SECURE,
		sameSite: 'lax',
		path: '/',
		maxAge: SESSION_MAX_AGE_SEC
	});
}

export async function finishLogin(event: RequestEvent): Promise<Session | null> {
	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	const errorParam = event.url.searchParams.get('error');

	if (errorParam) {
		throw error(401, `OIDC error: ${errorParam}`);
	}
	if (!code || !state) {
		throw error(400, 'Missing code or state');
	}

	const savedState = event.cookies.get(AUTH_STATE_COOKIE);
	const savedNonce = event.cookies.get(AUTH_NONCE_COOKIE);
	const codeVerifier = event.cookies.get(AUTH_VERIFIER_COOKIE);

	if (!savedState || !savedNonce || !codeVerifier) {
		throw error(401, 'Missing auth state');
	}
	if (state !== savedState) {
		throw error(401, 'Invalid state');
	}

	clearAuthState(event.cookies);

	const redirectUri = requireEnv('ENTRA_REDIRECT_URI');
	const tokens = await exchangeCodeForTokens({
		code,
		codeVerifier,
		redirectUri
	});
	if (!tokens.id_token) {
		throw error(500, 'Missing id_token in token response');
	}

	const claims = await verifyIdToken({ idToken: tokens.id_token, nonce: savedNonce });

	const id = (claims.oid || claims.sub) as string | undefined;
	if (!id) {
		throw error(401, 'Missing oid/sub in id_token');
	}

	const user: Session['user'] = {
		id,
		email: (claims.email || claims.preferred_username || claims.upn) as
			| string
			| undefined,
		name: (claims.name as string | undefined) ?? undefined
	};

	if (!tokens.access_token) {
		throw error(500, 'Missing access_token in token response');
	}

	const session: Session = { user };
	const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
	await upsertUserProfile(user);
	await ensureBootstrapManager(user);
	const sessionId = await createSessionRecord({
		user,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt
	});
	setSessionCookie(event.cookies, sessionId);

	return session;
}

export async function readSession(event: RequestEvent): Promise<Session | null> {
	const token = event.cookies.get(SESSION_COOKIE);
	if (!token) return null;

	try {
		await ensureSessionTable();
		const pool = await GetPool();
		const result = await pool
			.request()
			.input('sessionId', token)
			.query(
				`SELECT TOP (1) UserOid, Email, Name, AccessToken, RefreshToken, ExpiresAt
				 FROM dbo.UserSessions
				 WHERE SessionId = @sessionId;`
			);
		const sessionRow = result.recordset[0] as SessionRow | undefined;
		if (!sessionRow) return null;
		const row = await refreshSessionIfExpired(pool, token, sessionRow);
		if (!row) {
			return null;
		}
		const session = {
			user: {
				id: row.UserOid,
				email: row.Email ?? undefined,
				name: row.Name ?? undefined
			}
		};
		await upsertUserProfile(session.user);
		await ensureBootstrapManager(session.user);
		await cleanupSessions();
		return session;
	} catch {
		return null;
	}
}

export async function getSessionAccessToken(event: RequestEvent): Promise<string> {
	const token = event.cookies.get(SESSION_COOKIE);
	if (!token) {
		throw error(401, 'Missing session');
	}
	await ensureSessionTable();
	const pool = await GetPool();
	const result = await pool
		.request()
		.input('sessionId', token)
		.query(
			`SELECT TOP (1) UserOid, Email, Name, AccessToken, RefreshToken, ExpiresAt
			 FROM dbo.UserSessions
			 WHERE SessionId = @sessionId;`
		);
	const sessionRow = result.recordset[0] as SessionRow | undefined;
	if (!sessionRow) {
		throw error(401, 'Invalid session');
	}
	const row = await refreshSessionIfExpired(pool, token, sessionRow);
	if (!row) {
		throw error(401, 'Session expired');
	}
	await cleanupSessions();
	return row.AccessToken;
}

export async function getActiveScheduleId(
	cookies: RequestEvent['cookies']
): Promise<number | null> {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return null;
	await ensureSessionTable();
	const pool = await GetPool();
	const result = await pool
		.request()
		.input('sessionId', token)
		.query(
			`SELECT TOP (1) ActiveScheduleId
			 FROM dbo.UserSessions
			 WHERE SessionId = @sessionId;`
		);
	const row = result.recordset?.[0];
	return row?.ActiveScheduleId ?? null;
}

export async function setActiveScheduleForSession(
	cookies: RequestEvent['cookies'],
	scheduleId: number
): Promise<void> {
	const token = cookies.get(SESSION_COOKIE);
	if (!token) return;
	await ensureSessionTable();
	const pool = await GetPool();
	await pool
		.request()
		.input('sessionId', token)
		.input('scheduleId', scheduleId)
		.query(
			`UPDATE dbo.UserSessions
			 SET ActiveScheduleId = @scheduleId
			 WHERE SessionId = @sessionId;`
		);
}
