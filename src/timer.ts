/**
 * Legacy timer mode definitions.
 *
 * The actual Pomodoro timer is now owned by PomodoroTray.exe.
 * Obsidian only reads tray state and sends commands.
 */
export const enum Mode {
	Pomo,
	ShortBreak,
	LongBreak,
	NoTimer
}