<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-video/refs/heads/main/logo.png" height="160" alt="Video Toolkit"/></p>
<h1 align="center">Video Toolkit</h1>

A [xyOps](https://xyops.io) Marketplace Event Plugin for rendering, transforming, muxing, and transcoding video with [FFmpeg](https://ffmpeg.org), using a friendly JSON specification instead of hand-written shell commands.

This Plugin is designed for workflow automation. It receives input files from xyOps, resolves exact paths or glob patterns, compiles your JSON spec into FFmpeg arguments, runs FFmpeg locally inside Docker, and attaches the generated output files to the job.

The Plugin itself has zero runtime dependencies. It uses only Node.js built-in modules and the `ffmpeg` / `ffprobe` binaries available in the Docker image.

## Highlights

- Runs FFmpeg from JSON, without requiring users to write shell commands
- Supports exact input filenames and glob patterns such as `*.mp4` and `*.mp3`
- Supports named inputs, named filter chains, stream mapping, codecs, CRF, presets, bitrates, `-shortest`, and MP4 faststart
- Supports advanced filters such as `reverse`, `tpad`, `fade`, `setpts`, `fps`, `minterpolate`, `overlay`, `amix`, and any FFmpeg filter name
- Provides a raw escape hatch for expert FFmpeg argv arrays
- Emits xyOps progress updates using FFmpeg's progress stream
- Runs locally on your xyOps worker inside Docker
- Does not require API keys or any hosted video service

## Requirements

- `docker`

This Plugin ships as a prebuilt Docker image with FFmpeg installed, so every xyOps worker that may run it needs Docker installed and available to xySat.

## Environment Variables

None. This Plugin does not require any API key, token, or Secret Vault configuration.

## Data Collection

This Plugin does not collect analytics, telemetry, or usage metrics.

Video processing runs locally inside the Docker container on your xyOps worker. Files are not sent to PixlCore, OpenAI, or any other hosted service by this Plugin.

## Supported Input

The Plugin can read files in two ways:

1. Files attached to the xyOps job input, which xyRun downloads into the job working directory before launch.
2. Paths and glob patterns declared in the JSON spec.

Input paths are resolved from the job working directory. This means common patterns such as `*.mp4`, `*.mov`, `*.mp3`, and `input/*.wav` work naturally.

When a glob matches multiple files, the Plugin sorts the matches alphabetically and uses the first file by default. You can set `select` to `last` or to a zero-based numeric index.

## Output

Generated files are written into the job working directory and attached to the xyOps job output. Attached files can be viewed in the xyOps UI, downloaded from the job details page, or passed to downstream workflow nodes.

Output paths are declared in the JSON spec. Relative output paths are resolved from the job working directory.

## Basic Example

This example reverses the first MP4 file, fades in the result, doubles the frame rate while halving the duration, pads the final frame, maps the first MP3 file as audio, and lets the audio track control the final duration.

```json
{
	"inputs": [
		{
			"id": "video",
			"path": "*.mp4",
			"type": "video"
		},
		{
			"id": "music",
			"path": "*.mp3",
			"type": "audio"
		}
	],
	"streams": [
		{
			"id": "processed",
			"from": "video:v",
			"filters": [
				{ "name": "reverse" },
				{
					"name": "fade",
					"options": {
						"t": "in",
						"st": 0,
						"n": 16
					}
				},
				{
					"name": "setpts",
					"expr": "0.5*PTS"
				},
				{
					"name": "minterpolate",
					"options": {
						"fps": 48,
						"mi_mode": "mci"
					}
				},
				{
					"name": "tpad",
					"options": {
						"stop_mode": "clone",
						"stop_duration": 60
					}
				}
			]
		}
	],
	"output": {
		"path": "final.mp4",
		"map": {
			"video": "processed",
			"audio": "music:a"
		},
		"video": {
			"codec": "libx264",
			"crf": 10,
			"preset": "slow"
		},
		"audio": {
			"codec": "aac",
			"bitrate": "192k"
		},
		"shortest": true,
		"faststart": true
	}
}
```

The Plugin compiles the above into the same basic FFmpeg shape as:

```sh
ffmpeg -i input.mp4 -i bumper1.mp3 -filter_complex "[0:v]reverse,fade=t=in:st=0:n=16,setpts=0.5*PTS,minterpolate=fps=48:mi_mode=mci,tpad=stop_mode=clone:stop_duration=60[s0]" -map "[s0]" -map 1:a -c:v libx264 -crf 10 -preset slow -c:a aac -b:a 192k -shortest -movflags +faststart final.mp4
```

## JSON Format

The top-level JSON object is called the Video Spec.

| Property | Type | Description |
|----------|------|-------------|
| `inputs` | Array | Input files or globs. If omitted, the Plugin uses files attached to the xyOps job. |
| `streams` | Array | Named filter chains. Each chain consumes an input stream or previous named stream and produces a new named stream. |
| `output` | Object | Single output file definition. |
| `outputs` | Array | Multiple output file definitions. Use this instead of `output` for multi-output jobs. |
| `options` | Array | Raw FFmpeg options inserted after inputs and before outputs. |
| `overwrite` | Boolean | Defaults to `true`, which adds `-y`. Set to `false` to keep FFmpeg from overwriting output files. |
| `logLevel` | String | FFmpeg log level. Defaults to `warning`. Use `info` or `verbose` for debugging. |
| `dryRun` | Boolean | Compile and return arguments without rendering. The xyOps parameter named Dry Run does the same thing. |
| `raw` | Object | Expert mode for full FFmpeg argv control. See [Raw Mode](#raw-mode). |

### Inputs

Each input object declares one FFmpeg input.

```json
{
	"id": "video",
	"path": "*.mp4",
	"type": "video",
	"select": "first"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | String | Friendly name used by stream references such as `video:v`. |
| `path` | String | Exact path or glob pattern. |
| `glob` | String | Alias for `path`. |
| `type` | String | Optional hint. Use `video` or `audio` to choose the default stream when no suffix is provided. |
| `select` | String or Number | `first`, `last`, or a zero-based index when a glob matches multiple files. Defaults to `first`. |
| `options` | Object | Named input-side FFmpeg options. |
| `rawOptions` | Array | Raw input-side FFmpeg arguments inserted before `-i`. |

Supported named input options:

| Option | FFmpeg Flag | Description |
|--------|-------------|-------------|
| `stream_loop` | `-stream_loop` | Loop an input stream. |
| `loop` | `-loop` | Loop image inputs. |
| `framerate` | `-framerate` | Input frame rate. |
| `start` | `-ss` | Seek start time before input. |
| `duration` | `-t` | Limit input duration. |

### Stream References

Stream references are used in `from` and `map`.

| Reference | Meaning |
|-----------|---------|
| `video:v` | Video stream from the input named `video`. |
| `music:a` | Audio stream from the input named `music`. |
| `0:v` | Direct FFmpeg input stream reference. |
| `1:a` | Direct FFmpeg input stream reference. |
| `processed` | A named stream created in `streams`. |
| `[custom]` | A raw FFmpeg label. |

### Streams

A stream object describes a named filter chain.

```json
{
	"id": "scaled",
	"from": "video:v",
	"filters": [
		{
			"name": "scale",
			"options": {
				"w": 1280,
				"h": -2
			}
		},
		{
			"name": "fps",
			"options": {
				"fps": 30
			}
		}
	]
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | String | Friendly name for this stream. Use it later in `map` or another stream's `from`. |
| `from` | String or Array | Input stream, previous named stream, or array of streams for multi-input filters. |
| `filters` | Array | Filter chain. |
| `chain` | Array | Alias for `filters`. |
| `raw` | String | Raw filtergraph segment. Advanced users only. |
| `output` | String | Output label used with `raw`. |

### Filters

Filters may be strings or objects.

String form gives you full control:

```json
"setpts=0.5*PTS"
```

Object form is easier to generate from workflow tools:

```json
{
	"name": "tpad",
	"options": {
		"stop_mode": "clone",
		"stop_duration": 0.5
	}
}
```

Expression-style filters can use `expr`:

```json
{
	"name": "setpts",
	"expr": "0.5*PTS"
}
```

Raw positional arguments can use `args`:

```json
{
	"name": "crop",
	"args": ["1280", "720", "0", "0"]
}
```

Any FFmpeg filter name is allowed as long as it only contains letters, numbers, and underscores. The Plugin does not try to maintain a master list of FFmpeg filters, because available filters vary by FFmpeg build.

### Output

Use `output` for one file, or `outputs` for multiple files.

```json
{
	"path": "final.mp4",
	"map": {
		"video": "processed",
		"audio": "music:a"
	},
	"video": {
		"codec": "libx264",
		"crf": 18,
		"preset": "medium",
		"pix_fmt": "yuv420p"
	},
	"audio": {
		"codec": "aac",
		"bitrate": "192k"
	},
	"shortest": true,
	"faststart": true
}
```

| Property | Type | Description |
|----------|------|-------------|
| `path` | String | Output path. Relative paths are resolved from the job working directory. |
| `map` | Object or Array | Stream mapping. |
| `video` | Object or Boolean | Video encoding settings. Set to `false` to add `-vn`. |
| `audio` | Object or Boolean | Audio encoding settings. Set to `false` to add `-an`. |
| `shortest` | Boolean | Adds `-shortest`. Useful when audio should dictate the final duration. |
| `faststart` | Boolean | Defaults to `true` for MP4 output. Set to `false` to skip `-movflags +faststart`. |
| `format` | String | Adds `-f`. |
| `options` | Array | Raw output arguments inserted before the output path. |
| `rawOptions` | Array | Alias for `options`. |

Video settings:

| Property | FFmpeg Flag |
|----------|-------------|
| `codec` | `-c:v` |
| `bitrate` | `-b:v` |
| `crf` | `-crf` |
| `preset` | `-preset` |
| `pix_fmt` | `-pix_fmt` |
| `profile` | `-profile:v` |
| `level` | `-level` |
| `fps` | `-r` |

Audio settings:

| Property | FFmpeg Flag |
|----------|-------------|
| `codec` | `-c:a` |
| `bitrate` | `-b:a` |
| `sampleRate` | `-ar` |
| `channels` | `-ac` |

### Map Formats

Object form is usually nicest:

```json
"map": {
	"video": "processed",
	"audio": "music:a"
}
```

Array form is useful when you need more control:

```json
"map": [
	{ "stream": "processed" },
	{ "stream": "music:a" }
]
```

### Raw Mode

Raw mode lets expert users provide the complete FFmpeg argv array. The Plugin still runs FFmpeg safely with `spawn`, still works with xyRun, and still uploads the output files you list.

```json
{
	"raw": {
		"args": [
			"-y",
			"-i", "input.mp4",
			"-vf", "reverse",
			"-an",
			"output.mp4"
		],
		"outputs": ["output.mp4"]
	}
}
```

Raw mode does not resolve input globs or inject progress flags. It is intended as an escape hatch when a workflow needs something the structured format does not cover yet.

## Common Recipes

### Convert Video to Web MP4

```json
{
	"inputs": [
		{ "id": "input", "path": "*.mov", "type": "video" }
	],
	"output": {
		"path": "web.mp4",
		"map": {
			"video": "input:v",
			"audio": "input:a?"
		},
		"video": {
			"codec": "libx264",
			"crf": 23,
			"preset": "medium",
			"pix_fmt": "yuv420p"
		},
		"audio": {
			"codec": "aac",
			"bitrate": "128k"
		},
		"faststart": true
	}
}
```

### Extract a Thumbnail

```json
{
	"inputs": [
		{
			"id": "input",
			"path": "*.mp4",
			"options": {
				"start": 3
			}
		}
	],
	"output": {
		"path": "thumb.jpg",
		"map": {
			"video": "input:v"
		},
		"video": {
			"codec": "mjpeg"
		},
		"audio": false,
		"options": ["-frames:v", "1"]
	}
}
```

### Overlay One Video on Another

```json
{
	"inputs": [
		{ "id": "base", "path": "base.mp4" },
		{ "id": "pip", "path": "picture-in-picture.mp4" }
	],
	"streams": [
		{
			"id": "small",
			"from": "pip:v",
			"filters": [
				{ "name": "scale", "options": { "w": 480, "h": -2 } }
			]
		},
		{
			"id": "composited",
			"from": ["base:v", "small"],
			"filters": [
				{ "name": "overlay", "options": { "x": "W-w-40", "y": "H-h-40" } }
			]
		}
	],
	"output": {
		"path": "composited.mp4",
		"map": {
			"video": "composited",
			"audio": "base:a?"
		},
		"video": {
			"codec": "libx264",
			"crf": 18,
			"preset": "medium"
		},
		"audio": {
			"codec": "aac",
			"bitrate": "192k"
		}
	}
}
```

## Local Testing

Install Node.js 22 or newer and FFmpeg locally. No NPM packages are required.

Create a temporary working directory and place a sample video and audio file in it:

```sh
mkdir -p /tmp/xyplug-video-test
cp /path/to/input.mp4 /tmp/xyplug-video-test/input.mp4
cp /path/to/music.mp3 /tmp/xyplug-video-test/music.mp3
```

Run the Plugin directly:

```sh
printf '%s\n' '{"xy":1,"cwd":"/tmp/xyplug-video-test","params":{"dry_run":true,"spec":{"inputs":[{"id":"video","path":"*.mp4","type":"video"},{"id":"music","path":"*.mp3","type":"audio"}],"streams":[{"id":"processed","from":"video:v","filters":[{"name":"reverse"},{"name":"setpts","expr":"0.5*PTS"},{"name":"tpad","options":{"stop_mode":"clone","stop_duration":5}}]}],"output":{"path":"final.mp4","map":{"video":"processed","audio":"music:a"},"video":{"codec":"libx264","crf":23,"preset":"medium"},"audio":{"codec":"aac","bitrate":"128k"},"shortest":true}}}}' | node index.js
```

Or build and run the Docker image locally:

```sh
docker build -t xyplug-video:test .

printf '%s\n' '{"xy":1,"cwd":"/work","params":{"dry_run":true,"spec":{"inputs":[{"id":"video","path":"*.mp4"},{"id":"music","path":"*.mp3","type":"audio"}],"output":{"path":"copy.mp4","map":{"video":"video:v","audio":"music:a"},"video":{"codec":"libx264","crf":23},"audio":{"codec":"aac","bitrate":"128k"},"shortest":true}}}}' | \
docker run -i --rm \
	-v /tmp/xyplug-video-test:/work \
	--entrypoint node \
	xyplug-video:test /app/index.js
```

## GitHub Actions

The repository includes a workflow at `.github/workflows/docker.yml` that builds and publishes the Docker image to GitHub Container Registry on tag pushes.

The published image is:

```text
ghcr.io/pixlcore/xyplug-video:v1.0.0
```

The workflow builds both `linux/amd64` and `linux/arm64` images.

## License

MIT
