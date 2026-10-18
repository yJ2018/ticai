import { json, proxyUpstream } from './_edge.js'

export const config = { runtime: 'edge' }

const UPSTREAM = 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry'
const POOL_CODES = { had: 'hhad,had', crs: 'crs', ttg: 'ttg', hafu: 'hafu' }

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ success: false, errorMessage: '不支持的方法，仅允许 GET' }, 405)
  }

  const url = new URL(request.url)
  const poolType = (url.searchParams.get('poolType') ?? 'mixed').trim() || 'mixed'
  const query = new URLSearchParams({ channel: 'c' })

  if (poolType !== 'mixed') {
    const poolCode = POOL_CODES[poolType]
    if (!poolCode) {
      return json({ success: false, errorMessage: `不支持的玩法池：${poolType}` }, 400)
    }
    query.set('poolCode', poolCode)
  }

  return proxyUpstream(`${UPSTREAM}?${query.toString()}`, 20)
}
