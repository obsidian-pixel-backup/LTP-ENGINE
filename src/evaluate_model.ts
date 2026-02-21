import * as XLSX from "xlsx";
import { type DrawRecord, K } from "./analysis";
import {
  WEIGHT_PROFILES,
  calibrateRuntimeBudgets,
  createDiagnosticsCache,
  compositeScoring,
  generateCandidateSets,
  runPrediction,
  type GenerateCandidateOptions,
  type WeightProfile,
} from "./predictor";

declare const process: {
  argv: string[];
  exit: (code?: number) => never;
};

interface CliOptions {
  filePath: string | null;
  syntheticDraws: number | null;
  rollingWindow: number;
  step: number;
  minTrain: number;
  maxEvals: number;
}

interface MetricSummary {
  samples: number;
  avgOverlap: number;
  avgOverlapLower: number;
  avgOverlapUpper: number;
  hitRate: number;
  hitRateLower: number;
  hitRateUpper: number;
  fourPlusRate: number;
  fourPlusLower: number;
  fourPlusUpper: number;
  elapsedMs: number;
}

interface ProfileAblationResult {
  profileName: string;
  metrics: MetricSummary;
}

function hashStringToSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    filePath: null,
    syntheticDraws: null,
    rollingWindow: 260,
    step: 4,
    minTrain: 140,
    maxEvals: 70,
  };

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }

    if (!token.startsWith("--")) {
      options.filePath = token;
      continue;
    }

    const [flag, rawValue = ""] = token.split("=", 2);
    if (flag === "--window") {
      options.rollingWindow = parsePositiveInt(rawValue, flag);
      continue;
    }
    if (flag === "--step") {
      options.step = parsePositiveInt(rawValue, flag);
      continue;
    }
    if (flag === "--min-train") {
      options.minTrain = parsePositiveInt(rawValue, flag);
      continue;
    }
    if (flag === "--max-evals") {
      options.maxEvals = parsePositiveInt(rawValue, flag);
      continue;
    }
    if (flag === "--synthetic") {
      options.syntheticDraws = parsePositiveInt(rawValue, flag);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printUsage() {
  console.log("Usage:");
  console.log(
    "  npm run evaluate:model -- <data.xlsx> [--window=260] [--step=4] [--min-train=140] [--max-evals=70]",
  );
  console.log("  npm run evaluate:model -- --synthetic=600");
}

function normalizeDateParts(
  year: number,
  month: number,
  day: number,
): string | null {
  const dt = new Date(year, month - 1, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeTwoDigitYear(year: number): number {
  // Pivot rule: 00-69 => 2000-2069, 70-99 => 1970-1999
  return year >= 70 ? 1900 + year : 2000 + year;
}

function normalizeDate(dateVal: string): string | null {
  const cleaned = dateVal.trim();
  if (!cleaned) return null;

  const ymd = cleaned.match(
    /^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[ T].*)?$/,
  );
  if (ymd) {
    return normalizeDateParts(
      Number.parseInt(ymd[1], 10),
      Number.parseInt(ymd[2], 10),
      Number.parseInt(ymd[3], 10),
    );
  }

  const ymdShort = cleaned.match(
    /^(\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[ T].*)?$/,
  );
  if (ymdShort) {
    return normalizeDateParts(
      normalizeTwoDigitYear(Number.parseInt(ymdShort[1], 10)),
      Number.parseInt(ymdShort[2], 10),
      Number.parseInt(ymdShort[3], 10),
    );
  }

  const dmy = cleaned.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T].*)?$/,
  );
  if (dmy) {
    const dayFirst = normalizeDateParts(
      Number.parseInt(dmy[3], 10),
      Number.parseInt(dmy[2], 10),
      Number.parseInt(dmy[1], 10),
    );
    if (dayFirst) return dayFirst;

    return normalizeDateParts(
      Number.parseInt(dmy[3], 10),
      Number.parseInt(dmy[1], 10),
      Number.parseInt(dmy[2], 10),
    );
  }

  const dmyShort = cleaned.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2})(?:[ T].*)?$/,
  );
  if (dmyShort) {
    const yy = normalizeTwoDigitYear(Number.parseInt(dmyShort[3], 10));
    const dayFirst = normalizeDateParts(
      yy,
      Number.parseInt(dmyShort[2], 10),
      Number.parseInt(dmyShort[1], 10),
    );
    if (dayFirst) return dayFirst;

    return normalizeDateParts(
      yy,
      Number.parseInt(dmyShort[1], 10),
      Number.parseInt(dmyShort[2], 10),
    );
  }

  return null;
}

function parseDrawsFromWorkbook(filePath: string): DrawRecord[] {
  const workbook = XLSX.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(worksheet, {
    raw: false,
    defval: "",
  });

  const numberKeyRegex = /^number\d+$/i;

  return rows
    .map((row): DrawRecord | null => {
      const numbers: number[] = [];
      let bonus = 0;
      let dateVal = "";

      for (const [key, value] of Object.entries(row)) {
        const normalizedKey = key.toLowerCase();
        const normalizedValue = String(value ?? "").trim();

        if (normalizedKey.includes("date")) {
          dateVal = normalizedValue;
          continue;
        }
        if (normalizedKey === "bonus") {
          bonus = Number.parseInt(normalizedValue, 10) || 0;
          continue;
        }

        if (numberKeyRegex.test(normalizedKey.replace(/[^a-z0-9]/gi, ""))) {
          const parsedNum = Number.parseInt(normalizedValue, 10);
          if (!Number.isNaN(parsedNum)) numbers.push(parsedNum);
        }
      }

      const normalizedDate = normalizeDate(dateVal);
      const sortedNumbers = numbers.sort((a, b) => a - b);
      if (!normalizedDate) return null;
      if (sortedNumbers.length !== K) return null;
      if (new Set(sortedNumbers).size !== K) return null;
      if (sortedNumbers.some((n) => n <= 0)) return null;

      return {
        date: normalizedDate,
        numbers: sortedNumbers,
        bonus,
      };
    })
    .filter((draw): draw is DrawRecord => draw !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildSyntheticDraws(totalDraws: number, N = 52): DrawRecord[] {
  let seed = 0x7f4a7c15;
  const nextInt = (maxExclusive: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maxExclusive;
  };

  const startMs = Date.parse("2015-01-01T00:00:00Z");
  const oneDayMs = 24 * 60 * 60 * 1000;
  const draws: DrawRecord[] = [];

  for (let i = 0; i < totalDraws; i++) {
    const mainSet = new Set<number>();
    while (mainSet.size < K) {
      mainSet.add(nextInt(N) + 1);
    }
    const numbers = Array.from(mainSet).sort((a, b) => a - b);

    let bonus = nextInt(N) + 1;
    while (mainSet.has(bonus)) {
      bonus = nextInt(N) + 1;
    }

    const date = new Date(startMs + i * 7 * oneDayMs).toISOString().split("T")[0];
    draws.push({ date, numbers, bonus });
  }

  return draws;
}

function overlapCount(predicted: number[], actual: number[]): number {
  const set = new Set(predicted);
  return actual.filter((n) => set.has(n)).length;
}

function toSevenBallTarget(draw: DrawRecord): number[] {
  const target = [...draw.numbers];
  if (draw.bonus > 0 && !target.includes(draw.bonus)) {
    target.push(draw.bonus);
  }
  return target;
}

function wilsonInterval(successes: number, total: number, z = 1.96): {
  lower: number;
  upper: number;
} {
  if (total <= 0) return { lower: 0, upper: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin =
    (z *
      Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) /
    denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sampleStdDev(values: number[], avg: number): number {
  if (values.length <= 1) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) * (v - avg), 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function meanInterval95(values: number[]): {
  mean: number;
  lower: number;
  upper: number;
} {
  if (values.length === 0) return { mean: 0, lower: 0, upper: 0 };
  const avg = mean(values);
  if (values.length === 1) return { mean: avg, lower: avg, upper: avg };
  const std = sampleStdDev(values, avg);
  const margin = 1.96 * (std / Math.sqrt(values.length));
  return { mean: avg, lower: avg - margin, upper: avg + margin };
}

function summarizeMetrics(overlaps: number[], elapsedMs: number): MetricSummary {
  const overlapStats = meanInterval95(overlaps);
  const hitSuccesses = overlaps.filter((o) => o > 0).length;
  const fourPlusSuccesses = overlaps.filter((o) => o >= 4).length;
  const hitInterval = wilsonInterval(hitSuccesses, overlaps.length);
  const fourPlusInterval = wilsonInterval(fourPlusSuccesses, overlaps.length);

  return {
    samples: overlaps.length,
    avgOverlap: overlapStats.mean,
    avgOverlapLower: overlapStats.lower,
    avgOverlapUpper: overlapStats.upper,
    hitRate: overlaps.length > 0 ? hitSuccesses / overlaps.length : 0,
    hitRateLower: hitInterval.lower,
    hitRateUpper: hitInterval.upper,
    fourPlusRate: overlaps.length > 0 ? fourPlusSuccesses / overlaps.length : 0,
    fourPlusLower: fourPlusInterval.lower,
    fourPlusUpper: fourPlusInterval.upper,
    elapsedMs,
  };
}

function evaluateRollingModel(draws: DrawRecord[], options: CliOptions): MetricSummary {
  const startIdx = Math.max(options.minTrain, options.rollingWindow);
  if (draws.length <= startIdx) {
    throw new Error(
      `Not enough draws for rolling evaluation. Need > ${startIdx}, got ${draws.length}.`,
    );
  }

  const allIndices: number[] = [];
  for (let i = startIdx; i < draws.length; i += options.step) {
    allIndices.push(i);
  }
  const selectedIndices =
    allIndices.length > options.maxEvals
      ? allIndices.slice(allIndices.length - options.maxEvals)
      : allIndices;

  const diagnosticsCache = createDiagnosticsCache(220);
  const overlaps: number[] = [];
  const startedAt = Date.now();

  for (let idxPos = 0; idxPos < selectedIndices.length; idxPos++) {
    const idx = selectedIndices[idxPos];
    const historyStart = Math.max(0, idx - options.rollingWindow);
    const history = draws.slice(historyStart, idx);
    const diagnostics = diagnosticsCache.get(history);
    const prediction = runPrediction(history, diagnostics);
    const topSet = prediction.sets[0]?.numbers || [];
    const actual = toSevenBallTarget(draws[idx]);
    overlaps.push(overlapCount(topSet, actual));
  }

  const elapsedMs = Date.now() - startedAt;
  return summarizeMetrics(overlaps, elapsedMs);
}

function evaluateSingleProfile(
  profile: WeightProfile,
  baseHistory: DrawRecord[],
  testDraws: DrawRecord[],
): MetricSummary {
  const diagnosticsCache = createDiagnosticsCache(220);
  const history = [...baseHistory];
  const overlaps: number[] = [];
  const startedAt = Date.now();
  const runtimeBudgets = calibrateRuntimeBudgets(history.length, { fastMode: true });
  const candidateOptions: GenerateCandidateOptions = {
    fastMode: true,
    includeMonteCarlo: false,
    includeGenetic: false,
    includeSlidingWindow: false,
    includeHistoricalEcho: false,
    runtimeBudgets,
    diagnosticsCache,
  };
  let diagnostics = diagnosticsCache.get(history);

  for (let i = 0; i < testDraws.length; i++) {
    const target = testDraws[i];
    const scores = compositeScoring(diagnostics, history, profile);
    const seed = `${profile.name}:${history.length}:${target.date}`;
    const rng = createSeededRandom(hashStringToSeed(seed));
    const topSet =
      generateCandidateSets(scores, diagnostics, history, 1, rng, candidateOptions)[0]
        ?.numbers || scores.slice(0, K).map((score) => score.number);

    overlaps.push(overlapCount(topSet, toSevenBallTarget(target)));

    history.push(target);
    const shouldRefresh =
      i === testDraws.length - 1 ||
      (i + 1) % runtimeBudgets.backtestRefreshEvery === 0;
    if (shouldRefresh) {
      diagnostics = diagnosticsCache.get(history);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return summarizeMetrics(overlaps, elapsedMs);
}

function evaluateProfileAblation(
  draws: DrawRecord[],
  options: CliOptions,
): ProfileAblationResult[] {
  const splitIdx = Math.max(options.minTrain, Math.floor(draws.length * 0.8));
  if (splitIdx >= draws.length - 1) {
    throw new Error(
      `Not enough test rows for profile ablation. Draws=${draws.length}, split=${splitIdx}.`,
    );
  }

  const baseHistory = draws.slice(0, splitIdx);
  const testDraws = draws.slice(splitIdx);
  return WEIGHT_PROFILES.map((profile) => ({
    profileName: profile.name,
    metrics: evaluateSingleProfile(profile, baseHistory, testDraws),
  })).sort((a, b) => b.metrics.avgOverlap - a.metrics.avgOverlap);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function printMetricSummary(title: string, metrics: MetricSummary) {
  console.log(`\n${title}`);
  console.log(`  Samples: ${metrics.samples}`);
  console.log(
    `  Avg overlap: ${metrics.avgOverlap.toFixed(3)} (95% CI ${metrics.avgOverlapLower.toFixed(3)} - ${metrics.avgOverlapUpper.toFixed(3)})`,
  );
  console.log(
    `  Hit rate (>=1): ${pct(metrics.hitRate)} (95% CI ${pct(metrics.hitRateLower)} - ${pct(metrics.hitRateUpper)})`,
  );
  console.log(
    `  4+ rate: ${pct(metrics.fourPlusRate)} (95% CI ${pct(metrics.fourPlusLower)} - ${pct(metrics.fourPlusUpper)})`,
  );
  console.log(`  Runtime: ${(metrics.elapsedMs / 1000).toFixed(2)}s`);
}

function printAblation(results: ProfileAblationResult[]) {
  console.log("\nProfile ablation ranking (rolling fixed-profile evaluation):");
  results.forEach((entry, idx) => {
    console.log(
      `  ${idx + 1}. ${entry.profileName} | avgOverlap=${entry.metrics.avgOverlap.toFixed(3)} | hit=${pct(entry.metrics.hitRate)} | 4+=${pct(entry.metrics.fourPlusRate)} | runtime=${(entry.metrics.elapsedMs / 1000).toFixed(2)}s`,
    );
  });
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (!options.filePath && !options.syntheticDraws) {
    printUsage();
    throw new Error("Provide either a workbook path or --synthetic=<drawCount>.");
  }

  const draws = options.syntheticDraws
    ? buildSyntheticDraws(options.syntheticDraws)
    : parseDrawsFromWorkbook(options.filePath as string);

  if (draws.length < options.minTrain + 20) {
    throw new Error(
      `Insufficient valid draws (${draws.length}). Need at least ${
        options.minTrain + 20
      } for reliable evaluation.`,
    );
  }

  console.log(`Loaded ${draws.length} valid draws.`);
  console.log(
    `Config: window=${options.rollingWindow}, step=${options.step}, minTrain=${options.minTrain}, maxEvals=${options.maxEvals}`,
  );

  const rollingMetrics = evaluateRollingModel(draws, options);
  printMetricSummary("Rolling walk-forward (current model)", rollingMetrics);

  const ablationResults = evaluateProfileAblation(draws, options);
  printAblation(ablationResults);
}

try {
  main();
} catch (error) {
  console.error("Model evaluation failed:", error);
  process.exit(1);
}
