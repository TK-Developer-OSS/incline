import { useCallback, useRef, useState } from "react";
import { useTheme } from "../hooks/use-theme";

export function useMouseTracker() {
	const [cursor, setCursor] = useState({ x: 0, y: 0 });
	const lastUpdateRef = useRef(0);

	const onMouseMove = useCallback((event: { x: number; y: number }) => {
		const now = Date.now();
		if (now - lastUpdateRef.current < 30) return;
		lastUpdateRef.current = now;
		setCursor({ x: event.x, y: event.y });
	}, []);

	return { cursor, onMouseMove };
}

// INCLINE: 本家 Cline のキャラクターは使わず、単色の塗りつぶしにしている。
export function TrackedRobot(_props: { cursorX?: number; cursorY?: number }) {
	const fg = useTheme().defaultForeground;
	return (
		<box width="100%" flexShrink={1} overflow="hidden">
			<box width={24} height={8} backgroundColor={fg} />
		</box>
	);
}
