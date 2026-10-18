import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getTaskTrackerHtml } from "./task-tracker-webview-html"

// jsdom は webview-ui の devDependency (拡張側からは直接解決できない)
const { JSDOM } = createRequire(path.join(__dirname, "../../../webview-ui/package.json"))("jsdom")

function task(over: Record<string, unknown> = {}) {
	return {
		id: 1,
		title: "元の件名",
		status: "未着手",
		priority: "MIDDLE",
		category: "",
		assignee: "",
		remarks: "",
		creator: "me",
		created: "2026-01-01 00:00",
		updater: "me",
		updated: "2026-01-01 00:00",
		history: "",
		...over,
	}
}

function open() {
	const posted: unknown[] = []
	let state: unknown
	const dom = new JSDOM(getTaskTrackerHtml("n"), {
		runScripts: "dangerously",
		pretendToBeVisual: true,
		beforeParse(window: any) {
			;(window as any).acquireVsCodeApi = () => ({
				postMessage: (m: unknown) => posted.push(m),
				getState: () => state,
				setState: (s: unknown) => {
					state = s
				},
			})
			;(window as any).scrollTo = () => {}
		},
	})
	const send = (tasks: unknown[], categories: string[] = []) =>
		dom.window.dispatchEvent(
			new dom.window.MessageEvent("message", { data: { type: "tasks", tasks, categories, author: "me" } }),
		)
	return { dom, doc: dom.window.document, send, posted }
}

describe("task tracker webview: 編集中の保護 (#25)", () => {
	it("keeps an unsaved edit (and its orange marker) across a reload, and warns on closing", () => {
		const { dom, doc, send, posted } = open()
		send([task()])
		// カードを開く
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const input = doc.querySelector(".js-title") as HTMLInputElement
		expect(input.value).toBe("元の件名")

		// 編集 (入力イベント)
		input.value = "編集中の件名"
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(doc.querySelector(".js-title")!.classList.contains("dirty")).toBe(true)

		// 別の内容でリロードされても、編集中の項目は変わらず、印も残る
		send([task({ title: "外部で更新された件名", updated: "2026-01-02 00:00" })])
		const after = doc.querySelector(".js-title") as HTMLInputElement
		expect(after.value).toBe("編集中の件名")
		expect(after.classList.contains("dirty")).toBe(true)
		expect(doc.querySelector(".card")!.classList.contains("dirty")).toBe(true)

		// 未保存のまま閉じようとすると、画面内のお知らせ + ホストの警告通知が出て、閉じない
		// (webview では alert() が使えないので、alert には頼らない)
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const err = doc.querySelector(".card .card-error") as HTMLElement
		expect(err).not.toBeNull()
		expect(err.textContent).toContain("unsaved")
		expect(doc.querySelector(".card")!.classList.contains("has-error")).toBe(true)
		expect(posted.find((m: any) => m.type === "warn")).toMatchObject({ text: expect.stringContaining("unsaved") })
		expect(doc.querySelector(".js-title")).not.toBeNull()
	})

	it("drops the marker after discard", () => {
		const { dom, doc, send } = open()
		send([task()])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const input = doc.querySelector(".js-title") as HTMLInputElement
		input.value = "x"
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		;(doc.querySelector(".js-discard") as HTMLElement).click()
		// 破棄するとカードが閉じる (#80)。開き直すと元の件名で、印も付いていない
		expect(doc.querySelector(".js-title")).toBeNull()
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect((doc.querySelector(".js-title") as HTMLInputElement).value).toBe("元の件名")
		expect(doc.querySelector(".js-title")!.classList.contains("dirty")).toBe(false)
	})
})

describe("task tracker webview: 一覧項目と検索 (#18 / #15)", () => {
	it("shows creator / created / updated on the card row", () => {
		const { doc, send } = open()
		send([task({ creator: "AI", created: "2026-09-04 08:10", updated: "2026-09-07 00:46" })])
		// 日付は左の 2 行ブロックの 2 行目に短い形で (#101)。登録者・年を含む完全な値はツールチップに
		const dates = doc.querySelector(".card .row .idblock .dates") as HTMLElement
		expect(dates.textContent).toBe("C 09-04 08:10 · U 09-07 00:46")
		expect(dates.title).toContain("by AI")
		expect(dates.title).toContain("Created 2026-09-04 08:10")
		expect(dates.title).toContain("Updated 2026-09-07 00:46")
	})

	it("filters the list by free-text search", () => {
		const { dom, doc, send } = open()
		send([
			task({ id: 1, title: "ログイン画面のバグ", history: "" }),
			task({ id: 2, title: "ドキュメント整備", assignee: "TK", history: "- x me: 認証まわりを確認" }),
			task({ id: 3, title: "アイコン差し替え" }),
		])
		const search = doc.getElementById("search") as HTMLInputElement
		const visible = () => Array.from(doc.querySelectorAll(".card")).map((c) => (c as HTMLElement).dataset.id)
		expect(visible()).toEqual(["1", "2", "3"])

		search.value = "認証"
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(visible()).toEqual(["2"])

		search.value = "#3"
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(visible()).toEqual(["3"])

		search.value = "tk"
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(visible()).toEqual(["2"])
	})
})

describe("task tracker webview: 登録 (#48 / #55)", () => {
	it("lets you pick a category when registering, and closes open cards afterwards", () => {
		const { dom, doc, send, posted } = open()
		send([task()], ["バグ", "タスク"])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect(doc.querySelector(".js-title")).not.toBeNull()

		const dlg = doc.getElementById("new-dlg") as HTMLDialogElement
		;(dlg as any).showModal = () => {}
		;(doc.getElementById("new-btn") as HTMLElement).click()
		const opts = Array.from((doc.getElementById("nd-category") as HTMLSelectElement).options).map((o) => o.value)
		expect(opts).toEqual(["", "バグ", "タスク"])

		;(doc.getElementById("nd-title") as HTMLInputElement).value = "新しい課題"
		;(doc.getElementById("nd-category") as HTMLSelectElement).value = "バグ"
		;(dlg as any).returnValue = "ok"
		dlg.dispatchEvent(new dom.window.Event("close"))

		const created = posted.find((m: any) => m.type === "create") as any
		expect(created).toMatchObject({ title: "新しい課題", category: "バグ", priority: "MIDDLE" })
		// 開いていた課題は閉じている
		expect(doc.querySelector(".js-title")).toBeNull()
	})

	it("closes the card right after saving", () => {
		const { doc, send, posted } = open()
		send([task()])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		;(doc.querySelector(".js-save") as HTMLElement).click()
		expect(posted.some((m: any) => m.type === "update")).toBe(true)
		expect(doc.querySelector(".js-title")).toBeNull()
	})
})

describe("task tracker webview: 追記は未確定の印付き (#59)", () => {
	it("posts the note as tmp, shows it as unsaved, blocks closing, and commits/discards with save/discard", () => {
		const { dom, doc, send, posted } = open()
		send([task({ history: "- 2026-01-01 00:00 me: 登録。" })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const ta = doc.querySelector(".js-note") as HTMLTextAreaElement
		ta.value = "下書きコメント"
		ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		;(doc.querySelector(".js-note-btn") as HTMLElement).click()
		expect(posted.find((m: any) => m.type === "note")).toMatchObject({ text: "下書きコメント", tmp: true })

		// ホストが印付きで書き込み → 再配信
		send([task({ history: "- 2026-01-01 00:00 me: 登録。\n- 2026-10-16 20:00 me: data-tmp-::下書きコメント" })])
		const tmp = doc.querySelector(".history .tmp-line")
		expect(tmp?.textContent).toContain("[Unsaved]")
		expect(tmp?.textContent).toContain("下書きコメント")
		expect(doc.querySelector(".card")!.classList.contains("dirty")).toBe(true)

		// 未確定の追記があるうちは閉じられない
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect(doc.querySelector(".card .card-error")).not.toBeNull()

		// 保存 → commitNotes
		;(doc.querySelector(".js-save") as HTMLElement).click()
		expect(posted.find((m: any) => m.type === "update")).toMatchObject({ commitNotes: true })
	})

	it("discard sends discardNotes when tmp notes exist", () => {
		const { doc, send, posted } = open()
		send([task({ history: "- 2026-10-16 20:00 me: data-tmp-::消したい" })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		;(doc.querySelector(".js-discard") as HTMLElement).click()
		expect(posted.some((m: any) => m.type === "discardNotes")).toBe(true)
	})
})

describe("task tracker webview: 編集ロック通知", () => {
	it("tells the host when editing starts and when it ends", () => {
		const { dom, doc, send, posted } = open()
		const editing = () => posted.filter((m: any) => m.type === "editing").map((m: any) => m.editing)
		send([task()])
		expect(editing()).toEqual([])

		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const input = doc.querySelector(".js-title") as HTMLInputElement
		input.value = "x"
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(editing()).toEqual([true])

		;(doc.querySelector(".js-discard") as HTMLElement).click()
		expect(editing()).toEqual([true, false])
	})
})

describe("task tracker webview: 本文の途中の data-tmp-:: は未確定扱いにしない", () => {
	it("does not enter editing state or show [Unsaved] when the marker only appears mid-line", () => {
		const { doc, send, posted } = open()
		send([task({ history: "- 2026-10-16 20:59 AI: 一時変更は data-tmp-:: で逃がす方針で実装した。\n- 2026-10-16 21:00 AI: 注意: data-tmp-:: の説明" })])
		expect(posted.some((m: any) => m.type === "editing")).toBe(false)
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect(doc.querySelector(".history .tmp-line")).toBeNull()
		expect(doc.querySelector(".card")!.classList.contains("dirty")).toBe(false)
		// 行頭 (名前: の直後) に付いた行だけが未確定扱い
		send([task({ history: "- 2026-10-16 20:59 AI: 本文中の data-tmp-:: は通常\n- 2026-10-16 21:00 me: data-tmp-::本物の下書き" })])
		expect(doc.querySelectorAll(".history .tmp-line")).toHaveLength(1)
		expect(doc.querySelector(".history .tmp-line")!.textContent).toContain("[Unsaved] 本物の下書き")
	})
})

describe("task tracker webview: 破棄ボタンの空振り防止", () => {
	it("does not re-render the list when a text input loses focus (so the next button click is not lost)", () => {
		const { dom, doc, send } = open()
		send([task()])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const input = doc.querySelector(".js-title") as HTMLInputElement
		const discard = doc.querySelector(".js-discard") as HTMLElement
		input.value = "編集後の件名"
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) // blur 相当
		// 同じボタン要素が残っている (描き直されていない) ので、続くクリックが効く
		expect(discard.isConnected).toBe(true)
		// 一覧行の件名はその場で更新される
		expect(doc.querySelector(".card .row .title")!.textContent).toBe("編集後の件名")
		discard.click()
		expect(doc.querySelector(".js-title")).toBeNull() // 破棄で閉じる (#80)
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect((doc.querySelector(".js-title") as HTMLInputElement).value).toBe("元の件名")
	})
})

describe("task tracker webview: 新規登録の既定カテゴリ (#79)", () => {
	it("pre-selects 'タスク' in the new-task dialog when it exists, else (なし)", () => {
		const { doc, send } = open()
		send([task()], ["バグ", "タスク", "設計"])
		const dlg = doc.getElementById("new-dlg") as any
		dlg.showModal = () => {}
		;(doc.getElementById("new-btn") as HTMLElement).click()
		expect((doc.getElementById("nd-category") as HTMLSelectElement).value).toBe("タスク")

		send([task()], ["バグ", "設計"])
		;(doc.getElementById("new-btn") as HTMLElement).click()
		expect((doc.getElementById("nd-category") as HTMLSelectElement).value).toBe("")
	})
})

describe("task tracker webview: 判断待ち ([CONFIRM]) の点滅", () => {
	const confirmHistory = "- 2026-10-17 10:00 AI: 登録。\n- 2026-10-17 10:01 AI: [CONFIRM] A と B のどちらにしますか"

	it("marks the card and highlights the [CONFIRM] line while it is open", () => {
		const { doc, send } = open()
		send([task({ history: confirmHistory })])
		const card = doc.querySelector(".card") as HTMLElement
		expect(card.classList.contains("confirm")).toBe(true)
		expect(card.textContent).toContain("Needs decision")
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const lines = doc.querySelectorAll(".history .confirm-line")
		expect(lines).toHaveLength(1)
		expect(lines[0].textContent).toContain("[CONFIRM] A と B")
		expect(doc.querySelectorAll(".history > div")).toHaveLength(2) // 他の行は点滅しない
	})

	it("stops once a later [RESOLVED] line cancels it", () => {
		const { doc, send } = open()
		send([task({ history: `${confirmHistory}\n- 2026-10-17 10:05 TK: A で\n- 2026-10-17 10:06 AI: [RESOLVED] A に決定` })])
		expect(doc.querySelector(".card")!.classList.contains("confirm")).toBe(false)
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect(doc.querySelector(".history .confirm-line")).toBeNull()
	})

	it("does not fire for a mid-sentence mention, nor for completed tasks", () => {
		const { doc, send } = open()
		send([
			task({ id: 1, history: "- 2026-10-17 10:00 AI: 説明: [CONFIRM] は文頭に書く" }),
			task({ id: 2, status: "完了", history: confirmHistory }),
		])
		expect(doc.querySelectorAll(".card.confirm")).toHaveLength(0)
	})

	it("shows the number of open questions in the toolbar pill", () => {
		const { doc, send } = open()
		const pill = doc.getElementById("confirm-pill") as HTMLElement
		send([task({ id: 1 })])
		expect(pill.hidden).toBe(true)
		send([task({ id: 1, history: confirmHistory }), task({ id: 2, history: confirmHistory }), task({ id: 3 })])
		expect(pill.hidden).toBe(false)
		expect(pill.textContent).toContain("2")
	})

	it("supports per-topic tags in the panel too", () => {
		const { doc, send } = open()
		const h = "- 2026-10-17 10:00 AI: [CONFIRM:db] DB は\n- 2026-10-17 10:01 AI: [CONFIRM:ui] UI は\n- 2026-10-17 10:02 TK: [RESOLVED:db] SQLite"
		send([task({ history: h })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const lines = Array.from(doc.querySelectorAll(".history .confirm-line")).map((l: any) => l.textContent as string)
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("[CONFIRM:ui]")
	})
})

describe("task tracker webview: 判断待ちの点滅の見た目 (#97)", () => {
	const html = getTaskTrackerHtml("n")
	const rule = (selector: string) => html.match(new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? ""

	it("blinks (line / badge / pill / card) via CSS keyframes, regardless of the OS reduced-motion setting", () => {
		expect(html).toContain("@keyframes confirm-pulse")
		expect(html).toContain("@keyframes confirm-card")
		expect(html).toContain("@keyframes confirm-outline")
		expect(rule(".history .confirm-line")).toMatch(/animation: confirm-pulse [^;]*infinite alternate/)
		// バッジ・ピルは塗りつぶさず枠線だけを点滅させる (#97: 目が痛いため)
		for (const sel of [".confirm-badge", ".confirm-pill"]) {
			expect(rule(sel)).toMatch(/animation: confirm-outline [^;]*infinite alternate/)
		}
		expect(rule(".card.confirm")).toMatch(/animation: confirm-card [^;]*infinite alternate/)
		expect(html).not.toContain("prefers-reduced-motion: reduce")
	})

	it("draws the badge and pill as an outline only (transparent background, border), not a solid fill", () => {
		for (const sel of [".confirm-badge", ".confirm-pill"]) {
			expect(rule(sel)).toMatch(/background: transparent;/)
			expect(rule(sel)).toMatch(/border: 1\.5px solid/)
		}
		expect(html).not.toMatch(/@keyframes confirm-outline \{[^}]*background/)
	})

	it("uses white text for the confirmation line / badge / pill", () => {
		for (const sel of [".history .confirm-line", ".confirm-badge", ".confirm-pill"]) {
			expect(rule(sel)).toMatch(/color: #fff;/)
		}
	})

	it("has no red frame on the list card (no border / box-shadow), only a faint background pulse", () => {
		expect(rule(".card.confirm")).not.toMatch(/border|box-shadow/)
		expect(html).not.toMatch(/@keyframes confirm-card \{[^}]*box-shadow/)
		expect(html).not.toMatch(/@keyframes confirm-card \{[^}]*border/)
	})
})

describe("task tracker webview: 英語表記・カテゴリのプルダウン・検索語のハイライト・行レイアウト", () => {
	it("shows English labels (status values stay Japanese in the data, shown with English names)", () => {
		const { doc, send } = open()
		send([task({ status: "対応中" })], ["タスク"])
		const visible = doc.body.textContent!
		for (const word of ["New", "Show:", "Active only", "Categories", "Refresh", "Open task.md"]) {
			expect(visible).toContain(word)
		}
		const statusSelect = doc.querySelector(".js-quick-status") as HTMLSelectElement
		expect(statusSelect.value).toBe("対応中") // 保存値は日本語のまま
		expect(Array.from(statusSelect.options).map((o) => o.textContent)).toEqual(["Not started", "In progress", "Reported (needs your check)", "Sent back (rework)", "On hold", "Done", "Deleted"])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const detail = doc.querySelector(".detail")!.textContent!
		for (const word of ["Title", "Category", "Priority", "Status", "Assignee", "Remarks", "Add note", "Save changes", "Discard"]) {
			expect(detail).toContain(word)
		}
		const toolbar = doc.querySelector(".toolbar")!.cloneNode(true) as HTMLElement
		toolbar.querySelector("#cat-filter")!.remove() // カテゴリ名はデータ (日本語のまま)
		expect(/[ぁ-んァ-ヶ]/.test(toolbar.textContent!)).toBe(false) // ラベルにひらがな・カタカナは無い
	})

	it("filters by category with a dropdown that is independent of the search box (#93)", () => {
		const { dom, doc, send } = open()
		send(
			[task({ id: 1, category: "バグ" }), task({ id: 2, category: "タスク" }), task({ id: 3, category: "" })],
			["バグ", "タスク"],
		)
		const cat = doc.getElementById("cat-filter") as HTMLSelectElement
		expect(Array.from(cat.options).map((o) => o.textContent)).toEqual(["All categories", "バグ", "タスク", "(no category)"])
		const ids = () => Array.from(doc.querySelectorAll(".card")).map((c) => (c as HTMLElement).dataset.id)
		expect(ids()).toEqual(["1", "2", "3"])

		cat.value = "バグ"
		cat.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
		expect(ids()).toEqual(["1"])
		cat.value = "__none"
		cat.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
		expect(ids()).toEqual(["3"])

		// 検索語とは AND で独立に効く。選択は再読み込み (タスクの再送) でも保たれる
		cat.value = "タスク"
		cat.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
		const search = doc.getElementById("search") as HTMLInputElement
		search.value = "#2"
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(ids()).toEqual(["2"])
		send([task({ id: 1, category: "バグ" }), task({ id: 2, category: "タスク" })], ["バグ", "タスク"])
		expect((doc.getElementById("cat-filter") as HTMLSelectElement).value).toBe("タスク")
	})

	it("highlights the search keyword in the title and in the expanded history (#96)", () => {
		const { dom, doc, send } = open()
		send([task({ title: "ログイン画面のバグ", history: "- 2026-10-17 10:00 AI: ログインの修正を完了 (ログイン)" })])
		const search = doc.getElementById("search") as HTMLInputElement
		search.value = "ログイン"
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(doc.querySelector(".card .title mark.hit")!.textContent).toBe("ログイン")
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect(doc.querySelectorAll(".history mark.hit").length).toBe(2)
		// 検索語を消すとハイライトも消える
		search.value = ""
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(doc.querySelector("mark.hit")).toBeNull()
		// 特殊文字の検索語でも壊れない
		search.value = "(ログイン)"
		search.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
		expect(doc.querySelectorAll(".history mark.hit").length).toBe(1)
	})

	it("gives the title the full width: priority + #ID on line 1 and the dates on line 2 of the left block (#101)", () => {
		const { doc, send } = open()
		send([task({ title: "とても長い件名".repeat(8), priority: "HIGH", id: 42 })])
		const block = doc.querySelector(".card .row .idblock") as HTMLElement
		expect(block.querySelector(".idline")!.textContent).toBe("HIGH#42")
		expect(block.querySelector(".dates")!.textContent).toMatch(/^C \d\d-\d\d \d\d:\d\d · U /)
		// 行は [2 行ブロック] [件名 (バッジは件名の下の行)] [ステータス] の 3 つだけ。件名が残りの幅をすべて使える
		const row = doc.querySelector(".card .row") as HTMLElement
		expect(Array.from(row.children).map((c) => c.className.split(" ")[0])).toEqual(["idblock", "titleblock", "badge"])
		expect(doc.querySelector(".titleblock .title")!.textContent).toContain("とても長い件名")
	})
})

describe("task tracker webview: 手動並べ替え (#15) とステータス 報告 / 差戻", () => {
	const drag = (dom: any, type: string, target: Element, clientY = 0) => {
		const ev = new dom.window.Event(type, { bubbles: true, cancelable: true }) as any
		ev.dataTransfer = { effectAllowed: "", setData: () => {} }
		ev.clientY = clientY
		target.dispatchEvent(ev)
	}
	const cards = () => [task({ id: 1 }), task({ id: 2 }), task({ id: 3 })]

	it("posts a reorder (before the target) when a card header is dropped on another card", () => {
		const { dom, doc, send, posted } = open()
		send(cards())
		const rows = doc.querySelectorAll(".card .row")
		expect(rows[0].getAttribute("draggable")).toBe("true")
		drag(dom, "dragstart", rows[2])
		drag(dom, "drop", rows[0], 0) // upper half of card 1 (jsdom has no layout: top=height=0, clientY=0 means not after)
		expect(posted).toContainEqual({ type: "reorder", id: 3, beforeId: 1 })
	})

	it("posts beforeId = null when dropped on the lower half of the last card", () => {
		const { dom, doc, send, posted } = open()
		send(cards())
		const rows = doc.querySelectorAll(".card .row")
		drag(dom, "dragstart", rows[0])
		drag(dom, "drop", rows[2], 5) // lower half
		expect(posted).toContainEqual({ type: "reorder", id: 1, beforeId: null })
	})

	it("ignores a drop on the card itself", () => {
		const { dom, doc, send, posted } = open()
		send(cards())
		const rows = doc.querySelectorAll(".card .row")
		drag(dom, "dragstart", rows[1])
		drag(dom, "drop", rows[1], 0)
		expect(posted.filter((m: any) => m.type === "reorder")).toHaveLength(0)
	})

	it("lists 報告 and 差戻 in the status select with English names", () => {
		const { doc, send } = open()
		send([task({ status: "報告" })])
		const names = Array.from((doc.querySelector(".js-quick-status") as HTMLSelectElement).options).map((o) => o.textContent)
		expect(names).toContain("Reported (needs your check)")
		expect(names).toContain("Sent back (rework)")
	})
})


describe("task tracker webview: opening a card scrolls it to the top (#104)", () => {
	it("calls scrollIntoView({block:'start'}) on the opened card, not when closing", () => {
		const { dom, doc, send } = open()
		send([task({ id: 1 }), task({ id: 2 })])
		const calls: Array<{ id: string | undefined; arg: unknown }> = []
		;(dom.window as any).Element.prototype.scrollIntoView = function (arg: unknown) {
			calls.push({ id: (this as HTMLElement).dataset?.id, arg })
		}
		;(doc.querySelectorAll(".card .js-toggle")[1] as HTMLElement).click()
		expect(calls).toEqual([{ id: "2", arg: { block: "start" } }])
		calls.length = 0
		;(doc.querySelectorAll(".card .js-toggle")[1] as HTMLElement).click() // close
		expect(calls).toHaveLength(0)
	})
})


describe("task tracker webview: no full re-render while a control in the list has focus (#105)", () => {
	it("keeps the focused select (same node) when new tasks arrive, and renders after blur", async () => {
		const { doc, send } = open()
		send([task({ id: 1, title: "before" })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click() // open the card
		const select = doc.querySelector(".card .js-quick-status") as HTMLSelectElement
		select.focus()
		expect(doc.activeElement).toBe(select)
		send([task({ id: 1, title: "after" })])
		expect(doc.querySelector(".card .js-quick-status")).toBe(select) // not replaced
		expect(doc.querySelector(".card .title")!.textContent).toContain("before")
		select.blur()
		await new Promise((r) => setTimeout(r, 10))
		expect(doc.querySelector(".card .title")!.textContent).toContain("after") // rendered once the focus left
	})
})


describe("task tracker webview: a typed but not added note blocks closing and saving (#65)", () => {
	const typeNote = (doc: Document, text: string) => {
		const ta = doc.querySelector(".card .js-note") as HTMLTextAreaElement
		ta.value = text
		ta.dispatchEvent(new (doc.defaultView as any).Event("input", { bubbles: true }))
	}
	it("shows a notice and keeps the card open when closing with note text that was not added", () => {
		const { doc, send } = open()
		send([task({ id: 1 })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		typeNote(doc, "half written")
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click() // try to close
		expect(doc.querySelector(".card.open")).not.toBeNull()
		expect(doc.querySelector(".card .card-error")!.textContent).toContain("has not been added")
	})
	it("does not save while a note draft is pending", () => {
		const { doc, send, posted } = open()
		send([task({ id: 1 })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		typeNote(doc, "half written")
		;(doc.querySelector(".card .js-save") as HTMLElement).click()
		expect(posted.filter((m: any) => m.type === "update")).toHaveLength(0)
		expect(doc.querySelector(".card .card-error")!.textContent).toContain("Not saved")
	})
	it("closes normally once the draft is cleared", () => {
		const { doc, send } = open()
		send([task({ id: 1 })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		typeNote(doc, "half written")
		typeNote(doc, "")
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect(doc.querySelector(".card.open")).toBeNull()
	})
})


describe("task tracker webview: the list does not scroll while a card is open (#104)", () => {
	it("marks the body card-open only while a card is expanded", () => {
		const { doc, send } = open()
		send([task({ id: 1 }), task({ id: 2 })])
		expect(doc.body.classList.contains("card-open")).toBe(false)
		;(doc.querySelectorAll(".card .js-toggle")[0] as HTMLElement).click()
		expect(doc.body.classList.contains("card-open")).toBe(true)
		;(doc.querySelectorAll(".card .js-toggle")[0] as HTMLElement).click() // close
		expect(doc.body.classList.contains("card-open")).toBe(false)
	})
})


describe("task tracker webview: a note draft does not hold the task.md edit lock (#65)", () => {
	it("posts editing:false (no lock) while only an un-added note draft exists, but still blocks closing", () => {
		const { doc, send, posted } = open()
		send([task({ id: 1 })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const ta = doc.querySelector(".card .js-note") as HTMLTextAreaElement
		ta.value = "typed only"
		ta.dispatchEvent(new (doc.defaultView as any).Event("input", { bubbles: true }))
		expect(posted.filter((m: any) => m.type === "editing" && m.editing === true)).toHaveLength(0)
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click() // still blocked
		expect(doc.querySelector(".card.open")).not.toBeNull()
	})
})


describe("task tracker webview: the opened card stops below the sticky toolbar (#104)", () => {
	it("sets a scroll margin on the opened card equal to the toolbar height (+4px)", () => {
		const { dom, doc, send } = open()
		send([task({ id: 1 })])
		const tb = doc.querySelector(".toolbar") as HTMLElement
		Object.defineProperty(tb, "offsetHeight", { value: 70, configurable: true })
		;(dom.window as any).Element.prototype.scrollIntoView = () => {}
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		expect((doc.querySelector(".card") as HTMLElement).style.scrollMarginTop).toBe("74px")
	})
})


describe("task tracker webview: every blocked action shows the same in-card error (#65)", () => {
	it("uses one red error block inside the card for unsaved edits, a pending note, and a blocked save", () => {
		const { doc, send } = open()
		send([task({ id: 1 })])
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const ta = doc.querySelector(".card .js-note") as HTMLTextAreaElement
		ta.value = "typed"
		ta.dispatchEvent(new (doc.defaultView as any).Event("input", { bubbles: true }))
		;(doc.querySelector(".card .js-toggle") as HTMLElement).click()
		const a = doc.querySelector(".card .card-error") as HTMLElement
		expect(a.getAttribute("role")).toBe("alert")
		expect(a.textContent).toMatch(/^⚠ Not closed:/)
		;(doc.querySelector(".card .js-save") as HTMLElement).click()
		const b = doc.querySelector(".card .card-error") as HTMLElement
		expect(b.textContent).toMatch(/^⚠ Not saved:/)
		expect(doc.querySelectorAll(".card .card-error")).toHaveLength(1)
	})
})
