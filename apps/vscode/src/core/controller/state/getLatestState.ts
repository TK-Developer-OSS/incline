import { EmptyRequest } from "@shared/proto/cline/common"
import { State } from "@shared/proto/cline/state"
import { Controller } from "../index"

/**
 * Get the latest extension state
 * @param controller The controller instance
 * @param request The empty request
 * @returns The current extension state
 */
export async function getLatestState(controller: Controller, _: EmptyRequest): Promise<State> {
	// Incline: 設定パネルを開くときは、設定ファイル (globalState.json) の最新を正としてキャッシュを読み直し、
	// 画面にも送り直す (他のウィンドウが変えた値を反映し、古い値を書き戻さない)。
	controller.stateManager?.reloadFromFile?.()
	await controller.postStateToWebview?.()

	// Get the state using the existing method
	const state = await controller.getStateToPostToWebview()

	// Convert the state to a JSON string
	const stateJson = JSON.stringify(state)

	// Return the state as a JSON string
	return State.create({
		stateJson,
	})
}
