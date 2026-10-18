import { request } from './httpClient'
import {
  type LotteryHistoryParams,
  type LotteryHistoryValue,
  type MatchCalculatorValue,
  type MatchPoolKey,
  type SportteryEnvelope,
} from '../domain/sporttery'

// 统一走同源 BFF：/api/* 由 server/index.mjs 转发，密钥与上游地址不进入前端 bundle
const MATCH_CALCULATOR_URL = '/api/matches'
const LOTTERY_HISTORY_URL = '/api/history'

export async function getMatchCalculator(poolType: MatchPoolKey = 'mixed', signal?: AbortSignal) {
  const query = new URLSearchParams({ poolType })

  const response = await request<SportteryEnvelope<MatchCalculatorValue>>(
    `${MATCH_CALCULATOR_URL}?${query.toString()}`,
    { signal },
  )

  if (!response.success) {
    throw new Error(response.errorMessage || '接口返回失败')
  }

  return response.value
}

export async function getLotteryHistoryPage(params: LotteryHistoryParams, signal?: AbortSignal) {
  const query = new URLSearchParams({
    gameNo: params.gameNo,
    provinceId: String(params.provinceId ?? 0),
    pageSize: String(params.pageSize ?? 30),
    isVerify: String(params.isVerify ?? 1),
    termLimits: String(params.termLimits ?? 0),
    pageNo: String(params.pageNo ?? 1),
  })

  const response = await request<SportteryEnvelope<LotteryHistoryValue>>(
    `${LOTTERY_HISTORY_URL}?${query.toString()}`,
    { signal },
  )

  if (!response.success) {
    throw new Error(response.errorMessage || '接口返回失败')
  }

  return response.value
}
