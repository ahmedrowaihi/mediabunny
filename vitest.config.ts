import { defineConfig } from 'vitest/config';
import { webdriverio } from '@vitest/browser-webdriverio';
import path from 'node:path';

const CHROME_PROFILE = 'node_modules/.cache/chrome-profile';

export default defineConfig({
	resolve: {
		alias: {
			'mediabunny': path.resolve(__dirname, './src/index.ts'),
			'@mediabunny/ac3': path.resolve(__dirname, './packages/ac3/dist/bundles/mediabunny-ac3.mjs'),
			'@mediabunny/dts': path.resolve(__dirname, './packages/dts/dist/bundles/mediabunny-dts.mjs'),
			'@mediabunny/truehd': path.resolve(__dirname, './packages/truehd/dist/bundles/mediabunny-truehd.mjs'),
			'@mediabunny/aac-encoder':
				path.resolve(__dirname, './packages/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs'),
			'@mediabunny/flac-encoder':
				path.resolve(__dirname, './packages/flac-encoder/dist/bundles/mediabunny-flac-encoder.mjs'),
			'@mediabunny/mp3-encoder':
				path.resolve(__dirname, './packages/mp3-encoder/dist/bundles/mediabunny-mp3-encoder.mjs'),
			'@mediabunny/prores':
				path.resolve(__dirname, './packages/prores/dist/bundles/mediabunny-prores.mjs'),
			'@mediabunny/server':
				path.resolve(__dirname, './packages/server/src/index.ts'),
			'@mediabunny/rist':
				path.resolve(__dirname, './packages/rist/src/index.ts'),
		},
	},
	test: {
		restoreMocks: true,
		// node-gc tests force collections to check finalization behaviour. --expose-gc is a V8 flag, which
		// worker_threads execArgv rejects, so the whole run needs the forked pool.
		pool: 'forks',
		execArgv: ['--expose-gc'],
		// UV_THREADPOOL_SIZE is set by the `test` script rather than here: libuv reads it when a process starts,
		// so `test.env` lands too late to take effect. See the script for why it is needed.
		projects: [
			{
				extends: true,
				test: {
					name: 'node',
					root: 'test',
					include: ['node/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				extends: true,
				test: {
					name: 'node-gc',
					root: 'test',
					include: ['node-gc/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				extends: true,
				test: {
					name: 'browser',
					root: 'test',
					include: ['browser/**/*.test.ts'],
					browser: {
						enabled: true,
						provider: webdriverio({
							capabilities: {
								// macOS periodically purges files (but not folders) from the default os.tmpdir() cache,
								// leaving a gutted install that bricks the chromedriver setup - so keep the cache
								// somewhere persistent
								'wdio:chromedriverOptions': {
									cacheDir: path.resolve(__dirname, 'node_modules/.cache/webdriver'),
								},
								// Chrome leaks the profile directory it picks for itself when the run ends: 81 of
								// them, 13 GB, filled this machine's disk and the suite then failed with ENOSPC
								// rather than a test result. Naming one keeps it to a single reused directory.
								'goog:chromeOptions': {
									args: [
										'--autoplay-policy=no-user-gesture-required',
										`--user-data-dir=${path.resolve(__dirname, CHROME_PROFILE)}`,
									],
								},
							},
						}),
						instances: [{ browser: 'chrome' }],
						headless: false, // A bunch of features need the head
						screenshotFailures: false,
					},
				},
			},
		],
	},
});
