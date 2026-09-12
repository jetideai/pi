import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STOCK_REVISION = "d981de1229ef899957bbe968bc8dcda02a21f477";
const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(BENCHMARK_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

interface Measurement {
	wallMs: number;
	cpuUserMs: number;
	cpuSystemMs: number;
	cpuTotalMs: number;
}

interface WorkerResult {
	label: string;
	mode: "capability-off";
	geometry: { initial: { width: number; height: number }; resize: { width: number; height: number } };
	counts: Record<string, number>;
	fixtureHash: string;
	packageVersions: { codingAgent: string; tui: string };
	measurements: Record<"construction" | "firstRender" | "resize", Measurement>;
	structuralCorrectness: true;
}

export interface Target {
	label: string;
	root: string;
	expectedRevision: string;
	actualRevision: string;
	packageVersions: { codingAgent: string; tui: string };
}

export function serializeTarget({ root: _root, ...safeTarget }: Target): Omit<Target, "root"> {
	return safeTarget;
}

interface Arguments {
	stockRoot: string;
	jetpiRoot: string;
	jetpiRevision: string;
	warmups: number;
	samples: number;
	output: string;
}

function parseArguments(): Arguments {
	const values = new Map<string, string>();
	for (let index = 2; index < process.argv.length; index += 2) {
		const key = process.argv[index];
		const value = process.argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument at ${index}`);
		values.set(key.slice(2), value);
	}
	const stockRoot = values.get("stock-root");
	if (!stockRoot) throw new Error("Missing required --stock-root");
	const actualJetpiRevision = gitRevision(REPO_ROOT);
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	return {
		stockRoot: resolve(stockRoot),
		jetpiRoot: resolve(values.get("jetpi-root") ?? REPO_ROOT),
		jetpiRevision: values.get("jetpi-revision") ?? actualJetpiRevision,
		warmups: positiveInteger(values.get("warmups") ?? "1", "warmups"),
		samples: positiveInteger(values.get("samples") ?? "3", "samples"),
		output: resolve(values.get("output") ?? join(PACKAGE_ROOT, ".artifacts", `long-transcript-${timestamp}.json`)),
	};
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
	return parsed;
}

function gitRevision(root: string): string {
	return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function readVersion(root: string, path: string): string {
	return (JSON.parse(readFileSync(join(root, path), "utf8")) as { version: string }).version;
}

function validateTarget(label: string, root: string, expectedRevision: string): Target {
	const actualRevision = gitRevision(root);
	if (actualRevision !== expectedRevision) {
		throw new Error(`${label} revision mismatch: expected ${expectedRevision}, got ${actualRevision}`);
	}
	return {
		label,
		root,
		expectedRevision,
		actualRevision,
		packageVersions: {
			codingAgent: readVersion(root, "packages/coding-agent/package.json"),
			tui: readVersion(root, "packages/tui/package.json"),
		},
	};
}

function runWorker(target: Target): WorkerResult {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			join(BENCHMARK_DIR, "long-transcript-worker.ts"),
			"--target-root",
			target.root,
			"--label",
			target.label,
			"--width",
			"77",
			"--height",
			"35",
			"--resize-width",
			"118",
			"--resize-height",
			"35",
		],
		{ cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`${target.label} worker failed:\n${result.stderr || result.stdout}`);
	}
	const parsed = JSON.parse(result.stdout) as WorkerResult;
	if (!parsed.structuralCorrectness) throw new Error(`${target.label} worker did not prove structural correctness`);
	if (parsed.packageVersions.codingAgent !== target.packageVersions.codingAgent || parsed.packageVersions.tui !== target.packageVersions.tui) {
		throw new Error(`${target.label} worker loaded package versions from the wrong root`);
	}
	return parsed;
}

function statistics(values: number[]): { median: number; min: number; max: number } {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
	return { median, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
}

function summarize(samples: WorkerResult[]) {
	return Object.fromEntries(
		(["construction", "firstRender", "resize"] as const).map((phase) => [
			phase,
			Object.fromEntries(
				(["wallMs", "cpuUserMs", "cpuSystemMs", "cpuTotalMs"] as const).map((metric) => [
					metric,
					statistics(samples.map((sample) => sample.measurements[phase][metric])),
				]),
			),
		]),
	);
}

function format(value: number): string {
	return value.toFixed(2);
}

async function main(): Promise<void> {
	const args = parseArguments();
	const targets = [
		validateTarget("stock", args.stockRoot, STOCK_REVISION),
		validateTarget("jetpi", args.jetpiRoot, args.jetpiRevision),
	];
	const results = [];
	for (const target of targets) {
		for (let index = 0; index < args.warmups; index++) runWorker(target);
		const samples = Array.from({ length: args.samples }, () => runWorker(target));
		const summary = summarize(samples);
		results.push({ target, samples, summary });
		console.log(`\n${target.label} ${target.actualRevision} (${args.samples} samples after ${args.warmups} warm-up)`);
		for (const [index, sample] of samples.entries()) {
			const phases = (["construction", "firstRender", "resize"] as const)
				.map((phase) => {
					const value = sample.measurements[phase];
					return `${phase}: wall ${format(value.wallMs)} ms, CPU ${format(value.cpuTotalMs)} ms (${format(value.cpuUserMs)} user + ${format(value.cpuSystemMs)} system)`;
				})
				.join(" | ");
			console.log(`  sample ${index + 1}: ${phases}`);
		}
		for (const phase of ["construction", "firstRender", "resize"] as const) {
			const wall = summary[phase]?.wallMs;
			const cpu = summary[phase]?.cpuTotalMs;
			if (!wall || !cpu) throw new Error(`Missing summary for ${target.label} ${phase}`);
			console.log(
				`  ${phase}: wall median/min/max ${format(wall.median)}/${format(wall.min)}/${format(wall.max)} ms; CPU total ${format(cpu.median)}/${format(cpu.min)}/${format(cpu.max)} ms`,
			);
		}
	}

	const fixtureHashes = new Set(results.flatMap(({ samples }) => samples.map(({ fixtureHash }) => fixtureHash)));
	if (fixtureHashes.size !== 1) throw new Error("Workers used different fixtures");
	const countShapes = new Set(results.flatMap(({ samples }) => samples.map(({ counts }) => JSON.stringify(counts))));
	if (countShapes.size !== 1) throw new Error("Workers produced different structural counts");

	const artifact = {
		schemaVersion: 2,
		createdAt: new Date().toISOString(),
		description: "Descriptive synthetic long-transcript benchmark. Timing values are not pass/fail thresholds.",
		runtime: { node: process.version, platform: process.platform, arch: process.arch },
		geometry: { initial: { width: 77, height: 35 }, resize: { width: 118, height: 35 } },
		mode: "capability-off",
		warmups: args.warmups,
		sampleCount: args.samples,
		fixtureHash: [...fixtureHashes][0],
		counts: results[0]?.samples[0]?.counts,
		results: results.map(({ target, samples, summary }) => ({ target: serializeTarget(target), samples, summary })),
	};
	mkdirSync(dirname(args.output), { recursive: true });
	writeFileSync(args.output, `${JSON.stringify(artifact, null, 2)}\n`);
	console.log(`\nArtifact: ${args.output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
