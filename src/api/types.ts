/**
 * BFF 统一响应信封：{ success, data | errorMessage }
 * 体彩两个接口保留上游原信封（success/errorMessage/value），因此这里仅用于
 * 天气、星座、IP 归属地等新增接口。
 */
export type BffEnvelope<T> = {
  success: boolean
  data?: T
  errorMessage?: string
}
