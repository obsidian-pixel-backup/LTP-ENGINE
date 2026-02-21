/**
 * Statistical Analysis Engine for SA LOTTO
 * Auto-detects game format (6/49, 6/52, 6/58) and uses appropriate pool size.
 * Implements frequency analysis, hot/cold, pairs, groups, gaps, chi-square, autocorrelation.
 */

export const K = 6; // 6 numbers drawn per game

export interface DrawRecord {
  date: string;
  numbers: number[]; // sorted, length K
  bonus: number;
}

// ─── Format Detection ───────────────────────────────────────────────
export interface FormatEra {
  poolSize: number; // 49, 52, or 58
  startIndex: number;
  endIndex: number;
  drawCount: number;
}

/**
 * Auto-detect the pool size for each draw.
 * The SA LOTTO has changed from 6/49 → 6/52 → 6/58 over the years.
 * We detect the current era and return only draws from that era for analysis.
 */
export function detectFormat(draws: DrawRecord[]): {
  currentN: number;
  currentDraws: DrawRecord[];
  eras: FormatEra[];
} {
  if (draws.length === 0) return { currentN: 52, currentDraws: [], eras: [] };

  // Determine current pool size based on recent data
  const recentWindow = Math.min(50, draws.length);
  const recentDraws = draws.slice(-recentWindow);
  const recentMax = Math.max(
    ...recentDraws.flatMap((d) => [...d.numbers, d.bonus].filter((n) => n > 0)),
  );

  let currentN: number;
  if (recentMax > 52) currentN = 58;
  else if (recentMax > 49) currentN = 52;
  else currentN = 49;

  // Find transitions between eras
  const eras: FormatEra[] = [];
  let eraStartIndex = 0;
  let lastPoolSize = -1;

  for (let i = 0; i < draws.length; i++) {
    const maxInDraw = Math.max(...draws[i].numbers, draws[i].bonus || 0);
    let poolAtI = 49;
    if (maxInDraw > 52) poolAtI = 58;
    else if (maxInDraw > 49) poolAtI = 52;

    if (lastPoolSize === -1) {
      lastPoolSize = poolAtI;
    } else if (poolAtI > lastPoolSize) {
      // Transition to a larger pool
      eras.push({
        poolSize: lastPoolSize,
        startIndex: eraStartIndex,
        endIndex: i - 1,
        drawCount: i - eraStartIndex,
      });
      eraStartIndex = i;
      lastPoolSize = poolAtI;
    }
  }

  // Add the last (current) era
  eras.push({
    poolSize: currentN,
    startIndex: eraStartIndex,
    endIndex: draws.length - 1,
    drawCount: draws.length - eraStartIndex,
  });

  const currentDraws = draws.slice(eraStartIndex);
  return { currentN, currentDraws, eras };
}

// ─── Frequency Analysis ─────────────────────────────────────────────
export interface FrequencyResult {
  number: number;
  count: number;
  expected: number;
  zScore: number;
  frequency: number;
}

export function frequencyAnalysis(
  draws: DrawRecord[],
  N: number,
): FrequencyResult[] {
  const T = draws.length;
  const K_ANALYSIS = 7; // Treat as 7-number draw for frequency
  const counts = new Array(N + 1).fill(0);
  for (const d of draws) {
    const allNums = [...d.numbers, d.bonus];
    for (const n of allNums) {
      if (n > 0 && n <= N) counts[n]++;
    }
  }
  const expected = (T * K_ANALYSIS) / N;
  const stdDev = Math.sqrt(T * (K_ANALYSIS / N) * (1 - K_ANALYSIS / N));
  const results: FrequencyResult[] = [];
  for (let i = 1; i <= N; i++) {
    results.push({
      number: i,
      count: counts[i],
      expected,
      zScore: stdDev > 0 ? (counts[i] - expected) / stdDev : 0,
      frequency: counts[i] / T,
    });
  }
  return results;
}

// ─── Hot/Cold Classification ────────────────────────────────────────
export type HotColdStatus = "hot" | "cold" | "neutral";

export interface HotColdResult {
  number: number;
  recentCount: number;
  allTimeFreq: number;
  recentFreq: number;
  status: HotColdStatus;
  delta: number;
}

export function hotColdAnalysis(
  draws: DrawRecord[],
  N: number,
  windowSize = 20,
): HotColdResult[] {
  const allFreq = frequencyAnalysis(draws, N);
  const actualWindow = Math.min(windowSize, draws.length);
  const recentDraws = draws.slice(-actualWindow);
  const recentCounts = new Array(N + 1).fill(0);

  for (const d of recentDraws) {
    const allNums = [...d.numbers, d.bonus];
    for (const n of allNums) {
      if (n > 0 && n <= N) recentCounts[n]++;
    }
  }

  const threshold = 1.5;

  return allFreq.map((f) => {
    const recentFreq = recentCounts[f.number] / actualWindow;
    const p = f.frequency; // Use all-time frequency as the probability
    const expWindow = actualWindow * p;
    const stdWindow = Math.sqrt(actualWindow * p * (1 - p));
    const zRecent =
      stdWindow > 0 ? (recentCounts[f.number] - expWindow) / stdWindow : 0;

    let status: HotColdStatus = "neutral";
    if (zRecent > threshold) status = "hot";
    else if (zRecent < -threshold) status = "cold";

    return {
      number: f.number,
      recentCount: recentCounts[f.number],
      allTimeFreq: f.frequency,
      recentFreq,
      status,
      delta: zRecent,
    };
  });
}

// ─── Pair Co-occurrence ─────────────────────────────────────────────
export interface PairResult {
  i: number;
  j: number;
  count: number;
  expected: number;
  zScore: number;
}

export function pairAnalysis(
  draws: DrawRecord[],
  N: number,
  topN = 30,
): PairResult[] {
  const T = draws.length;
  const K_A = 6; // Main numbers only
  const pPair = (K_A * (K_A - 1)) / (N * (N - 1));
  const expectedPair = T * pPair;
  const stdPair = Math.sqrt(T * pPair * (1 - pPair));

  const pairCounts = new Map<string, number>();
  for (const d of draws) {
    const nums = [...d.numbers].filter((n) => n > 0 && n <= N);
    for (let a = 0; a < nums.length; a++) {
      for (let b = a + 1; b < nums.length; b++) {
        const key = `${nums[a]}-${nums[b]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  const results: PairResult[] = [];
  for (const [key, count] of pairCounts) {
    const [i, j] = key.split("-").map(Number);
    results.push({
      i,
      j,
      count,
      expected: expectedPair,
      zScore: stdPair > 0 ? (count - expectedPair) / stdPair : 0,
    });
  }
  results.sort((a, b) => b.zScore - a.zScore);
  return results.slice(0, topN);
}

// ─── Number Group Distribution ──────────────────────────────────────
export type GroupName = "Low" | "Medium" | "MedHigh" | "High";

export interface GroupPatternResult {
  pattern: string;
  count: number;
  percentage: number;
}

export function getGroup(n: number, N: number = 52): GroupName {
  const q = Math.ceil(N / 4);
  if (n <= q) return "Low";
  if (n <= q * 2) return "Medium";
  if (n <= q * 3) return "MedHigh";
  return "High";
}

export function groupAnalysis(
  draws: DrawRecord[],
  N: number,
): GroupPatternResult[] {
  const T = draws.length;
  const patternCounts = new Map<string, number>();

  for (const d of draws) {
    const groups = { Low: 0, Medium: 0, MedHigh: 0, High: 0 };
    const allNums = [...d.numbers, d.bonus].filter((n) => n > 0);
    for (const n of allNums) groups[getGroup(n, N)]++;
    const pattern = `${groups.Low}-${groups.Medium}-${groups.MedHigh}-${groups.High}`;
    patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
  }

  const results: GroupPatternResult[] = [];
  for (const [pattern, count] of patternCounts) {
    results.push({ pattern, count, percentage: (count / T) * 100 });
  }
  results.sort((a, b) => b.count - a.count);
  return results;
}

// ─── Gap Analysis ───────────────────────────────────────────────────
export interface GapResult {
  number: number;
  currentGap: number;
  avgGap: number;
  maxGap: number;
  isOverdue: boolean;
}

export function gapAnalysis(draws: DrawRecord[], N: number): GapResult[] {
  const T = draws.length;
  const results: GapResult[] = [];

  for (let num = 1; num <= N; num++) {
    let lastSeen = -1;
    const gaps: number[] = [];

    for (let t = 0; t < T; t++) {
      const allNums = [...draws[t].numbers, draws[t].bonus];
      if (allNums.includes(num)) {
        if (lastSeen >= 0) gaps.push(t - lastSeen);
        lastSeen = t;
      }
    }

    const currentGap = lastSeen >= 0 ? T - 1 - lastSeen : T;
    const avgGap =
      gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : T;
    const maxGap = gaps.length > 0 ? Math.max(...gaps) : T;

    results.push({
      number: num,
      currentGap,
      avgGap,
      maxGap,
      isOverdue: currentGap > avgGap * 1.5,
    });
  }
  return results;
}

// ─── Chi-Square Global Uniformity Test ──────────────────────────────
export interface ChiSquareResult {
  chiSquare: number;
  degreesOfFreedom: number;
  pValue: number;
  isUniform: boolean;
}

function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function chiSquarePValue(chiSq: number, df: number): number {
  const z = Math.pow(chiSq / df, 1 / 3) - (1 - 2 / (9 * df));
  const denom = Math.sqrt(2 / (9 * df));
  const zNorm = z / denom;
  return 1 - normalCDF(zNorm);
}

export function chiSquareTest(draws: DrawRecord[], N: number): ChiSquareResult {
  const T = draws.length;
  const counts = new Array(N + 1).fill(0);
  for (const d of draws) {
    for (const n of d.numbers) {
      if (n <= N) counts[n]++;
    }
  }
  const expected = (T * K) / N;
  const chiSq = counts.slice(1).reduce(
    // Start from index 1 to ignore the 0th element if N is the max number
    (acc, count) => acc + (count - expected) ** 2 / expected,
    0,
  );
  // Using N for degrees of freedom calculation
  const pValue = chiSquarePValue(chiSq, N - 1);
  return {
    chiSquare: chiSq,
    degreesOfFreedom: N - 1,
    pValue,
    isUniform: pValue > 0.05,
  };
}

// ─── Serial Autocorrelation (Lag-1) ─────────────────────────────────
export interface AutocorrResult {
  number: number;
  lag1Corr: number;
  isSignificant: boolean;
}

export function autocorrelationAnalysis(
  draws: DrawRecord[],
  N: number,
): AutocorrResult[] {
  const T = draws.length;
  const results: AutocorrResult[] = [];

  for (let num = 1; num <= N; num++) {
    const x: number[] = [];
    for (let t = 0; t < T; t++) {
      x.push(draws[t].numbers.includes(num) ? 1 : 0);
    }
    const mean = x.reduce((a, b) => a + b, 0) / T;
    let num1 = 0,
      denom = 0;
    for (let t = 0; t < T; t++) {
      denom += (x[t] - mean) ** 2;
      if (t < T - 1) num1 += (x[t] - mean) * (x[t + 1] - mean);
    }
    const lag1 = denom > 0 ? num1 / denom : 0;
    const threshold = 2 / Math.sqrt(T);

    results.push({
      number: num,
      lag1Corr: lag1,
      isSignificant: Math.abs(lag1) > threshold,
    });
  }
  return results;
}

// ─── Positional Hotness Analysis ────────────────────────────────────
export interface PositionalFreq {
  position: number; // 1-6
  numberFreqs: Record<number, number>; // number -> percentage
}

export function positionalFrequencyAnalysis(
  draws: DrawRecord[],
  _N: number,
): PositionalFreq[] {
  const K_SIZE = 7; // Updated to 7 for all-inclusive training
  const counts: Record<number, number>[] = Array.from(
    { length: K_SIZE },
    () => ({}),
  );

  for (const d of draws) {
    const sorted = [...d.numbers, d.bonus]
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      if (counts[i]) {
        counts[i][n] = (counts[i][n] || 0) + 1;
      }
    }
  }

  return counts.map((c, i) => {
    const freqs: Record<number, number> = {};
    // Ensure all numbers in pool N are represented if needed, or just map existing
    Object.entries(c).forEach(([num, count]) => {
      freqs[parseInt(num)] = (count / (draws.length || 1)) * 100;
    });
    return { position: i + 1, numberFreqs: freqs };
  });
}

// ─── Markov Transition Analysis (Multi-Lag) ──────────────────────────
export interface TransitionMatch {
  number: number;
  count: number;
  probability: number;
}

export interface TransitionResult {
  lag: number;
  fromNumber: number;
  toNumbers: TransitionMatch[];
}

export function transitionAnalysis(
  draws: DrawRecord[],
  N: number,
  maxLag = 4,
  topN = 10,
): TransitionResult[] {
  const results: TransitionResult[] = [];

  for (let lag = 1; lag <= maxLag; lag++) {
    const matrix: Record<number, Record<number, number>> = {};

    for (let t = 0; t < draws.length - lag; t++) {
      const current = [...draws[t].numbers].filter((n) => n > 0);
      const next = [...draws[t + lag].numbers].filter((n) => n > 0);

      for (const a of current) {
        if (!matrix[a]) matrix[a] = {};
        for (const b of next) {
          matrix[a][b] = (matrix[a][b] || 0) + 1;
        }
      }
    }

    for (let i = 1; i <= N; i++) {
      if (!matrix[i]) continue;
      const transitions = Object.entries(matrix[i]).map(([num, count]) => ({
        number: parseInt(num),
        count,
      }));
      const total = transitions.reduce((s, x) => s + x.count, 0);
      const sorted = transitions
        .map((t) => ({
          number: t.number,
          count: t.count,
          probability: t.count / total,
        }))
        .sort((a, b) => b.probability - a.probability)
        .slice(0, topN);

      results.push({ lag, fromNumber: i, toNumbers: sorted });
    }
  }
  return results;
}

// ─── Full Diagnostics Bundle ────────────────────────────────────────
export interface FullDiagnostics {
  totalDraws: number;
  poolSize: number;
  eraDrawCount: number;
  frequency: FrequencyResult[];
  hotCold: HotColdResult[];
  topPairs: PairResult[];
  groupPatterns: GroupPatternResult[];
  gaps: GapResult[];
  chiSquare: ChiSquareResult;
  autocorrelation: AutocorrResult[];
  deltas: DeltaResult[];
  topTriples: TripleResult[];
  topQuadruples: QuadrupleResult[];
  topQuintets: QuintetResult[];
  positionalFreq: PositionalFreq[];
  transitions: TransitionResult[];
  biasDetected: boolean;
  biasReasons: string[];
  eras: FormatEra[];
}

export function runFullDiagnostics(draws: DrawRecord[]): FullDiagnostics {
  const { currentN, currentDraws, eras } = detectFormat(draws);
  const N = currentN;

  // Ensure at least 1000 draws for relationship analysis if available
  let relationshipDraws = currentDraws;
  if (relationshipDraws.length < 1000) {
    relationshipDraws = draws.slice(Math.max(0, draws.length - 1000));
  }

  // BIAS DIAGNOSTICS: Stay era-pure for frequency/uniformity
  const freq = frequencyAnalysis(currentDraws, N);
  const hc = hotColdAnalysis(currentDraws, N, 20);
  const pairs = pairAnalysis(currentDraws, N, 30);
  const groups = groupAnalysis(currentDraws, N);
  const gaps = gapAnalysis(currentDraws, N);
  const chi = chiSquareTest(currentDraws, N);
  const ac = autocorrelationAnalysis(currentDraws, N);

  // RELATIONSHIP ANALYSIS: Use deep history (1000 draws)
  const deltas = deltaAnalysis(relationshipDraws);
  const triples = tripleAnalysis(relationshipDraws, 50);
  const quadruples = quadrupleAnalysis(relationshipDraws, 20);
  const quintets = quintetAnalysis(relationshipDraws, 10);
  const positional = positionalFrequencyAnalysis(relationshipDraws, N);
  const transitions = transitionAnalysis(relationshipDraws, N);

  const sigAutocorr = ac.filter((a) => a.isSignificant);
  const biasReasons: string[] = [];

  if (!chi.isUniform) biasReasons.push("Frequency imbalance (Chi-Square)");
  if (sigAutocorr.length > 0)
    biasReasons.push(`Sequential dependency (${sigAutocorr.length} lags)`);
  if (gaps.filter((g) => g.isOverdue).length > N * 0.2)
    biasReasons.push("High number of overdue values");
  if (hc.filter((h) => h.status === "hot").length < 3)
    biasReasons.push("Weak recent trend (Cold cycle)");

  const biasDetected = biasReasons.length > 0;

  return {
    totalDraws: draws.length,
    poolSize: N,
    eraDrawCount: currentDraws.length,
    frequency: freq,
    hotCold: hc,
    topPairs: pairs,
    groupPatterns: groups,
    gaps,
    chiSquare: chi,
    autocorrelation: ac,
    deltas,
    topTriples: triples,
    topQuadruples: quadruples,
    topQuintets: quintets,
    positionalFreq: positional,
    transitions,
    biasDetected,
    biasReasons,
    eras,
  };
}

// ─── Set Balance Helpers ────────────────────────────────────────────
export function getOddEvenSplit(numbers: number[]): {
  odd: number;
  even: number;
} {
  let odd = 0;
  for (const n of numbers) {
    if (n % 2 !== 0) odd++;
  }
  return { odd, even: numbers.length - odd };
}

export function getSum(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0);
}

export function checkConsecutiveness(numbers: number[]): number {
  let consecutivePairs = 0;
  // numbers are assumed sorted
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i + 1] === numbers[i] + 1) consecutivePairs++;
  }
  return consecutivePairs;
}

// ─── Delta Analysis ─────────────────────────────────────────────────
export interface DeltaResult {
  delta: number;
  count: number;
  percentage: number;
}

export function deltaAnalysis(draws: DrawRecord[]): DeltaResult[] {
  const deltaCounts: Record<number, number> = {};
  let totalDeltas = 0;

  for (const draw of draws) {
    const sorted = [...draw.numbers, draw.bonus]
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const d = sorted[i + 1] - sorted[i];
      deltaCounts[d] = (deltaCounts[d] || 0) + 1;
      totalDeltas++;
    }
  }

  return Object.entries(deltaCounts)
    .map(([d, count]) => ({
      delta: parseInt(d),
      count,
      percentage: (count / totalDeltas) * 100,
    }))
    .sort((a, b) => b.count - a.count);
}

// ─── Triple Affinity ────────────────────────────────────────────────
export interface TripleResult {
  i: number;
  j: number;
  k: number;
  count: number;
}

export function tripleAnalysis(draws: DrawRecord[], topN = 50): TripleResult[] {
  const trips: Record<string, number> = {};
  for (const draw of draws) {
    const allNums = [...draw.numbers, draw.bonus]
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    for (let i = 0; i < allNums.length - 2; i++) {
      for (let j = i + 1; j < allNums.length - 1; j++) {
        for (let l = j + 1; l < allNums.length; l++) {
          const key = `${allNums[i]},${allNums[j]},${allNums[l]}`;
          trips[key] = (trips[key] || 0) + 1;
        }
      }
    }
  }

  return Object.entries(trips)
    .map(([key, count]) => {
      const [i, j, k] = key.split(",").map(Number);
      return { i, j, k, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

// ─── Quadruple Affinity ─────────────────────────────────────────────
export interface QuadrupleResult {
  i: number;
  j: number;
  k: number;
  l: number;
  count: number;
}

export function quadrupleAnalysis(
  draws: DrawRecord[],
  topN = 20,
): QuadrupleResult[] {
  const quads: Record<string, number> = {};
  for (const draw of draws) {
    const allNums = [...draw.numbers, draw.bonus]
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    for (let i = 0; i < allNums.length - 3; i++) {
      for (let j = i + 1; j < allNums.length - 2; j++) {
        for (let k = j + 1; k < allNums.length - 1; k++) {
          for (let l = k + 1; l < allNums.length; l++) {
            const key = `${allNums[i]},${allNums[j]},${allNums[k]},${allNums[l]}`;
            quads[key] = (quads[key] || 0) + 1;
          }
        }
      }
    }
  }

  return Object.entries(quads)
    .filter(([, count]) => count > 1) // Only care about repeats
    .map(([key, count]) => {
      const [i, j, k, l] = key.split(",").map(Number);
      return { i, j, k, l, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

// ─── Quintet Affinity ───────────────────────────────────────────────
export interface QuintetResult {
  i: number;
  j: number;
  k: number;
  l: number;
  m: number;
  count: number;
}

export function quintetAnalysis(
  draws: DrawRecord[],
  topN = 10,
): QuintetResult[] {
  const quints: Record<string, number> = {};
  for (const draw of draws) {
    const allNums = [...draw.numbers, draw.bonus]
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    for (let i = 0; i < allNums.length - 4; i++) {
      for (let j = i + 1; j < allNums.length - 3; j++) {
        for (let k = j + 1; k < allNums.length - 2; k++) {
          for (let l = k + 1; l < allNums.length - 1; l++) {
            for (let m = l + 1; m < allNums.length; m++) {
              const key = `${allNums[i]},${allNums[j]},${allNums[k]},${allNums[l]},${allNums[m]}`;
              quints[key] = (quints[key] || 0) + 1;
            }
          }
        }
      }
    }
  }

  return Object.entries(quints)
    .filter(([, count]) => count > 1) // Only rare repeats
    .map(([key, count]) => {
      const [i, j, k, l, m] = key.split(",").map(Number);
      return { i, j, k, l, m, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}
