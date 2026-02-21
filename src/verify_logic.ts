import {
  runPrediction,
  bayesianSmoothed,
  compositeScoring,
  WEIGHT_PROFILES,
} from "./predictor";
import { K, runFullDiagnostics, DrawRecord } from "./analysis";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildSyntheticDraws(totalDraws: number, N = 52): DrawRecord[] {
  let seed = 0x7f4a7c15;
  const nextInt = (maxExclusive: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maxExclusive;
  };

  const startMs = Date.parse("2020-01-01T00:00:00Z");
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

function testBayesianRecencyWeighting() {
  const N = 49;
  const recencyDraws: DrawRecord[] = [
    { date: "2023-01-01", numbers: [2, 4, 6, 8, 10, 12], bonus: 14 },
    { date: "2023-01-08", numbers: [3, 5, 7, 9, 11, 13], bonus: 15 },
    { date: "2023-01-15", numbers: [40, 16, 18, 20, 22, 24], bonus: 26 },
  ];
  const results = bayesianSmoothed(recencyDraws, N);
  const byNumber = new Map(results.map((r) => [r.number, r]));
  const n40 = byNumber.get(40);
  const n2 = byNumber.get(2);

  assert(n40, "Bayesian result map is missing number 40.");
  assert(n2, "Bayesian result map is missing number 2.");
  assert(
    n40.weightedCount > n2.weightedCount,
    `Expected recent number 40 to outrank older number 2, got ${n40.weightedCount} <= ${n2.weightedCount}`,
  );
}

function testCompositeScoreOrdering() {
  const draws = buildSyntheticDraws(80);
  const diag = runFullDiagnostics(draws);
  const scores = compositeScoring(diag, draws, WEIGHT_PROFILES[0]);

  assert(
    scores.length === diag.poolSize,
    `Expected ${diag.poolSize} scores, got ${scores.length}.`,
  );
  assert(
    scores.every((s) => Number.isFinite(s.compositeScore)),
    "Composite scoring produced non-finite values.",
  );
  for (let i = 1; i < scores.length; i++) {
    assert(
      scores[i - 1].compositeScore >= scores[i].compositeScore,
      "Composite scores are not sorted descending.",
    );
  }
}

function testPredictionDeterminism() {
  const draws = buildSyntheticDraws(70);
  const diag1 = runFullDiagnostics(draws);
  const diag2 = runFullDiagnostics(draws);
  const outputA = runPrediction(draws, diag1);
  const outputB = runPrediction(draws, diag2);

  assert(outputA.sets.length > 0, "Prediction output A contains no sets.");
  assert(outputB.sets.length > 0, "Prediction output B contains no sets.");

  const topA = outputA.sets[0].numbers.join(",");
  const topB = outputB.sets[0].numbers.join(",");
  assert(topA === topB, `Deterministic top set mismatch: ${topA} vs ${topB}`);
  assert(
    Math.abs(outputA.backtest.modelHitRate - outputB.backtest.modelHitRate) <
      1e-12,
    "Backtest hit rate is not deterministic between repeated runs.",
  );
}

function runVerificationSuite() {
  testBayesianRecencyWeighting();
  testCompositeScoreOrdering();
  testPredictionDeterminism();
}

try {
  runVerificationSuite();
  console.log("All verification checks passed.");
} catch (error) {
  console.error("Verification failed:", error);
  throw error;
}
