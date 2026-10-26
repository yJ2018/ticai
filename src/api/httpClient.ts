export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: BodyInit | null
  signal?: AbortSignal
  /** 超时保护，默认 15s；避免弱网下请求悬挂 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 与 `request` 相同，但把响应头一起返回。
 * 赛事接口用 `x-data-as-of` 告诉前端「库里的数据是什么时候的」，页面才能显示真实新鲜度。
 */
export async function requestWithMeta<T>(
  url: string,
  options: RequestOptions = {},
): Promise<{ data: T; headers: Headers }> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal =
    options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, timeoutSignal])
      : (options.signal ?? timeoutSignal)

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
      throw error
    }

    if (timeoutSignal.aborted) {
      throw new ApiError('请求超时，请稍后重试', 408)
    }

    throw new ApiError('网络请求失败，请确认 BFF 服务已启动（npm run dev）', 0)
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status)
  }

  if (response.status === 204) {
    return { data: undefined as T, headers: response.headers }
  }

  try {
    return { data: (await response.json()) as T, headers: response.headers }
  } catch {
    throw new ApiError('接口返回格式异常', response.status)
  }
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { data } = await requestWithMeta<T>(url, options)
  return data
}

async function readErrorMessage(response: Response) {
  try {
    const text = await response.text()
    if (!text) {
      return `请求失败: ${response.status}`
    }

    try {
      const body = JSON.parse(text) as { errorMessage?: unknown; message?: unknown; reason?: unknown }
      const message = body.errorMessage ?? body.message ?? body.reason
      if (typeof message === 'string' && message.trim()) {
        return message
      }
    } catch {
      // 非 JSON 响应，下面按纯文本兜底
    }

    if (text.length <= 200) {
      return text
    }
  } catch {
    // 读取 body 失败时忽略，使用状态码兜底
  }

  return `请求失败: ${response.status}`
}
