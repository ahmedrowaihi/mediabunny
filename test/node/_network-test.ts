import { test } from 'vitest';
import { RetryTimeoutError } from '../../src/errors.js';

// These read from third-party hosts, so a connect failure is a fact about the network rather than
// about this library. A red that can mean "a CDN was slow" cannot be told apart from a regression, so
// a network failure skips and an assertion failure still fails. NETWORK_STRICT makes reachability
// binding again, which is what you want when the question is whether the hosts are up.
const NETWORK_STRICT = process.env['HLS_NETWORK_STRICT'] === '1';

const NETWORK_ERROR_CODES = new Set([
	'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
	'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

const isNetworkFailure = (error: unknown): boolean => {
	for (let current = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
		if (current instanceof RetryTimeoutError) {
			return true;
		}

		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
			return true;
		}

		if (current.name === 'TypeError' && current.message === 'fetch failed') {
			return true;
		}

		// A request abandoned on its own deadline, which is how an unanswered host presents
		if (current.name === 'TimeoutError' || current.name === 'AbortError') {
			return true;
		}
	}

	return false;
};

const runGuarded = async (body: () => Promise<void>, skip: () => void) => {
	try {
		await body();
	} catch (error) {
		if (!NETWORK_STRICT && isNetworkFailure(error)) {
			skip();
			return;
		}

		throw error;
	}
};

/** `test` variants whose failure to reach a host is reported as a skip rather than as a defect. */
// A live publisher takes as long as the machine is busy to get its first bytes across, so tests wait for
// the condition they actually need rather than a sleep long enough on an idle machine.
export const waitUntil = async (predicate: () => boolean, timeoutMs: number, what: string) => {
	const deadline = Date.now() + timeoutMs;

	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
		}

		await new Promise(resolve => setTimeout(resolve, 50));
	}
};

export const makeNetworkTest = (timeout: number) => {
	const networkTest = (name: string, body: () => Promise<void>) => {
		test.concurrent(name, { timeout }, ({ skip }) => runGuarded(body, skip));
	};

	networkTest.serial = (name: string, body: () => Promise<void>) => {
		test(name, { timeout }, ({ skip }) => runGuarded(body, skip));
	};

	return networkTest;
};
