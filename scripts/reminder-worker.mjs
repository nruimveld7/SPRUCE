const endpoint =
	process.env.REMINDER_JOB_ENDPOINT?.trim() ||
	'http://shiftschedule:3000/api/internal/jobs/scheduled-reminders';
const intervalSeconds = Math.max(
	60,
	Number.parseInt(process.env.REMINDER_WORKER_INTERVAL_SECONDS ?? '3600', 10) || 3600
);
const runOnce = process.argv.includes('--once');

function log(message, extra) {
	if (extra === undefined) {
		console.log(`[reminder-worker] ${message}`);
		return;
	}
	console.log(`[reminder-worker] ${message}`, extra);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : 'Unknown error';
}

async function dispatchOnce() {
	const response = await fetch(endpoint, {
		method: 'POST'
	});

	const bodyText = await response.text();
	if (!response.ok) {
		if (response.status === 503) {
			return {
				skipped: true,
				reason: 'database_unavailable',
				status: response.status,
				body: bodyText
			};
		}
		throw new Error(`Dispatch failed (${response.status}): ${bodyText}`);
	}

	try {
		return JSON.parse(bodyText);
	} catch {
		return { raw: bodyText };
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	if (runOnce) {
		const summary = await dispatchOnce();
		log('dispatch complete', summary);
		return;
	}

	log(
		`starting loop endpoint=${endpoint} intervalSeconds=${intervalSeconds} (set REMINDER_WORKER_INTERVAL_SECONDS to change)`
	);
	while (true) {
		const startedAt = Date.now();
		try {
			const summary = await dispatchOnce();
			log('dispatch complete', summary);
		} catch (error) {
			log('dispatch failed', errorMessage(error));
		}

		const elapsedMs = Date.now() - startedAt;
		const sleepMs = Math.max(0, intervalSeconds * 1000 - elapsedMs);
		await sleep(sleepMs);
	}
}

process.on('unhandledRejection', (reason) => {
	log('unhandled rejection', errorMessage(reason));
});

process.on('uncaughtException', (err) => {
	log('uncaught exception', errorMessage(err));
});

main().catch((error) => {
	log('fatal error', errorMessage(error));
	if (runOnce) {
		process.exitCode = 1;
	}
});
