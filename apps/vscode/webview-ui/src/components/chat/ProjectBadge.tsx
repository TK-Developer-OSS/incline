import type { WorkspaceRoot } from "@shared/multi-root/types"
import { memo } from "react"

/** ワークスペースのフォルダ名。name が無ければパスの末尾。 */
export function workspaceFolderName(root: Pick<WorkspaceRoot, "path" | "name">): string {
	if (root.name?.trim()) {
		return root.name.trim()
	}
	const parts = root.path.split(/[\\/]/).filter(Boolean)
	return parts[parts.length - 1] ?? root.path
}

/**
 * どのプロジェクトの INCLINE か分かるよう、フォルダ名を青い文字 + 角丸の枠で出す (#70)。
 * 複数フォルダのときは先頭 + 「+N」。ホバーで全パスを表示する。
 */
const ProjectBadge = ({ workspaceRoots }: { workspaceRoots?: WorkspaceRoot[] }) => {
	if (!workspaceRoots?.length) {
		return null
	}
	const first = workspaceFolderName(workspaceRoots[0])
	const rest = workspaceRoots.length - 1
	return (
		<div className="flex shrink-0 items-center px-2 pt-1.5 pb-0.5">
			<span
				className="max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs font-medium"
				data-testid="project-badge"
				style={{ color: "#3b82f6", borderColor: "#3b82f6" }}
				title={workspaceRoots.map((r) => r.path).join("\n")}>
				{first}
				{rest > 0 ? ` +${rest}` : ""}
			</span>
		</div>
	)
}

export default memo(ProjectBadge)
