import {
  analyzeMathTrendPrediction,
  type MathTrendAnalyzeOptions,
  type MathTrendPredictionAnalysis,
  type PredictionHistoryEntry,
} from '../domain/historyPrediction'

type MathTrendAnalysisWorkerRequest = {
  requestId: number
  entries: PredictionHistoryEntry[]
  options: MathTrendAnalyzeOptions
}

type MathTrendAnalysisWorkerResponse = {
  requestId: number
  analysis: MathTrendPredictionAnalysis
}

self.onmessage = (event: MessageEvent<MathTrendAnalysisWorkerRequest>) => {
  const { requestId, entries, options } = event.data
  const analysis = analyzeMathTrendPrediction(entries, options)
  const response: MathTrendAnalysisWorkerResponse = {
    requestId,
    analysis,
  }

  self.postMessage(response)
}

export {}
