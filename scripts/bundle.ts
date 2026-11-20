import * as esbuild from 'esbuild';
import process from 'node:process';
import PluginExternalGlobal from 'esbuild-plugin-external-global';
import { inlineWorkerPlugin } from './esbuild/inlined-workers.js';

const LICENSE_BANNER = `/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */`;

/**
 * `__dirname` for an ESM bundle, which has none — esbuild also compiles `import.meta.url` to an empty
 * object in the CJS output, so neither form works in both and the source uses `__dirname` alone. Only
 * the server bundle gets this: it imports `node:url` and `node:path`, which have no place in a browser
 * bundle, and it is the only package that reads a file from beside itself.
 */
const ESM_DIRNAME_BANNER = `${LICENSE_BANNER}
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __pathDirname } from 'node:path';
const __dirname = __pathDirname(__fileURLToPath(import.meta.url));`;

/** Creates UMD and ESM variants, each unminified and minified. */
const createVariants = async (
	entryPoint: string,
	globalName: string,
	outfileBase: string,
	umdExtension: string,
	specificUmdConfig: esbuild.BuildOptions = {},
	specificEsmConfig: esbuild.BuildOptions = {},
	nodeUmdVariant = false,
) => {
	const baseConfig: esbuild.BuildOptions = {
		entryPoints: [entryPoint],
		bundle: true,
		logLevel: 'info',
		target: 'es2021',
		logOverride: {
			'import-is-undefined': 'silent', // Warning caused by the disabled "node.ts" import
		},
		banner: {
			js: LICENSE_BANNER,
		},
		legalComments: 'none',
	};

	const umdConfig: esbuild.BuildOptions = {
		...baseConfig,
		format: 'iife',
		globalName,
		footer: {
			js:
`if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, ${globalName})`,
		},
	};

	const esmConfig: esbuild.BuildOptions = {
		...baseConfig,
		format: 'esm',
	};

	const umdVariant = await esbuild.context({
		...umdConfig,
		...specificUmdConfig,
		outfile: `${outfileBase}.${umdExtension}`,
	});

	const esmVariant = await esbuild.context({
		...esmConfig,
		...specificEsmConfig,
		outfile: `${outfileBase}.mjs`,
	});

	const umdMinifiedVariant = await esbuild.context({
		...umdConfig,
		...specificUmdConfig,
		outfile: `${outfileBase}.min.${umdExtension}`,
		minify: true,
	});

	const esmMinifiedVariant = await esbuild.context({
		...esmConfig,
		...specificEsmConfig,
		outfile: `${outfileBase}.min.mjs`,
		minify: true,
	});

	const variants = [umdVariant, esmVariant, umdMinifiedVariant, esmMinifiedVariant];

	if (nodeUmdVariant) {
		const nodeVariant = await esbuild.context({
			...umdConfig,
			...specificUmdConfig,
			outfile: `${outfileBase}.node.${umdExtension}`,
			platform: 'node', // This is different
		});
		variants.push(nodeVariant);
	}

	return variants;
};

const mediabunnyVariants = await createVariants(
	'src/index.ts',
	'Mediabunny',
	'dist/bundles/mediabunny',
	'cjs',
	undefined,
	undefined,
	true,
);

// Standalone file containing all of Mediabunny's worker programs, for environments that can't run blob: workers
const mediabunnyWorker = await esbuild.context({
	entryPoints: ['src/worker.ts'],
	bundle: true,
	minify: true,
	format: 'iife',
	target: 'es2021',
	logLevel: 'info',
	banner: {
		js: LICENSE_BANNER,
	},
	legalComments: 'none',
	outfile: 'dist/bundles/mediabunny.worker.js',
});

const mp3EncoderVariants = await createVariants(
	'packages/mp3-encoder/src/index.ts',
	'MediabunnyMp3Encoder',
	'packages/mp3-encoder/dist/bundles/mediabunny-mp3-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin('@mediabunny/mp3-encoder:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin('@mediabunny/mp3-encoder:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const ac3Variants = await createVariants(
	'packages/ac3/src/index.ts',
	'MediabunnyAc3',
	'packages/ac3/dist/bundles/mediabunny-ac3',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin('@mediabunny/ac3:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin('@mediabunny/ac3:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const dtsVariants = await createVariants(
	'packages/dts/src/index.ts',
	'MediabunnyDts',
	'packages/dts/dist/bundles/mediabunny-dts',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin('@mediabunny/dts:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin('@mediabunny/dts:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const trueHdVariants = await createVariants(
	'packages/truehd/src/index.ts',
	'MediabunnyTrueHd',
	'packages/truehd/dist/bundles/mediabunny-truehd',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin('@mediabunny/truehd:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin('@mediabunny/truehd:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const aacEncoderVariants = await createVariants(
	'packages/aac-encoder/src/index.ts',
	'MediabunnyAacEncoder',
	'packages/aac-encoder/dist/bundles/mediabunny-aac-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin('@mediabunny/aac-encoder:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin('@mediabunny/aac-encoder:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const flacEncoderVariants = await createVariants(
	'packages/flac-encoder/src/index.ts',
	'MediabunnyFlacEncoder',
	'packages/flac-encoder/dist/bundles/mediabunny-flac-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin('@mediabunny/flac-encoder:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin('@mediabunny/flac-encoder:workerUrl', {
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const proresVariants = await createVariants(
	'packages/prores/src/index.ts',
	'MediabunnyProres',
	'packages/prores/dist/bundles/mediabunny-prores',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependency)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
		],
	},
	{
		external: ['mediabunny'],
		platform: 'node', // To retain the Node imports
	},
);

// `turbores` is ESM-only - its `exports` states no `require` - so leaving it external made the CJS
// bundle emit a `__require("turbores")` that no CommonJS consumer could resolve. It carries no native
// addon, so it is inlined instead, and `@mediabunny/prores` with it: that package ships no CJS build, so
// requiring it loads its `.mjs` and with it a second copy of Mediabunny. `node-av` stays external
// because it does carry an addon.
// `koffi` stays external for the same reason `node-av` does: it resolves a platform-specific native
// addon for itself at runtime, and inlining it leaves a bundle whose `require` cannot find the binary.
// The CJS bundle is what catches this - `the CommonJS bundle can actually be required` in
// server-extension.test.ts fails on a loader error rather than on anything SRT-shaped.
const SERVER_EXTERNALS = ['mediabunny', 'node-av', 'node-av/*', 'koffi'];

const serverVariants = await createVariants(
	'packages/server/src/index.ts',
	'MediabunnyServer',
	'packages/server/dist/bundles/mediabunny-server',
	'cjs',
	{
		platform: 'node',
		external: SERVER_EXTERNALS,
	},
	{
		// The libsrt binding resolves the build shipped in `prebuilt/` from this module's own directory,
		// which an ESM bundle has no `__dirname` for
		banner: { js: ESM_DIRNAME_BANNER },
		platform: 'node',
		external: SERVER_EXTERNALS,
	},
);

const contexts = [
	...mediabunnyVariants,
	mediabunnyWorker,
	...mp3EncoderVariants,
	...ac3Variants,
	...dtsVariants,
	...trueHdVariants,
	...aacEncoderVariants,
	...flacEncoderVariants,
	...proresVariants,
	...serverVariants,
];

if (process.argv[2] === '--watch') {
	await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
	for (const ctx of contexts) {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
