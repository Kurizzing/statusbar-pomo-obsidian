import {
	Plugin,
	TFile,
	moment
} from "obsidian";


import {
	PomoSettingTab,
	PomoSettings,
	DEFAULT_SETTINGS
} from "./settings";

import {
	getDailyNote,
	createDailyNote,
	getAllDailyNotes,
	getDailyNoteSettings
} from "obsidian-daily-notes-interface";

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TRAY_STATE_FILE = path.join(
	os.tmpdir(),
	"obsidian-pomodoro-state.json"
);

const TRAY_COMMAND_FILE = path.join(
	os.tmpdir(),
	"obsidian-pomodoro-command.json"
);

const TRAY_CONFIG_FILE = path.join(
	os.tmpdir(),
	"obsidian-pomodoro-config.json"
);

const TRAY_EVENTS_FILE = path.join(
	os.tmpdir(),
	"obsidian-pomodoro-events.json"
);


interface TrayState {
	mode: string;
	status: string;
	paused: boolean;
	remainingMs: number;
	endTime?: number | null;
	updatedAt: number;
	completedPomos?: number;
	cyclesSinceLastAutoStop?: number;
	activeNotePath?: string | null;
}


interface TrayEvent {
	id: string;
	type: string;
	completedAt: number;
	durationMinutes: number;
	activeNotePath?: string | null;
}


interface TrayEventQueue {
	events: TrayEvent[];
}


interface TrayCommand {
	command: string;
	createdAt: number;
	activeNotePath?: string;
	eventIds?: string[];
}


interface PluginData {
	settings: PomoSettings;
	processedEventIds: string[];
}


export default class PomoTimerPlugin extends Plugin {

	settings!: PomoSettings;

	statusBar!: HTMLElement;

	private trayState: TrayState = {
		mode: "none",
		status: "idle",
		paused: false,
		remainingMs: 0,
		updatedAt: 0
	};

	private processedEventIds: string[] = [];

	private pendingCommands: TrayCommand[] = [];

	private processingEvents = false;


	async onload() {

		console.log(
			"Loading Status Bar Pomodoro Tray"
		);

		await this.loadSettings();

		this.addSettingTab(
			new PomoSettingTab(
				this.app,
				this
			)
		);

		this.statusBar =
			this.addStatusBarItem();

		this.statusBar.addClass(
			"statusbar-pomo"
		);

		if (this.settings.logging) {
			this.openLogFileOnClick();
		}

		/*
		 * Send the current Obsidian settings
		 * to PomodoroTray.
		 */
		this.writeTrayConfig();


		/*
		 * Keep the active note path reasonably
		 * up-to-date for automatically started
		 * Pomodoros.
		 */
		this.registerEvent(
			this.app.workspace.on(
				"active-leaf-change",
				() => {
					this.writeTrayConfig();
				}
			)
		);


		/*
		 * Ribbon button:
		 *
		 * Idle     -> Start
		 * Running  -> Pause
		 * Paused   -> Resume
		 */
		if (this.settings.ribbonIcon) {

			this.addRibbonIcon(
				"clock",
				"Toggle pomodoro",
				() => {

					if (
						this.trayState.mode === "none" ||
						this.trayState.status === "idle"
					) {
						this.sendStartCommand();
						return;
					}

					if (this.trayState.paused) {
						this.queueTrayCommand({
							command: "resume",
							createdAt: Date.now()
						});
					}
					else {
						this.queueTrayCommand({
							command: "pause",
							createdAt: Date.now()
						});
					}
				}
			);
		}


		/*
		 * Obsidian commands
		 */

		this.addCommand({
			id: "start-satusbar-pomo",
			name: "Start pomodoro",
			icon: "play",

			callback: () => {
				this.sendStartCommand();
			}
		});


		this.addCommand({
			id: "pause-satusbar-pomo",
			name: "Toggle timer pause",
			icon: "pause",

			callback: () => {

				if (
					this.trayState.mode === "none"
				) {
					return;
				}

				this.queueTrayCommand({
					command:
						this.trayState.paused
							? "resume"
							: "pause",

					createdAt: Date.now()
				});
			}
		});


		this.addCommand({
			id: "quit-satusbar-pomo",
			name: "Quit timer",
			icon: "quit",

			callback: () => {

				this.queueTrayCommand({
					command: "stop",
					createdAt: Date.now()
				});
			}
		});


		/*
		 * Polling here is only for UI synchronization.
		 *
		 * Timer progression itself is handled by
		 * PomodoroTray.exe.
		 *
		 * Therefore Electron background throttling
		 * cannot stop the actual Pomodoro timer.
		 */
		this.registerInterval(
			window.setInterval(
				() => {
					this.updateFromTray();
				},
				500
			)
		);


		/*
		 * Initial update.
		 */
		this.updateFromTray();
	}


	// ============================================================
	// Main synchronization
	// ============================================================

	private async updateFromTray(): Promise<void> {

		this.readTrayState();

		this.updateStatusBar();

		this.flushCommandQueue();

		await this.processTrayEvents();
	}


	// ============================================================
	// Tray state
	// ============================================================

	private readTrayState(): void {

		try {

			if (
				!fs.existsSync(
					TRAY_STATE_FILE
				)
			) {
				return;
			}

			const raw =
				fs.readFileSync(
					TRAY_STATE_FILE,
					"utf8"
				);

			if (!raw) {
				return;
			}

			const state =
				JSON.parse(
					raw
				) as TrayState;

			this.trayState =
				state;
		}
		catch (error) {

			/*
			 * Tray may be replacing the file
			 * at the exact same time.
			 *
			 * Simply retry on the next tick.
			 */
		}
	}


	private updateStatusBar(): void {

		/*
		 * Tray not running / stale heartbeat.
		 */
		if (
			this.trayState.updatedAt > 0 &&
			Date.now() -
				this.trayState.updatedAt >
				5000
		) {

			this.statusBar.setText(
				""
			);

			return;
		}


		if (
			this.trayState.mode === "none" ||
			this.trayState.status === "idle"
		) {

			this.statusBar.setText(
				""
			);

			return;
		}


		let symbol = "";

		if (this.settings.emoji) {

			symbol =
				this.trayState.mode ===
					"pomodoro"
					? "🍅 "
					: "🏖️ ";
		}


		const time =
			this.formatMilliseconds(
				this.trayState.remainingMs
			);


		this.statusBar.setText(
			symbol + time
		);
	}


	private formatMilliseconds(
		milliseconds: number
	): string {

		const value =
			Math.max(
				0,
				milliseconds
			);

		const totalSeconds =
			Math.floor(
				value / 1000
			);

		const hours =
			Math.floor(
				totalSeconds / 3600
			);

		const minutes =
			Math.floor(
				(totalSeconds % 3600) /
				60
			);

		const seconds =
			totalSeconds % 60;


		if (hours > 0) {

			return (
				hours
					.toString()
					.padStart(2, "0") +
				":" +
				minutes
					.toString()
					.padStart(2, "0") +
				":" +
				seconds
					.toString()
					.padStart(2, "0")
			);
		}


		return (
			minutes
				.toString()
				.padStart(2, "0") +
			":" +
			seconds
				.toString()
				.padStart(2, "0")
		);
	}


	// ============================================================
	// Commands → Tray
	// ============================================================

	private sendStartCommand(): void {

		const activeNote =
			this.app.workspace
				.getActiveFile();


		this.queueTrayCommand({
			command: "start",

			createdAt:
				Date.now(),

			activeNotePath:
				activeNote?.path
		});
	}


	private queueTrayCommand(
		command: TrayCommand
	): void {

		this.pendingCommands.push(
			command
		);

		this.flushCommandQueue();
	}


	private flushCommandQueue(): void {

		if (
			this.pendingCommands.length ===
			0
		) {
			return;
		}


		/*
		 * Tray has not consumed the previous
		 * command yet.
		 */
		if (
			fs.existsSync(
				TRAY_COMMAND_FILE
			)
		) {
			return;
		}


		const command =
			this.pendingCommands[0];


		try {

			this.atomicWrite(
				TRAY_COMMAND_FILE,
				JSON.stringify(
					command
				)
			);

			this.pendingCommands.shift();
		}
		catch (error) {

			console.error(
				"[Pomodoro Tray] Failed to send command:",
				error
			);
		}
	}


	// ============================================================
	// Settings → Tray
	// ============================================================

	writeTrayConfig(): void {

		try {

			const activeNote =
				this.app.workspace
					.getActiveFile();


			const config = {

				pomoMinutes:
					this.settings.pomo,

				shortBreakMinutes:
					this.settings.shortBreak,

				longBreakMinutes:
					this.settings.longBreak,

				longBreakInterval:
					this.settings.longBreakInterval,

				autostartTimer:
					this.settings.autostartTimer,

				numAutoCycles:
					this.settings.numAutoCycles,

				activeNotePath:
					activeNote?.path ?? null
			};


			this.atomicWrite(
				TRAY_CONFIG_FILE,
				JSON.stringify(
					config,
					null,
					2
				)
			);
		}
		catch (error) {

			console.error(
				"[Pomodoro Tray] Failed to write config:",
				error
			);
		}
	}


	// ============================================================
	// Completion events
	// ============================================================

	private async processTrayEvents(): Promise<void> {

		if (this.processingEvents) {
			return;
		}

		if (
			!fs.existsSync(
				TRAY_EVENTS_FILE
			)
		) {
			return;
		}


		this.processingEvents = true;


		try {

			const raw =
				fs.readFileSync(
					TRAY_EVENTS_FILE,
					"utf8"
				);


			if (!raw) {
				return;
			}


			const queue =
				JSON.parse(
					raw
				) as TrayEventQueue;


			if (
				!queue.events ||
				queue.events.length === 0
			) {
				return;
			}


			const ackIds: string[] =
				[];


			for (
				const event
				of queue.events
			) {

				/*
				 * Already handled before.
				 *
				 * This prevents duplicate log entries
				 * if Obsidian crashes after logging but
				 * before Tray receives the ACK.
				 */
				if (
					this.processedEventIds
						.includes(event.id)
				) {

					ackIds.push(
						event.id
					);

					continue;
				}


				try {

					if (
						event.type ===
							"pomodoroCompleted"
					) {

						if (
							this.settings.logging
						) {

							await this.logPomodoroEvent(
								event
							);
						}
					}


					this.processedEventIds.push(
						event.id
					);


					/*
					 * Keep the list bounded.
					 */
					if (
						this.processedEventIds.length >
						500
					) {

						this.processedEventIds =
							this.processedEventIds.slice(
								-500
							);
					}


					await this.savePluginData();


					ackIds.push(
						event.id
					);
				}
				catch (error) {

					console.error(
						"[Pomodoro Tray] Failed to process event:",
						event,
						error
					);

					/*
					 * Do NOT ACK failed events.
					 * They will be retried later.
					 */
				}
			}


			if (ackIds.length > 0) {

				this.queueTrayCommand({
					command:
						"ackEvents",

					createdAt:
						Date.now(),

					eventIds:
						ackIds
				});
			}
		}
		catch (error) {

			/*
			 * Tray may be writing events.json.
			 * Retry later.
			 */
		}
		finally {

			this.processingEvents =
				false;
		}
	}


	// ============================================================
	// Pomodoro logging
	// ============================================================

	private async logPomodoroEvent(
		event: TrayEvent
	): Promise<void> {

		/*
		 * IMPORTANT:
		 *
		 * Use the actual completion timestamp from
		 * Tray instead of the time Obsidian happens
		 * to wake up.
		 */
		const completedMoment =
			moment(
				event.completedAt
			);


		let logText =
			completedMoment.format(
				this.settings.logText
			);


		const logFilePlaceholder =
			"{{logFile}}";


		if (
			this.settings.logActiveNote &&
			event.activeNotePath
		) {

			const abstractFile =
				this.app.vault
					.getAbstractFileByPath(
						event.activeNotePath
					);


			if (
				abstractFile instanceof
					TFile
			) {

				const linkText =
					this.app.fileManager
						.generateMarkdownLink(
							abstractFile,
							""
						);


				if (
					logText.includes(
						logFilePlaceholder
					)
				) {

					logText =
						logText.replace(
							logFilePlaceholder,
							linkText
						);
				}
				else {

					logText =
						logText +
						" " +
						linkText;
				}
			}
		}


		logText =
			logText.replace(
				String.raw`\n`,
				"\n"
			);


		if (
			this.settings.logToDaily
		) {

			const file =
				await this.getDailyNoteFile(
					completedMoment
				);


			await this.appendFile(
				file.path,
				logText
			);
		}
		else {

			const filePath =
				this.settings.logFile;


			let file =
				this.app.vault
					.getAbstractFileByPath(
						filePath
					);


			if (!file) {

				await this.app.vault.create(
					filePath,
					""
				);
			}


			await this.appendFile(
				filePath,
				logText
			);
		}
	}


	private async appendFile(
		filePath: string,
		logText: string
	): Promise<void> {

		let existingContent =
			await this.app.vault.adapter.read(
				filePath
			);


		if (
			existingContent.length > 0
		) {

			existingContent +=
				"\r";
		}


		await this.app.vault.adapter.write(
			filePath,
			existingContent +
				logText
		);
	}


	// ============================================================
	// Daily notes
	// ============================================================

	async getDailyNoteFile(
		date: any = moment()
	): Promise<TFile> {

		try {

			let file =
				getDailyNote(
					date as any,
					getAllDailyNotes()
				);


			if (!file) {

				file =
					(
						await createDailyNote(
							date as any
						)
					)!;
			}


			return file as TFile;
		}
		catch (error) {

			const dailyNoteFolder =
				getDailyNoteSettings()
					.folder ?? "";


			if (dailyNoteFolder) {

				const existing =
					this.app.vault
						.getAbstractFileByPath(
							dailyNoteFolder
						);


				if (!existing) {

					await this.app.vault
						.createFolder(
							dailyNoteFolder
						);
				}
			}


			const file =
				(
					await createDailyNote(
						date as any
					)
				)!;


			return file as TFile;
		}
	}


	// ============================================================
	// Logging status-bar click
	// ============================================================

	openLogFileOnClick(): void {

		this.statusBar.addClass(
			"statusbar-pomo-logging"
		);


		this.statusBar.onClickEvent(
			async () => {

				if (
					!this.settings.logging
				) {
					return;
				}


				try {

					let file: string;


					if (
						this.settings.logToDaily
					) {

						file =
							(
								await this
									.getDailyNoteFile()
							).path;
					}
					else {

						file =
							this.settings.logFile;
					}


					this.app.workspace
						.openLinkText(
							file,
							"",
							false
						);
				}
				catch (error) {

					console.error(
						error
					);
				}
			}
		);
	}


	// ============================================================
	// Settings persistence
	// ============================================================

	async loadSettings(): Promise<void> {

		const data =
			await this.loadData();


		/*
		 * Migration:
		 *
		 * Older versions stored settings directly.
		 * New versions store:
		 *
		 * {
		 *   settings: {...},
		 *   processedEventIds: [...]
		 * }
		 */
		if (
			data &&
			data.settings
		) {

			const pluginData =
				data as PluginData;


			this.settings =
				Object.assign(
					{},
					DEFAULT_SETTINGS,
					pluginData.settings
				);


			this.processedEventIds =
				pluginData
					.processedEventIds ??
				[];
		}
		else {

			this.settings =
				Object.assign(
					{},
					DEFAULT_SETTINGS,
					data ?? {}
				);


			this.processedEventIds =
				[];
		}
	}


	async saveSettings(): Promise<void> {

		await this.savePluginData();

		this.writeTrayConfig();
	}


	private async savePluginData(): Promise<void> {

		const data: PluginData = {

			settings:
				this.settings,

			processedEventIds:
				this.processedEventIds
		};


		await this.saveData(
			data
		);
	}


	// ============================================================
	// File helper
	// ============================================================

	private atomicWrite(
		filePath: string,
		content: string
	): void {

		const tempFile =
			filePath + ".tmp";


		fs.writeFileSync(
			tempFile,
			content,
			"utf8"
		);


		fs.renameSync(
			tempFile,
			filePath
		);
	}


	onunload(): void {

		/*
		 * Do NOT stop the timer.
		 *
		 * PomodoroTray.exe owns the timer and should
		 * continue running even when Obsidian closes.
		 */

		console.log(
			"Unloading Status Bar Pomodoro Tray"
		);
	}
}