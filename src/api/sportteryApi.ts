import { apiUrl } from './base'
import { request, requestWithMeta } from './httpClient'
import {
  type LotteryHistoryParams,
  type LotteryHistoryValue,
  type MatchCalculatorValue,
  type MatchPoolKey,
  type SportteryEnvelope,
} from '../domain/sporttery'

/**
 * 赛程与开奖数据。
 *
 * 全部走自有 API（apps/api 读库），浏览器不再直连体彩：
 * 体彩只由本地爬虫在服务端抓取，WAF 出口 IP 的问题因此消失。
 */
const MATCH_CALCULATOR_URL = apiUrl('/api/matches')
const LOTTERY_HISTORY_URL = apiUrl('/api/history')

export async function getMatchCalculator(poolType: MatchPoolKey = 'mixed', signal?: AbortSignal) {
  const query = new URLSearchParams({ channel: 'c', poolType })

  const response = await request<SportteryEnvelope<MatchCalculatorValue>>(
    `${MATCH_CALCULATOR_URL}?${query.toString()}`,
    { signal },
  )

  if (!response.success) {
    throw new Error(response.errorMessage || '接口返回失败')
  }

  return response.value
}

/**
 * 同 `getMatchCalculator`，额外带回 `x-data-as-of`。
 * 页面用它显示「数据更新于 …」，避免用户分不清是自己没刷新还是爬虫没跑。
 */
export async function getMatchCalculatorWithMeta(
  poolType: MatchPoolKey = 'mixed',
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ channel: 'c', poolType })

  const { data, headers } = await requestWithMeta<SportteryEnvelope<MatchCalculatorValue>>(
    `${MATCH_CALCULATOR_URL}?${query.toString()}`,
    { signal },
  )

  if (!data.success) {
    throw new Error(data.errorMessage || '接口返回失败')
  }

  return {
    value: data.value,
    dataAsOf: headers.get('x-data-as-of'),
    count: Number(headers.get('x-match-count') ?? 0),
  }
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
