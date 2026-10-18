import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// vscode は偽物に差し替える (エディタ領域のタブの作り方・開き直し・復元だけを検証する)
const created: any[] = []
vi.mock("vscode", () => ({
	ViewColumn: { Active: -1, Beside: -2 },
	window: {
		createWebviewPanel: (...args: unknown[]) => {
			const p = fakePanel()
			p.createArgs = args
			created.push(p)
			return p
		},
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	workspace: { getConfiguration: () => ({ get: () => "me" }), openTextDocument: vi.fn() },
	Uri: { file: (p: string) => ({ fsPath: p }) },
}))

function fakePanel(): any {
	const msg: ((m: unknown) => void)[] = []
	const dispose: (() => void)[] = []
	const view: (() => void)[] = []
	const posted: any[] = []
	return {
		createArgs: undefined,
		viewColumn: -1,
		visible: true,
		iconPath: undefined,
		reveal: vi.fn(),
		posted,
		webview: {
			options: {},
			html: "",
			postMessage: async (m: unknown) => {
				posted.push(m)
				return true
			},
			onDidReceiveMessage: (h: (m: unknown) => void) => {
				msg.push(h)
				return { dispose() {} }
			},
		},
		onDidChangeViewState: (h: () => void) => {
			view.push(h)
			return { dispose() {} }
		},
		onDidDispose: (h: () => void) => {
			dispose.push(h)
			return { dispose() {} }
		},
		// テストから操作する
		send: async (m: unknown) => {
			for (const h of msg) {
				await h(m)
			}
		},
		close: () => dispose.forEach((h) => h()),
		fireViewState: () => view.forEach((h) => h()),
	}
}

import { TaskMdStore } from "./task-md-store"
import { TaskTrackerEditor, TaskTrackerSideView } from "./task-tracker-editor"
import { TASK_TRACKER_PANEL_TYPE, TaskTrackerViewProvider } from "./task-tracker-view"

describe("INCLINE Tasks in the editor area (#95)", () => {
	let dir: string
	let store: TaskMdStore
	let provider: TaskTrackerViewProvider
	let editor: TaskTrackerEditor

	beforeEach(async () => {
		created.length = 0
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-editor-"))
		store = new TaskMdStore(path.join(dir, "task.md"))
		provider = new TaskTrackerViewProvider(store)
		editor = new TaskTrackerEditor(provider)
	})
	afterEach(async () => {
		provider.dispose()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("opens a tab in the currently active editor group, with scripts and retained context", () => {
		editor.open()
		expect(created).toHaveLength(1)
		const [viewType, title, column, options] = created[0].createArgs
		expect(viewType).toBe(TASK_TRACKER_PANEL_TYPE)
		expect(title).toBe("INCLINE Tasks")
		expect(column).toMatchObject({ viewColumn: -1, preserveFocus: false }) // ViewColumn.Active = いま操作しているペイン
		expect(options).toMatchObject({ enableScripts: true, retainContextWhenHidden: true })
		expect(created[0].webview.html).toContain('id="list"')
		expect(editor.isOpen).toBe(true)
	})

	it("reveals the existing tab instead of opening a second one", () => {
		editor.open()
		editor.open()
		expect(created).toHaveLength(1)
		expect(created[0].reveal).toHaveBeenCalledTimes(1)
	})

	it("serves tasks and handles webview messages in the tab (ready / create)", async () => {
		editor.open()
		const panel = created[0]
		await panel.send({ type: "ready" })
		expect(panel.posted.at(-1)).toMatchObject({ type: "tasks", tasks: [] })

		await panel.send({ type: "create", title: "エディタのタブから登録", priority: "LOW", category: "" })
		expect((await store.list()).map((t) => t.title)).toEqual(["エディタのタブから登録"])
		expect(panel.posted.at(-1).tasks).toHaveLength(1)
	})

	it("closing the tab releases the edit lock, and it can be opened again", async () => {
		editor.open()
		await created[0].send({ type: "editing", editing: true })
		await expect(fs.access(store.lockPath)).resolves.toBeUndefined()
		created[0].close()
		await new Promise((r) => setTimeout(r, 30))
		expect(editor.isOpen).toBe(false)
		await expect(fs.access(store.lockPath)).rejects.toThrow()

		editor.open()
		expect(created).toHaveLength(2)
	})

	it("restores a tab that VS Code hands back after a reload (serializer)", async () => {
		const restored = fakePanel()
		await editor.deserializeWebviewPanel(restored)
		expect(editor.isOpen).toBe(true)
		expect(restored.webview.html).toContain('id="list"')
		await restored.send({ type: "ready" })
		expect(restored.posted.at(-1)).toMatchObject({ type: "tasks" })
	})

	it("reposts the tasks when the tab becomes visible again", async () => {
		editor.open()
		const panel = created[0]
		await panel.send({ type: "ready" })
		const before = panel.posted.length
		panel.fireViewState()
		await new Promise((r) => setTimeout(r, 30))
		expect(panel.posted.length).toBeGreaterThan(before)
	})
})

describe("INCLINE Tasks in the right secondary side bar (#95)", () => {
	let dir: string
	let store: TaskMdStore
	let provider: TaskTrackerViewProvider

	beforeEach(async () => {
		created.length = 0
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "incline-side-"))
		store = new TaskMdStore(path.join(dir, "task.md"))
		provider = new TaskTrackerViewProvider(store)
	})
	afterEach(async () => {
		provider.dispose()
		await fs.rm(dir, { recursive: true, force: true })
	})

	const fakeView = () => {
		const v = fakePanel()
		v.onDidChangeVisibility = v.onDidChangeViewState
		return v
	}

	it("serves the tasks in the side-bar view (Chat / Claude Code sit next to it)", async () => {
		const view = fakeView()
		new TaskTrackerSideView(provider).resolveWebviewView(view)
		expect(view.webview.html).toContain('id="list"')
		expect(view.webview.options).toMatchObject({ enableScripts: true })
		await view.send({ type: "create", title: "右のペインから登録", priority: "LOW", category: "" })
		expect((await store.list()).map((t) => t.title)).toEqual(["右のペインから登録"])
		expect(view.posted.at(-1).tasks).toHaveLength(1)
	})

	it("keeps the side-bar view and an editor tab in sync, and closing one does not break the other", async () => {
		const view = fakeView()
		new TaskTrackerSideView(provider).resolveWebviewView(view)
		const editor = new TaskTrackerEditor(provider)
		editor.open()
		const tab = created[0]
		await view.send({ type: "create", title: "同期", priority: "LOW", category: "" })
		expect(view.posted.at(-1).tasks).toHaveLength(1)
		expect(tab.posted.at(-1).tasks).toHaveLength(1) // 両方に届く

		await tab.send({ type: "editing", editing: true })
		tab.close() // タブを閉じても、サイドバーは動き続ける
		await new Promise((r) => setTimeout(r, 30))
		await expect(fs.access(store.lockPath)).resolves.toBeUndefined() // まだ画面が残っているのでロックは維持
		await view.send({ type: "create", title: "閉じたあとも", priority: "LOW", category: "" })
		expect(view.posted.at(-1).tasks).toHaveLength(2)

		view.close() // 最後の画面が閉じたらロックを解除
		await new Promise((r) => setTimeout(r, 30))
		await expect(fs.access(store.lockPath)).rejects.toThrow()
	})
})

describe("package.json contributions for the editor tab (#95)", () => {
	it("has the Open Tasks command + sidebar button + activation, and no bottom-panel container / view any more", async () => {
		const pkg = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../../package.json"), "utf8"))
		const c = pkg.contributes
		expect(c.commands.some((x: any) => x.command === "incline.openTasks" && x.title === "Open Tasks" && x.category === "INCLINE")).toBe(true)
		expect(c["menus"]["view/title"].some((x: any) => x.command === "incline.openTasks" && x.when === "view == incline.SidebarProvider")).toBe(true)
		expect(pkg.activationEvents).toContain("onWebviewPanel:incline.tasksEditor")
		expect(c.viewsContainers.panel).toBeUndefined()
		expect(Object.keys(c.views)).not.toContain("incline-tasks")
		// 右のセカンダリ サイドバー (Chat / Claude Code と並ぶ) のビューと、エディタのタブで開くコマンド
		expect(c.viewsContainers.secondarySidebar.map((x: any) => x.id)).toEqual(["incline-tasks-secondary"])
		expect(c.views["incline-tasks-secondary"]).toEqual([{ type: "webview", id: "incline.tasksView", name: "Tasks" }])
		expect(c.commands.some((x: any) => x.command === "incline.openTasksInEditor" && x.title === "Open Tasks in Editor")).toBe(true)
		expect(pkg.activationEvents).toContain("onView:incline.tasksView")
	})
})
