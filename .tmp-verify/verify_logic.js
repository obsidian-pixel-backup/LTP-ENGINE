"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const predictor_1 = require("./predictor");
const analysis_1 = require("./analysis");
function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
function buildSyntheticDraws(totalDraws, N = 52) {
    let seed = 0x7f4a7c15;
    const nextInt = (maxExclusive) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % maxExclusive;
    };
    const startMs = Date.parse("2020-01-01T00:00:00Z");
    const oneDayMs = 24 * 60 * 60 * 1000;
    const draws = [];
    for (let i = 0; i < totalDraws; i++) {
        const mainSet = new Set();
        while (mainSet.size < analysis_1.K) {
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
    const recencyDraws = [
        { date: "2023-01-01", numbers: [2, 4, 6, 8, 10, 12], bonus: 14 },
        { date: "2023-01-08", numbers: [3, 5, 7, 9, 11, 13], bonus: 15 },
        { date: "2023-01-15", numbers: [40, 16, 18, 20, 22, 24], bonus: 26 },
    ];
    const results = (0, predictor_1.bayesianSmoothed)(recencyDraws, N);
    const byNumber = new Map(results.map((r) => [r.number, r]));
    const n40 = byNumber.get(40);
    const n2 = byNumber.get(2);
    assert(n40, "Bayesian result map is missing number 40.");
    assert(n2, "Bayesian result map is missing number 2.");
    assert(n40.weightedCount > n2.weightedCount, `Expected recent number 40 to outrank older number 2, got ${n40.weightedCount} <= ${n2.weightedCount}`);
}
function testCompositeScoreOrdering() {
    const draws = buildSyntheticDraws(80);
    const diag = (0, analysis_1.runFullDiagnostics)(draws);
    const scores = (0, predictor_1.compositeScoring)(diag, draws, predictor_1.WEIGHT_PROFILES[0]);
    assert(scores.length === diag.poolSize, `Expected ${diag.poolSize} scores, got ${scores.length}.`);
    assert(scores.every((s) => Number.isFinite(s.compositeScore)), "Composite scoring produced non-finite values.");
    for (let i = 1; i < scores.length; i++) {
        assert(scores[i - 1].compositeScore >= scores[i].compositeScore, "Composite scores are not sorted descending.");
    }
}
function testPredictionDeterminism() {
    const draws = buildSyntheticDraws(70);
    const diag1 = (0, analysis_1.runFullDiagnostics)(draws);
    const diag2 = (0, analysis_1.runFullDiagnostics)(draws);
    const outputA = (0, predictor_1.runPrediction)(draws, diag1);
    const outputB = (0, predictor_1.runPrediction)(draws, diag2);
    assert(outputA.sets.length > 0, "Prediction output A contains no sets.");
    assert(outputB.sets.length > 0, "Prediction output B contains no sets.");
    const topA = outputA.sets[0].numbers.join(",");
    const topB = outputB.sets[0].numbers.join(",");
    assert(topA === topB, `Deterministic top set mismatch: ${topA} vs ${topB}`);
    assert(Math.abs(outputA.backtest.modelHitRate - outputB.backtest.modelHitRate) <
        1e-12, "Backtest hit rate is not deterministic between repeated runs.");
}
function testDiagnosticsCacheKeyUniqueness() {
    const base = buildSyntheticDraws(41);
    const alt = base.map((draw) => ({
        date: draw.date,
        numbers: [...draw.numbers],
        bonus: draw.bonus,
    }));
    for (let i = 1; i < alt.length; i += 2) {
        const tail = 7 + (i % 46); // 7..52
        const numbers = [1, 2, 3, 4, 5, tail];
        let bonus = tail + 1;
        if (bonus > 52 || numbers.includes(bonus))
            bonus = 52;
        if (numbers.includes(bonus))
            bonus = 6;
        alt[i] = {
            ...alt[i],
            numbers,
            bonus,
        };
    }
    const cache = (0, predictor_1.createDiagnosticsCache)(32);
    const baseDiag = cache.get(base);
    const cachedAltDiag = cache.get(alt);
    const directAltDiag = (0, analysis_1.runFullDiagnostics)(alt);
    assert(baseDiag !== cachedAltDiag, "Diagnostics cache returned the same entry for different draw histories.");
    assert(Math.abs(cachedAltDiag.chiSquare.chiSquare - directAltDiag.chiSquare.chiSquare) <
        1e-12, "Diagnostics cache returned stale diagnostics for a new history.");
}
function runVerificationSuite() {
    testBayesianRecencyWeighting();
    testCompositeScoreOrdering();
    testPredictionDeterminism();
    testDiagnosticsCacheKeyUniqueness();
}
try {
    runVerificationSuite();
    console.log("All verification checks passed.");
}
catch (error) {
    console.error("Verification failed:", error);
    throw error;
}
