import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDebouncedInput } from "./useDebouncedInput"

// #127: 保存したあとに、遅れて届いた古い値 (echo) が入力欄を古い値で置き換えると、続けて打った文字が欠けたり、
// 古い値が保存されたりする。入力中は、自分が送った値 / 編集前の値の echo を無視する。
describe("useDebouncedInput: stale echoes while typing", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("keeps the typed value when a stale (older) value is echoed back after a save", () => {
		const onChange = vi.fn()
		const { result, rerender } = renderHook(({ initial }) => useDebouncedInput(initial, onChange, 100), {
			initialProps: { initial: "OLD" },
		})

		act(() => result.current[1]("ttp"))
		act(() => {
			vi.advanceTimersByTime(150)
		})
		expect(onChange).toHaveBeenLastCalledWith("ttp") // 保存した

		// 保存の echo より先に、編集前の古い値が状態として届く (遅れた古いスナップショット)
		rerender({ initial: "OLD" })
		rerender({ initial: "ttp" })
		rerender({ initial: "OLD" }) // 順序が入れ替わった古い値
		expect(result.current[0]).toBe("ttp") // 入力欄は、入力した値のまま

		// 続けて打った文字は、古い値の上ではなく、入力した値の上に乗る
		act(() => result.current[1]("http://x"))
		act(() => {
			vi.advanceTimersByTime(150)
		})
		expect(onChange).toHaveBeenLastCalledWith("http://x")
		expect(onChange).not.toHaveBeenCalledWith("OLD") // 古い値を保存し直さない
	})

	it("still follows a genuinely external change when nothing is being typed", () => {
		const onChange = vi.fn()
		const { result, rerender } = renderHook(({ initial }) => useDebouncedInput(initial, onChange, 100), {
			initialProps: { initial: "A" },
		})
		rerender({ initial: "B" }) // 他のウィンドウが変えた
		expect(result.current[0]).toBe("B")
		expect(onChange).not.toHaveBeenCalled()
	})
})
