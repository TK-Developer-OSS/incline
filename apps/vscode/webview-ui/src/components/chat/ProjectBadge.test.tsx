import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ProjectBadge, { workspaceFolderName } from "./ProjectBadge"

describe("workspaceFolderName", () => {
	it("uses the display name, else the last path segment", () => {
		expect(workspaceFolderName({ path: "/workspace/incline", name: "incline-dev" })).toBe("incline-dev")
		expect(workspaceFolderName({ path: "/workspace/incline" })).toBe("incline")
		expect(workspaceFolderName({ path: "C:\\work\\My App\\" })).toBe("My App")
	})
})

describe("ProjectBadge", () => {
	const root = (path: string) => ({ path, vcs: "git" as never })

	it("shows the folder name in blue inside a rounded frame, with the full path on hover", () => {
		render(<ProjectBadge workspaceRoots={[root("/workspace/incline")]} />)
		const badge = screen.getByTestId("project-badge")
		expect(badge.textContent).toBe("incline")
		expect(badge.className).toContain("rounded-full")
		expect(badge.style.color).toBe("rgb(59, 130, 246)")
		expect(badge.title).toBe("/workspace/incline")
	})

	it("adds +N for multi-root workspaces and renders nothing without a folder", () => {
		const { rerender } = render(<ProjectBadge workspaceRoots={[root("/a/one"), root("/a/two"), root("/a/three")]} />)
		expect(screen.getByTestId("project-badge").textContent).toBe("one +2")
		rerender(<ProjectBadge workspaceRoots={[]} />)
		expect(screen.queryByTestId("project-badge")).toBeNull()
	})
})
