import { json, proxyUpstream } from './_edge.js'

export const config = { runtime: 'edge' }

const UPSTREAM = 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
const ALLOWED_PARAMS = ['gameNo', 'provinceId', 'pageSize', 'isVerify', 'termLimits', 'pageNo']

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ success: false, errorMessage: '不支持的方法，仅允许 GET' }, 405)
  }

  const url = new URL(request.url)
  const gameNo = (url.searchParams.get('gameNo') ?? '').trim()
  if (!/^\d{4,8}$/.test(gameNo)) {
    return json({ success: false, errorMessage: 'gameNo 参数不合法' }, 400)
  }

  const query = new URLSearchParams()
  for (const key of ALLOWED_PARAMS) {
    const value = url.searchParams.get(key)
    if (value !== null && value !== '') {
      query.set(key, value)
    }
  }

  return proxyUpstream(`${UPSTREAM}?${query.toString()}`, 60)
}
