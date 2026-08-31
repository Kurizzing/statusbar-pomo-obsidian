export class WhiteNoise {
	private whiteNoisePlayer: HTMLAudioElement;

	constructor(whiteNoiseUrl: string) {
		this.whiteNoisePlayer = new Audio(whiteNoiseUrl);
		this.whiteNoisePlayer.loop = true;
	}

	play(): void {
		this.whiteNoisePlayer.play();
	}

	stop(): void {
		this.whiteNoisePlayer.pause();
		this.whiteNoisePlayer.currentTime = 0;
	}
}