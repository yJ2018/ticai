import { COUNTER_STORAGE_KEY, defaultCounter, type Counter } from '../domain/counter'

export const counterService = {
  getCounter(): Counter {
    if (typeof window === 'undefined') {
      return defaultCounter
    }

    const rawValue = window.localStorage.getItem(COUNTER_STORAGE_KEY)
    if (!rawValue) {
      return defaultCounter
    }

    const parsed = Number(rawValue)
    return Number.isFinite(parsed) ? { value: parsed } : defaultCounter
  },

  saveCounter(counter: Counter) {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(COUNTER_STORAGE_KEY, String(counter.value))
  },
}
