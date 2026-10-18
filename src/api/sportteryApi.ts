import { request } from './httpClient'
import {
  type LotteryHistoryParams,
  type LotteryHistoryValue,
  type MatchCalculatorValue,
  type MatchPoolKey,
  type SportteryEnvelope,
} from '../domain/sporttery'

/**
 * 体彩接口有两条链路：
 *
 * - 默认走同源 BFF：`/api/*`，由 server/ 或 api/ 转发，便于统一超时与错误码；
 * - `VITE_SPORTTERY_DIRECT=1` 时浏览器直连体彩。
 *
 * 之所以需要直连模式：体彩 WAF 会对云厂商出口 IP 返回 HTTP 567，
 * 部署在 Vercel（无论 iad1 还是 hkg1）都无法访问；而体彩接口本身
 * 不涉及密钥、且允许跨域，因此在云端部署时改为浏览器直连最稳妥。
 */
const DIRECT = import.meta.env.VITE_SPORTTERY_DIRECT === '1'

const MATCH_CALCULATOR_URL = DIRECT
  ? 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry'
  : '/api/matches'
const LOTTERY_HISTORY_URL = DIRECT
  ? 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
  : '/api/history'

function poolCodeFor(poolType: MatchPoolKey) {
  if (poolType === 'mixed') {
    return ''
  }
  if (poolType === 'had') {
    return 'hhad,had'
  }
  return poolType
}

export async function getMatchCalculator(poolType: MatchPoolKey = 'mixed', signal?: AbortSignal) {
  const query = new URLSearchParams({ channel: 'c' })
  if (DIRECT) {
    const poolCode = poolCodeFor(poolType)
    if (poolCode) {
      query.set('poolCode', poolCode)
    }
  } else {
    query.set('poolType', poolType)
  }

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
