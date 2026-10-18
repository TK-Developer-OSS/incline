import { describe, expect, it } from "vitest";
import { CLINE_ENVIRONMENTS } from "./cline-environment";

// INCLINE: 本家 Cline のバックエンド (*.cline.bot) へ接続する設定が復活したら失敗させる。
// 本家の更新の取り込みや再生成で無効化が戻っても気づけるようにするためのガード。
describe("upstream Cline backend guard", () => {
	it("no environment points at cline.bot", () => {
		const urls = Object.values(CLINE_ENVIRONMENTS).flatMap((env) =>
			Object.values(env).filter((v): v is string => typeof v === "string"),
		);
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) {
			expect(url).not.toMatch(/cline\.bot/i);
		}
	});
});
