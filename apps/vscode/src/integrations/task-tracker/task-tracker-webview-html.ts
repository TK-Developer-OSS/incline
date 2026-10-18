// "Incline Tasks" パネル Webview の自己完結 HTML (ビルド不要のバニラ JS)。
// 拡張 <-> Webview のメッセージ:
//   ext  -> web : { type: "tasks", tasks: Task[], categories: string[], author: string, filePath: string }
//   web  -> ext : { type: "ready" } / { type: "refresh" }
//                 { type: "create", title, content, priority, category }
//                 { type: "update", id, patch: {title?,status?,category?,priority?,assignee?,remarks?} }
//                 { type: "note",   id, text, tmp }   (tmp: 『変更を保存』まで未確定の印 data-tmp-:: 付きで追記)
//                 { type: "update", id, patch, commitNotes }  (commitNotes: 未確定の追記も確定)
//                 { type: "discardNotes", id }
//                 { type: "editing", editing }  (編集が始まった/続いている/終わった。ホストは task.md.lock を作る・更新する・消す)
//                 { type: "categories", list: string[], renames: Record<oldName, newName> }
//                 { type: "openFile" }
//                 { type: "warn", text }  (画面内のお知らせと同じ文をホストの警告通知で出す)

import { TASK_PRIORITIES, TASK_STATUSES } from "./task-md"

const AUTO_REFRESH_MS = 30_000

export function getTaskTrackerHtml(nonce: string): string {
	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 0;
		font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	}
	.toolbar {
		display: flex; gap: 6px; align-items: center; padding: 6px 8px; flex-wrap: wrap;
		position: sticky; top: 0; z-index: 2;
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		border-bottom: 1px solid var(--vscode-panel-border, transparent);
	}
	button {
		font-family: inherit; font-size: inherit; cursor: pointer;
		color: var(--vscode-button-foreground); background: var(--vscode-button-background);
		border: none; padding: 3px 9px; border-radius: 2px;
	}
	button.secondary {
		color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	select, input, textarea {
		font-family: inherit; font-size: inherit;
		color: var(--vscode-input-foreground); background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #8888));
		border-radius: 2px; padding: 2px 4px;
	}
	textarea { width: 100%; resize: vertical; min-height: 44px; }
	.meta { font-size: 10px; opacity: 0.6; }
	.spacer { flex: 1; }
	.linkish { background: none; color: var(--vscode-textLink-foreground); padding: 0; }
	.list { padding: 4px 6px 40px; }
	.card {
		border: 1px solid var(--vscode-panel-border, #8884); border-radius: 3px;
		margin: 4px 0; padding: 6px 8px;
	}
	.card.open {
		border-color: var(--vscode-focusBorder, #007fd4);
		background: var(--vscode-list-activeSelectionBackground, var(--vscode-menu-selectionBackground, #007fd420));
	}
	.notice { margin: 6px 0; padding: 6px 8px; border: 1px solid #ff4500; border-radius: 3px; background: #ff450018; }
	.history .tmp-line { color: #ff4500; }
	/* 判断待ち ([CONFIRM]): 該当の行は背景の赤みで、バッジ・ピルは塗りつぶさず枠線だけ (目が痛いため) を、やんわり点滅させる。文字は白。
	   カードは赤い枠線・枠の影を付けず、背景の赤みだけをごく薄く点滅させる (TK 指示: 枠は毒々しい / 点滅は残す / 文字色は白)。 */
	@keyframes confirm-card { from { background-color: #ff3c3c08; } to { background-color: #ff3c3c26; } }
	@keyframes confirm-outline { from { border-color: #a82c2c; } to { border-color: #ff6262; } }
	@keyframes confirm-pulse { from { background-color: #b02e2e; } to { background-color: #e04646; } }
	.card.confirm { animation: confirm-card 2.2s ease-in-out infinite alternate; }
	.history .confirm-line { color: #fff; font-weight: 600; border-radius: 3px; padding: 1px 4px; margin: 1px 0; animation: confirm-pulse 2.2s ease-in-out infinite alternate; }
	.confirm-badge { font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; background: transparent; border: 1.5px solid #c93a3a; border-radius: 8px; padding: 0 6px; animation: confirm-outline 2.2s ease-in-out infinite alternate; }
	.confirm-pill { font-size: 12px; font-weight: 700; color: #fff; background: transparent; border: 1.5px solid #c93a3a; border-radius: 10px; padding: 0 8px; animation: confirm-outline 2.2s ease-in-out infinite alternate; }
	/* ライトテーマでは白文字が読めないので、暗い赤にする */
	body.vscode-light .confirm-badge, body.vscode-light .confirm-pill { color: #a52626; }
	.card.dirty {
		border-color: #ff4500;
	}
	/* Errors for an action on a card are shown inside that card, in the same red block every time (#65). */
	.card.has-error { border-color: #e53935; animation: card-shake .35s; }
	.card-error { margin: 8px 0 0; padding: 8px 10px; border: 1.5px solid #e53935; border-left-width: 6px; border-radius: 4px; background: rgba(229, 57, 53, .16); font-size: 13px; font-weight: 600; }
	body.vscode-light .card-error { color: #a52626; }
	@keyframes card-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-5px); } 60% { transform: translateX(5px); } }
	input.dirty, select.dirty, textarea.dirty {
		border: 1.5px solid #ff4500 !important;
		outline: 1px solid #ff4500 !important;
	}
	.card .row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
	/* 左の 2 行ブロック: 1 行目 優先度 + #ID、2 行目 日付 (小さく薄く)。件名に十分な幅を残す (#101) */
	.idblock { display: flex; flex-direction: column; gap: 2px; flex: none; min-width: 0; }
	.idline { display: flex; align-items: center; gap: 6px; }
	.dates { font-size: 10px; opacity: .6; white-space: nowrap; font-variant-numeric: tabular-nums; }
	mark.hit { background: #ffd54a; color: #000; border-radius: 2px; padding: 0 1px; }
	#search { flex: 1; min-width: 120px; max-width: 260px; }
	.titleblock { flex: 1; min-width: 8em; display: flex; flex-direction: column; gap: 3px; }
	.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
	.card .title { flex: 1; min-width: 8em; font-weight: 600; word-break: break-word; }
	.id { opacity: .6; font-variant-numeric: tabular-nums; }
	.badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; white-space: nowrap;
		border: 1px solid var(--vscode-panel-border, #8886); }
	.badge.cat { opacity: .85; background: var(--vscode-badge-background, #8883); color: var(--vscode-badge-foreground, inherit); border-color: transparent; }
	select.badge { cursor: pointer; outline: none; font-family: inherit; }
	select.badge option {
		background: var(--vscode-dropdown-background, var(--vscode-input-background, #222));
		color: var(--vscode-dropdown-foreground, var(--vscode-foreground, #fff));
	}
	.badge.s-未着手 { opacity: .75; }
	.badge.s-対応中 { background: var(--vscode-charts-blue, #3794ff); color: #fff; border-color: transparent; }
	.badge.s-報告   { background: var(--vscode-charts-purple, #b180d7); color: #fff; border-color: transparent; }
	.badge.s-差戻   { background: var(--vscode-charts-red, #f14c4c); color: #fff; border-color: transparent; }
	.badge.s-保留   { background: var(--vscode-charts-yellow, #cca700); color: #000; border-color: transparent; }
	.badge.s-完了   { background: var(--vscode-charts-green, #89d185); color: #000; border-color: transparent; }
	.badge.s-削除   { opacity: .5; text-decoration: line-through; }
	.pri { font-size: 10px; font-weight: 700; letter-spacing: .5px; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
	.pri.p-HIGH   { background: var(--vscode-charts-red, #f14c4c); color: #fff; }
	.pri.p-MIDDLE { background: var(--vscode-charts-yellow, #cca700); color: #000; }
	.pri.p-LOW    { opacity: .6; border: 1px solid var(--vscode-panel-border, #8886); }
	.assignee { font-size: 11px; opacity: .8; }
	.sub-meta { font-size: 11px; opacity: .65; margin-top: 3px; display: flex; gap: 8px; flex-wrap: wrap; cursor: pointer; }
	/* While a card is open the list does not scroll (#104): the open card's body scrolls inside itself, so reaching the end of the text never drags the whole list. */
	body.card-open { overflow: hidden; }
	body.card-open .card.open .detail { max-height: calc(100vh - 190px); overflow-y: auto; overscroll-behavior: contain; }
	.detail { margin-top: 8px; border-top: 1px dashed var(--vscode-panel-border, #8886); padding-top: 8px; display: grid; gap: 6px; }
	.detail label { display: grid; grid-template-columns: 64px 1fr; gap: 6px; align-items: center; font-size: 12px; opacity: .9; }
	.detail label span { opacity: .7; }
	.meta { font-size: 11px; opacity: .6; }
	.history { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12px; background: var(--vscode-textCodeBlock-background, #8881); border-radius: 3px; padding: 6px 8px; max-height: 220px; overflow: auto; }
	.hist-add { display: flex; gap: 6px; align-items: flex-start; }
	.hist-add textarea { flex: 1; }
	.empty { opacity: .6; padding: 16px 8px; text-align: center; }
	dialog { border: 1px solid var(--vscode-panel-border, #888); border-radius: 4px; padding: 12px;
		color: var(--vscode-foreground); background: var(--vscode-editor-background); width: min(90vw, 420px); }
	dialog::backdrop { background: #0007; }
	.dlg-row { display: grid; gap: 6px; margin-bottom: 8px; }
	.dlg-actions { display: flex; gap: 6px; justify-content: flex-end; }
	.cat-row { display: flex; gap: 6px; margin-bottom: 4px; }
	.cat-row input { flex: 1; }
	#cat-list { max-height: 40vh; overflow: auto; }
</style>
</head>
<body>
<div class="toolbar">
	<button id="new-btn">＋ New</button>
	<label class="assignee">Show:
		<select id="filter">
			<option value="active">Active only</option>
			<option value="all">All</option>
			<option value="未着手">Not started</option>
			<option value="対応中">In progress</option>
			<option value="保留">On hold</option>
			<option value="完了">Done</option>
			<option value="削除">Deleted</option>
		</select>
	</label>
	<select id="cat-filter" title="Filter by category (independent of the search box)"></select>
	<input id="search" type="search" placeholder="Search (#ID / title / category / assignee / remarks / history)" autocomplete="off" />
	<span id="confirm-pill" class="confirm-pill" hidden></span>
	<span class="spacer"></span>
	<button class="linkish" id="cat-btn" title="Add / rename / delete categories">Categories</button>
	<button class="linkish" id="refresh-btn" title="Reload task.md">⟳ Refresh</button>
	<button class="linkish" id="open-file">Open task.md</button>
</div>
<div id="notice" class="notice" hidden></div>
<div id="list" class="list"><div class="empty">Loading…</div></div>

<dialog id="new-dlg">
	<form method="dialog">
		<div class="dlg-row"><label>Title</label><input id="nd-title" required autocomplete="off" /></div>
		<div class="dlg-row"><label>Category</label><select id="nd-category"></select></div>
		<div class="dlg-row"><label>Priority</label>
			<select id="nd-priority">${TASK_PRIORITIES.map((p) => `<option value="${p}"${p === "MIDDLE" ? " selected" : ""}>${p}</option>`).join("")}</select>
		</div>
		<div class="dlg-row"><label>Description (first history entry)</label><textarea id="nd-content"></textarea></div>
		<div class="dlg-actions">
			<button class="secondary" id="nd-cancel" type="button" formnovalidate>Cancel</button>
			<button id="nd-ok" value="ok" type="submit">Create</button>
		</div>
	</form>
</dialog>

<dialog id="cat-dlg">
	<form method="dialog">
		<div class="dlg-row">
			<label>Categories (renaming also updates the linked tasks; a category that still has tasks cannot be deleted)</label>
			<div id="cat-list"></div>
			<button class="secondary" id="cat-add" type="button">＋ Add</button>
		</div>
		<div class="dlg-actions">
			<button class="secondary" id="cat-cancel" type="button" formnovalidate>Cancel</button>
			<button id="cat-ok" value="ok" type="submit">Save</button>
		</div>
	</form>
</dialog>

<script nonce="${nonce}">
(function () {
	const vscode = acquireVsCodeApi();
	const listEl = document.getElementById("list");
	const filterEl = document.getElementById("filter");
	const searchEl = document.getElementById("search");
	const catFilterEl = document.getElementById("cat-filter");
	const noticeEl = document.getElementById("notice");
	// webview では alert() が出ない (サンドボックスで無効) ので、画面内のお知らせ + ホスト側の警告通知で知らせる。
	let noticeTimer;
	// Errors for an action on a card (blocked close / save): shown in the card, always in the same red block.
	let cardErrors = {};
	function setCardError(id, text) {
		cardErrors[id] = text;
		post({ type: "warn", text: text });
		render();
		setTimeout(() => { if (cardErrors[id] === text) { delete cardErrors[id]; render(); } }, 8000);
	}
	function showNotice(text) {
		noticeEl.textContent = text;
		noticeEl.hidden = false;
		post({ type: "warn", text: text });
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, 6000);
	}
	const newDlg = document.getElementById("new-dlg");
	const catDlg = document.getElementById("cat-dlg");
	const catListEl = document.getElementById("cat-list");
	let tasks = [];
	let categories = [];
	let author = "me";
	let expandedId = (vscode.getState() && vscode.getState().expandedId) || null;
	let dirtyStates = (vscode.getState() && vscode.getState().dirtyStates) || {};

	const STATUSES = ${JSON.stringify(TASK_STATUSES)};
	const PRIORITIES = ${JSON.stringify(TASK_PRIORITIES)};
	const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

	let noteDrafts = (vscode.getState() && vscode.getState().noteDrafts) || {};

	// 未確定の追記行は『行頭の "- <日時> <名前>: " の直後に data-tmp-:: が来る行』だけ
	// (ストア側 task-md.ts の判定と同じ)。本文の途中に書かれた data-tmp-:: は通常の文字として扱う。
	const TMP_LINE = /^- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} [^\\s:]+: data-tmp-::/;
	function hasTmp(t) { return !!t && String(t.history || "").split("\\n").some((l) => TMP_LINE.test(l)); }
	function hasNoteDraft(id) { return !!(noteDrafts[id] && String(noteDrafts[id]).trim()); }
	function isEditing(id) { return !!dirtyStates[id] || hasTmp(tasks.find((t) => t.id === id)) || hasNoteDraft(id); }
	// 判断待ち: 行の本文が [CONFIRM] で始まる行が発火、後の [RESOLVED] で始まる行が打ち消す (task-md.ts の findOpenConfirms と同じ規則)。
	const CONFIRM_LINE = /^- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} [^\\s:]+: \\[(CONFIRM|RESOLVED)(?::([^\\]\\s]+))?\\]/;
	function openConfirmLines(h) {
		let open = [];
		String(h || "").split("\\n").filter((l) => l.trim()).forEach((l, i) => {
			const m = l.match(CONFIRM_LINE);
			if (!m) return;
			if (m[1] === "CONFIRM") open.push({ line: i, tag: m[2] });
			else open = m[2] ? open.filter((c) => c.tag !== m[2]) : [];
		});
		return open;
	}
	function needsConfirm(t) { return !!t && t.status !== "完了" && t.status !== "削除" && openConfirmLines(t.history).length > 0; }
	// 履歴を行ごとに描画し、未確定の追記は赤みオレンジで【未保存】と示す。判断待ちの行は赤く点滅。
	function renderHistory(h) {
		const lines = String(h || "").split("\\n").filter((l) => l.trim());
		if (!lines.length) return "(no history)";
		const confirmLines = new Set(openConfirmLines(h).map((c) => c.line));
		return lines.map((l, i) => confirmLines.has(i)
			? '<div class="confirm-line">⚠ ' + hl(l) + "</div>"
			: TMP_LINE.test(l)
			? '<div class="tmp-line">' + hl(l.replace(/^(- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} [^\\s:]+: )data-tmp-::/, "$1[Unsaved] ")) + "</div>"
			: "<div>" + hl(l) + "</div>").join("");
	}
	// 編集中 (未保存の項目変更 / 未確定の追記) かをホストに知らせ、ホストが task.md.lock を管理する。
	let lastEditing = false;
	// A typed-but-not-added note draft is NOT an edit of the file (nothing is written yet), so it must not hold the task.md lock
	// (a draft restored with the panel state would hold it for no reason). It still blocks closing / saving (isEditing).
	function currentlyEditing() { return Object.keys(dirtyStates).length > 0 || tasks.some(hasTmp); }
	function syncEditing() {
		const now = currentlyEditing();
		if (now !== lastEditing) { lastEditing = now; post({ type: "editing", editing: now }); }
	}
	// 編集が続いている間は 1 分ごとにロックの更新時刻を延ばす (15分更新が無いと INCLINE が解除する)。
	setInterval(() => { if (lastEditing) post({ type: "editing", editing: true }); }, 60000);
	function saveState() { vscode.setState({ expandedId: expandedId, dirtyStates: dirtyStates, noteDrafts: noteDrafts }); syncEditing(); }
	function post(msg) { vscode.postMessage(msg); }

	// カテゴリのプルダウン (#93): 検索ボックスとは独立の絞り込み。選択は、カテゴリ一覧が更新されても保つ。
	const CAT_ALL = "__all", CAT_NONE = "__none";
	function refreshCatFilter() {
		const prev = catFilterEl.value || CAT_ALL;
		const names = categories.slice();
		tasks.forEach((t) => { if (t.category && names.indexOf(t.category) < 0) names.push(t.category); });
		catFilterEl.innerHTML = '<option value="' + CAT_ALL + '">All categories</option>' +
			names.map((c) => '<option value="' + esc(c) + '">' + esc(c) + "</option>").join("") +
			'<option value="' + CAT_NONE + '">(no category)</option>';
		catFilterEl.value = [CAT_ALL, CAT_NONE].concat(names).indexOf(prev) >= 0 ? prev : CAT_ALL;
	}
	function visibleTasks() {
		const f = filterEl.value;
		const cf = catFilterEl.value || CAT_ALL;
		const q = searchEl.value.trim().toLowerCase();
		return tasks.filter((t) => {
			if (cf === CAT_NONE ? !!t.category : (cf !== CAT_ALL && t.category !== cf)) return false;
			if (q) {
				const hay = ["#" + t.id, t.title, t.category, t.assignee, t.remarks, t.creator, t.history].join(" ").toLowerCase();
				if (hay.indexOf(q) < 0) return false;
			}
			if (f === "all") return true;
			if (f === "active") return t.status !== "完了" && t.status !== "削除";
			return t.status === f;
		});
	}

	// 再描画で編集中の入力 (フォーカス・カーソル位置・スクロール) を潰さない。
	function render() {
		// 判断待ちの件数 (ツールバーのピル)。完了 / 削除でないタスクのうち、有効な [CONFIRM] があるもの。
		const confirmCount = tasks.filter(needsConfirm).length;
		const pill = document.getElementById("confirm-pill");
		pill.hidden = confirmCount === 0;
		pill.textContent = "⚠ Needs decision " + confirmCount;
		const ae = document.activeElement;
		let focus = null;
		if (ae && listEl.contains(ae) && ae.className) {
			const c = ae.closest(".card");
			focus = { id: c && c.dataset.id, cls: String(ae.className).split(" ")[0], s: ae.selectionStart, e: ae.selectionEnd };
		}
		const scrollY = window.scrollY;
		const vis = visibleTasks();
		if (!vis.length) {
			listEl.innerHTML = '<div class="empty">' + (tasks.length ? "No tasks match the current filter." : "No tasks yet. Use the New button to create one.") + "</div>";
			return;
		}
		listEl.innerHTML = vis.map(renderCard).join("");
		document.body.classList.toggle("card-open", !!listEl.querySelector(".card.open"));
		if (focus && focus.id) {
			const el = listEl.querySelector('.card[data-id="' + focus.id + '"] .' + focus.cls);
			if (el) {
				el.focus();
				try { if (focus.s != null) el.setSelectionRange(focus.s, focus.e); } catch (_) {}
			}
		}
		window.scrollTo(0, scrollY);
	}

	// ステータスの表示名 (task.md に保存する値は日本語のまま)。
	const STATUS_LABELS = { "未着手": "Not started", "対応中": "In progress", "報告": "Reported (needs your check)", "差戻": "Sent back (rework)", "保留": "On hold", "完了": "Done", "削除": "Deleted" };
	function options(values, current) {
		return values.map((v) => '<option value="' + v + '"' + (v === current ? " selected" : "") + ">" + (STATUS_LABELS[v] || v) + "</option>").join("");
	}

	// 検索語のハイライト (#96): 展開した本文 (履歴) と行の件名で、検索語に一致する部分を <mark> で囲む。
	function escapeRegExp(x) { return x.replace(/[.*+?^$()|[\\]{}\\\\]/g, "\\\\$&"); }
	function hl(text) {
		const e = esc(text);
		const q = searchEl.value.trim();
		if (!q) return e;
		return e.replace(new RegExp(escapeRegExp(esc(q)), "gi"), (m) => '<mark class="hit">' + m + "</mark>");
	}
	// "2026-10-17 11:02" -> "10-17 11:02" (行に収まる短い形)
	function shortDate(d) { return String(d || "").replace(/^\\d{4}-/, ""); }

	// カテゴリ select 用。先頭に "(none)"、一覧に無い既存値も欠落させないよう補う。
	function categoryOptions(current) {
		const opts = [""].concat(categories);
		if (current && opts.indexOf(current) < 0) opts.push(current);
		return opts.map((v) => '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + (v === "" ? "(none)" : esc(v)) + "</option>").join("");
	}

	function renderCard(t) {
		const open = t.id === expandedId;
		const dirty = dirtyStates[t.id];
		const editing = !!dirty || hasTmp(t);
		const confirm = needsConfirm(t);
		const getVal = (field) => (dirty && dirty[field] !== undefined ? dirty[field] : t[field]);
		// 編集中 (未保存) の項目には dirty クラスを付け、赤みのオレンジ枠で示す。
		const dc = (field, base) => base + (dirty && dirty[field] !== undefined ? " dirty" : "");
		return '' +
			'<div class="card' + (open ? ' open' : '') + (editing ? ' dirty' : '') + (confirm ? ' confirm' : '') + (open && cardErrors[t.id] ? ' has-error' : '') + '" data-id="' + t.id + '">' +
				'<div class="row js-toggle" draggable="true" title="Drag to reorder">' +
					'<div class="idblock">' +
						'<div class="idline"><span class="pri p-' + t.priority + '">' + t.priority + "</span>" +
						'<span class="id">#' + t.id + '</span></div>' +
						'<div class="dates" title="Created ' + esc(t.created) + " by " + esc(t.creator) + " / Updated " + esc(t.updated) + '">C ' + esc(shortDate(t.created)) + " · U " + esc(shortDate(t.updated)) + "</div>" +
					"</div>" +
					// 件名は残りの幅をすべて使う。バッジ (判断待ち / カテゴリ / 担当者) は件名の下の行に回す (#101)。
					'<div class="titleblock">' +
						'<span class="title">' + hl(getVal("title")) + "</span>" +
						(confirm || getVal("category") || t.assignee
							? '<div class="tags">' +
								(confirm ? '<span class="confirm-badge" title="Needs a human decision ([CONFIRM])">⚠ Needs decision</span>' : "") +
								(getVal("category") ? '<span class="badge cat">' + esc(getVal("category")) + "</span>" : "") +
								(t.assignee ? '<span class="assignee">@' + esc(getVal("assignee")) + "</span>" : "") +
								"</div>"
							: "") +
					"</div>" +
					'<select class="badge s-' + t.status + ' js-quick-status" title="Change status">' + options(STATUSES, t.status) + "</select>" +
				"</div>" +
				(open && cardErrors[t.id] ? '<div class="card-error" role="alert">⚠ ' + esc(cardErrors[t.id]) + "</div>" : "") +
				(open ? (
					'<div class="detail">' +
						'<label><span>Title</span><input class="' + dc("title", "js-title") + '" value="' + esc(getVal("title")) + '" /></label>' +
						'<label><span>Category</span><select class="' + dc("category", "js-category") + '">' + categoryOptions(getVal("category")) + "</select></label>" +
						'<label><span>Priority</span><select class="' + dc("priority", "js-priority") + '">' + options(PRIORITIES, getVal("priority")) + "</select></label>" +
						'<label><span>Status</span><select class="' + dc("status", "js-status") + '">' + options(STATUSES, getVal("status")) + "</select></label>" +
						'<label><span>Assignee</span><input class="' + dc("assignee", "js-assignee") + '" value="' + esc(getVal("assignee")) + '" placeholder="(unassigned)" /></label>' +
						'<label><span>Remarks</span><input class="' + dc("remarks", "js-remarks") + '" value="' + esc(getVal("remarks")) + '" /></label>' +
						'<div class="meta">Created: ' + esc(t.creator) + " " + esc(t.created) + " / Updated: " + esc(t.updater) + " " + esc(t.updated) + "</div>" +
						'<div class="history">' + renderHistory(t.history) + "</div>" +
						'<div class="hist-add">' +
							'<textarea class="js-note" placeholder="Add a comment / progress note…">' + esc(noteDrafts[t.id] || "") + '</textarea>' +
							'<button class="js-note-btn">Add note</button>' +
						"</div>" +
						'<div><button class="secondary js-save">Save changes</button><button class="secondary js-discard">Discard</button></div>' +
					"</div>"
				) : "") +
			"</div>";
	}

	listEl.addEventListener("click", (e) => {
		const card = e.target.closest(".card");
		if (!card) return;
		const id = Number(card.dataset.id);
		if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
			return;
		}
		if (e.target.closest(".js-toggle")) {
			if (expandedId === id && isEditing(id)) {
				setCardError(id, hasNoteDraft(id) && !dirtyStates[id] && !hasTmp(tasks.find((t) => t.id === id))
					? "Not closed: the note text has not been added. Press Add note, or clear the text."
					: "Not closed: you have unsaved edits. Press Save changes or Discard.");
				return;
			}
			expandedId = expandedId === id ? null : id;
			saveState();
			render();
			// Opening a card scrolls it to the top of the list (#104).
			if (expandedId === id) {
				const opened = listEl.querySelector('.card[data-id="' + id + '"]');
				if (opened && typeof opened.scrollIntoView === "function") {
					// The toolbar is sticky: stop below it so the card header (the close bar) stays visible.
					const tb = document.querySelector(".toolbar");
					opened.style.scrollMarginTop = ((tb ? tb.offsetHeight : 0) + 4) + "px";
					opened.scrollIntoView({ block: "start" });
				}
			}
			return;
		}
		if (e.target.classList.contains("js-save")) {
			if (hasNoteDraft(id)) {
				setCardError(id, "Not saved: the note text has not been added. Press Add note, or clear the text.");
				return;
			}
			const patch = {
				title: card.querySelector(".js-title").value,
				category: card.querySelector(".js-category").value,
				priority: card.querySelector(".js-priority").value,
				status: card.querySelector(".js-status").value,
				assignee: card.querySelector(".js-assignee").value,
				remarks: card.querySelector(".js-remarks").value,
			};
			post({ type: "update", id: id, patch: patch, commitNotes: true });
			delete dirtyStates[id];
			// 保存直後は課題を閉じる (#55)
			if (expandedId === id) expandedId = null;
			saveState();
			render();
		}
		if (e.target.classList.contains("js-discard")) {
			if (hasTmp(tasks.find((t) => t.id === id))) post({ type: "discardNotes", id: id });
			delete dirtyStates[id];
			delete noteDrafts[id];
			// 破棄したらカードを閉じる (#80)
			if (expandedId === id) expandedId = null;
			saveState();
			render();
		}
		if (e.target.classList.contains("js-note-btn")) {
			const ta = card.querySelector(".js-note");
			const text = ta.value.trim();
			if (!text) return;
			post({ type: "note", id: id, text: text, tmp: true });
			ta.value = "";
			delete noteDrafts[id];
			saveState();
		}
	});

	// 入力のたびに下書きを保持 (blur 前に自動リロードが来ても本文が消えない)。
	listEl.addEventListener("input", (e) => {
		const card = e.target.closest(".card");
		if (!card) return;
		const id = Number(card.dataset.id);
		const cls = String(e.target.className).split(" ")[0];
		if (cls === "js-note") {
			if (e.target.value) noteDrafts[id] = e.target.value; else delete noteDrafts[id];
			saveState();
		} else if (["js-title", "js-category", "js-priority", "js-status", "js-assignee", "js-remarks"].indexOf(cls) >= 0) {
			if (!dirtyStates[id]) dirtyStates[id] = {};
			dirtyStates[id][cls.replace("js-", "")] = e.target.value;
			card.classList.add("dirty");
			e.target.classList.add("dirty");
			saveState();
		}
	});

	listEl.addEventListener("change", (e) => {
		const card = e.target.closest(".card");
		if (!card) return;
		const id = Number(card.dataset.id);

		if (e.target.classList.contains("js-quick-status")) {
			post({ type: "update", id: id, patch: { status: e.target.value } });
			return;
		}

		if (e.target.classList.contains("js-title") ||
		    e.target.classList.contains("js-category") ||
		    e.target.classList.contains("js-priority") ||
		    e.target.classList.contains("js-status") ||
		    e.target.classList.contains("js-assignee") ||
		    e.target.classList.contains("js-remarks")) {
			if (!dirtyStates[id]) dirtyStates[id] = {};
			const field = String(e.target.className).split(" ")[0].replace("js-", "");
			dirtyStates[id][field] = e.target.value;
			saveState();
			// 入力欄 (テキスト) は blur で全体を描き直さない: 描き直すと、続くボタンのクリック
			// (破棄 / 保存) が空振りする。一覧行の表示だけをその場で更新する。
			if (e.target.tagName === "INPUT") {
				const rowEl = card.querySelector(".row ." + field);
				if (rowEl) rowEl.textContent = (field === "assignee" ? "@" : "") + e.target.value;
				return;
			}
			render();
		}
	});

	// Manual reorder (#15): drag a card header onto another card. Dropped on the upper half = before it, lower half = after it.
	let dragId = null;
	listEl.addEventListener("dragstart", (e) => {
		const card = e.target.closest && e.target.closest(".card");
		if (!card) return;
		dragId = Number(card.dataset.id);
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", String(dragId));
	});
	listEl.addEventListener("dragover", (e) => {
		if (dragId !== null) e.preventDefault();
	});
	listEl.addEventListener("drop", (e) => {
		if (dragId === null) return;
		e.preventDefault();
		const card = e.target.closest && e.target.closest(".card");
		const id = dragId;
		dragId = null;
		if (!card || Number(card.dataset.id) === id) return;
		const r = card.getBoundingClientRect();
		const after = e.clientY > r.top + r.height / 2;
		let beforeId = Number(card.dataset.id);
		if (after) {
			let n = card.nextElementSibling;
			while (n && Number(n.dataset.id) === id) n = n.nextElementSibling;
			beforeId = n ? Number(n.dataset.id) : null;
		}
		post({ type: "reorder", id: id, beforeId: beforeId });
	});
	listEl.addEventListener("dragend", () => { dragId = null; });
	filterEl.addEventListener("change", render);
	catFilterEl.addEventListener("change", render);
	searchEl.addEventListener("input", render);
	document.getElementById("open-file").addEventListener("click", () => post({ type: "openFile" }));
	document.getElementById("refresh-btn").addEventListener("click", () => post({ type: "refresh" }));
	document.getElementById("new-btn").addEventListener("click", () => {
		document.getElementById("nd-title").value = "";
		document.getElementById("nd-content").value = "";
		document.getElementById("nd-priority").value = "MIDDLE";
		const ndCat = document.getElementById("nd-category");
		ndCat.innerHTML = categoryOptions("");
		// 新規登録のカテゴリは「タスク」が初期選択 (#79)。無ければ (なし)。
		if (categories.indexOf("タスク") >= 0) ndCat.value = "タスク";
		newDlg.showModal();
	});
	document.getElementById("nd-cancel").addEventListener("click", () => newDlg.close("cancel"));
	newDlg.addEventListener("close", () => {
		if (newDlg.returnValue !== "ok") return;
		const title = document.getElementById("nd-title").value.trim();
		if (!title) return;
		post({
			type: "create",
			title: title,
			priority: document.getElementById("nd-priority").value,
			category: document.getElementById("nd-category").value,
			content: document.getElementById("nd-content").value.trim(),
		});
		// 登録直後は開いている課題を閉じる (#55)
		expandedId = null;
		saveState();
		render();
	});

	// --- カテゴリ設定ダイアログ (#19) ---
	function makeCatRow(name) {
		const row = document.createElement("div");
		row.className = "cat-row";
		const inp = document.createElement("input");
		inp.className = "cat-name";
		inp.value = name || "";
		if (name) inp.dataset.old = name;
		const del = document.createElement("button");
		del.type = "button";
		del.className = "secondary";
		del.textContent = "Delete";
		del.addEventListener("click", () => row.remove());
		row.appendChild(inp);
		row.appendChild(del);
		return row;
	}
	document.getElementById("cat-btn").addEventListener("click", () => {
		catListEl.innerHTML = "";
		categories.forEach((c) => catListEl.appendChild(makeCatRow(c)));
		catDlg.showModal();
	});
	document.getElementById("cat-add").addEventListener("click", () => {
		catListEl.appendChild(makeCatRow(""));
	});
	document.getElementById("cat-cancel").addEventListener("click", () => catDlg.close("cancel"));
	catDlg.addEventListener("close", () => {
		if (catDlg.returnValue !== "ok") return;
		const list = [];
		const renames = {};
		const seen = {};
		catListEl.querySelectorAll(".cat-name").forEach((inp) => {
			const v = inp.value.trim();
			if (!v || seen[v]) return;
			seen[v] = true;
			list.push(v);
			const old = inp.dataset.old;
			if (old && old !== v) renames[old] = v;
		});
		post({ type: "categories", list: list, renames: renames });
	});

	window.addEventListener("message", (event) => {
		const msg = event.data;
		if (msg && msg.type === "tasks") {
			tasks = msg.tasks || [];
			categories = msg.categories || [];
			author = msg.author || "me";
			refreshCatFilter();
			// While the user is working in a control inside the list (dropdown, text field), do not re-render:
			// replacing the DOM drops the focus and closes the dropdown (#105). Render once the focus leaves.
			if (isInteracting()) {
				renderPending = true;
			} else {
				render();
			}
			syncEditing();
		}
	});
	let renderPending = false;
	function isInteracting() {
		const ae = document.activeElement;
		return !!ae && listEl.contains(ae) && (ae.tagName === "SELECT" || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
	}
	listEl.addEventListener("focusout", () => {
		setTimeout(() => {
			if (renderPending && !isInteracting()) { renderPending = false; render(); }
		}, 0);
	});

	// 30秒ごとの自動リロード (ファイル監視が効かない環境の保険)。非表示時はスキップ。
	setInterval(() => { if (!document.hidden) post({ type: "refresh" }); }, ${AUTO_REFRESH_MS});

	post({ type: "ready" });
})();
</script>
</body>
</html>`
}
