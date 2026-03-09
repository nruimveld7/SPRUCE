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

export const GetPool = async () => {
	if (!poolPromise) {
		poolPromise = mssql.connect(config).catch((error: unknown) => {
			poolPromise = null;
			throw error;
		});
	}
	return poolPromise;
};
