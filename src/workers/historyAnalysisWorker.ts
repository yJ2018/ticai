import {
  analyzeHistoryPrediction,
  type HistoryPredictionAnalysis,
  type PredictionAnalyzeOptions,
  type PredictionHistoryEntry,
} from '../domain/historyPrediction'

type HistoryAnalysisWorkerRequest = {
  requestId: number
  entries: PredictionHistoryEntry[]
  options: PredictionAnalyzeOptions
}

type HistoryAnalysisWorkerResponse = {
  requestId: number
  analysis: HistoryPredictionAnalysis
}

self.onmessage = (event: MessageEvent<HistoryAnalysisWorkerRequest>) => {
  const { requestId, entries, options } = event.data
  const analysis = analyzeHistoryPrediction(entries, options)
  const response: HistoryAnalysisWorkerResponse = {
    requestId,
    analysis,
  }

  self.postMessage(response)
}

export {}
