import {
  bayesianSmoothed,
  compositeScoring,
  WEIGHT_PROFILES,
} from "./predictor";
import { runFullDiagnostics, DrawRecord } from "./analysis";

const mockDraws: DrawRecord[] = [
  { date: "2023-01-01", numbers: [1, 2, 3, 4, 5, 6], bonus: 7 },
  { date: "2023-01-08", numbers: [1, 2, 3, 4, 5, 7], bonus: 8 },
  { date: "2023-01-15", numbers: [1, 10, 11, 12, 13, 14], bonus: 15 },
];

function testBayesian() {
  console.log("Testing Bayesian Smoothing...");
  const N = 49;
  const results = bayesianSmoothed(mockDraws, N);

  // Recent draws (like 1, 10, 11...) should have higher raw weights if monotonic
  const n1 = results.find((r) => r.number === 1)!;
  const n10 = results.find((r) => r.number === 10)!;
  const n2 = results.find((r) => r.number === 2)!;

  console.log(`Number 1 (all draws): ${n1.weightedCount}`);
  console.log(`Number 10 (recent draw): ${n10.weightedCount}`);
  console.log(`Number 2 (older draws): ${n2.weightedCount}`);

  if (n10.weightedCount > n2.weightedCount) {
    console.log(
      "✅ Recency weighting verified: Recent draw (10) has higher weight than older (2).",
    );
  } else {
    console.log("❌ Recency weighting failed.");
  }
}

function testNormalization() {
  console.log("\nTesting Composite Score Normalization...");
  const diag = runFullDiagnostics(mockDraws);
  const scores = compositeScoring(diag, mockDraws, WEIGHT_PROFILES[0]);

  const allComp = scores.map((s) => s.compositeScore);
  const max = Math.max(...allComp);
  const min = Math.min(...allComp);

  console.log(`Max Score: ${max}`);
  console.log(`Min Score: ${min}`);

  scores.slice(0, 5).forEach((s) => {
    console.log(
      `Num ${s.number}: Comp=${s.compositeScore.toFixed(4)}, HC=${s.hotColdScore.toFixed(4)}, Gap=${s.gapScore.toFixed(4)}`,
    );
  });

  if (max <= 5 && min >= 0) {
    // arbitrary bound check
    console.log("✅ Normalization range looks reasonable.");
  }
}

try {
  testBayesian();
  testNormalization();
} catch (e) {
  console.error("Verification failed:", e);
}
