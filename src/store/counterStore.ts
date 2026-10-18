import { create } from 'zustand'
import { counterService } from '../service/counterService'

type CounterState = {
  count: number
  hydrate: () => void
  increase: () => void
  decrease: () => void
}

export const useCounterStore = create<CounterState>((set, get) => ({
  count: 0,
  hydrate: () => {
    const counter = counterService.getCounter()
    set({ count: counter.value })
  },
  increase: () => {
    const nextValue = get().count + 1
    counterService.saveCounter({ value: nextValue })
    set({ count: nextValue })
  },
  decrease: () => {
    const nextValue = get().count - 1
    counterService.saveCounter({ value: nextValue })
    set({ count: nextValue })
  },
}))
