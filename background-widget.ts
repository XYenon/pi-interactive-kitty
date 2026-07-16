import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatDuration } from "./types.js";
import type { ShellSessionManager } from "./session-manager.js";
import type { InteractiveShellCoordinator } from "./runtime-coordinator.js";

export function setupBackgroundWidget(
	ctx: { ui: { setWidget: Function }; hasUI?: boolean },
	sessionManager: ShellSessionManager,
	coordinator?: InteractiveShellCoordinator,
): (() => void) | null {
	if (!ctx.hasUI) return null;

	let durationTimer: ReturnType<typeof setInterval> | null = null;
	let tuiRef: { requestRender: () => void } | null = null;

	const requestRender = () => tuiRef?.requestRender();
	const unsubscribe = sessionManager.onChange(() => {
		manageDurationTimer();
		requestRender();
	});

	function manageDurationTimer() {
		const sessions = sessionManager.list();
		const hasRunning = sessions.some((s) => !s.session.exited);
		if (hasRunning && !durationTimer) {
			durationTimer = setInterval(requestRender, 10_000);
		} else if (!hasRunning && durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
	}

	ctx.ui.setWidget(
		"bg-sessions",
		(tui: any, theme: any) => {
			tuiRef = tui;
			return {
				render: (width: number) => {
					const sessions = sessionManager.list();
					if (sessions.length === 0) return [];
					const cols = width || tui.terminal?.columns || 120;
					const lines: string[] = [];
					for (const s of sessions) {
						const monitorState = coordinator?.getMonitorSessionState(s.id);
						const exited = s.session.exited;
						let dot: string;
						if (exited) {
							dot = theme.fg("dim", "○");
						} else if (monitorState) {
							dot = theme.fg("accent", "◆");
						} else {
							dot = theme.fg("accent", "●");
						}
						const id = theme.fg("dim", s.id);
						const cmd = s.command.replace(/\s+/g, " ").trim();
						const truncCmd = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
						const reason = s.reason ? theme.fg("dim", ` · ${s.reason}`) : "";
						let statusText: string;
						if (monitorState) {
							const base = monitorState.status === "running" ? "monitoring" : "monitor-stopped";
							const events = monitorState.eventCount > 0 ? ` e:${monitorState.eventCount}` : "";
							statusText = `${base}${events}`;
						} else if (exited) {
							statusText = "exited";
						} else {
							statusText = "running";
						}
						let status: string;
						if (exited) {
							status = theme.fg("dim", statusText);
						} else if (monitorState) {
							status = theme.fg("accent", statusText);
						} else {
							status = theme.fg("success", statusText);
						}
						const duration = theme.fg("dim", formatDuration(Date.now() - s.startedAt.getTime()));
						const strategy = monitorState ? theme.fg("dim", ` · ${monitorState.strategy}`) : "";
						const oneLine = ` ${dot} ${id}  ${truncCmd}${reason}${strategy}  ${status} ${duration}`;
						if (visibleWidth(oneLine) <= cols) {
							lines.push(oneLine);
						} else {
							lines.push(truncateToWidth(` ${dot} ${id}  ${cmd}`, cols, "…"));
							lines.push(truncateToWidth(`   ${status} ${duration}${reason}`, cols, "…"));
						}
					}
					return lines;
				},
				invalidate: () => {},
			};
		},
		{ placement: "belowEditor" },
	);

	manageDurationTimer();

	return () => {
		unsubscribe();
		if (durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
		ctx.ui.setWidget("bg-sessions", undefined);
	};
}
