import mssql from 'mssql';
const env = process.env;

function getRequiredEnv(name: string): string {
	const value = env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const config: mssql.config = {
	server: getRequiredEnv('MSSQL_HOST'),
	port: Number(env.MSSQL_PORT ?? 1433),
	user: getRequiredEnv('MSSQL_USER'),
	password: getRequiredEnv('MSSQL_PASSWORD'),
	database: env.MSSQL_DATABASE ?? 'master',
	options: {
		encrypt: (env.MSSQL_ENCRYPT ?? 'false') == 'true',
		trustServerCertificate: (env.MSSQL_TRUST_SERVER_CERT ?? 'true') === 'true'
	}
};

let poolPromise: Promise<mssql.ConnectionPool> | null = null;
const observedPools = new WeakSet<mssql.ConnectionPool>();

const DB_ERROR_CODES = new Set([
	'ESOCKET',
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNCLOSED',
	'ELOGIN',
	'ETIMEOUT',
	'ENOTFOUND'
]);

function getErrorValue(error: unknown, key: string): unknown {
	if (!error || typeof error !== 'object') {
		return undefined;
	}
	return (error as Record<string, unknown>)[key];
}

export function isDatabaseConnectionError(error: unknown): boolean {
	let current: unknown = error;
	let depth = 0;
	while (current && depth < 6) {
		const code = String(getErrorValue(current, 'code') ?? '').toUpperCase();
		const name = String(getErrorValue(current, 'name') ?? '').toUpperCase();
		const message = String(getErrorValue(current, 'message') ?? '').toUpperCase();
		if (
			DB_ERROR_CODES.has(code) ||
			name.includes('CONNECTIONERROR') ||
			message.includes('ECONNRESET') ||
			message.includes('ECONNREFUSED') ||
			message.includes('NO ROUTE TO HOST') ||
			message.includes('CONNECTION LOST') ||
			message.includes('CONNECTION IS CLOSED') ||
			message.includes('FAILED TO CONNECT')
		) {
			return true;
		}
		current = getErrorValue(current, 'cause') ?? getErrorValue(current, 'originalError');
		depth += 1;
	}
	return false;
}

// Prevent unhandled mssql pool errors from terminating the Node process.
mssql.on('error', (error: unknown) => {
	console.error('[db] mssql global error', error);
	poolPromise = null;
});

export const GetPool = async () => {
	if (!poolPromise) {
		poolPromise = mssql.connect(config)
			.then((pool) => {
				if (!observedPools.has(pool)) {
					observedPools.add(pool);
					pool.on('error', (error: unknown) => {
						console.error('[db] SQL connection pool error', error);
						poolPromise = null;
					});
				}
				return pool;
			})
			.catch((error: unknown) => {
				poolPromise = null;
				throw error;
			});
	}
	return poolPromise;
};
