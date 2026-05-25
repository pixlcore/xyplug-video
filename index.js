#!/usr/bin/env node

// xyplug-video
// A zero-dependency xyOps Event Plugin for running FFmpeg from JSON specs.
// Copyright (c) 2026 PixlCore LLC
// MIT License

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const XYWP_VERSION = 1;
const DEFAULT_OUTPUT = 'output.mp4';

// Emit a JSON message back to xyOps using the XYWP line-delimited format.
function emitJson(data) {
	// XYWP messages must be compact JSON on one line.
	process.stdout.write(JSON.stringify(Object.assign({ xy: XYWP_VERSION }, data)) + "\n");
}

// Emit a plain text log line for the xyOps job log.
function log(message) {
	// Plain text emitted to stdout is logged by xyOps, and ignored by XYWP.
	process.stdout.write(String(message).replace(/\r?\n$/, '') + "\n");
}

// Convert common form/env truthy values into a real boolean.
function normalizeBoolean(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return !!value;
	if (typeof value === 'string') return !!value.match(/^(1|true|yes|on)$/i);
	return false;
}

// Normalize user-facing IDs into safe FFmpeg label fragments.
function cleanId(value, fallback) {
	// FFmpeg labels are picky, so user-facing IDs are mapped into safe labels.
	const text = String(value || '').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
	return text || fallback;
}

// Validate a file path and reject names that FFmpeg could mistake for flags.
function safePath(value, label) {
	if ((typeof value !== 'string') || !value.trim()) {
		throw new Error(`${label} must be a non-empty string.`);
	}
	if (path.basename(value).startsWith('-')) {
		throw new Error(`${label} cannot have a basename starting with '-': ${value}`);
	}
	return value;
}

// Detect whether a path string contains glob syntax.
function hasGlobMagic(value) {
	// Node's native fs.glob() handles the expansion. This test just decides
	// whether we should call it or treat the path as an exact filename.
	return /[*?[\]{}()!+@]/.test(value);
}

// Parse a JSON plugin parameter that may already be an object.
function parseJsonParam(value, fallback, label) {
	if ((value === undefined) || (value === null) || (value === '')) return fallback;
	if (typeof value === 'object') return value;
	if (typeof value !== 'string') {
		throw new Error(`${label} must be JSON text or an object.`);
	}
	try {
		return JSON.parse(value);
	}
	catch (err) {
		throw new Error(`Failed to parse ${label}: ${err.message}`);
	}
}

// Coerce an optional value into an array, or throw on the wrong shape.
function normalizeArray(value, label) {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value;
	throw new Error(`${label} must be an array.`);
}

// Escape a value for use inside an FFmpeg filter option list.
function formatFilterValue(value) {
	// This escapes only the common FFmpeg filtergraph separators. For advanced
	// expressions, callers can use the raw string form to take full control.
	if (value === true) return '1';
	if (value === false) return '0';
	if (value === null || value === undefined) return '';
	return String(value)
		.replace(/\\/g, '\\\\')
		.replace(/:/g, '\\:')
		.replace(/,/g, '\\,')
		.replace(/;/g, '\\;')
		.replace(/\[/g, '\\[')
		.replace(/\]/g, '\\]');
}

// Convert one JSON filter object or raw string into FFmpeg filter syntax.
function formatFilter(filter) {
	if (typeof filter === 'string') return filter;
	if (!filter || (typeof filter !== 'object')) {
		throw new Error('Each filter must be a string or object.');
	}
	if (filter.raw) return String(filter.raw);

	const name = filter.name || filter.filter;
	if (!name || !String(name).match(/^[A-Za-z0-9_]+$/)) {
		throw new Error(`Invalid FFmpeg filter name: ${name}`);
	}

	// Common expression-style filters can use "expr" for readability.
	if (filter.expr !== undefined) {
		return `${name}=${formatFilterValue(filter.expr)}`;
	}

	// "args" may be a string for raw positional arguments, or an array for
	// positional args separated by colons.
	if (filter.args !== undefined) {
		if (Array.isArray(filter.args)) {
			return `${name}=${filter.args.map(formatFilterValue).join(':')}`;
		}
		return `${name}=${filter.args}`;
	}

	const options = filter.options || filter.params || {};
	const keys = Object.keys(options);
	if (!keys.length) return String(name);

	return `${name}=` + keys.map(function(key) {
		// Convert each option key/value pair into FFmpeg's key=value form.
		return `${key}=${formatFilterValue(options[key])}`;
	}).join(':');
}

// Convert a list of JSON filters into a comma-separated FFmpeg filter chain.
function formatFilterChain(filters) {
	return normalizeArray(filters, 'filters').map(formatFilter).join(',');
}

// Parse one FFmpeg -progress block into a key/value object.
function readProgressBlock(block) {
	const out = {};
	block.split(/\r?\n/).forEach(function(line) {
		// Split each progress line on the first equals sign.
		const idx = line.indexOf('=');
		if (idx > -1) out[line.substring(0, idx)] = line.substring(idx + 1);
	});
	return out;
}

// Read and parse the xyOps job request from STDIN.
async function readJob() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString());
}

// Test whether a readable file exists.
async function fileExists(file) {
	try {
		await fsp.access(file, fs.constants.R_OK);
		return true;
	}
	catch {
		return false;
	}
}

// Resolve an exact input path or glob pattern into one or more files.
async function resolvePattern(pattern, workDir) {
	const requested = safePath(pattern, 'Input path or glob');
	const absolute = path.isAbsolute(requested) ? requested : path.resolve(workDir, requested);

	if (!hasGlobMagic(requested)) {
		if (!(await fileExists(absolute))) {
			throw new Error(`Input file not found: ${requested}`);
		}
		return [absolute];
	}

	if (typeof fsp.glob !== 'function') {
		throw new Error('This Plugin requires Node.js 22 or newer for native fs.glob().');
	}

	const matches = [];
	const globOptions = path.isAbsolute(requested) ? {} : { cwd: workDir };
	for await (const match of fsp.glob(requested, globOptions)) {
		const fullPath = path.isAbsolute(match) ? match : path.resolve(workDir, match);
		const stat = await fsp.stat(fullPath).catch(function() {
			// Ignore disappearing files while glob results are being inspected.
			return null;
		});
		if (stat && stat.isFile()) matches.push(fullPath);
	}

	matches.sort();
	if (!matches.length) throw new Error(`Input glob did not match any files: ${requested}`);
	return matches;
}

// Resolve all declared inputs, including xyOps input-file fallback behavior.
async function resolveInputs(spec, job, workDir) {
	const inputs = [];
	const inputMap = new Map();
	let sourceInputs = normalizeArray(spec.inputs, 'spec.inputs');

	// If the spec omits inputs, fall back to files supplied by xyOps. This keeps
	// the Plugin pleasant for simple workflows that just process the first upload.
	if (!sourceInputs.length) {
		const files = (job.input && Array.isArray(job.input.files)) ? job.input.files : [];
		sourceInputs = files.map(function(file, idx) {
			// Convert xyOps input file metadata into the same shape as spec.inputs.
			return {
				id: idx ? `input${idx}` : 'input',
				path: file.filename
			};
		});
	}

	if (!sourceInputs.length) {
		throw new Error('No inputs were provided. Add spec.inputs or attach files to the job.');
	}

	for (const [idx, input] of sourceInputs.entries()) {
		const id = cleanId(input.id || `input${idx}`, `input${idx}`);
		const pattern = input.path || input.glob || input.file;
		if (!pattern) throw new Error(`Input '${id}' is missing a path or glob.`);

		const matches = await resolvePattern(pattern, workDir);
		let selected = matches[0];
		const select = input.select || 'first';

		if (matches.length > 1) {
			if (select === 'last') selected = matches[matches.length - 1];
			else if (typeof select === 'number') selected = matches[Math.max(0, Math.min(matches.length - 1, select))];
			else if (select !== 'first') throw new Error(`Unsupported select mode for input '${id}': ${select}`);
			log(`Input '${id}' matched ${matches.length} files. Using ${path.basename(selected)}.`);
		}

		const resolved = {
			id,
			index: inputs.length,
			path: selected,
			matches,
			type: input.type || input.kind || '',
			options: input.options || {},
			rawOptions: input.rawOptions || []
		};
		inputs.push(resolved);
		inputMap.set(id, resolved);
	}

	return { inputs, inputMap };
}

// Convert a friendly stream reference into an FFmpeg map value or filter label.
function resolveStreamRef(ref, ctx, mode) {
	if (Array.isArray(ref)) {
		return ref.map(function(item) {
			// Multi-input filters concatenate labels such as [0:v][1:v].
			return resolveStreamRef(item, ctx, mode);
		}).join('');
	}

	const value = String(ref || '').trim();
	if (!value) throw new Error('Stream reference cannot be empty.');

	if (ctx.streamLabels.has(value)) {
		return mode === 'map' ? ctx.streamLabels.get(value) : ctx.streamLabels.get(value);
	}
	if (value.match(/^\[[^\]]+\]$/)) return value;
	if (value.match(/^\d+:[vasd](?::\d+)?\??$/)) return mode === 'map' ? value : `[${value}]`;

	const idMatch = value.match(/^([A-Za-z0-9_]+)(?::([vasd](?::\d+)?\??))?$/);
	if (idMatch && ctx.inputMap.has(idMatch[1])) {
		const input = ctx.inputMap.get(idMatch[1]);
		const stream = idMatch[2] || (input.type === 'audio' ? 'a' : 'v');
		const refText = `${input.index}:${stream}`;
		return mode === 'map' ? refText : `[${refText}]`;
	}

	throw new Error(`Unknown stream reference: ${value}`);
}

// Build input-side FFmpeg arguments from resolved input definitions.
function buildInputArgs(inputs) {
	const args = [];

	inputs.forEach(function(input) {
		// Append input-side flags before the matching -i argument.
		const opts = input.options || {};

		// A few common input-side options get named fields for readability.
		if (opts.stream_loop !== undefined) args.push('-stream_loop', String(opts.stream_loop));
		if (opts.loop !== undefined) args.push('-loop', String(opts.loop));
		if (opts.framerate !== undefined) args.push('-framerate', String(opts.framerate));
		if (opts.start !== undefined) args.push('-ss', String(opts.start));
		if (opts.duration !== undefined) args.push('-t', String(opts.duration));

		normalizeArray(input.rawOptions, `input ${input.id} rawOptions`).forEach(function(arg) {
			// Preserve raw input options exactly as individual argv items.
			args.push(String(arg));
		});

		args.push('-i', input.path);
	});

	return args;
}

// Build the complete -filter_complex graph from named JSON streams.
function buildFilterGraph(spec, ctx) {
	const parts = [];
	const streams = normalizeArray(spec.streams || spec.filters, 'spec.streams');

	streams.forEach(function(stream, idx) {
		// Compile each named stream into one labeled filtergraph segment.
		if (!stream || (typeof stream !== 'object')) throw new Error('Each stream must be an object.');

		const id = cleanId(stream.id || `stream${idx}`, `stream${idx}`);
		const outLabel = `[s${idx}]`;

		if (stream.raw) {
			parts.push(String(stream.raw));
			ctx.streamLabels.set(id, stream.output || outLabel);
			return;
		}

		const from = stream.from || stream.input || (idx ? streams[idx - 1].id : null);
		if (!from) throw new Error(`Stream '${id}' is missing a from reference.`);

		const inputLabel = resolveStreamRef(from, ctx, 'filter');
		const chain = formatFilterChain(stream.filters || stream.chain || []);
		if (!chain) throw new Error(`Stream '${id}' has no filters.`);

		parts.push(`${inputLabel}${chain}${outLabel}`);
		ctx.streamLabels.set(id, outLabel);
	});

	if (spec.filter_complex) parts.push(String(spec.filter_complex));
	if (spec.filterComplex) parts.push(String(spec.filterComplex));

	return parts.filter(Boolean).join(';');
}

// Append video or audio codec options onto an FFmpeg argv array.
function pushCodecArgs(args, mediaType, opts) {
	if (!opts || (typeof opts !== 'object')) return;

	const prefix = mediaType === 'video' ? 'v' : 'a';
	if (opts.codec) args.push(`-c:${prefix}`, String(opts.codec));
	if (opts.bitrate) args.push(`-b:${prefix}`, String(opts.bitrate));
	if (mediaType === 'video') {
		if (opts.crf !== undefined) args.push('-crf', String(opts.crf));
		if (opts.preset) args.push('-preset', String(opts.preset));
		if (opts.pix_fmt) args.push('-pix_fmt', String(opts.pix_fmt));
		if (opts.profile) args.push('-profile:v', String(opts.profile));
		if (opts.level) args.push('-level', String(opts.level));
		if (opts.fps) args.push('-r', String(opts.fps));
	}
	else {
		if (opts.sampleRate) args.push('-ar', String(opts.sampleRate));
		if (opts.channels) args.push('-ac', String(opts.channels));
	}
}

// Append stream mapping options for one output definition.
function pushMaps(args, output, ctx) {
	const map = output.map;
	if (!map) return;

	if (Array.isArray(map)) {
		map.forEach(function(item) {
			// Array map form allows explicit mapping order.
			const ref = (typeof item === 'string') ? item : (item.stream || item.ref);
			args.push('-map', resolveStreamRef(ref, ctx, 'map'));
		});
		return;
	}

	if (typeof map === 'object') {
		['video', 'audio', 'subtitle', 'data'].forEach(function(key) {
			// Object map form keeps common stream types easy to read.
			if (map[key]) args.push('-map', resolveStreamRef(map[key], ctx, 'map'));
		});
		return;
	}

	throw new Error('output.map must be an object or array.');
}

// Build output-side FFmpeg arguments and collect files to upload.
function buildOutputArgs(outputs, ctx, workDir) {
	const args = [];
	const files = [];

	outputs.forEach(function(output, idx) {
		// Append all per-output flags immediately before that output path.
		if (!output || (typeof output !== 'object')) throw new Error('Each output must be an object.');

		const outputPath = path.resolve(workDir, safePath(output.path || output.file || DEFAULT_OUTPUT, `Output ${idx} path`));
		files.push(outputPath);

		pushMaps(args, output, ctx);
		pushCodecArgs(args, 'video', output.video);
		pushCodecArgs(args, 'audio', output.audio);

		if (output.video === false) args.push('-vn');
		if (output.audio === false) args.push('-an');
		if (output.shortest) args.push('-shortest');
		if (output.format) args.push('-f', String(output.format));
		if (output.faststart !== false && outputPath.match(/\.mp4$/i)) args.push('-movflags', '+faststart');

		normalizeArray(output.options || output.rawOptions, `output ${idx} options`).forEach(function(arg) {
			// Preserve raw output options exactly as individual argv items.
			args.push(String(arg));
		});

		args.push(outputPath);
	});

	return { args, files };
}

// Normalize the single-output and multi-output spec forms.
function normalizeOutputs(spec) {
	if (Array.isArray(spec.outputs)) return spec.outputs;
	if (spec.output) return [spec.output];
	return [{ path: DEFAULT_OUTPUT }];
}

// Compile the full Video Spec into an FFmpeg argv array.
function buildFFmpegArgs(spec, resolved, workDir) {
	if (spec.raw && Array.isArray(spec.raw.args)) {
		// Raw mode is intentionally small: the user owns every FFmpeg flag, but
		// still gets xyRun output uploading and basic process error handling.
		const rawArgs = spec.raw.args.slice();
		if (rawArgs[0] === 'ffmpeg') rawArgs.shift();
		const rawFiles = normalizeArray(spec.raw.outputs || spec.raw.files, 'spec.raw.outputs')
			.map(function(file) {
				// Resolve declared raw outputs so xyRun can upload them.
				return path.resolve(workDir, safePath(file, 'raw output file'));
			});
		return { args: rawArgs, files: rawFiles };
	}

	const ctx = {
		inputMap: resolved.inputMap,
		streamLabels: new Map()
	};

	const args = [];
	if (spec.overwrite !== false) args.push('-y');
	args.push('-hide_banner', '-nostdin', '-loglevel', String(spec.logLevel || 'warning'), '-progress', 'pipe:1', '-nostats');
	args.push.apply(args, buildInputArgs(resolved.inputs));

	const filterGraph = buildFilterGraph(spec, ctx);
	if (filterGraph) args.push('-filter_complex', filterGraph);

	normalizeArray(spec.options || spec.rawOptions, 'spec.options').forEach(function(arg) {
		// Preserve global raw options exactly as individual argv items.
		args.push(String(arg));
	});

	const outputBuild = buildOutputArgs(normalizeOutputs(spec), ctx, workDir);
	args.push.apply(args, outputBuild.args);

	return { args, files: outputBuild.files, filterGraph };
}

// Probe a media file duration for best-effort progress calculation.
async function probeDuration(file) {
	return await new Promise(function(resolve) {
		// Run ffprobe in a tiny child process and never fail the whole job on probe errors.
		const child = spawn('ffprobe', [
			'-v', 'error',
			'-show_entries', 'format=duration',
			'-of', 'default=noprint_wrappers=1:nokey=1',
			file
		], { stdio: ['ignore', 'pipe', 'ignore'] });

		let stdout = '';
		child.stdout.on('data', function(chunk) {
			// Accumulate ffprobe's duration output.
			stdout += chunk.toString();
		});
		child.on('error', function() {
			// If ffprobe cannot run, progress simply becomes less precise.
			resolve(0);
		});
		child.on('close', function(code) {
			// Resolve with zero duration on malformed or unavailable probe output.
			const duration = parseFloat(stdout.trim());
			resolve(code ? 0 : (Number.isFinite(duration) ? duration : 0));
		});
	});
}

// Run FFmpeg, stream logs, parse progress, and surface nonzero exits.
async function runFFmpeg(args, options) {
	return await new Promise(function(resolve, reject) {
		// Spawn FFmpeg directly with argv, never through a shell.
		const child = spawn('ffmpeg', args, {
			cwd: options.workDir,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdoutBuffer = '';
		let stderrBuffer = '';
		let stderrTail = '';
		let lastProgress = -1;

		child.on('error', reject);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', function(chunk) {
			// Buffer stdout because FFmpeg progress blocks may arrive split.
			stdoutBuffer += chunk;

			// FFmpeg progress output is grouped into key/value blocks ending in
			// progress=continue or progress=end.
			while (stdoutBuffer.match(/progress=(continue|end)\r?\n/)) {
				const match = stdoutBuffer.match(/progress=(continue|end)\r?\n/);
				const end = match.index + match[0].length;
				const block = stdoutBuffer.substring(0, end);
				stdoutBuffer = stdoutBuffer.substring(end);
				const progress = readProgressBlock(block);
				const micros = parseInt(progress.out_time_us || progress.out_time_ms || '0', 10);

				if (options.duration && Number.isFinite(micros)) {
					const pct = Math.max(0, Math.min(0.99, (micros / 1000000) / options.duration));
					if (pct > lastProgress) {
						lastProgress = pct;
						emitJson({ progress: pct });
					}
				}
			}
		});

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', function(chunk) {
			// Keep a bounded tail for error reporting while streaming full log lines.
			stderrTail = (stderrTail + chunk).slice(-16384);
			stderrBuffer += chunk;
			const lines = stderrBuffer.split(/\r?\n/);
			stderrBuffer = lines.pop() || '';
			lines.filter(Boolean).forEach(log);
		});

		child.on('close', function(code, signal) {
			// Resolve or reject when FFmpeg exits, preserving the most useful error line.
			if (stderrBuffer.trim()) log(stderrBuffer.trim());
			if (code) {
				const lastLine = stderrTail.trim().split(/\r?\n/).filter(Boolean).pop();
				reject(new Error(lastLine || `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ''}.`));
				return;
			}
			resolve();
		});
	});
}

// Main plugin entrypoint: read the job, compile the spec, run FFmpeg, and report results.
(async function main() {
	const started = Date.now();
	let job = null;

	try {
		job = await readJob();
	}
	catch (err) {
		emitJson({ code: 1, description: `Failed to parse job JSON: ${err.message}` });
		process.exit(0);
	}

	try {
		const params = job.params || {};
		const workDir = path.resolve(job.cwd || process.cwd());
		if (job.cwd) process.chdir(workDir);

		const spec = parseJsonParam(params.spec || params.config, {}, 'Video Spec');
		const dryRun = normalizeBoolean(params.dry_run || spec.dryRun);

		emitJson({ progress: 0 });

		const isRawMode = !!(spec.raw && Array.isArray(spec.raw.args));
		const resolved = isRawMode ? { inputs: [], inputMap: new Map() } : await resolveInputs(spec, job, workDir);
		const build = buildFFmpegArgs(spec, resolved, workDir);
		const commandPreview = ['ffmpeg'].concat(build.args).map(function(arg) {
			// Quote only preview arguments with whitespace for readable logs.
			return /\s/.test(arg) ? JSON.stringify(arg) : arg;
		}).join(' ');

		log(`Prepared FFmpeg command: ${commandPreview}`);

		if (dryRun) {
			emitJson({
				code: 0,
				data: {
					dryRun: true,
					inputs: resolved.inputs.map(function(input) {
						// Return resolved input details for dry-run inspection.
						return { id: input.id, path: input.path, matches: input.matches.length };
					}),
					outputs: build.files,
					filterGraph: build.filterGraph || '',
					args: build.args
				},
				files: []
			});
			process.exit(0);
		}

		emitJson({ progress: 0.01 });

		const duration = resolved.inputs[0] ? await probeDuration(resolved.inputs[0].path) : 0;
		await runFFmpeg(build.args, { workDir, duration });

		for (const file of build.files) {
			if (!(await fileExists(file))) throw new Error(`Expected output file was not created: ${file}`);
		}

		emitJson({
			code: 0,
			progress: 1,
			data: {
				inputs: resolved.inputs.map(function(input) {
					// Summarize input files in the final job data.
					return {
						id: input.id,
						filename: path.basename(input.path),
						matches: input.matches.length
					};
				}),
				outputs: build.files.map(function(file) {
					// Summarize output files in the final job data.
					return {
						filename: path.basename(file),
						size: fs.statSync(file).size
					};
				}),
				duration_ms: Date.now() - started
			},
			files: build.files
		});
		process.exit(0);
	}
	catch (err) {
		emitJson({ code: 1, description: String(err.message || err) });
		process.exit(0);
	}
})();
