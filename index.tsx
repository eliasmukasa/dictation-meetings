/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */

import {GoogleGenAI} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash-preview-04-17';

interface Note {
  id: string;
  rawTranscription: string;
  polishedNote: string;
  timestamp: number;
}

type AppMode = 'note' | 'meeting';

class VoiceNotesApp {
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private actionItems: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;
  private hasAttemptedPermission = false;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  private currentMode: AppMode = 'note';
  private noteTabs: HTMLDivElement;
  private meetingTabs: HTMLDivElement;

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.API_KEY!,
    });

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.actionItems = document.getElementById(
      'actionItems',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector(
      'i',
    ) as HTMLElement;
    this.editorTitle = document.querySelector(
      '.editor-title',
    ) as HTMLDivElement;

    this.noteTabs = document.getElementById('note-tabs') as HTMLDivElement;
    this.meetingTabs = document.getElementById('meeting-tabs') as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        'Live waveform canvas element not found. Visualizer will not work.',
      );
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      console.warn('Recording interface element not found.');
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.setupTabbedPanels();
    this.initTheme();
    this.setMode('note', true);

    this.recordingStatus.textContent = 'Ready to record';
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  private setupTabbedPanels() {
    this.setupModeSelection();
    this.setupOutputTabs('#note-tabs');
    this.setupOutputTabs('#meeting-tabs');

    document
      .querySelectorAll<HTMLElement>('[contenteditable][placeholder]')
      .forEach((el) => {
        const placeholder = el.getAttribute('placeholder')!;

        const updatePlaceholderState = () => {
          const currentText = (
            el.id === 'polishedNote' || el.id === 'actionItems'
              ? el.innerText
              : el.textContent
          )?.trim();

          if (currentText === '' || currentText === placeholder) {
            if (
              (el.id === 'polishedNote' || el.id === 'actionItems') &&
              currentText === ''
            ) {
              el.innerHTML = placeholder;
            } else if (currentText === '') {
              el.textContent = placeholder;
            }
            el.classList.add('placeholder-active');
          } else {
            el.classList.remove('placeholder-active');
          }
        };

        updatePlaceholderState();

        el.addEventListener('focus', function () {
          const currentText = (
            this.id === 'polishedNote' || this.id === 'actionItems'
              ? this.innerText
              : this.textContent
          )?.trim();
          if (currentText === placeholder) {
            if (this.id === 'polishedNote' || this.id === 'actionItems')
              this.innerHTML = '';
            else this.textContent = '';
            this.classList.remove('placeholder-active');
          }
        });

        el.addEventListener('blur', () => {
          updatePlaceholderState();
        });
      });
  }

  private setupModeSelection() {
    const modeNav = document.getElementById('mode-navigation-container');
    if (!modeNav) return;

    const modeButtons = modeNav.querySelectorAll('.tab-button');
    const activeTabIndicator = modeNav.querySelector(
      '.active-tab-indicator',
    ) as HTMLElement;

    const setActiveMode = (activeButton: Element, skipAnimation = false) => {
      if (!activeButton || !activeTabIndicator) return;
      modeButtons.forEach((btn) => btn.classList.remove('active'));
      activeButton.classList.add('active');
      const mode = activeButton.getAttribute('data-mode') as AppMode;

      const originalTransition = activeTabIndicator.style.transition;
      if (skipAnimation) activeTabIndicator.style.transition = 'none';
      else activeTabIndicator.style.transition = '';

      activeTabIndicator.style.left = `${(activeButton as HTMLElement).offsetLeft}px`;
      activeTabIndicator.style.width = `${(activeButton as HTMLElement).offsetWidth}px`;

      if (skipAnimation) {
        activeTabIndicator.offsetHeight;
        activeTabIndicator.style.transition = originalTransition;
      }
      this.setMode(mode);
    };

    modeButtons.forEach((button) => {
      button.addEventListener('click', (e) => {
        setActiveMode(e.currentTarget as Element);
      });
    });

    const initiallyActiveButton = modeNav.querySelector('.tab-button.active');
    if (initiallyActiveButton) {
      requestAnimationFrame(() => setActiveMode(initiallyActiveButton, true));
    }

    window.addEventListener('resize', () => {
      const currentActiveButton = modeNav.querySelector('.tab-button.active');
      if (currentActiveButton)
        requestAnimationFrame(() => setActiveMode(currentActiveButton, true));
    });
  }

  private setMode(mode: AppMode, isInitial = false) {
    if (this.currentMode === mode && !isInitial) return;
    this.currentMode = mode;

    if (mode === 'note') {
      this.noteTabs.style.display = 'inline-flex';
      this.meetingTabs.style.display = 'none';
      this.editorTitle.setAttribute('placeholder', 'Untitled Note');
      this.newButton.setAttribute('title', 'New Note');
    } else {
      // meeting mode
      this.noteTabs.style.display = 'none';
      this.meetingTabs.style.display = 'inline-flex';
      this.editorTitle.setAttribute('placeholder', 'Untitled Meeting');
      this.newButton.setAttribute('title', 'New Meeting');
    }

    // Force animation redraw for the newly visible tab set
    const activeTabContainer =
      mode === 'note' ? this.noteTabs : this.meetingTabs;
    const activeIndicator = activeTabContainer.querySelector(
      '.active-tab-indicator',
    );
    const firstTab = activeTabContainer.querySelector('.tab-button');
    if (activeIndicator && firstTab) {
      (activeIndicator as HTMLElement).style.width = `${(firstTab as HTMLElement).offsetWidth}px`;
      (activeIndicator as HTMLElement).style.left = `${(firstTab as HTMLElement).offsetLeft}px`;
    }

    this.createNewNote();
  }

  private setupOutputTabs(containerSelector: string) {
    const tabContainer = document.querySelector(containerSelector);
    if (!tabContainer) return;

    const tabButtons = tabContainer.querySelectorAll('.tab-button');
    const activeTabIndicator = tabContainer.querySelector(
      '.active-tab-indicator',
    ) as HTMLElement;
    const noteContents = document.querySelectorAll(
      '.note-content',
    ) as NodeListOf<HTMLElement>;

    const setActiveTab = (activeButton: Element, skipAnimation = false) => {
      if (!activeButton || !activeTabIndicator) return;
      tabButtons.forEach((btn) => btn.classList.remove('active'));
      activeButton.classList.add('active');

      const originalTransition = activeTabIndicator.style.transition;
      if (skipAnimation) activeTabIndicator.style.transition = 'none';
      else activeTabIndicator.style.transition = '';

      activeTabIndicator.style.left = `${(activeButton as HTMLElement).offsetLeft}px`;
      activeTabIndicator.style.width = `${(activeButton as HTMLElement).offsetWidth}px`;

      if (skipAnimation) {
        activeTabIndicator.offsetHeight;
        activeTabIndicator.style.transition = originalTransition;
      }

      const tabName = activeButton.getAttribute('data-tab');
      noteContents.forEach((content) => content.classList.remove('active'));

      switch (tabName) {
        case 'polished':
        case 'summary':
          document.getElementById('polishedNote')?.classList.add('active');
          break;
        case 'raw':
        case 'transcript':
          document.getElementById('rawTranscription')?.classList.add('active');
          break;
        case 'actions':
          document.getElementById('actionItems')?.classList.add('active');
          break;
      }
    };

    tabButtons.forEach((button) => {
      button.addEventListener('click', (e) =>
        setActiveTab(e.currentTarget as Element),
      );
    });

    const initiallyActiveButton = tabContainer.querySelector(
      '.tab-button.active',
    );
    if (initiallyActiveButton) {
      requestAnimationFrame(() => setActiveTab(initiallyActiveButton, true));
    }

    window.addEventListener('resize', () => {
      const currentActiveButton = tabContainer.querySelector(
        '.tab-button.active',
      );
      if (currentActiveButton) {
        requestAnimationFrame(() => setActiveTab(currentActiveButton, true));
      }
    });
  }

  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      localStorage.setItem('theme', 'dark');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        'One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Untitled';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder ? currentTitle : 'New Recording';

    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private async startRecording(): Promise<void> {
    try {
      this.audioChunks = [];
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }

      this.recordingStatus.textContent = 'Requesting microphone access...';

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.error('Failed with basic constraints:', err);
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: 'audio/webm',
        });
      } catch (e) {
        console.error('audio/webm not supported, trying default:', e);
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        this.stopLiveDisplay();

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {
            type: this.mediaRecorder?.mimeType || 'audio/webm',
          });
          this.processAudio(audioBlob).catch((err) => {
            console.error('Error processing audio:', err);
            this.recordingStatus.textContent = 'Error processing recording';
          });
        } else {
          this.recordingStatus.textContent =
            'No audio data captured. Please try again.';
        }

        if (this.stream) {
          this.stream.getTracks().forEach((track) => {
            track.stop();
          });
          this.stream = null;
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;

      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Stop Recording');

      this.startLiveDisplay();
    } catch (error) {
      console.error('Error starting recording:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';

      if (
        errorName === 'NotAllowedError' ||
        errorName === 'PermissionDeniedError'
      ) {
        this.recordingStatus.textContent =
          'Microphone permission denied. Please check browser settings and reload page.';
      } else if (
        errorName === 'NotFoundError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Requested device not found'))
      ) {
        this.recordingStatus.textContent =
          'No microphone found. Please connect a microphone.';
      } else if (
        errorName === 'NotReadableError' ||
        errorName === 'AbortError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Failed to allocate audiosource'))
      ) {
        this.recordingStatus.textContent =
          'Cannot access microphone. It may be in use by another application.';
      } else {
        this.recordingStatus.textContent = `Error: ${errorMessage}`;
      }

      this.isRecording = false;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.stopLiveDisplay();
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.error('Error stopping MediaRecorder:', e);
        this.stopLiveDisplay();
      }

      this.isRecording = false;

      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.recordingStatus.textContent = 'Processing audio...';
    } else {
      if (!this.isRecording) this.stopLiveDisplay();
    }
  }

  private async processAudio(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) {
      this.recordingStatus.textContent =
        'No audio data captured. Please try again.';
      return;
    }

    try {
      URL.createObjectURL(audioBlob);

      this.recordingStatus.textContent = 'Converting audio...';

      const reader = new FileReader();
      const readResult = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          try {
            const base64data = reader.result as string;
            const base64Audio = base64data.split(',')[1];
            resolve(base64Audio);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(reader.error);
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await readResult;

      if (!base64Audio) throw new Error('Failed to convert audio to base64');

      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      await this.getTranscription(base64Audio, mimeType);
    } catch (error) {
      console.error('Error in processAudio:', error);
      this.recordingStatus.textContent =
        'Error processing recording. Please try again.';
    }
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    try {
      this.recordingStatus.textContent = 'Getting transcription...';

      let transcriptionPrompt =
        'Generate a complete, detailed transcript of this audio.';
      if (this.currentMode === 'meeting') {
        transcriptionPrompt =
          'Generate a complete, detailed transcript of this audio, identifying and labeling each speaker (e.g., "Speaker 1", "Speaker 2").';
      }

      const contents = [
        {text: transcriptionPrompt},
        {inlineData: {mimeType: mimeType, data: base64Audio}},
      ];

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });

      const transcriptionText = response.text;

      if (transcriptionText) {
        this.rawTranscription.textContent = transcriptionText;
        this.rawTranscription.classList.remove('placeholder-active');

        if (this.currentNote)
          this.currentNote.rawTranscription = transcriptionText;

        const nextStep =
          this.currentMode === 'note' ? 'Polishing note...' : 'Analyzing meeting...';
        this.recordingStatus.textContent = `Transcription complete. ${nextStep}`;

        this.processTranscription().catch((err) => {
          console.error(`Error in processTranscription for mode ${this.currentMode}:`, err);
          this.recordingStatus.textContent =
            `Error processing ${this.currentMode} after transcription.`;
        });
      } else {
        this.recordingStatus.textContent =
          'Transcription failed or returned empty.';
        this.polishedNote.innerHTML =
          '<p><em>Could not transcribe audio. Please try again.</em></p>';
        this.rawTranscription.textContent =
          this.rawTranscription.getAttribute('placeholder');
        this.rawTranscription.classList.add('placeholder-active');
      }
    } catch (error) {
      console.error('Error getting transcription:', error);
      this.recordingStatus.textContent =
        'Error getting transcription. Please try again.';
      this.polishedNote.innerHTML = `<p><em>Error during transcription: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.rawTranscription.textContent =
        this.rawTranscription.getAttribute('placeholder');
      this.rawTranscription.classList.add('placeholder-active');
    }
  }

  private async processTranscription(): Promise<void> {
    if (
      !this.rawTranscription.textContent ||
      this.rawTranscription.textContent.trim() === '' ||
      this.rawTranscription.classList.contains('placeholder-active')
    ) {
      this.recordingStatus.textContent = 'No transcription to process';
      return;
    }

    if (this.currentMode === 'note') {
      await this.getPolishedNote();
    } else {
      await this.getMeetingAnalysis();
    }
  }

  private async renderMeetingNotes(data: {
    summary: string;
    actionItems: {task: string; owner: string; dueDate: string}[];
    transcript: string;
  }) {
    // Render Summary
    if (data.summary) {
      try {
        this.polishedNote.innerHTML = await marked.parse(data.summary);
        this.polishedNote.classList.remove('placeholder-active');
      } catch (e) {
        console.error("Error parsing summary markdown:", e);
        // Fallback to plain text if markdown parsing fails
        this.polishedNote.textContent = data.summary;
        this.polishedNote.classList.remove('placeholder-active');
      }
    } else {
      this.polishedNote.innerHTML =
        this.polishedNote.getAttribute('placeholder') || '';
      this.polishedNote.classList.add('placeholder-active');
    }

    // Render Action Items
    if (data.actionItems && data.actionItems.length > 0) {
      const table = document.createElement('table');
      table.className = 'action-items-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>Action Item</th>
            <th>Owner</th>
            <th>Due Date</th>
          </tr>
        </thead>
        <tbody>
          ${data.actionItems
            .map(
              (item) => `
            <tr>
              <td>${item.task || 'N/A'}</td>
              <td>${item.owner || 'N/A'}</td>
              <td>${item.dueDate || 'N/A'}</td>
            </tr>
          `,
            )
            .join('')}
        </tbody>
      `;
      this.actionItems.innerHTML = '';
      this.actionItems.appendChild(table);
      this.actionItems.classList.remove('placeholder-active');
      this.actionItems.removeAttribute('contenteditable');
    } else {
      this.actionItems.innerHTML =
        this.actionItems.getAttribute('placeholder') || '';
      this.actionItems.classList.add('placeholder-active');
      this.actionItems.setAttribute('contenteditable', 'true');
    }

    // Render Transcript
    if (data.transcript) {
      this.rawTranscription.textContent = data.transcript;
      this.rawTranscription.classList.remove('placeholder-active');
    }
  }

  private async getMeetingAnalysis(): Promise<void> {
    try {
      this.recordingStatus.textContent = 'Analyzing meeting notes...';

      const systemInstruction = `You are an expert meeting assistant. Your task is to process a raw meeting transcript and extract key information in a structured JSON format. The output should be professional and adhere to the highest industry standards for meeting notes. The JSON object must have three properties: "summary", "actionItems", and "transcript". "actionItems" must be an array of objects, each with "task", "owner", and "dueDate" properties.`;

      const prompt = `
        Given the following raw meeting transcript, please generate a JSON object with the following structure:
        {
          "summary": "A concise, professional summary of the meeting in markdown format, covering the main topics discussed, key decisions made, and overall outcomes.",
          "actionItems": [
            { "task": "A specific, actionable task.", "owner": "The name of the person or role responsible.", "dueDate": "The due date for the task, if mentioned (YYYY-MM-DD), otherwise 'N/A'." }
          ],
          "transcript": "The full, speaker-diarized transcript, cleaned up for readability but without altering the content."
        }

        Ensure all action items are clearly identified. If an owner or due date is not explicitly mentioned, use 'N/A'.
        The summary should be suitable for sharing with stakeholders.

        Raw Transcript:
        ${this.rawTranscription.textContent}
      `;

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      let jsonStr = typeof response.text === 'string' ? response.text.trim() : '';
      const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
      const match = jsonStr.match(fenceRegex);
      if (match && match[2]) {
        jsonStr = match[2].trim();
      }

      try {
        const parsedData = JSON.parse(jsonStr);
        await this.renderMeetingNotes(parsedData);
        this.recordingStatus.textContent =
          'Meeting analysis complete. Ready for next recording.';

        // Set title from summary
        if (parsedData.summary) {
            const tempDiv = document.createElement('div');
            try {
                tempDiv.innerHTML = await marked.parse(parsedData.summary);
                const h1 = tempDiv.querySelector('h1');
                if (h1 && this.editorTitle) {
                    this.editorTitle.textContent = h1.textContent;
                    this.editorTitle.classList.remove('placeholder-active');
                }
            } catch (e) {
                console.error("Error parsing summary for title extraction:", e);
            }
        }

      } catch (e) {
        console.error('Failed to parse JSON response:', e, 'Raw text:', jsonStr);
        throw new Error('Could not parse meeting analysis from the model.');
      }
    } catch (error) {
      console.error('Error getting meeting analysis:', error);
      this.recordingStatus.textContent =
        'Error analyzing meeting. Please try again.';
      this.polishedNote.innerHTML = `<p><em>Error during analysis: ${error instanceof Error ? error.message : String(error)}</em></p>`;
    }
  }

  private async getPolishedNote(): Promise<void> {
    try {
      this.recordingStatus.textContent = 'Polishing note...';
      const prompt = `Take this raw transcription and create a polished, well-formatted note.
                    Remove filler words (um, uh, like), repetitions, and false starts.
                    Format any lists or bullet points properly. Use markdown formatting for headings, lists, etc.
                    Maintain all the original content and meaning.

                    Raw transcription:
                    ${this.rawTranscription.textContent}`;

      const response = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
      });
      const polishedText = response.text;

      if (polishedText) {
        try {
          const htmlContent = await marked.parse(polishedText);
          this.polishedNote.innerHTML = htmlContent;
          this.polishedNote.classList.remove('placeholder-active');

          let noteTitleSet = false;
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = htmlContent;
          const h1 = tempDiv.querySelector('h1');
          if (h1 && this.editorTitle) {
            this.editorTitle.textContent = h1.textContent;
            this.editorTitle.classList.remove('placeholder-active');
            noteTitleSet = true;
          }

          if (!noteTitleSet && this.editorTitle) {
            const firstP = tempDiv.querySelector('p');
            if (firstP && firstP.textContent) {
              const potentialTitle = firstP.textContent.trim();
              if (potentialTitle.length > 3) {
                const maxLength = 60;
                this.editorTitle.textContent =
                  potentialTitle.substring(0, maxLength) +
                  (potentialTitle.length > maxLength ? '...' : '');
                this.editorTitle.classList.remove('placeholder-active');
              }
            }
          }

          if (this.currentNote) this.currentNote.polishedNote = polishedText;
          this.recordingStatus.textContent =
            'Note polished. Ready for next recording.';
        } catch (e) {
            console.error("Error parsing polished note markdown:", e);
            this.polishedNote.textContent = polishedText; // Fallback to plain text
            this.polishedNote.classList.remove('placeholder-active');
        }
      } else {
        this.recordingStatus.textContent =
          'Polishing failed or returned empty.';
        this.polishedNote.innerHTML =
          '<p><em>Polishing returned empty. Raw transcription is available.</em></p>';
        this.polishedNote.classList.add('placeholder-active');
      }
    } catch (error) {
      console.error('Error polishing note:', error);
      this.recordingStatus.textContent =
        'Error polishing note. Please try again.';
      this.polishedNote.innerHTML = `<p><em>Error during polishing: ${error instanceof Error ? error.message : String(error)}</em></p>`;
      this.polishedNote.classList.add('placeholder-active');
    }
  }

  private createNewNote(): void {
    this.currentNote = {
      id: `note_${Date.now()}`,
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
    };

    const rawPlaceholder =
      this.rawTranscription.getAttribute('placeholder') || '';
    this.rawTranscription.textContent = rawPlaceholder;
    this.rawTranscription.classList.add('placeholder-active');

    const polishedPlaceholder =
      this.polishedNote.getAttribute('placeholder') || '';
    this.polishedNote.innerHTML = polishedPlaceholder;
    this.polishedNote.classList.add('placeholder-active');

    const actionItemsPlaceholder =
      this.actionItems.getAttribute('placeholder') || '';
    this.actionItems.innerHTML = actionItemsPlaceholder;
    this.actionItems.classList.add('placeholder-active');
    this.actionItems.setAttribute('contenteditable', 'true');

    if (this.editorTitle) {
      const placeholder =
        this.editorTitle.getAttribute('placeholder') || 'Untitled';
      this.editorTitle.textContent = placeholder;
      this.editorTitle.classList.add('placeholder-active');
    }
    this.recordingStatus.textContent = 'Ready to record';

    if (this.isRecording) {
      this.mediaRecorder?.stop();
      this.isRecording = false;
      this.recordButton.classList.remove('recording');
    } else {
      this.stopLiveDisplay();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VoiceNotesApp();
});

export {};
