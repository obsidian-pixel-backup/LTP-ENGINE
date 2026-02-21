import type { DrawRecord, FullDiagnostics } from "./analysis";
import type {
  ModelSettings,
  PredictionLiveTrace,
  PredictionOutput,
} from "./predictor";

export interface PredictionWorkerPredictRequest {
  requestId: number;
  type?: "predict";
  draws: DrawRecord[];
  settings?: ModelSettings;
}

export interface PredictionWorkerRefreshRequest {
  requestId: number;
  type: "refresh_candidates";
  draws: DrawRecord[];
  settings?: ModelSettings;
  basePrediction: PredictionOutput;
  diagnostics?: FullDiagnostics;
}

export interface PredictionWorkerCancelRequest {
  requestId: number;
  type: "cancel";
}

export type PredictionWorkerRequest =
  | PredictionWorkerPredictRequest
  | PredictionWorkerRefreshRequest
  | PredictionWorkerCancelRequest;

export interface PredictionWorkerProgress {
  requestId: number;
  type: "progress";
  percent: number;
  stage: string;
}

export interface PredictionWorkerTrace {
  requestId: number;
  type: "trace";
  percent: number;
  trace: PredictionLiveTrace;
}

export interface PredictionWorkerSuccess {
  requestId: number;
  type: "result";
  diagnostics: FullDiagnostics;
  prediction: PredictionOutput;
}

export interface PredictionWorkerRoundResult {
  requestId: number;
  type: "round_result";
  diagnostics: FullDiagnostics;
  prediction: PredictionOutput;
  round: number;
  percent: number;
  stage: string;
}

export interface PredictionWorkerRefreshResult {
  requestId: number;
  type: "refresh_result";
  diagnostics: FullDiagnostics;
  prediction: PredictionOutput;
}

export interface PredictionWorkerFailure {
  requestId: number;
  type: "error";
  error: string;
}

export type PredictionWorkerResponse =
  | PredictionWorkerTrace
  | PredictionWorkerProgress
  | PredictionWorkerRoundResult
  | PredictionWorkerRefreshResult
  | PredictionWorkerSuccess
  | PredictionWorkerFailure;
